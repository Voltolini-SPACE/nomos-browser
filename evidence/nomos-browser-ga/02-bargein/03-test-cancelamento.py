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


# ─────────────────────────────────────────────────────────────────────────────
# A TRILHA DO BARGE-IN
#
# Um cancelamento sem trilha é indistinguível de uma falha, e as duas coisas
# pedem reações opostas: uma é o dono no controle, a outra é o produto quebrado.
# Estes testes exigem que a trilha separe TRÊS momentos — pedido, aceito,
# terminado — e, principalmente, que ela saiba dizer quando o pedido chegou
# TARDE DEMAIS.
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture()
def trilha(monkeypatch):
    linhas = []
    B.ligar_auditoria(lambda evento, **campos: linhas.append({"evento": evento, **campos}))
    yield linhas
    B.ligar_auditoria(None)


def eventos(linhas):
    return [l["evento"] for l in linhas]


def test_trilha_separa_pedido_aceite_e_terminacao(nomos_lento, manifesto_registrado, trilha):
    parar = threading.Event()
    threading.Timer(1.0, parar.set).start()
    r = B.executar("browser_tabs", {}, cancelar=parar, timeout_s=30)

    assert r["status"] == "CANCELADO"
    evs = eventos(trilha)
    for esperado in ("browser.cancel.requested",
                     "browser.cancel.accepted",
                     "browser.cancel.terminated"):
        assert esperado in evs, f"faltou {esperado} em {evs}"
    # E na ORDEM: aceitar antes de pedir seria trilha inventada.
    assert (evs.index("browser.cancel.requested")
            < evs.index("browser.cancel.accepted")
            < evs.index("browser.cancel.terminated"))


def test_terminated_diz_se_o_grupo_morreu_mesmo(nomos_lento, manifesto_registrado, trilha):
    """`terminated` sem prova de morte seria otimismo com cara de auditoria."""
    parar = threading.Event()
    threading.Timer(1.0, parar.set).start()
    B.executar("browser_tabs", {}, cancelar=parar, timeout_s=30)

    fim = next(l for l in trilha if l["evento"] == "browser.cancel.terminated")
    assert fim["grupo_ainda_vivo"] is False, fim
    assert fim["gid"] is not None and fim["pid"] > 0
    assert "SIGTERM" in fim["sinais"] or "SIGKILL" in fim["sinais"], fim


@pytest.fixture()
def nomos_instantaneo(tmp_path, monkeypatch):
    """Um 'nomos' que responde NA HORA e anuncia o próprio PID ao sair."""
    marca = tmp_path / "pid-do-filho.txt"
    falso = tmp_path / "nomos-rapido.sh"
    # O `nomos` real gera `node servidor.mjs` e sai. O neto herda os pipes e
    # continua segurando-os — e é EXATAMENTE nessa janela que `poll()` já não é
    # None enquanto `communicate()` ainda espera. Sem o neto, este teste nem
    # alcançaria o caminho que ele existe para cobrir.
    falso.write_text(
        "#!/bin/sh\n"
        "echo 'route=browser.tabs session_id=ses_abc http=200'\n"
        "( sleep 3 ) &\n"
        f"echo $$ > '{marca}'\n",          # última linha antes de sair
        encoding="utf-8")
    falso.chmod(0o755)
    monkeypatch.setattr(B, "NOMOS_BIN", str(falso))
    return marca


def _processo_acabou(pid: int) -> bool:
    """Morto de verdade OU zumbi (saiu, só não foi ceifado ainda)."""
    r = subprocess.run(["ps", "-o", "state=", "-p", str(pid)],
                       capture_output=True, text=True)
    estado = r.stdout.strip()
    return estado == "" or estado.startswith("Z")


class CancelaSoDepoisQueOFilhoAcabou:
    """Um `cancelar` que só fica setado quando o processo JÁ terminou.

    Sem isto, o caso tardio dependia de vencer uma corrida de milissegundos, e
    um teste que às vezes pula não prova nada — foi o que aconteceu na primeira
    versão, que saiu `skipped`. `executar` só chama `is_set()`, então dá para
    ancorar a condição no fato que interessa em vez de torcer por ele.
    """

    def __init__(self, marca):
        self.marca = marca

    def is_set(self) -> bool:
        if not self.marca.exists():
            return False
        try:
            pid = int(self.marca.read_text().strip())
        except (ValueError, OSError):
            return False
        prazo = time.monotonic() + 10
        while time.monotonic() < prazo:
            if _processo_acabou(pid):
                return True
            time.sleep(0.01)
        return True


def test_cancelamento_tardio_nao_mente_dizendo_cancelado(
        nomos_instantaneo, manifesto_registrado, trilha):
    """O caso que o código ingênuo conta errado.

    Se o `nomos` já terminou quando o evento chega, a ação ACONTECEU — a aba já
    trocou, a página já navegou. Devolver CANCELADO seria dizer ao dono que nada
    ocorreu enquanto o efeito está na tela dele. Tem de sair EXECUTADO, com
    `cancelamento_tardio=True` e um `too_late` na trilha.
    """
    marca = nomos_instantaneo
    r = B.executar("browser_tabs", {}, cancelar=CancelaSoDepoisQueOFilhoAcabou(marca),
                   timeout_s=30)

    assert r["status"] == "EXECUTADO", r
    assert r["cancelamento_tardio"] is True, r
    assert "ses_abc" in r["texto"], r
    evs = eventos(trilha)
    assert "browser.cancel.requested" in evs, evs
    assert "browser.cancel.too_late" in evs, evs
    assert "browser.cancel.terminated" not in evs, "nao se 'termina' o que ja tinha acabado"
    assert "browser.cancel.accepted" not in evs, "nao se 'aceita' um cancelamento impossivel"
