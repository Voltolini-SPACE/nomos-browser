"""Barge-in no caminho CANÔNICO (manifesto registrado no NOMOS).

O DEFEITO QUE ESTES TESTES EXISTEM PARA IMPEDIR (observado, não hipotético):
``gi_nomos.browser.executar`` tem duas portas. A Porta 2 (manifesto ainda
experimental) sempre honrou ``cancelar`` — quem olhava o evento era o
``_ClienteStdio``. A Porta 1 (manifesto REGISTRADO, isto é, produção) chamava
``subprocess.run(...)``, que bloqueia até o fim e ignora o evento. Resultado: no
dia em que o dono registra o manifesto — e só nesse dia — o barge-in some. A Gi
continuaria executando a ação de navegador depois de o dono mandar parar.

Verbatim do run que pegou o defeito, com o manifesto já registrado:

    [FALHA] 10. cancelamento — ... status=EXECUTADO via=nomos-mcp

Os testes abaixo não usam o NOMOS real: trocam ``NOMOS_BIN`` por um script que
demora de propósito, para que a janela de cancelamento seja determinística.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time

import pytest

from gi_nomos import browser as B


@pytest.fixture()
def nomos_lento(tmp_path, monkeypatch):
    """Um 'nomos' falso que dorme, e um 'neto' que ele deixa rodando.

    O neto existe para provar a parte que o ``kill`` ingênuo erra: o
    ``nomos mcp chamar`` gera ``node servidor.mjs``, e matar só o pai deixaria o
    filho segurando a sessão do runtime.
    """
    marca = tmp_path / "neto-vivo.txt"
    neto = tmp_path / "neto.sh"
    neto.write_text(
        "#!/bin/sh\n"
        f"while true; do echo vivo > '{marca}'; sleep 0.2; done\n",
        encoding="utf-8")
    neto.chmod(0o755)

    falso = tmp_path / "nomos-falso.sh"
    falso.write_text(
        "#!/bin/sh\n"
        f"'{neto}' &\n"
        "sleep 30\n"
        "echo 'nao deveria chegar aqui'\n",
        encoding="utf-8")
    falso.chmod(0o755)
    monkeypatch.setattr(B, "NOMOS_BIN", str(falso))
    return {"marca": marca}


@pytest.fixture()
def manifesto_registrado(monkeypatch):
    """Força a Porta 1 sem depender do catálogo real do dono."""
    monkeypatch.setattr(B, "veredito", lambda tool, m=None: {
        "nivel": "A0", "categoria": "A0_READ_LOCAL",
        "alvo": f"mcp:nomos-browser:{tool}", "veredito": "ALLOW",
        "saida_nomos": "ALLOW — permitido pela política"})
    monkeypatch.setattr(B, "registrado", lambda m=None: True)
    monkeypatch.setattr(B, "carregar_manifesto", lambda: {
        "nome": "nomos-browser", "comando": ["node", "servidor.mjs"],
        "nivel_padrao": "A5", "tools": {"browser_tabs": "A0"},
        "_ok": True, "_origem": "/tmp/manifesto-de-teste.json"})


def test_porta_canonica_honra_cancelar(nomos_lento, manifesto_registrado):
    """Evento JÁ setado ⇒ CANCELADO, e rápido: não espera os 30 s do falso."""
    parar = threading.Event()
    parar.set()
    t0 = time.monotonic()
    r = B.executar("browser_tabs", {}, cancelar=parar, timeout_s=30)
    decorrido = time.monotonic() - t0

    assert r["status"] == "CANCELADO", r
    assert r["via"] == "nomos-mcp", r
    assert r["ok"] is False
    assert decorrido < 5, f"demorou {decorrido:.1f}s — não cancelou, esperou"


def test_cancelamento_no_meio_da_chamada(nomos_lento, manifesto_registrado):
    """Barge-in de verdade: o evento chega DEPOIS de a chamada começar."""
    parar = threading.Event()
    threading.Timer(1.0, parar.set).start()
    t0 = time.monotonic()
    r = B.executar("browser_tabs", {}, cancelar=parar, timeout_s=30)
    decorrido = time.monotonic() - t0

    assert r["status"] == "CANCELADO", r
    assert 0.5 < decorrido < 6, f"decorrido={decorrido:.1f}s"


def test_cancelamento_derruba_a_arvore_nao_so_o_pai(nomos_lento, manifesto_registrado):
    """O neto do processo também morre — senão a sessão do runtime fica presa."""
    marca = nomos_lento["marca"]
    parar = threading.Event()
    threading.Timer(1.0, parar.set).start()
    B.executar("browser_tabs", {}, cancelar=parar, timeout_s=30)

    assert marca.exists(), "o neto nem chegou a rodar — o teste não provaria nada"
    marca.unlink()
    time.sleep(1.0)          # o neto reescreveria a marca a cada 0,2 s se vivo
    assert not marca.exists(), "o NETO continuou vivo depois do cancelamento"


def test_sem_cancelar_o_comportamento_nao_muda(nomos_lento, manifesto_registrado):
    """Controle: sem evento, a chamada segue até o prazo e vira INDISPONIVEL.

    Sem este controle, um `executar` que cancelasse SEMPRE passaria nos três
    testes acima e ninguém notaria.
    """
    t0 = time.monotonic()
    r = B.executar("browser_tabs", {}, cancelar=None, timeout_s=2)
    decorrido = time.monotonic() - t0

    assert r["status"] == "INDISPONIVEL", r
    assert "não respondeu" in (r.get("motivo") or "")
    assert decorrido >= 1.8, f"saiu antes do prazo: {decorrido:.1f}s"
