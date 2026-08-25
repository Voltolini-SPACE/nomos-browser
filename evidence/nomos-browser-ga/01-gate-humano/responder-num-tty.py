#!/usr/bin/env python3
"""Roda um comando num TTY DE VERDADE e responde ao prompt com uma palavra dada.

POR QUE ISTO EXISTE, E O QUE ELE **NÃO** PODE FAZER
===================================================
O `interactive_approver` do NOMOS recusa qualquer coisa que não seja um TTY:

    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        print("NEGADO (fail-closed): aprovação exige terminal interativo.")
        return False

Isso torna o caso "sem TTY ⇒ negado" fácil de provar, mas deixa um buraco: como
provar que o gate também recusa uma resposta ERRADA *tendo* um TTY? Sem um
pseudo-terminal, esse caso simplesmente não é testável, e ficaria como suposição.

Este utilitário abre um pty e digita a palavra que lhe for passada.

**Ele é proibido de digitar `APROVO`.** A checagem abaixo não é decorativa: é a
linha que separa "testar que o gate rejeita o que não é consentimento" de
"fabricar o consentimento do dono". A primeira é o trabalho; a segunda é fraude,
e nenhuma pressa de missão a justifica. Se alguém tentar, o programa sai com
código 2 e não roda nada.

Uso:
    python3 responder-num-tty.py "NAO" -- nomos mcp chamar ...
"""
from __future__ import annotations

import os
import pty
import select
import sys
import time

# A palavra sagrada. Este arquivo não a digita — nunca, sob nenhum argumento.
PALAVRA_PROIBIDA = "APROVO"


def main() -> int:
    if "--" not in sys.argv:
        print("uso: responder-num-tty.py <resposta> -- <comando...>", file=sys.stderr)
        return 2
    corte = sys.argv.index("--")
    if corte != 2:
        print("uso: responder-num-tty.py <resposta> -- <comando...>", file=sys.stderr)
        return 2
    resposta = sys.argv[1]
    comando = sys.argv[corte + 1:]
    if not comando:
        print("faltou o comando", file=sys.stderr)
        return 2

    if resposta.strip() == PALAVRA_PROIBIDA:
        print("RECUSADO: este utilitário existe para provar que o gate rejeita "
              "respostas ERRADAS. Digitar a aprovação do dono seria forjar "
              "consentimento — e isso não se faz nem para fechar um gate.",
              file=sys.stderr)
        return 2

    pid, fd = pty.fork()
    if pid == 0:                                  # filho: vira o comando
        os.execvp(comando[0], comando)
        os._exit(127)                             # inalcançável

    saida = bytearray()
    respondido = False
    prazo = time.monotonic() + 90
    while time.monotonic() < prazo:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try:
                pedaco = os.read(fd, 4096)
            except OSError:
                break
            if not pedaco:
                break
            saida += pedaco
            texto = saida.decode("utf-8", "replace")
            # O prompt do NOMOS é literalmente:
            #   Digite exatamente "APROVO" para autorizar:
            if not respondido and "para autorizar" in texto:
                os.write(fd, (resposta + "\n").encode("utf-8"))
                respondido = True
        else:
            try:
                fim, _ = os.waitpid(pid, os.WNOHANG)
                if fim == pid:
                    break
            except ChildProcessError:
                break

    try:
        _, status = os.waitpid(pid, 0)
        rc = os.waitstatus_to_exitcode(status)
    except ChildProcessError:
        rc = -1
    os.close(fd)

    sys.stdout.write(saida.decode("utf-8", "replace"))
    sys.stdout.write(f"\n[TTY] prompt_visto={respondido} resposta_digitada={resposta!r} rc={rc}\n")
    return 0 if respondido else 3


if __name__ == "__main__":
    raise SystemExit(main())
