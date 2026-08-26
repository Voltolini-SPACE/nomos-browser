"""Cliente Python do NOMOS Browser Runtime — API v1.

Codifica contra ``docs/API.md`` (tabela de rotas normativa) e
``packages/core/src/contract.ts`` (``CONTRACT_VERSION = "1"``). Não inventa rota.

Sem dependência de runtime — só a stdlib. O motivo é operacional, não estético:
este SDK roda dentro de processos de agente que já carregam a própria árvore de
dependências, e uma dependência de HTTP a mais é uma superfície a mais para
conflitar com o que já está instalado lá.

**Sobre os tipos.** O contrato v1 vive em TypeScript e não pode ser importado
daqui. Este módulo transcreve o mínimo indispensável — ``ActionTiming`` e
``ActionResponse``, que todo chamador toca — e deixa o resto (``SessionInfo``,
``Observation``, ``PageInfo``, ``ResolvedTarget``…) como ``dict`` cru vindo do
JSON. Transcrever tudo dobraria a superfície de divergência entre as duas
linguagens sem dar nada em troca: um ``dict`` que espelha o JSON não pode
"envelhecer" em relação ao servidor, uma dataclass pode.

Uso::

    from nomos_browser import NomosBrowser

    browser = NomosBrowser()
    session = browser.create_session()
    session.goto("https://example.com")
    session.click(text="Login")
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import TracebackType
from typing import Any

from .errors import (
    NomosBrowserError,
    NomosHttpError,
    NomosProtocolError,
    NomosTransportError,
    SessionClosedError,
)

__all__ = [
    "ACTION_TOOLS",
    "API_PREFIX",
    "CAPABILITY_NAMES",
    "CONTRACT_VERSION",
    "DEFAULT_BASE_URL",
    "SCREENSHOT_SCOPES",
    "SDK_VERSION",
    "TARGET_FIELDS",
    "VERIFICATION_KINDS",
    "WAIT_CONDITIONS",
    "ActionResponse",
    "ActionTiming",
    "NomosBrowser",
    "Session",
    "target",
    "verification",
]

SDK_VERSION = "0.5.0"

#: Espelham as constantes homônimas de packages/core/src/contract.ts.
CONTRACT_VERSION = "1"
API_PREFIX = "/api/v1"

DEFAULT_BASE_URL = "http://127.0.0.1:7777"

#: Campos de ``TargetDescriptor`` (contract.ts). Ordem = ordem de declaração lá.
TARGET_FIELDS: tuple[str, ...] = (
    "selector",
    "text",
    "role",
    "label",
    "placeholder",
    "semantic",
    "coordinates",
    "nth",
)

#: Chaves de ``Capabilities`` (contract.ts).
CAPABILITY_NAMES: tuple[str, ...] = (
    "navigate",
    "read",
    "click",
    "type",
    "download",
    "upload",
    "send",
    "purchase",
    "payment",
    "delete",
)

#: ``VerificationKind`` (contract.ts).
VERIFICATION_KINDS: frozenset[str] = frozenset(
    {
        "URL_CHANGED",
        "ELEMENT_APPEARED",
        "ELEMENT_DISAPPEARED",
        "NETWORK_SUCCESS",
        "TEXT_CHANGED",
        "DOM_CHANGED",
        "NONE",
    }
)

#: Condições aceitas por ``browser.wait`` (docs/API.md). Duração fixa não está na
#: lista **de propósito**: esperar N milissegundos não é observar nada.
WAIT_CONDITIONS: frozenset[str] = frozenset(
    {"url_contains", "element_visible", "element_hidden", "network_idle", "text_present"}
)

#: Escopos de ``browser.screenshot`` (docs/API.md).
SCREENSHOT_SCOPES: frozenset[str] = frozenset({"viewport", "full", "element", "region"})

#: Ferramentas de ação da API v1, na ordem da tabela de docs/API.md.
ACTION_TOOLS: tuple[str, ...] = (
    "browser.open",
    "browser.goto",
    "browser.back",
    "browser.forward",
    "browser.reload",
    "browser.observe",
    "browser.find",
    "browser.click",
    "browser.type",
    "browser.press",
    "browser.scroll",
    "browser.drag",
    "browser.extract",
    "browser.screenshot",
    "browser.tabs",
    "browser.new_tab",
    "browser.switch_tab",
    "browser.close_tab",
    "browser.download",
    "browser.upload",
    "browser.wait",
    "browser.network",
    "browser.task",
)


# ─────────────────────────────────────────────────────────────────────────────
# Envelope
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ActionTiming:
    """Espelha ``ActionTiming`` do contrato v1."""

    started_at: str | None
    ended_at: str | None
    duration_ms: int | None

    @classmethod
    def from_json(cls, raw: Any) -> "ActionTiming | None":
        if not isinstance(raw, Mapping):
            return None
        return cls(
            started_at=raw.get("started_at"),
            ended_at=raw.get("ended_at"),
            duration_ms=raw.get("duration_ms"),
        )


@dataclass(frozen=True)
class ActionResponse:
    """Espelha ``ActionResponse<T>`` do contrato v1.

    ``raw`` guarda o JSON inteiro como veio. Os métodos de :class:`Session`
    devolvem apenas ``result`` por ergonomia — quem precisar de ``action_id`` ou
    ``timing`` lê ``session.last_response``, que nunca é descartado. Nada do
    envelope é perdido no caminho.
    """

    success: bool
    action_id: str | None
    state: str | None
    result: Any
    error: dict[str, Any] | None
    timing: ActionTiming | None
    raw: dict[str, Any]


# ─────────────────────────────────────────────────────────────────────────────
# Construtores de descritor
# ─────────────────────────────────────────────────────────────────────────────


def _coordinates(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        if "x" not in value or "y" not in value:
            raise ValueError("coordinates precisa das chaves 'x' e 'y'")
        pair = (value["x"], value["y"])
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)) and len(value) == 2:
        pair = (value[0], value[1])
    else:
        raise ValueError("coordinates deve ser {'x': .., 'y': ..} ou um par (x, y)")
    for component in pair:
        if isinstance(component, bool) or not isinstance(component, (int, float)):
            raise ValueError(f"coordinates com componente não numérico: {component!r}")
    return {"x": pair[0], "y": pair[1]}


def target(
    *,
    selector: str | None = None,
    text: str | None = None,
    role: str | None = None,
    label: str | None = None,
    placeholder: str | None = None,
    semantic: str | None = None,
    coordinates: Any = None,
    nth: int | None = None,
) -> dict[str, Any]:
    """Monta um ``TargetDescriptor`` do contrato v1 a partir de kwargs.

    Campos ``None`` não são enviados — mandar ``{"selector": null}`` faria o
    runtime tentar a estratégia de seletor com um seletor inexistente.

    Um descritor vazio é rejeitado aqui e não na rede: o contrato prevê a cascata
    seletor → role/text → acessibilidade → semantic → visão → coordenada, e sem
    nenhum campo não há cascata nenhuma para percorrer.
    """
    descriptor: dict[str, Any] = {}
    if selector is not None:
        descriptor["selector"] = _require_str("selector", selector)
    if text is not None:
        descriptor["text"] = _require_str("text", text)
    if role is not None:
        descriptor["role"] = _require_str("role", role)
    if label is not None:
        descriptor["label"] = _require_str("label", label)
    if placeholder is not None:
        descriptor["placeholder"] = _require_str("placeholder", placeholder)
    if semantic is not None:
        descriptor["semantic"] = _require_str("semantic", semantic)
    if coordinates is not None:
        descriptor["coordinates"] = _coordinates(coordinates)
    if nth is not None:
        if isinstance(nth, bool) or not isinstance(nth, int):
            raise ValueError(f"nth deve ser int, veio {type(nth).__name__}")
        if nth < 0:
            raise ValueError(f"nth deve ser >= 0, veio {nth}")
        descriptor["nth"] = nth
    if not descriptor:
        raise ValueError(
            "TargetDescriptor vazio — informe ao menos um de: " + ", ".join(TARGET_FIELDS)
        )
    return descriptor


def verification(kind: str, *, expect: str | None = None, timeout_ms: int | None = None) -> dict[str, Any]:
    """Monta um ``VerificationSpec`` do contrato v1."""
    if kind not in VERIFICATION_KINDS:
        raise ValueError(
            f"kind {kind!r} não pertence a VerificationKind do contrato v1; "
            f"válidos: {sorted(VERIFICATION_KINDS)}"
        )
    spec: dict[str, Any] = {"kind": kind}
    if expect is not None:
        spec["expect"] = _require_str("expect", expect)
    if timeout_ms is not None:
        spec["timeout_ms"] = _require_int("timeout_ms", timeout_ms)
    return spec


def _as_target(value: Any, argument: str) -> dict[str, Any]:
    """Normaliza um alvo já pronto (dict) vindo do chamador."""
    if not isinstance(value, Mapping):
        raise ValueError(f"{argument} deve ser um TargetDescriptor (dict), veio {type(value).__name__}")
    unknown = sorted(set(value) - set(TARGET_FIELDS))
    if unknown:
        raise ValueError(
            f"{argument} tem campo(s) fora de TargetDescriptor v1: {unknown}; "
            f"válidos: {list(TARGET_FIELDS)}"
        )
    return target(**value)


def _as_verification(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        return verification(value)
    if isinstance(value, Mapping):
        unknown = sorted(set(value) - {"kind", "expect", "timeout_ms"})
        if unknown:
            raise ValueError(
                f"verification tem campo(s) fora de VerificationSpec v1: {unknown}; "
                "válidos: ['kind', 'expect', 'timeout_ms']"
            )
        kind = value.get("kind")
        if not isinstance(kind, str):
            raise ValueError("verification precisa da chave 'kind'")
        return verification(kind, expect=value.get("expect"), timeout_ms=value.get("timeout_ms"))
    raise ValueError(f"verification deve ser str ou dict, veio {type(value).__name__}")


def _require_str(name: str, value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} deve ser str, veio {type(value).__name__}")
    return value


def _require_int(name: str, value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} deve ser int, veio {type(value).__name__}")
    return value


def _capabilities(value: Any) -> dict[str, bool]:
    """Valida um bloco ``Capabilities``.

    Chave desconhecida é erro, não é ignorada: se o chamador escrever
    ``{"downloads": True}`` e o SDK deixar passar, o runtime aplica o default
    negado e o chamador vai jurar que concedeu a permissão. Fail closed **e**
    barulhento.
    """
    if not isinstance(value, Mapping):
        raise ValueError(f"capabilities deve ser dict, veio {type(value).__name__}")
    unknown = sorted(set(value) - set(CAPABILITY_NAMES))
    if unknown:
        raise ValueError(
            f"capabilities com chave(s) fora de Capabilities v1: {unknown}; "
            f"válidas: {list(CAPABILITY_NAMES)}"
        )
    out: dict[str, bool] = {}
    for key, flag in value.items():
        if not isinstance(flag, bool):
            raise ValueError(f"capabilities[{key!r}] deve ser bool, veio {type(flag).__name__}")
        out[key] = flag
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Cliente
# ─────────────────────────────────────────────────────────────────────────────


class NomosBrowser:
    """Ponto de entrada do SDK. Sem estado de conexão: cada chamada é um HTTP.

    O runtime é quem guarda o estado da navegação — o cliente ser descartável é a
    consequência direta disso, não uma simplificação.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = 30.0,
        owner: str = "nomos-sdk-python",
        client: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        self.base_url = _require_str("base_url", base_url).rstrip("/")
        if not self.base_url:
            raise ValueError("base_url vazio")
        self.timeout = float(timeout)
        if self.timeout <= 0:
            raise ValueError("timeout deve ser > 0")
        self.owner = _require_str("owner", owner)
        if not self.owner:
            raise ValueError("owner vazio — o runtime precisa saber de quem é a sessão")
        self.client = client or f"sdk-python/{os.getpid()}"
        self._headers = {
            "content-type": "application/json",
            "accept": "application/json",
            "user-agent": f"nomos-browser-sdk-python/{SDK_VERSION} contract/{CONTRACT_VERSION}",
        }
        if headers:
            self._headers.update({str(k).lower(): str(v) for k, v in headers.items()})
        # ProxyHandler vazio desliga a herança de HTTP_PROXY/ALL_PROXY do ambiente.
        # Sem isto, um proxy corporativo exportado no shell sequestraria a chamada a
        # 127.0.0.1 e o sintoma chegaria como timeout sem causa aparente.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    # ── transporte ───────────────────────────────────────────────────────────

    def _request(self, method: str, path: str, body: Any = None) -> tuple[int, bytes, str]:
        url = f"{self.base_url}{path}"
        data = None
        if body is not None:
            # allow_nan=False: NaN/Infinity não são JSON válido. Deixar o json
            # emiti-los produziria um corpo que o servidor rejeita com uma
            # mensagem que não aponta para a causa.
            data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        request = urllib.request.Request(url, data=data, method=method, headers=dict(self._headers))
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                return int(response.status), response.read(), url
        except urllib.error.HTTPError as exc:
            # docs/API.md: "Erro HTTP mantém o envelope". O corpo do 4xx/5xx é
            # informação, não ruído — por isso é lido em vez de descartado.
            # HTTPError é um objeto de arquivo com socket/tempfile por trás: sem o
            # close() explícito ele só é recolhido pelo GC, e aí vaza descritor sob
            # carga (o CPython avisa com ResourceWarning).
            try:
                payload = exc.read()
            except OSError:
                payload = b""
            finally:
                exc.close()
            return int(exc.code), payload, url
        except urllib.error.URLError as exc:
            raise NomosTransportError(
                f"{method} {url} não obteve resposta: {exc.reason}", url=url, cause=exc
            ) from exc
        except TimeoutError as exc:
            raise NomosTransportError(
                f"{method} {url} estourou o timeout de {self.timeout}s", url=url, cause=exc
            ) from exc
        except OSError as exc:
            raise NomosTransportError(f"{method} {url} falhou: {exc}", url=url, cause=exc) from exc

    @staticmethod
    def _decode(status: int, raw: bytes, url: str) -> Any:
        if not raw:
            if 200 <= status < 300:
                return None
            raise NomosHttpError("resposta de erro sem corpo", status=status, url=url)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            text = raw.decode("utf-8", errors="replace")
            if 200 <= status < 300:
                raise NomosProtocolError(
                    f"{url} respondeu 2xx com corpo que não é JSON", url=url, status=status, body=text
                ) from exc
            raise NomosHttpError(
                "resposta de erro com corpo que não é JSON", status=status, url=url, body=text
            ) from exc

    def _action(self, tool: str, body: dict[str, Any]) -> ActionResponse:
        """Executa uma ferramenta e devolve o envelope; falha vira exceção."""
        path = f"{API_PREFIX}/{tool}"
        status, raw, url = self._request("POST", path, body)
        payload = self._decode(status, raw, url)

        if not isinstance(payload, Mapping) or "success" not in payload:
            if 200 <= status < 300:
                raise NomosProtocolError(
                    f"{tool} respondeu 2xx sem envelope ActionResponse v1",
                    url=url,
                    status=status,
                    body=payload,
                )
            raise NomosHttpError(
                f"{tool} falhou sem envelope ActionResponse v1", status=status, url=url, body=payload
            )

        success = payload.get("success")
        if not isinstance(success, bool):
            raise NomosProtocolError(
                f"{tool}: envelope com 'success' não booleano ({success!r})",
                url=url,
                status=status,
                body=payload,
            )

        error = payload.get("error")
        response = ActionResponse(
            success=success,
            action_id=payload.get("action_id"),
            state=payload.get("state"),
            result=payload.get("result"),
            error=dict(error) if isinstance(error, Mapping) else None,
            timing=ActionTiming.from_json(payload.get("timing")),
            raw=dict(payload),
        )
        if response.success:
            return response

        if response.error is None or not isinstance(response.error.get("code"), str):
            raise NomosProtocolError(
                f"{tool}: envelope com success=false e sem error.code — violação do contrato v1",
                url=url,
                status=status,
                body=payload,
            )
        detail = response.error.get("detail")
        raise NomosBrowserError(
            response.error["code"],
            response.error.get("message") or "",
            action_id=response.action_id,
            state=response.state,
            timing=response.timing,
            detail=detail if isinstance(detail, Mapping) else None,
            http_status=status,
            tool=tool,
        )

    def _management(self, method: str, path: str, body: Any = None) -> Any:
        """Rotas de gestão. Respondem o objeto direto, **não** o envelope."""
        status, raw, url = self._request(method, path, body)
        payload = self._decode(status, raw, url)
        if 200 <= status < 300:
            return payload
        # Mesmo fora do envelope, o runtime pode devolver {error:{code,...}}.
        # Preservar o código é o que permite ao chamador distinguir um
        # CAPABILITY_DENIED de um 500 genérico.
        if isinstance(payload, Mapping):
            error = payload.get("error")
            if isinstance(error, Mapping) and isinstance(error.get("code"), str):
                detail = error.get("detail")
                raise NomosBrowserError(
                    error["code"],
                    error.get("message") or "",
                    action_id=payload.get("action_id"),
                    state=payload.get("state"),
                    timing=ActionTiming.from_json(payload.get("timing")),
                    detail=detail if isinstance(detail, Mapping) else None,
                    http_status=status,
                    tool=path,
                )
        raise NomosHttpError(f"{method} {path} falhou", status=status, url=url, body=payload)

    @staticmethod
    def _session_path(session_id: str, suffix: str = "") -> str:
        # quote com safe="" impede que um session_id contendo '/' forje outra rota.
        return f"{API_PREFIX}/sessions/{urllib.parse.quote(_require_str('session_id', session_id), safe='')}{suffix}"

    # ── gestão ───────────────────────────────────────────────────────────────

    def health(self) -> dict[str, Any]:
        """``GET /health`` → ``HealthResponse``."""
        payload = self._management("GET", "/health")
        if not isinstance(payload, Mapping):
            raise NomosProtocolError("/health não respondeu um objeto", body=payload)
        return dict(payload)

    def list_sessions(self) -> list[dict[str, Any]]:
        """``GET /api/v1/sessions`` → ``SessionInfo[]``."""
        payload = self._management("GET", f"{API_PREFIX}/sessions")
        if not isinstance(payload, list):
            raise NomosProtocolError("GET /sessions não respondeu uma lista", body=payload)
        return [dict(item) for item in payload]

    def get_session_info(self, session_id: str) -> dict[str, Any]:
        """``GET /api/v1/sessions/:id`` → ``SessionInfo``."""
        return self._as_info(self._management("GET", self._session_path(session_id)))

    def create_session(
        self,
        *,
        owner: str | None = None,
        profile: str | None = None,
        capabilities: Mapping[str, bool] | None = None,
        headless: bool | None = None,
    ) -> "Session":
        """``POST /api/v1/sessions`` → :class:`Session` que **fecha** ao sair do ``with``.

        ``capabilities`` omitido faz o runtime aplicar seu default restrito
        (``RESTRICTED_CAPABILITIES`` no contrato). O SDK não escolhe permissão por
        conta própria — conceder é ato do dono.
        """
        return self._create(
            owner=owner,
            profile=profile,
            capabilities=capabilities,
            headless=headless,
            close_on_exit=True,
        )

    def detached_session(
        self,
        *,
        owner: str | None = None,
        profile: str | None = None,
        capabilities: Mapping[str, bool] | None = None,
        headless: bool | None = None,
    ) -> "Session":
        """Igual a :meth:`create_session`, porém a sessão **sobrevive** ao ``with``.

        ASSIMETRIA PROPOSITAL — leia antes de "corrigir":

        - ``create_session()`` no ``with``: ao sair, chama ``DELETE /sessions/:id``.
          A sessão morre. É o padrão para trabalho de vida curta.
        - ``detached_session()`` no ``with``: ao sair, chama
          ``POST /sessions/:id/detach``. A sessão **continua viva** no runtime, com
          as mesmas abas, cookies e task; ``attached_client`` vira ``null`` e outro
          cliente pode assumir com ``attach``.

        Isto existe porque o estado da navegação pertence ao Runtime, não ao
        agente: o processo do agente pode morrer, ser trocado por outro de outro
        fornecedor, ou simplesmente terminar o bloco — e a sessão não deve morrer
        junto. Fechar aqui destruiria justamente a propriedade que o produto vende.

        Por que ``detach`` e não "nada": sair do bloco sem soltar o cliente deixaria
        ``attached_client`` apontando para um processo que não existe mais, e o
        próximo cliente encontraria a sessão ocupada por um fantasma.
        """
        return self._create(
            owner=owner,
            profile=profile,
            capabilities=capabilities,
            headless=headless,
            close_on_exit=False,
        )

    def _create(
        self,
        *,
        owner: str | None,
        profile: str | None,
        capabilities: Mapping[str, bool] | None,
        headless: bool | None,
        close_on_exit: bool,
    ) -> "Session":
        body: dict[str, Any] = {"owner": _require_str("owner", owner) if owner is not None else self.owner}
        if profile is not None:
            body["profile"] = _require_str("profile", profile)
        if capabilities is not None:
            body["capabilities"] = _capabilities(capabilities)
        if headless is not None:
            if not isinstance(headless, bool):
                raise ValueError(f"headless deve ser bool, veio {type(headless).__name__}")
            body["headless"] = headless
        info = self._as_info(self._management("POST", f"{API_PREFIX}/sessions", body))
        return Session(self, info, close_on_exit=close_on_exit)

    def attach_session(self, session_id: str, *, client: str | None = None) -> "Session":
        """``POST /api/v1/sessions/:id/attach`` numa sessão que já existe.

        Sai do ``with`` com ``detach``, nunca com ``close``: quem não criou a
        sessão não tem mandato para destruí-la.
        """
        info = self._as_info(
            self._management(
                "POST",
                self._session_path(session_id, "/attach"),
                {"client": client or self.client},
            )
        )
        return Session(self, info, close_on_exit=False)

    @staticmethod
    def _as_info(payload: Any) -> dict[str, Any]:
        if not isinstance(payload, Mapping):
            raise NomosProtocolError("rota de sessão não respondeu um SessionInfo", body=payload)
        if not isinstance(payload.get("session_id"), str) or not payload["session_id"]:
            raise NomosProtocolError("SessionInfo sem session_id utilizável", body=payload)
        return dict(payload)

    def __repr__(self) -> str:  # pragma: no cover - conveniência de depuração
        return f"NomosBrowser(base_url={self.base_url!r}, owner={self.owner!r})"


# ─────────────────────────────────────────────────────────────────────────────
# Sessão
# ─────────────────────────────────────────────────────────────────────────────


class Session:
    """Uma sessão de navegação no runtime.

    Cada método de ação devolve o campo ``result`` do envelope. O envelope
    completo da última ação fica em :attr:`last_response` — ``action_id``,
    ``state`` e ``timing`` não são jogados fora.
    """

    def __init__(self, browser: NomosBrowser, info: Mapping[str, Any], *, close_on_exit: bool) -> None:
        self._browser = browser
        self._info = dict(info)
        self._close_on_exit = close_on_exit
        self._closed = False
        self.last_response: ActionResponse | None = None

    # ── identidade / estado ──────────────────────────────────────────────────

    @property
    def session_id(self) -> str:
        return self._info["session_id"]

    @property
    def info(self) -> dict[str, Any]:
        """Último ``SessionInfo`` conhecido. Cópia — mutar não afeta a sessão."""
        return dict(self._info)

    @property
    def state(self) -> Any:
        return self._info.get("status")

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def closes_on_exit(self) -> bool:
        """True para ``create_session``, False para ``detached_session``."""
        return self._close_on_exit

    def refresh(self) -> dict[str, Any]:
        """Relê o ``SessionInfo`` do runtime."""
        self._info = self._browser.get_session_info(self.session_id)
        return self.info

    # ── plumbing ─────────────────────────────────────────────────────────────

    def _act(self, tool: str, body: dict[str, Any] | None = None) -> Any:
        if self._closed:
            raise SessionClosedError(self.session_id, tool)
        payload: dict[str, Any] = {"session_id": self.session_id}
        if body:
            payload.update(body)
        response = self._browser._action(tool, payload)
        self.last_response = response
        if isinstance(response.state, str):
            self._info["status"] = response.state
        return response.result

    def _target_kwargs(
        self,
        *,
        selector: str | None,
        text: str | None,
        role: str | None,
        label: str | None,
        placeholder: str | None,
        semantic: str | None,
        coordinates: Any,
        nth: int | None,
        target_: Any,
        required: bool,
        argument: str = "target",
    ) -> dict[str, Any] | None:
        """Resolve o alvo vindo ou de ``target=`` pronto ou dos kwargs soltos."""
        loose = {
            "selector": selector,
            "text": text,
            "role": role,
            "label": label,
            "placeholder": placeholder,
            "semantic": semantic,
            "coordinates": coordinates,
            "nth": nth,
        }
        given = {k: v for k, v in loose.items() if v is not None}
        if target_ is not None:
            if given:
                raise ValueError(
                    f"{argument}= e kwargs de alvo ({sorted(given)}) ao mesmo tempo — "
                    "escolha um dos dois; mesclar silenciosamente esconderia qual venceu"
                )
            return _as_target(target_, argument)
        if given:
            return target(**given)
        if required:
            raise ValueError(
                f"{argument} obrigatório — informe ao menos um de: " + ", ".join(TARGET_FIELDS)
            )
        return None

    # ── navegação ────────────────────────────────────────────────────────────

    def open(self, url: str) -> Any:
        """``browser.open`` → ``PageInfo``."""
        return self._act("browser.open", {"url": _require_str("url", url)})

    def goto(self, url: str, *, wait_until: str | None = None) -> Any:
        """``browser.goto`` → ``PageInfo``."""
        body: dict[str, Any] = {"url": _require_str("url", url)}
        if wait_until is not None:
            body["wait_until"] = _require_str("wait_until", wait_until)
        return self._act("browser.goto", body)

    def back(self) -> Any:
        """``browser.back`` → ``PageInfo``."""
        return self._act("browser.back")

    def forward(self) -> Any:
        """``browser.forward`` → ``PageInfo``."""
        return self._act("browser.forward")

    def reload(self) -> Any:
        """``browser.reload`` → ``PageInfo``."""
        return self._act("browser.reload")

    # ── percepção ────────────────────────────────────────────────────────────

    def observe(
        self,
        *,
        accessibility: bool | None = None,
        screenshot: bool | None = None,
        limit: int | None = None,
    ) -> Any:
        """``browser.observe`` → ``Observation``.

        O ``Observation`` traz ``total_elements`` e ``truncated``; com ``limit``
        baixo, conferir esses dois é a diferença entre "a página tem 50 elementos"
        e "eu pedi 50".
        """
        body: dict[str, Any] = {}
        if accessibility is not None:
            body["accessibility"] = bool(accessibility)
        if screenshot is not None:
            body["screenshot"] = bool(screenshot)
        if limit is not None:
            body["limit"] = _require_int("limit", limit)
        return self._act("browser.observe", body)

    def find(
        self,
        *,
        selector: str | None = None,
        text: str | None = None,
        role: str | None = None,
        label: str | None = None,
        placeholder: str | None = None,
        semantic: str | None = None,
        coordinates: Any = None,
        nth: int | None = None,
        target: Any = None,
    ) -> Any:
        """``browser.find`` → ``ResolvedTarget`` (inclui ``strategy`` e ``healed``)."""
        descriptor = self._target_kwargs(
            selector=selector,
            text=text,
            role=role,
            label=label,
            placeholder=placeholder,
            semantic=semantic,
            coordinates=coordinates,
            nth=nth,
            target_=target,
            required=True,
        )
        return self._act("browser.find", {"target": descriptor})

    def extract(
        self,
        *,
        format: str | None = None,
        selector: str | None = None,
        text: str | None = None,
        role: str | None = None,
        label: str | None = None,
        placeholder: str | None = None,
        semantic: str | None = None,
        coordinates: Any = None,
        nth: int | None = None,
        target: Any = None,
    ) -> Any:
        """``browser.extract`` → ``{content}``. Sem alvo, extrai a página."""
        descriptor = self._target_kwargs(
            selector=selector,
            text=text,
            role=role,
            label=label,
            placeholder=placeholder,
            semantic=semantic,
            coordinates=coordinates,
            nth=nth,
            target_=target,
            required=False,
        )
        body: dict[str, Any] = {}
        if descriptor is not None:
            body["target"] = descriptor
        if format is not None:
            body["format"] = _require_str("format", format)
        return self._act("browser.extract", body)

    def screenshot(
        self,
        *,
        scope: str | None = None,
        region: Mapping[str, Any] | None = None,
        selector: str | None = None,
        text: str | None = None,
        role: str | None = None,
        label: str | None = None,
        placeholder: str | None = None,
        semantic: str | None = None,
        coordinates: Any = None,
        nth: int | None = None,
        target: Any = None,
    ) -> Any:
        """``browser.screenshot`` → ``{screenshot_ref, width, height}``.

        Devolve uma **referência**, não bytes: o binário fica na observabilidade do
        runtime, onde já passa pela redação.
        """
        body: dict[str, Any] = {}
        if scope is not None:
            if scope not in SCREENSHOT_SCOPES:
                raise ValueError(f"scope {scope!r} inválido; válidos: {sorted(SCREENSHOT_SCOPES)}")
            body["scope"] = scope
        if region is not None:
            if not isinstance(region, Mapping):
                raise ValueError("region deve ser dict {x, y, width, height}")
            missing = sorted({"x", "y", "width", "height"} - set(region))
            if missing:
                raise ValueError(f"region sem as chaves {missing}")
            body["region"] = {k: region[k] for k in ("x", "y", "width", "height")}
        descriptor = self._target_kwargs(
            selector=selector,
            text=text,
            role=role,
            label=label,
            placeholder=placeholder,
            semantic=semantic,
            coordinates=coordinates,
            nth=nth,
            target_=target,
            required=False,
        )
        if descriptor is not None:
            body["target"] = descriptor
        return self._act("browser.screenshot", body)

    def network(self, *, limit: int | None = None) -> Any:
        """``browser.network`` → ``{requests[]}`` (já redigido pelo runtime)."""
        body: dict[str, Any] = {}
        if limit is not None:
            body["limit"] = _require_int("limit", limit)
        return self._act("browser.network", body)

    # ── ação ─────────────────────────────────────────────────────────────────

    def click(
        self,
        *,
        selector: str | None = None,
        text: str | None = None,
        role: str | None = None,
        label: str | None = None,
        placeholder: str | None = None,
        semantic: str | None = None,
        coordinates: Any = None,
        nth: int | None = None,
        target: Any = None,
        verification: Any = None,
    ) -> Any:
        """``browser.click`` → ``{target: ResolvedTarget, verification: VerificationResult}``."""
        descriptor = self._target_kwargs(
            selector=selector,
            text=text,
            role=role,
            label=label,
            placeholder=placeholder,
            semantic=semantic,
            coordinates=coordinates,
            nth=nth,
            target_=target,
            required=True,
        )
        body: dict[str, Any] = {"target": descriptor}
        if verification is not None:
            body["verification"] = _as_verification(verification)
        return self._act("browser.click", body)

    def type_(
        self,
        text_to_type: str | None = None,
        *,
        credential_ref: str | None = None,
        selector: str | None = None,
        text: str | None = None,
        role: str | None = None,
        label: str | None = None,
        placeholder: str | None = None,
        semantic: str | None = None,
        coordinates: Any = None,
        nth: int | None = None,
        target: Any = None,
        verification: Any = None,
    ) -> Any:
        """``browser.type`` → ``{target, verification}``.

        O nome leva ``_`` porque ``type`` é o builtin de Python: um método
        ``Session.type`` é legal, mas o parâmetro/variável ``type`` que apareceria
        em todo chamador sombrearia o builtin dentro daquele escopo. O contrato v1
        não muda — a ferramenta enviada continua sendo ``browser.type``.

        Note que ``text_to_type`` é o texto **digitado** e ``text=`` é campo do
        ``TargetDescriptor`` (o texto do elemento alvo). São coisas distintas e o
        contrato as separa; por isso não compartilham nome aqui.

        Segredo: prefira ``credential_ref``. Com ele o valor nunca atravessa este
        processo — o runtime resolve a referência e injeta. ``text_to_type`` viaja
        no corpo da requisição, e este SDK nunca o registra em log nem o inclui em
        mensagem de exceção; ainda assim, para senha, a referência é o caminho.
        """
        if (text_to_type is None) == (credential_ref is None):
            raise ValueError(
                "informe exatamente um entre text_to_type= e credential_ref= "
                "(nenhum dos dois, ou ambos, é ambíguo por construção)"
            )
        descriptor = self._target_kwargs(
            selector=selector,
            text=text,
            role=role,
            label=label,
            placeholder=placeholder,
            semantic=semantic,
            coordinates=coordinates,
            nth=nth,
            target_=target,
            required=True,
        )
        body: dict[str, Any] = {"target": descriptor}
        if text_to_type is not None:
            body["text"] = _require_str("text_to_type", text_to_type)
        else:
            body["credential_ref"] = _require_str("credential_ref", credential_ref)
        if verification is not None:
            body["verification"] = _as_verification(verification)
        return self._act("browser.type", body)

    def press(self, key: str | None = None, *, keys: Sequence[str] | None = None) -> Any:
        """``browser.press`` → ``{pressed}``. Um entre ``key`` e ``keys``."""
        if (key is None) == (keys is None):
            raise ValueError("informe exatamente um entre key= e keys=")
        if key is not None:
            return self._act("browser.press", {"key": _require_str("key", key)})
        if isinstance(keys, (str, bytes)) or not isinstance(keys, Sequence):
            raise ValueError("keys deve ser uma sequência de str")
        return self._act("browser.press", {"keys": [_require_str("keys[i]", k) for k in keys]})

    def scroll(
        self,
        *,
        dx: float | None = None,
        dy: float | None = None,
        selector: str | None = None,
        text: str | None = None,
        role: str | None = None,
        label: str | None = None,
        placeholder: str | None = None,
        semantic: str | None = None,
        coordinates: Any = None,
        nth: int | None = None,
        target: Any = None,
    ) -> Any:
        """``browser.scroll`` → ``{scrolled}``."""
        if dx is None and dy is None:
            raise ValueError("scroll precisa de dx= e/ou dy=")
        body: dict[str, Any] = {}
        for name, value in (("dx", dx), ("dy", dy)):
            if value is not None:
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise ValueError(f"{name} deve ser numérico, veio {type(value).__name__}")
                body[name] = value
        descriptor = self._target_kwargs(
            selector=selector,
            text=text,
            role=role,
            label=label,
            placeholder=placeholder,
            semantic=semantic,
            coordinates=coordinates,
            nth=nth,
            target_=target,
            required=False,
        )
        if descriptor is not None:
            body["target"] = descriptor
        return self._act("browser.scroll", body)

    def drag(self, *, from_: Mapping[str, Any], to: Mapping[str, Any]) -> Any:
        """``browser.drag`` → ``{dragged}``.

        ``from_`` leva ``_`` porque ``from`` é palavra reservada de Python. O corpo
        enviado usa a chave ``from`` do contrato. Use :func:`target` para montar os
        dois descritores.
        """
        return self._act(
            "browser.drag",
            {"from": _as_target(from_, "from_"), "to": _as_target(to, "to")},
        )

    # ── abas ─────────────────────────────────────────────────────────────────

    def tabs(self) -> Any:
        """``browser.tabs`` → ``PageInfo[]``."""
        return self._act("browser.tabs")

    def new_tab(self, url: str | None = None) -> Any:
        """``browser.new_tab`` → ``PageInfo``."""
        body: dict[str, Any] = {}
        if url is not None:
            body["url"] = _require_str("url", url)
        return self._act("browser.new_tab", body)

    def switch_tab(self, page_id: str) -> Any:
        """``browser.switch_tab`` → ``PageInfo``."""
        return self._act("browser.switch_tab", {"page_id": _require_str("page_id", page_id)})

    def close_tab(self, page_id: str) -> Any:
        """``browser.close_tab`` → ``{closed}``."""
        return self._act("browser.close_tab", {"page_id": _require_str("page_id", page_id)})

    # ── arquivos (COMMIT — capability negada por padrão) ─────────────────────

    def download(
        self,
        *,
        url: str | None = None,
        selector: str | None = None,
        text: str | None = None,
        role: str | None = None,
        label: str | None = None,
        placeholder: str | None = None,
        semantic: str | None = None,
        coordinates: Any = None,
        nth: int | None = None,
        target: Any = None,
    ) -> Any:
        """``browser.download`` → ``DownloadRecord``.

        Classe COMMIT no contrato: a capability ``download`` nasce negada. Sem
        concessão explícita do dono, isto levanta ``NomosBrowserError`` com
        ``DOWNLOAD_DENIED``/``CAPABILITY_DENIED`` — e é assim que deve ser.
        """
        descriptor = self._target_kwargs(
            selector=selector,
            text=text,
            role=role,
            label=label,
            placeholder=placeholder,
            semantic=semantic,
            coordinates=coordinates,
            nth=nth,
            target_=target,
            required=False,
        )
        if url is None and descriptor is None:
            raise ValueError("download precisa de url= ou de um alvo")
        body: dict[str, Any] = {}
        if url is not None:
            body["url"] = _require_str("url", url)
        if descriptor is not None:
            body["target"] = descriptor
        return self._act("browser.download", body)

    def upload(
        self,
        *,
        path: str | None = None,
        file_ref: str | None = None,
        selector: str | None = None,
        text: str | None = None,
        role: str | None = None,
        label: str | None = None,
        placeholder: str | None = None,
        semantic: str | None = None,
        coordinates: Any = None,
        nth: int | None = None,
        target: Any = None,
    ) -> Any:
        """``browser.upload`` → ``UploadRecord``. Classe COMMIT, capability ``upload``."""
        if (path is None) == (file_ref is None):
            raise ValueError("informe exatamente um entre path= e file_ref=")
        descriptor = self._target_kwargs(
            selector=selector,
            text=text,
            role=role,
            label=label,
            placeholder=placeholder,
            semantic=semantic,
            coordinates=coordinates,
            nth=nth,
            target_=target,
            required=True,
        )
        body: dict[str, Any] = {"target": descriptor}
        if path is not None:
            body["path"] = _require_str("path", path)
        else:
            body["file_ref"] = _require_str("file_ref", file_ref)
        return self._act("browser.upload", body)

    # ── espera e task ────────────────────────────────────────────────────────

    def wait(self, condition: Any, *, timeout_ms: int | None = None) -> Any:
        """``browser.wait`` → ``{waited_ms}``.

        ``condition`` é um dos verbos observáveis de ``WAIT_CONDITIONS`` (str) ou um
        dict que carregue ``condition``/``kind`` com esse verbo. Duração fixa é
        rejeitada aqui: docs/API.md diz que ``browser.wait`` não aceita duração como
        condição principal, e um ``sleep`` disfarçado de espera é a forma mais comum
        de um teste passar sem que nada tenha acontecido.
        """
        if isinstance(condition, bool) or isinstance(condition, (int, float)):
            raise ValueError(
                "wait() não aceita duração como condição — use uma de "
                f"{sorted(WAIT_CONDITIONS)} (docs/API.md). Duração fixa não observa nada."
            )
        if isinstance(condition, str):
            if condition not in WAIT_CONDITIONS:
                raise ValueError(
                    f"condition {condition!r} inválida; válidas: {sorted(WAIT_CONDITIONS)}"
                )
            payload: Any = condition
        elif isinstance(condition, Mapping):
            verb = condition.get("condition", condition.get("kind"))
            if not isinstance(verb, str) or verb not in WAIT_CONDITIONS:
                raise ValueError(
                    "condition dict precisa de 'condition' (ou 'kind') em "
                    f"{sorted(WAIT_CONDITIONS)}; veio {verb!r}"
                )
            payload = dict(condition)
        else:
            raise ValueError(f"condition deve ser str ou dict, veio {type(condition).__name__}")
        body: dict[str, Any] = {"condition": payload}
        if timeout_ms is not None:
            body["timeout_ms"] = _require_int("timeout_ms", timeout_ms)
        return self._act("browser.wait", body)

    def task(self, goal: str, *, profile: str | None = None) -> Any:
        """``browser.task`` → ``BrowserTask``."""
        body: dict[str, Any] = {"goal": _require_str("goal", goal)}
        if profile is not None:
            body["profile"] = _require_str("profile", profile)
        return self._act("browser.task", body)

    # ── ciclo de vida ────────────────────────────────────────────────────────

    def attach(self, client: str | None = None) -> dict[str, Any]:
        """``POST /sessions/:id/attach`` → ``SessionInfo``."""
        if self._closed:
            raise SessionClosedError(self.session_id, "attach")
        self._info = NomosBrowser._as_info(
            self._browser._management(
                "POST",
                NomosBrowser._session_path(self.session_id, "/attach"),
                {"client": client or self._browser.client},
            )
        )
        return self.info

    def detach(self) -> dict[str, Any]:
        """``POST /sessions/:id/detach`` → ``SessionInfo``. A sessão **continua viva**."""
        if self._closed:
            raise SessionClosedError(self.session_id, "detach")
        self._info = NomosBrowser._as_info(
            self._browser._management(
                "POST", NomosBrowser._session_path(self.session_id, "/detach")
            )
        )
        return self.info

    def handoff(self, to_owner: str) -> dict[str, Any]:
        """``POST /sessions/:id/handoff`` → ``SessionInfo``. Passa a sessão a outro dono."""
        if self._closed:
            raise SessionClosedError(self.session_id, "handoff")
        self._info = NomosBrowser._as_info(
            self._browser._management(
                "POST",
                NomosBrowser._session_path(self.session_id, "/handoff"),
                {"to_owner": _require_str("to_owner", to_owner)},
            )
        )
        return self.info

    def close(self) -> Any:
        """``DELETE /sessions/:id`` → ``{closed: true}``.

        Idempotente: a segunda chamada não vai à rede e não levanta. Isto não é
        engolir erro — não há erro a engolir, o estado desejado já vale.
        """
        if self._closed:
            return {"closed": True}
        payload = self._browser._management("DELETE", NomosBrowser._session_path(self.session_id))
        self._closed = True
        self._info["status"] = "CLOSED"
        return payload

    # ── context manager ──────────────────────────────────────────────────────

    def __enter__(self) -> "Session":
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> bool:
        # Assimetria documentada em NomosBrowser.detached_session().
        if self._closed:
            return False
        if self._close_on_exit:
            self.close()
        else:
            self.detach()
        # Retorna False sempre: a limpeza não suprime a exceção do bloco. Se a
        # própria limpeza falhar, a falha sobe com a original como __context__ —
        # ninguém fica sabendo menos do que aconteceu.
        return False

    def __repr__(self) -> str:  # pragma: no cover - conveniência de depuração
        mode = "close_on_exit" if self._close_on_exit else "detach_on_exit"
        return (
            f"Session(session_id={self.session_id!r}, status={self._info.get('status')!r}, "
            f"{mode}, closed={self._closed})"
        )
