"""Suíte do SDK Python contra um runtime FALSO servido por http.server numa thread.

Por que um servidor de verdade e não um mock de ``urllib``: o que precisa ser
provado aqui é o **formato do fio** — método HTTP, rota e corpo JSON que chegam do
outro lado. Um mock de biblioteca provaria apenas que o SDK chama o mock. O
servidor falso registra o que realmente trafegou, e é sobre esse registro que as
asserções falam.

O runtime falso NÃO valida o contrato; ele grava e devolve o que o teste mandar
devolver. Isto é deliberado: se ele "consertasse" um corpo malformado, o teste
mediria o conserto e não o SDK.

Rodar::

    cd sdk-python && python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# Permite rodar a suíte de qualquer cwd, não só de sdk-python/.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nomos_browser import (  # noqa: E402
    ACTION_ERROR_CODES,
    SDK_VERSION,
    NomosBrowser,
    NomosBrowserError,
    NomosHttpError,
    NomosProtocolError,
    Session,
    SessionClosedError,
    target,
)

SESSION_ID = "sess_test_0001"


def session_info(**overrides: Any) -> dict[str, Any]:
    """``SessionInfo`` mínimo do contrato v1."""
    info: dict[str, Any] = {
        "session_id": SESSION_ID,
        "owner": "nomos-sdk-python",
        "profile": "default",
        "permissions": {
            "navigate": True,
            "read": True,
            "click": True,
            "type": True,
            "download": False,
            "upload": False,
            "send": False,
            "purchase": False,
            "payment": False,
            "delete": False,
        },
        "created_at": "2026-08-24T10:00:00.000Z",
        "last_activity": "2026-08-24T10:00:00.000Z",
        "context_id": "ctx_test",
        "pages": [],
        "task": None,
        "status": "ACTIVE",
        "control": "agent",
        "attached_client": "sdk-python/1",
    }
    info.update(overrides)
    return info


def envelope(
    result: Any = None,
    *,
    success: bool = True,
    code: str | None = None,
    message: str = "",
    detail: dict[str, Any] | None = None,
    action_id: str = "act_test_1",
    state: str = "ACTIVE",
) -> dict[str, Any]:
    """``ActionResponse<T>`` do contrato v1."""
    error = None
    if not success:
        error = {"code": code, "message": message}
        if detail is not None:
            error["detail"] = detail
    return {
        "success": success,
        "action_id": action_id,
        "state": state,
        "result": result if success else None,
        "error": error,
        "timing": {
            "started_at": "2026-08-24T10:00:01.000Z",
            "ended_at": "2026-08-24T10:00:01.250Z",
            "duration_ms": 250,
        },
    }


class FakeRuntime:
    """Servidor HTTP em thread que grava requisições e devolve respostas roteirizadas."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self._script: dict[tuple[str, str], tuple[int, Any]] = {}
        self._lock = threading.Lock()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _handler_for(self))
        # poll_interval curto: o default de 0,5s é o tempo que shutdown() leva para
        # ser notado, e com um servidor por teste isso somava ~15s de suíte parada
        # esperando — tempo que não mede nada.
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        self._thread.start()

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def on(self, method: str, path: str, payload: Any, status: int = 200) -> None:
        self._script[(method.upper(), path)] = (status, payload)

    def resolve(self, method: str, path: str) -> tuple[int, Any]:
        entry = self._script.get((method.upper(), path))
        if entry is None:
            # 404 sem envelope: o teste que cair aqui pediu rota que não foi
            # roteirizada, e tem de falhar de forma visível.
            return 404, {"fake_runtime": "rota não roteirizada", "method": method, "path": path}
        return entry

    def record(self, entry: dict[str, Any]) -> None:
        with self._lock:
            self.requests.append(entry)

    def paths(self) -> list[tuple[str, str]]:
        with self._lock:
            return [(r["method"], r["path"]) for r in self.requests]

    def find(self, method: str, path: str) -> dict[str, Any] | None:
        with self._lock:
            for entry in self.requests:
                if entry["method"] == method and entry["path"] == path:
                    return entry
        return None

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


def _handler_for(runtime: FakeRuntime) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args: Any) -> None:  # silencia o log do http.server
            pass

        def _dispatch(self, method: str) -> None:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b""
            body: Any = None
            if raw:
                try:
                    body = json.loads(raw.decode("utf-8"))
                except ValueError:
                    body = {"__unparseable__": raw.decode("utf-8", errors="replace")}
            runtime.record(
                {
                    "method": method,
                    "path": self.path,
                    "body": body,
                    "content_type": self.headers.get("content-type"),
                    "user_agent": self.headers.get("user-agent"),
                }
            )
            status, payload = runtime.resolve(method, self.path)
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            self._dispatch("GET")

        def do_POST(self) -> None:
            self._dispatch("POST")

        def do_DELETE(self) -> None:
            self._dispatch("DELETE")

    return Handler


class RuntimeTestCase(unittest.TestCase):
    """Base: sobe o runtime falso e um cliente apontado para ele."""

    def setUp(self) -> None:
        self.runtime = FakeRuntime()
        self.addCleanup(self.runtime.stop)
        self.browser = NomosBrowser(self.runtime.base_url, timeout=5.0)
        self.runtime.on("POST", "/api/v1/sessions", session_info(), status=201)
        self.runtime.on("DELETE", f"/api/v1/sessions/{SESSION_ID}", {"closed": True})
        self.runtime.on(
            "POST", f"/api/v1/sessions/{SESSION_ID}/detach", session_info(attached_client=None)
        )


# ─────────────────────────────────────────────────────────────────────────────
# 1. create_session + goto + click mandam método/rota/corpo certos
# ─────────────────────────────────────────────────────────────────────────────


class TestWireFormat(RuntimeTestCase):
    def test_create_goto_click_hit_the_documented_routes(self) -> None:
        page = {
            "page_id": "page_1",
            "url": "https://example.com/",
            "title": "Example",
            "active": True,
            "opened_at": "2026-08-24T10:00:01.000Z",
        }
        self.runtime.on("POST", "/api/v1/browser.goto", envelope(page))
        self.runtime.on(
            "POST",
            "/api/v1/browser.click",
            envelope({"target": {"strategy": "role_text", "healed": False}, "verification": {"verified": True}}),
        )

        session = self.browser.create_session()
        goto_result = session.goto("https://example.com")
        click_result = session.click(text="Login")

        self.assertEqual(
            self.runtime.paths(),
            [
                ("POST", "/api/v1/sessions"),
                ("POST", "/api/v1/browser.goto"),
                ("POST", "/api/v1/browser.click"),
            ],
        )

        create = self.runtime.requests[0]
        self.assertEqual(create["body"], {"owner": "nomos-sdk-python"})
        self.assertEqual(create["content_type"], "application/json")
        self.assertIn(f"nomos-browser-sdk-python/{SDK_VERSION}", create["user_agent"])
        self.assertIn("contract/1", create["user_agent"])

        # Regra invariante nº1 de docs/API.md: toda rota de ação leva session_id.
        self.assertEqual(
            self.runtime.requests[1]["body"],
            {"session_id": SESSION_ID, "url": "https://example.com"},
        )
        self.assertEqual(
            self.runtime.requests[2]["body"],
            {"session_id": SESSION_ID, "target": {"text": "Login"}},
        )

        # O SDK devolve `result` desembrulhado…
        self.assertEqual(goto_result, page)
        self.assertTrue(click_result["verification"]["verified"])
        # …e o envelope inteiro continua acessível: nada é descartado.
        self.assertIsNotNone(session.last_response)
        self.assertEqual(session.last_response.action_id, "act_test_1")
        self.assertEqual(session.last_response.timing.duration_ms, 250)
        self.assertEqual(session.state, "ACTIVE")

    def test_create_session_sends_profile_capabilities_headless(self) -> None:
        self.browser.create_session(
            owner="operador",
            profile="trabalho",
            capabilities={"download": True},
            headless=False,
        )
        self.assertEqual(
            self.runtime.requests[0]["body"],
            {
                "owner": "operador",
                "profile": "trabalho",
                "capabilities": {"download": True},
                "headless": False,
            },
        )

    def test_unknown_capability_is_rejected_before_the_wire(self) -> None:
        # Fail closed E barulhento: "downloads" (plural) não pode virar um
        # no-op que o chamador confunde com permissão concedida.
        with self.assertRaises(ValueError) as ctx:
            self.browser.create_session(capabilities={"downloads": True})
        self.assertIn("downloads", str(ctx.exception))
        self.assertEqual(self.runtime.requests, [])

    def test_every_verb_of_the_conceptual_api_exists(self) -> None:
        for verb in (
            "goto", "back", "forward", "reload", "observe", "find", "click", "type_",
            "press", "scroll", "drag", "extract", "screenshot", "tabs", "new_tab",
            "switch_tab", "close_tab", "download", "upload", "wait", "network",
            "task", "detach", "attach", "handoff", "close",
        ):
            with self.subTest(verb=verb):
                self.assertTrue(callable(getattr(Session, verb, None)), f"falta Session.{verb}")


# ─────────────────────────────────────────────────────────────────────────────
# 2. success=false vira NomosBrowserError com code preservado
# ─────────────────────────────────────────────────────────────────────────────


class TestErrorEnvelope(RuntimeTestCase):
    def test_failure_envelope_becomes_error_with_code_action_id_timing(self) -> None:
        self.runtime.on(
            "POST",
            "/api/v1/browser.click",
            envelope(
                success=False,
                code="CAPABILITY_DENIED",
                message="capability 'click' negada para esta sessão",
                detail={"required": "click"},
                action_id="act_denied_9",
                state="ACTIVE",
            ),
            status=403,  # docs/API.md: capability negada ⇒ 403 mantendo o envelope
        )
        session = self.browser.create_session()

        with self.assertRaises(NomosBrowserError) as ctx:
            session.click(text="Login")

        err = ctx.exception
        self.assertEqual(err.code, "CAPABILITY_DENIED")
        self.assertIn(err.code, ACTION_ERROR_CODES)
        self.assertTrue(err.known_code)
        self.assertEqual(err.action_id, "act_denied_9")
        self.assertEqual(err.state, "ACTIVE")
        self.assertEqual(err.http_status, 403)
        self.assertEqual(err.tool, "browser.click")
        self.assertEqual(err.detail, {"required": "click"})
        self.assertIsNotNone(err.timing)
        self.assertEqual(err.timing.duration_ms, 250)
        self.assertEqual(err.timing.started_at, "2026-08-24T10:00:01.000Z")
        self.assertIn("CAPABILITY_DENIED", str(err))

    def test_unknown_error_code_is_surfaced_not_swallowed(self) -> None:
        # Código fora do enum fechado é violação do servidor. O SDK entrega o
        # código como veio e marca known_code=False — esconder seria pior.
        self.runtime.on(
            "POST",
            "/api/v1/browser.goto",
            envelope(success=False, code="QUOTA_EXCEEDED", message="inventado"),
            status=500,
        )
        session = self.browser.create_session()
        with self.assertRaises(NomosBrowserError) as ctx:
            session.goto("https://example.com")
        self.assertEqual(ctx.exception.code, "QUOTA_EXCEEDED")
        self.assertFalse(ctx.exception.known_code)

    def test_success_false_without_error_code_is_a_protocol_violation(self) -> None:
        self.runtime.on(
            "POST",
            "/api/v1/browser.goto",
            {"success": False, "action_id": "a", "state": "ACTIVE", "result": None,
             "error": None, "timing": None},
        )
        session = self.browser.create_session()
        with self.assertRaises(NomosProtocolError):
            session.goto("https://example.com")

    def test_http_error_without_envelope_is_not_disguised_as_business_error(self) -> None:
        self.runtime.on("POST", "/api/v1/browser.goto", {"nginx": "bad gateway"}, status=502)
        session = self.browser.create_session()
        with self.assertRaises(NomosHttpError) as ctx:
            session.goto("https://example.com")
        self.assertEqual(ctx.exception.status, 502)


# ─────────────────────────────────────────────────────────────────────────────
# 3. click(text="Login") serializa target correto no corpo
# ─────────────────────────────────────────────────────────────────────────────


class TestTargetSerialization(RuntimeTestCase):
    def setUp(self) -> None:
        super().setUp()
        for tool in ("click", "find", "type", "drag", "scroll", "upload"):
            self.runtime.on("POST", f"/api/v1/browser.{tool}", envelope({}))
        self.session = self.browser.create_session()

    def body_of(self, tool: str) -> dict[str, Any]:
        entry = self.runtime.find("POST", f"/api/v1/browser.{tool}")
        self.assertIsNotNone(entry, f"browser.{tool} não foi chamado")
        return entry["body"]

    def test_click_by_text_serializes_only_that_field(self) -> None:
        self.session.click(text="Login")
        self.assertEqual(
            self.body_of("click"),
            {"session_id": SESSION_ID, "target": {"text": "Login"}},
        )

    def test_all_target_fields_serialize_with_contract_names(self) -> None:
        self.session.find(
            selector="#login",
            text="Login",
            role="button",
            label="Entrar",
            placeholder="usuário",
            semantic="o botão principal do formulário",
            coordinates=(120, 340),
            nth=2,
        )
        self.assertEqual(
            self.body_of("find")["target"],
            {
                "selector": "#login",
                "text": "Login",
                "role": "button",
                "label": "Entrar",
                "placeholder": "usuário",
                "semantic": "o botão principal do formulário",
                "coordinates": {"x": 120, "y": 340},
                "nth": 2,
            },
        )

    def test_none_fields_are_omitted_not_sent_as_null(self) -> None:
        self.session.click(role="button", text=None, selector=None)
        self.assertEqual(self.body_of("click")["target"], {"role": "button"})

    def test_empty_target_is_rejected_locally(self) -> None:
        with self.assertRaises(ValueError):
            self.session.click()

    def test_target_dict_and_loose_kwargs_together_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self.session.click(target={"role": "button"}, text="Login")

    def test_click_with_verification_spec(self) -> None:
        self.session.click(text="Login", verification={"kind": "URL_CHANGED", "expect": "/painel"})
        self.assertEqual(
            self.body_of("click")["verification"],
            {"kind": "URL_CHANGED", "expect": "/painel"},
        )

    def test_type_underscore_separates_typed_text_from_target_text(self) -> None:
        self.session.type_("nomos-operador", placeholder="usuário")
        self.assertEqual(
            self.body_of("type"),
            {
                "session_id": SESSION_ID,
                "target": {"placeholder": "usuário"},
                "text": "nomos-operador",
            },
        )

    def test_type_accepts_credential_ref_instead_of_text(self) -> None:
        self.session.type_(credential_ref="vault://senha-do-portal", selector="#pass")
        body = self.body_of("type")
        self.assertEqual(body["credential_ref"], "vault://senha-do-portal")
        self.assertNotIn("text", body)

    def test_type_requires_exactly_one_of_text_or_credential_ref(self) -> None:
        with self.assertRaises(ValueError):
            self.session.type_(selector="#pass")
        with self.assertRaises(ValueError):
            self.session.type_("segredo", credential_ref="vault://x", selector="#pass")

    def test_drag_maps_from_underscore_to_the_contract_key_from(self) -> None:
        self.session.drag(from_=target(selector="#a"), to=target(selector="#b"))
        body = self.body_of("drag")
        self.assertEqual(body["from"], {"selector": "#a"})
        self.assertEqual(body["to"], {"selector": "#b"})
        self.assertNotIn("from_", body)

    def test_unknown_target_field_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self.session.click(target={"css": "#login"})


# ─────────────────────────────────────────────────────────────────────────────
# 4. context manager fecha a sessão; detached_session NÃO fecha
# ─────────────────────────────────────────────────────────────────────────────


class TestContextManagerAsymmetry(RuntimeTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.runtime.on("POST", "/api/v1/browser.goto", envelope({"page_id": "page_1"}))

    def test_create_session_closes_on_exit(self) -> None:
        with self.browser.create_session() as session:
            session.goto("https://example.com")
            self.assertFalse(session.closed)
            self.assertTrue(session.closes_on_exit)
        self.assertIn(("DELETE", f"/api/v1/sessions/{SESSION_ID}"), self.runtime.paths())
        self.assertTrue(session.closed)
        self.assertEqual(session.info["status"], "CLOSED")

    def test_detached_session_does_not_close_on_exit(self) -> None:
        with self.browser.detached_session() as session:
            session.goto("https://example.com")
            self.assertFalse(session.closes_on_exit)
            kept_id = session.session_id

        paths = self.runtime.paths()
        # A prova negativa: DELETE nunca aconteceu. Sem esta asserção, "não fecha"
        # seria só uma frase.
        self.assertNotIn(("DELETE", f"/api/v1/sessions/{SESSION_ID}"), paths)
        # E a prova positiva: soltou o cliente pela rota que mantém a sessão viva.
        self.assertIn(("POST", f"/api/v1/sessions/{SESSION_ID}/detach"), paths)
        self.assertFalse(session.closed)
        self.assertEqual(kept_id, SESSION_ID)

    def test_exception_inside_block_still_closes_and_propagates(self) -> None:
        with self.assertRaises(ZeroDivisionError):
            with self.browser.create_session():
                raise ZeroDivisionError("falha do chamador")
        self.assertIn(("DELETE", f"/api/v1/sessions/{SESSION_ID}"), self.runtime.paths())

    def test_close_is_idempotent_and_does_not_re_hit_the_network(self) -> None:
        session = self.browser.create_session()
        session.close()
        session.close()
        deletes = [p for p in self.runtime.paths() if p[0] == "DELETE"]
        self.assertEqual(len(deletes), 1)

    def test_action_after_close_fails_locally_without_faking_a_server_verdict(self) -> None:
        session = self.browser.create_session()
        session.close()
        with self.assertRaises(SessionClosedError):
            session.goto("https://example.com")
        self.assertNotIn(("POST", "/api/v1/browser.goto"), self.runtime.paths())

    def test_attach_session_binds_to_an_existing_session_and_never_closes_it(self) -> None:
        self.runtime.on("POST", f"/api/v1/sessions/{SESSION_ID}/attach", session_info())
        with self.browser.attach_session(SESSION_ID, client="outro-agente") as session:
            self.assertEqual(session.session_id, SESSION_ID)
        paths = self.runtime.paths()
        self.assertIn(("POST", f"/api/v1/sessions/{SESSION_ID}/attach"), paths)
        self.assertNotIn(("DELETE", f"/api/v1/sessions/{SESSION_ID}"), paths)
        self.assertEqual(
            self.runtime.find("POST", f"/api/v1/sessions/{SESSION_ID}/attach")["body"],
            {"client": "outro-agente"},
        )


# ─────────────────────────────────────────────────────────────────────────────
# Extras: rotas de gestão e as regras que docs/API.md impõe ao wait
# ─────────────────────────────────────────────────────────────────────────────


class TestManagementAndWait(RuntimeTestCase):
    def test_health_and_list_sessions_return_the_object_not_the_envelope(self) -> None:
        health = {
            "runtime": "ok", "browser": "ok", "workers": {"active": 0, "max": 4},
            "sessions": {"total": 1, "active": 1, "idle": 0, "paused": 0},
            "version": "0.2.0-rc.1", "contract": "1", "uptime_s": 12,
        }
        self.runtime.on("GET", "/health", health)
        self.runtime.on("GET", "/api/v1/sessions", [session_info()])
        self.assertEqual(self.browser.health(), health)
        self.assertEqual(self.browser.list_sessions()[0]["session_id"], SESSION_ID)

    def test_handoff_sends_to_owner_and_updates_local_info(self) -> None:
        self.runtime.on(
            "POST", f"/api/v1/sessions/{SESSION_ID}/handoff", session_info(owner="outro-dono")
        )
        session = self.browser.create_session()
        info = session.handoff("outro-dono")
        self.assertEqual(info["owner"], "outro-dono")
        self.assertEqual(
            self.runtime.find("POST", f"/api/v1/sessions/{SESSION_ID}/handoff")["body"],
            {"to_owner": "outro-dono"},
        )

    def test_wait_rejects_a_fixed_duration(self) -> None:
        # docs/API.md: browser.wait não aceita duração como condição principal.
        session = self.browser.create_session()
        with self.assertRaises(ValueError) as ctx:
            session.wait(3000)
        self.assertIn("duração", str(ctx.exception))

    def test_wait_accepts_a_documented_condition(self) -> None:
        self.runtime.on("POST", "/api/v1/browser.wait", envelope({"waited_ms": 120}))
        session = self.browser.create_session()
        self.assertEqual(session.wait("network_idle", timeout_ms=5000), {"waited_ms": 120})
        self.assertEqual(
            self.runtime.find("POST", "/api/v1/browser.wait")["body"],
            {"session_id": SESSION_ID, "condition": "network_idle", "timeout_ms": 5000},
        )

    def test_session_id_with_slash_cannot_forge_another_route(self) -> None:
        forged = "sess/../../health"
        self.runtime.on("POST", "/api/v1/sessions", session_info(session_id=forged), status=201)
        self.runtime.on("DELETE", "/api/v1/sessions/sess%2F..%2F..%2Fhealth", {"closed": True})
        session = self.browser.create_session()
        session.close()
        self.assertIn(
            ("DELETE", "/api/v1/sessions/sess%2F..%2F..%2Fhealth"), self.runtime.paths()
        )

    def test_transport_failure_is_not_confused_with_a_business_error(self) -> None:
        dead = NomosBrowser("http://127.0.0.1:1", timeout=2.0)
        from nomos_browser import NomosTransportError

        with self.assertRaises(NomosTransportError):
            dead.health()


if __name__ == "__main__":  # pragma: no cover
    unittest.main(verbosity=2)
