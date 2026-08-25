#!/usr/bin/env python3
"""FASE 8 — PROVA DO CAMINHO Gi → NOMOS → NOMOS Browser → Chromium → Gi.

Escrito em Python, e não em TypeScript, porque a Gi é Python: o que se quer
provar é o módulo `gi_nomos.browser` REAL sendo exercitado do jeito que o
dispatcher da Gi o exercitaria — não uma reimplementação em outra linguagem que
poderia divergir dele sem ninguém notar.

O que este arquivo mede, caso a caso:
  • DESCOBERTA  — a Gi enumera as tools e a CATEGORIA de cada uma vem do
                  manifesto que o dono registra, nunca de uma escolha local;
  • CONSULTA    — veredito do NOMOS pedido e registrado para cada ação;
  • NAVEGAÇÃO / CLIQUE / FORMULÁRIO — A2: o NOMOS responde REQUIRE_APPROVAL e a
                  Gi NÃO EXECUTA. Isso é o produto certo, não uma falha — e o
                  teste prova que nada aconteceu, comparando o estado do
                  navegador antes e depois;
  • EXTRAÇÃO    — A0: roda de ponta a ponta contra Chromium real;
  • VISÃO       — A0: captura real, referência de imagem de volta;
  • ERRO        — argumento inválido volta como erro, não como sucesso vazio;
  • CANCELAMENTO— chamada abandonada derruba o conector e vira CANCELADO;
  • INTEGRAÇÃO  — a sessão do runtime sobrevive entre processos one-shot.

NADA aqui aprova coisa alguma no lugar do dono. Onde o consentimento falta, o
caso imprime BLOQUEADO_POR_APROVACAO com o comando exato que falta.

Uso: python3 evidence/nomos-browser-final-loop/08-gi/e2e-gi.py
"""
from __future__ import annotations

import http.server
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parents[2]                       # .../nomos-browser
GI_BACKEND = Path(os.environ.get("GI_BACKEND", "/Users/AI/Projects/pocket-assistant/backend"))
DAEMON_TS = RAIZ / "packages/api/src/daemon.ts"

sys.path.insert(0, str(GI_BACKEND))

MARCA = "GI-NOMOS-BROWSER-E2E"
PAGINA = (f"<!doctype html><html lang='pt-BR'><head><meta charset='utf-8'>"
          f"<title>Fixture da Gi</title></head><body><h1>{MARCA}</h1>"
          f"<input id='campo' placeholder='Digite'><button id='b'>Enviar</button>"
          f"</body></html>").encode("utf-8")

# ─────────────────────────────────────────────────────────────────────────────
# Placar
# ─────────────────────────────────────────────────────────────────────────────
FALHAS = 0
MARCADORES: dict[str, str] = {}


def caso(nome: str, ok: bool, detalhe: str) -> bool:
    global FALHAS
    if not ok:
        FALHAS += 1
    print(f"[{'PASS' if ok else 'FALHA'}] {nome} — {detalhe}", flush=True)
    return ok


def veredito_linha(r: dict) -> str:
    return (f"veredito_NOMOS={r.get('veredito')} categoria={r.get('categoria')} "
            f"status={r.get('status')} via={r.get('via') or '-'}")


# ─────────────────────────────────────────────────────────────────────────────
# Fixture e daemon reais
# ─────────────────────────────────────────────────────────────────────────────
class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):                                    # noqa: N802
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(PAGINA)))
        self.end_headers()
        self.wfile.write(PAGINA)

    def log_message(self, *a):                           # silêncio
        return


def subir_fixture():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/", srv


def subir_daemon(runtime_dir: Path, perfis: Path, sessoes: Path):
    env = dict(os.environ)
    env.update({"NOMOS_RUNTIME_DIR": str(runtime_dir), "NOMOS_BROWSER_PORT": "0",
                "NOMOS_BROWSER_HOST": "127.0.0.1", "NOMOS_BROWSER_HEADLESS": "true",
                "NOMOS_BROWSER_ALLOW_INTERNAL": "true",
                "NOMOS_BROWSER_PROFILES_ROOT": str(perfis),
                "NOMOS_SESSIONS_ROOT": str(sessoes)})
    env.pop("NOMOS_BROWSER_CONFIG", None)
    proc = subprocess.Popen(["node", str(DAEMON_TS)], cwd=str(RAIZ),
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                            text=True, env=env)
    url, buf, prazo = None, "", time.monotonic() + 90
    while time.monotonic() < prazo:
        linha = proc.stderr.readline()
        if linha == "" and proc.poll() is not None:
            raise RuntimeError(f"daemon saiu: {buf[-1200:]}")
        buf += linha
        m = re.search(r"nomos-browser em (http://\S+)", buf)
        if m:
            url = m.group(1)
            break
    if url is None:
        proc.kill()
        raise RuntimeError(f"daemon não subiu em 90s: {buf[-1200:]}")
    # Drena stderr para o daemon não travar no pipe cheio.
    threading.Thread(target=lambda: [None for _ in proc.stderr], daemon=True).start()
    token = (runtime_dir / "control-token").read_text(encoding="utf-8").strip()
    return url, token, proc


# ─────────────────────────────────────────────────────────────────────────────
# A bateria
# ─────────────────────────────────────────────────────────────────────────────
def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="gi-e2e-"))
    runtime_dir, perfis, sessoes = tmp / "rt", tmp / "perfis", tmp / "sess"
    for d in (runtime_dir, perfis, sessoes):
        d.mkdir(parents=True, exist_ok=True)
    url_fixture, fixture = subir_fixture()
    daemon = None
    try:
        url, token, daemon = subir_daemon(runtime_dir, perfis, sessoes)
        print(f"# daemon real em {url}")
        # O módulo da Gi repassa o ambiente do processo ao conector — é assim que
        # o dono também vai configurar (ver docs/GI-INTEGRATION.md).
        os.environ["NOMOS_BROWSER_URL"] = url
        os.environ["NOMOS_BROWSER_TOKEN"] = token

        from gi_nomos import browser as B          # importado DEPOIS do ambiente

        # ── 1. DESCOBERTA ────────────────────────────────────────────────────
        d = B.descobrir()
        tools = {t["tool"]: t for t in d["tools"]}
        a0 = {"browser_observe", "browser_find", "browser_extract", "browser_tabs",
              "browser_screenshot"}
        a2 = {"browser_navigate", "browser_click", "browser_type", "browser_press",
              "browser_scroll", "browser_download", "browser_upload"}
        classificacao_ok = (
            len(tools) == 13
            and all(tools[t]["categoria"] == "A0_READ_LOCAL" for t in a0)
            and all(tools[t]["categoria"] == "A2_NET_EGRESS" for t in a2)
            and tools["browser_task"]["categoria"] == "A5_CODE_EXEC")
        ok_desc = caso(
            "1. descoberta — 13 tools, categoria vinda do MANIFESTO registrado",
            classificacao_ok and d["manifesto_valido"],
            f"manifesto={d['manifesto']} impressao={str(d['impressao'])[:16]}… "
            f"registrado_no_nomos={d['registrado']}")
        vereditos = {t: tools[t]["veredito"] for t in sorted(tools)}
        ok_consulta = caso(
            "2. consulta — o veredito de CADA tool veio do NOMOS, não daqui",
            all(v in ("ALLOW", "REQUIRE_APPROVAL", "DENY") for v in vereditos.values())
            and all(vereditos[t] == "ALLOW" for t in a0)
            and all(vereditos[t] == "REQUIRE_APPROVAL" for t in a2)
            and vereditos["browser_task"] == "REQUIRE_APPROVAL",
            "ALLOW=" + ",".join(sorted(t for t, v in vereditos.items() if v == "ALLOW"))
            + " | REQUIRE_APPROVAL=" + str(sum(1 for v in vereditos.values()
                                               if v == "REQUIRE_APPROVAL")))
        caso("2b. fail-closed — tool que o manifesto NÃO declara cai em A5, nunca A0",
             B.categoria_da_tool("browser_tool_que_nao_existe") == "A5_CODE_EXEC",
             f"browser_tool_que_nao_existe → {B.categoria_da_tool('browser_tool_que_nao_existe')}")

        # ── 3. ESTADO ANTES (A0, executa) ────────────────────────────────────
        antes = B.executar("browser_tabs", {})
        sid = antes.get("session_id")
        ok_a0 = caso("3. consulta A0 — browser_tabs roda headless, sem incomodar o dono",
                     antes["ok"] and antes["status"] == "EXECUTADO" and sid,
                     f"{veredito_linha(antes)} session_id={sid}")
        url_antes = antes.get("texto", "")

        # ── 4. NAVEGAÇÃO (A2) — TEM de ser bloqueada ─────────────────────────
        nav = B.executar("browser_navigate", {"url": url_fixture, "session_id": sid})
        ok_nav = caso(
            "4. navegação A2 — NOMOS exige o dono e a Gi NÃO executa",
            nav["status"] == "BLOQUEADO_POR_APROVACAO" and not nav["ok"]
            and nav["veredito"] == "REQUIRE_APPROVAL" and nav.get("texto", "") == "",
            veredito_linha(nav))
        # CONTROLE: se a navegação tivesse escapado, a aba teria mudado de URL.
        depois = B.executar("browser_tabs", {"session_id": sid})
        ok_nada = caso(
            "4b. controle — o navegador NÃO se moveu: nenhuma navegação vazou o gate",
            depois["ok"] and MARCA not in depois.get("texto", "")
            and (url_fixture.rstrip("/") not in depois.get("texto", "")),
            f"aba continua em about:blank={'about:blank' in depois.get('texto','')} "
            f"fixture_presente={url_fixture.rstrip('/') in depois.get('texto','')}")

        # ── 5. CLIQUE e FORMULÁRIO (A2) ──────────────────────────────────────
        clique = B.executar("browser_click", {"target": {"selector": "#b"}, "session_id": sid})
        ok_clique = caso("5. clique A2 — bloqueado por política, com o motivo do NOMOS",
                         clique["status"] == "BLOQUEADO_POR_APROVACAO" and not clique["ok"],
                         veredito_linha(clique))
        form = B.executar("browser_type", {"target": {"selector": "#campo"},
                                           "text": "nomos", "session_id": sid})
        ok_form = caso("6. formulário A2 — bloqueado por política (digitação é egresso)",
                       form["status"] == "BLOQUEADO_POR_APROVACAO" and not form["ok"],
                       veredito_linha(form))
        caso("6b. a recusa carrega o comando EXATO que falta ao dono",
             bool(form.get("falta")) and "mcp chamar" in form["falta"],
             (form.get("falta") or "")[:110])

        # ── 7. EXTRAÇÃO (A0) — o loop completo até o Chromium ────────────────
        ext = B.executar("browser_extract", {"format": "text", "session_id": sid})
        ok_ext = caso(
            "7. extração A0 — Gi → NOMOS → MCP → API v1 → Chromium → resultado",
            ext["ok"] and ext["status"] == "EXECUTADO" and '"scope"' in ext.get("texto", "")
            and ext.get("session_id") == sid,
            f"{veredito_linha(ext)} envelope={'\"provenance\"' in ext.get('texto','')}")

        # ── 8. VISÃO (A0) ────────────────────────────────────────────────────
        visao = B.executar("browser_screenshot", {"scope": "viewport", "session_id": sid})
        tv = visao.get("texto", "")
        ok_visao = caso(
            "8. visão A0 — captura real da página aberta, referência de volta",
            visao["ok"] and visao["status"] == "EXECUTADO"
            and ("screenshot_ref" in tv or "screenshot" in tv),
            f"{veredito_linha(visao)} ref={'screenshot_ref' in tv}")

        # ── 9. ERRO ──────────────────────────────────────────────────────────
        erro = B.executar("browser_extract", {"formatoo": "text", "session_id": sid})
        ok_erro = caso(
            "9. erro — argumento inválido vira falha explícita, não sucesso vazio",
            (not erro["ok"]) and erro["status"] in ("INDISPONIVEL", "EXECUTADO")
            and ("desconhecido" in (erro.get("motivo") or "")
                 or "NOMOS_BROWSER_ERROR" in erro.get("texto", "")),
            f"status={erro['status']} motivo={(erro.get('motivo') or '')[:80]}")
        caso("9b. controle — o MESMO caminho com argumento válido deu ok",
             ext["ok"] and not erro["ok"],
             f"extract_valido.ok={ext['ok']} extract_invalido.ok={erro['ok']}")

        # ── 10. CANCELAMENTO ─────────────────────────────────────────────────
        # Evento JÁ setado: o resultado é determinístico, e é exatamente o que a
        # Gi faz num barge-in — abandona a chamada em voo e derruba o conector.
        parar = threading.Event()
        parar.set()
        canc = B.executar("browser_extract", {"session_id": sid}, cancelar=parar)
        ok_canc = caso(
            "10. cancelamento — chamada abandonada derruba o conector e vira CANCELADO",
            canc["status"] == "CANCELADO" and not canc["ok"],
            f"{veredito_linha(canc)} motivo={(canc.get('motivo') or '')[:70]}")

        # ── 11. INTEGRAÇÃO — a sessão sobrevive entre processos one-shot ─────
        de_novo = B.executar("browser_tabs", {"session_id": sid})
        ok_int = caso(
            "11. integração — cada chamada é um processo NOVO e a sessão continua",
            de_novo["ok"] and de_novo.get("session_id") == sid,
            f"session_id 1ª={sid} · última={de_novo.get('session_id')}")

        # ── 12. o dispatcher da Gi aceita o registro (sem ligar no serviço) ──
        from gi_nomos.dispatcher import NomosDispatcher
        disp = NomosDispatcher()
        nomes = B.registrar(disp)
        cat_reg = {c: disp._caps[c].category for c in nomes}          # noqa: SLF001
        ok_reg = caso(
            "12. integração — registrar() usa a categoria DO MANIFESTO no dispatcher",
            set(nomes) == {"navegador_ler", "navegador_abas", "navegador_ver", "navegador_abrir"}
            and cat_reg["navegador_ler"] == "A0" and cat_reg["navegador_abrir"] == "A2",
            json.dumps(cat_reg, ensure_ascii=False))
        r_disp = disp.dispatch("navegador_abas", {}, tool_call_id="tc-1")
        ok_disp = caso(
            "12b. integração — despacho real pela Gi devolve o veredito junto do resultado",
            r_disp["status"] == "OK" and r_disp["result"]["veredito"] == "ALLOW"
            and r_disp["result"]["categoria"] == "A0_READ_LOCAL",
            f"tool=navegador_abas → {r_disp['result']['status']} / {r_disp['result']['veredito']}")
        r_bloq = disp.dispatch("navegador_abrir", {"url": url_fixture}, tool_call_id="tc-2")
        ok_disp2 = caso(
            "12c. integração — a tool A2 pela Gi para no gate do NOMOS, não no navegador",
            r_bloq["result"]["status"] == "BLOQUEADO_POR_APROVACAO"
            and r_bloq["result"]["veredito"] == "REQUIRE_APPROVAL",
            f"tool=navegador_abrir → {r_bloq['result']['status']}")

        MARCADORES["GI_BROWSER_DISCOVERY"] = "PASS" if (ok_desc and ok_consulta) else "FAIL"
        MARCADORES["GI_BROWSER_ACTION"] = (
            "BLOQUEADO_POR_APROVACAO" if (ok_nav and ok_nada and ok_clique and ok_form)
            else "FAIL")
        MARCADORES["GI_BROWSER_RESULT"] = "PASS" if (ok_a0 and ok_ext and ok_erro and ok_canc) else "FAIL"
        MARCADORES["GI_BROWSER_VISION"] = "PASS" if ok_visao else "FAIL"
        MARCADORES["GI_BROWSER_INTEGRATION"] = (
            "PASS" if (ok_int and ok_reg and ok_disp and ok_disp2) else "FAIL")
    except Exception as exc:                                   # noqa: BLE001
        caso("XX execução da bateria", False, f"{type(exc).__name__}: {exc}")
        for k in ("GI_BROWSER_DISCOVERY", "GI_BROWSER_ACTION", "GI_BROWSER_RESULT",
                  "GI_BROWSER_VISION", "GI_BROWSER_INTEGRATION"):
            MARCADORES.setdefault(k, "FAIL")
    finally:
        if daemon is not None:
            daemon.terminate()
            try:
                daemon.wait(timeout=15)
            except Exception:
                daemon.kill()
        fixture.shutdown()
        import shutil as _sh
        _sh.rmtree(tmp, ignore_errors=True)

    print()
    print("# A2/A5 aparecem como BLOQUEADO_POR_APROVACAO porque o dono ainda não")
    print("# aprovou — esse É o comportamento correto: o NOMOS é a autoridade.")
    print(f"casos_com_falha={FALHAS}")
    for k in ("GI_BROWSER_DISCOVERY", "GI_BROWSER_ACTION", "GI_BROWSER_RESULT",
              "GI_BROWSER_VISION", "GI_BROWSER_INTEGRATION"):
        print(f"{k}={MARCADORES.get(k, 'FAIL')}")
    return 0 if FALHAS == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
