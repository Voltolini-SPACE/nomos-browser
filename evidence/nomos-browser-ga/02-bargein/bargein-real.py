#!/usr/bin/env python3
"""FASE 2 — BARGE-IN NO CAMINHO PRIVILEGIADO, CONTRA O NOMOS E O RUNTIME REAIS.

Os testes unitários provam a mecânica com um `nomos` falso. Aqui não há falso
nenhum: binário do dono, manifesto registrado, daemon de verdade, Chromium de
verdade. O que se mede é o único invariante que importa num barge-in:

    A RESPOSTA QUE A Gi DÁ AO DONO TEM DE BATER COM O QUE O RUNTIME REGISTROU.

Isto é mais forte do que "cancelou". Um cancelamento é honesto quando:
  · disse CANCELADO  ⇒  a trilha do runtime NÃO ganhou a ação;
  · disse EXECUTADO  ⇒  a trilha GANHOU a ação, e a resposta admite
                        `cancelamento_tardio=True`.
Qualquer outro par é mentira — e é o par que o código ingênuo produzia.

O atraso do cancelamento é varrido de propósito (0 a 500 ms), porque a janela
interessante não está num ponto: ela cruza o arranque do `nomos`, a ida ao
runtime e a volta. Varrer é o que faz o teste encostar nos três.

Roda com daemon e RUNTIME_DIR próprios, para não encostar na sessão que o gate
humano A1 está usando.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[3]
sys.path.insert(0, "/Users/AI/Projects/pocket-assistant/backend")

PORTA = int(os.environ.get("PORTA_BARGEIN", "7788"))
RUNTIME_DIR = Path("/tmp/ga-bargein-runtime")
SESSOES = Path("/tmp/ga-bargein-sessoes")
ATRASOS_MS = [0, 60, 120, 180, 240, 300, 360, 420, 480, 540]


def linhas_da_trilha(sid: str) -> list[dict]:
    p = SESSOES / sid / "actions.jsonl"
    if not p.exists():
        return []
    fora = []
    for l in p.read_text(encoding="utf-8").splitlines():
        l = l.strip()
        if not l:
            continue
        try:
            fora.append(json.loads(l))
        except Exception:
            pass
    return fora


def acoes_de_navegador(linhas: list[dict]) -> list[str]:
    return [l.get("action", "") for l in linhas if str(l.get("action", "")).startswith("browser.")]


def main() -> int:
    for d in (RUNTIME_DIR, SESSOES):
        d.mkdir(parents=True, exist_ok=True)

    env = {**os.environ,
           "NOMOS_BROWSER_PORT": str(PORTA),
           "NOMOS_BROWSER_HEADLESS": "true",
           "NOMOS_RUNTIME_DIR": str(RUNTIME_DIR),
           "NOMOS_SESSIONS_ROOT": str(SESSOES)}
    daemon = subprocess.Popen(
        ["node", "packages/api/src/daemon.ts"], cwd=str(RAIZ), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    print(f"# daemon proprio em :{PORTA} (pid {daemon.pid}) runtime_dir={RUNTIME_DIR}")

    token = ""
    prazo = time.monotonic() + 25
    alvo = RUNTIME_DIR / "control-token"
    while time.monotonic() < prazo:
        if alvo.exists() and alvo.read_text().strip():
            token = alvo.read_text().strip()
            break
        time.sleep(0.3)
    if not token:
        print("ABORTADO: daemon nao publicou credencial")
        daemon.kill()
        return 2

    os.environ["NOMOS_BROWSER_URL"] = f"http://127.0.0.1:{PORTA}"
    os.environ["NOMOS_BROWSER_TOKEN"] = token
    os.environ["NOMOS_BROWSER_TOKEN_FILE"] = str(alvo)
    os.environ["NOMOS_BROWSER_RUNTIME_DIR"] = str(RUNTIME_DIR)
    os.environ["NOMOS_BROWSER_HEADLESS"] = "1"

    from gi_nomos import browser as B          # depois do ambiente, como a Gi faz

    trilha_eventos: list[dict] = []
    B.ligar_auditoria(lambda ev, **c: trilha_eventos.append({"evento": ev, **c}))

    # Aquece: cria a sessao MCP e descobre o session_id.
    inicial = B.executar("browser_tabs", {})
    if inicial.get("status") != "EXECUTADO":
        print(f"ABORTADO: nem a chamada de aquecimento passou: {inicial}")
        daemon.kill()
        return 2
    sid = inicial.get("session_id") or ""
    print(f"# sessao MCP: {sid}")
    print(f"# registrado_no_nomos={inicial.get('registrado')} via={inicial.get('via')}")
    if not inicial.get("registrado"):
        print("ABORTADO: o manifesto nao esta registrado — este teste mede a PORTA 1")
        daemon.kill()
        return 2

    cancelados = executados_tardios = incoerentes = 0
    print()
    print(f"{'atraso':>7}  {'status':<12} {'tardio':<7} {'acoes novas':<12} veredito")
    print("-" * 62)
    for atraso in ATRASOS_MS:
        antes = len(acoes_de_navegador(linhas_da_trilha(sid)))
        trilha_eventos.clear()
        parar = threading.Event()
        if atraso == 0:
            parar.set()
        else:
            threading.Timer(atraso / 1000.0, parar.set).start()

        r = B.executar("browser_observe", {"accessibility": True},
                       cancelar=parar, timeout_s=30)
        time.sleep(0.4)                        # deixa a trilha assentar
        novas = len(acoes_de_navegador(linhas_da_trilha(sid))) - antes

        st = r.get("status")
        tardio = bool(r.get("cancelamento_tardio"))
        if st == "CANCELADO":
            ok = (novas == 0)
            if ok:
                cancelados += 1
        elif st == "EXECUTADO" and tardio:
            ok = (novas >= 1)
            if ok:
                executados_tardios += 1
        elif st == "EXECUTADO" and not tardio:
            # O cancelamento nunca foi observado (chegou depois de tudo). A
            # resposta e' honesta desde que a acao esteja na trilha.
            ok = (novas >= 1)
        else:
            ok = False
        if not ok:
            incoerentes += 1
        print(f"{atraso:>5}ms  {st:<12} {str(tardio):<7} {novas:<12} "
              f"{'coerente' if ok else 'INCOERENTE <<<'}")
        if not ok:
            print(f"         resposta={json.dumps({k: r.get(k) for k in ('status','motivo','texto')}, ensure_ascii=False)[:200]}")
            print(f"         eventos={[e['evento'] for e in trilha_eventos]}")

    # ── residuo ─────────────────────────────────────────────────────────────
    time.sleep(1)
    def conta(padrao: str) -> int:
        r = subprocess.run(["pgrep", "-fc", padrao], capture_output=True, text=True)
        try:
            return int(r.stdout.strip() or "0")
        except ValueError:
            return 0
    residual_nomos = conta("nomos mcp chamar")
    residual_node = conta(f"servidor.mjs")

    daemon.terminate()
    try:
        daemon.wait(timeout=10)
    except subprocess.TimeoutExpired:
        daemon.kill()

    print()
    print(f"CANCELADOS_COERENTES={cancelados}")
    print(f"EXECUTADOS_TARDIOS_COERENTES={executados_tardios}")
    print(f"INCOERENTES={incoerentes}")
    print(f"POST_CANCEL_ACTIONS={0 if incoerentes == 0 else 'INDETERMINADO'}")
    print(f"PROCESS_RESIDUAL_NOMOS={residual_nomos}")
    print(f"PROCESS_RESIDUAL_SERVIDOR_MCP={residual_node}")
    verde = (incoerentes == 0 and cancelados >= 1
             and residual_nomos == 0 and residual_node == 0)
    print(f"REGISTERED_PATH_CANCEL={'PASS' if cancelados >= 1 and incoerentes == 0 else 'FAIL'}")
    print(f"BARGE_IN_PRODUCTION_PATH={'PASS' if verde else 'FAIL'}")
    return 0 if verde else 1


if __name__ == "__main__":
    raise SystemExit(main())
