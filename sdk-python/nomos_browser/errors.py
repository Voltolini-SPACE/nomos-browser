"""Erros do SDK Python do NOMOS Browser Runtime.

Hierarquia::

    NomosError
    ├── NomosTransportError  — não houve resposta (conexão recusada, DNS, timeout)
    ├── NomosHttpError       — houve resposta HTTP de erro sem envelope v1 legível
    ├── NomosProtocolError   — houve resposta 2xx cujo corpo não é o contrato v1
    ├── NomosBrowserError    — envelope v1 com ``success=false``
    └── SessionClosedError   — o próprio SDK já fechou esta sessão

Por que cinco e não uma: um ``CAPABILITY_DENIED`` (decisão de política do runtime,
prevista e recuperável) e um "connection refused" (o daemon não está de pé) exigem
reações diferentes de quem chama. Colapsar os dois numa exceção única obrigaria o
chamador a inspecionar string de mensagem para decidir — que é exatamente o tipo
de acoplamento frágil que o contrato v1 existe para evitar.

Regra de segredo: nenhuma exceção daqui carrega o **corpo da requisição**. O corpo
é o único lugar do fluxo onde uma senha injetada por ``text=`` poderia estar, e
exceção vira log em qualquer stack de aplicação. Só o corpo da *resposta* aparece,
truncado, e ele já passou pela redação do runtime (packages/observability/redact).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # ciclo só no type-check: client.py importa errors.py em runtime
    from .client import ActionTiming

__all__ = [
    "ACTION_ERROR_CODES",
    "NomosBrowserError",
    "NomosError",
    "NomosHttpError",
    "NomosProtocolError",
    "NomosTransportError",
    "SessionClosedError",
]

#: Transcrição literal de ``ActionErrorCode`` em packages/core/src/contract.ts (v1).
#: Serve para *classificar*, nunca para filtrar: um código fora desta lista ainda
#: vira ``NomosBrowserError`` — com ``known_code=False`` — porque engolir o código
#: desconhecido seria esconder uma violação de contrato do servidor.
ACTION_ERROR_CODES: frozenset[str] = frozenset(
    {
        "SESSION_NOT_FOUND",
        "SESSION_NOT_ACTIVE",
        "CONTROL_HELD_BY_HUMAN",
        "CAPABILITY_DENIED",
        "TARGET_NOT_FOUND",
        "TARGET_AMBIGUOUS",
        "VERIFICATION_FAILED",
        "NAVIGATION_FAILED",
        "TIMEOUT",
        "BACKPRESSURE_REJECTED",
        "POLICY_BLOCKED",
        "BROWSER_UNAVAILABLE",
        "UPLOAD_DENIED",
        "DOWNLOAD_DENIED",
        "INVALID_REQUEST",
        "INTERNAL",
    }
)

_MAX_BODY_ECHO = 512


def _truncate(body: Any) -> str | None:
    """Recorta o corpo da resposta para caber numa mensagem de erro."""
    if body is None:
        return None
    text = body if isinstance(body, str) else repr(body)
    if len(text) <= _MAX_BODY_ECHO:
        return text
    return text[:_MAX_BODY_ECHO] + f"… (+{len(text) - _MAX_BODY_ECHO} chars)"


class NomosError(Exception):
    """Base de tudo que este SDK levanta."""


class NomosTransportError(NomosError):
    """Não houve resposta do runtime: conexão recusada, host inalcançável, timeout."""

    def __init__(
        self,
        message: str,
        *,
        url: str | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.url = url
        self.cause = cause


class NomosHttpError(NomosError):
    """Resposta HTTP de erro que **não** trouxe um envelope v1 interpretável.

    Isto é diferente de ``NomosBrowserError``: aqui o runtime (ou algo entre nós e
    ele — proxy, balanceador) falhou sem falar o contrato. Quem chama não deve
    tratar como decisão de negócio.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int,
        url: str | None = None,
        body: Any = None,
    ) -> None:
        super().__init__(f"HTTP {status}: {message}")
        self.message = message
        self.status = status
        self.url = url
        self.body = _truncate(body)


class NomosProtocolError(NomosError):
    """Resposta 2xx cujo corpo não é o que o contrato v1 promete."""

    def __init__(
        self,
        message: str,
        *,
        url: str | None = None,
        status: int | None = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.url = url
        self.status = status
        self.body = _truncate(body)


class SessionClosedError(NomosError):
    """A sessão já foi fechada por este cliente.

    Levantado **localmente**, sem ida ao runtime. Deliberadamente não é um
    ``NomosBrowserError``: fingir um veredito do servidor que o servidor nunca deu
    seria exatamente a mentira que a missão proíbe.
    """

    def __init__(self, session_id: str, tool: str) -> None:
        super().__init__(
            f"sessão {session_id} já foi fechada por este cliente; "
            f"{tool} não foi enviado ao runtime"
        )
        self.session_id = session_id
        self.tool = tool


class NomosBrowserError(NomosError):
    """O runtime respondeu o envelope v1 com ``success=false``.

    Campos vindos do envelope (``ActionResponse`` do contrato v1):

    - ``code``      — ``ActionError.code``
    - ``message``   — ``ActionError.message``
    - ``detail``    — ``ActionError.detail`` (o contrato garante: sem segredo)
    - ``action_id`` — correlaciona com o log/evento do runtime
    - ``state``     — ``SessionState`` no momento da falha
    - ``timing``    — ``ActionTiming`` da ação que falhou
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        action_id: str | None = None,
        state: str | None = None,
        timing: "ActionTiming | None" = None,
        detail: dict[str, Any] | None = None,
        http_status: int | None = None,
        tool: str | None = None,
    ) -> None:
        super().__init__(f"[{code}] {message}" if message else f"[{code}]")
        self.code = code
        self.message = message
        self.action_id = action_id
        self.state = state
        self.timing = timing
        self.detail = dict(detail) if detail is not None else None
        self.http_status = http_status
        self.tool = tool

    @property
    def known_code(self) -> bool:
        """False quando o runtime devolveu código fora do enum fechado do v1."""
        return self.code in ACTION_ERROR_CODES

    def __repr__(self) -> str:  # pragma: no cover - conveniência de depuração
        return (
            f"NomosBrowserError(code={self.code!r}, tool={self.tool!r}, "
            f"action_id={self.action_id!r}, state={self.state!r})"
        )
