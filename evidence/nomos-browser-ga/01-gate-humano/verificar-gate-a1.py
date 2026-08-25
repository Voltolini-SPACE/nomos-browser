#!/usr/bin/env python3
"""Computa os sete gates do A1 humano a partir das TRILHAS, não do stdout.

O script do gate roda no terminal do dono e a saída dele fica na tela dele. Ler
o gate por ali me obrigaria a pedir que alguém copiasse e colasse um texto — e
texto colado não é evidência: é depoimento. As duas trilhas, não.

    ~/.nomos/logs/audit.jsonl                    quem AUTORIZOU (e quem negou)
    <SESSOES>/<sid>/actions.jsonl                o que foi EXECUTADO

Elas são independentes, escritas por processos diferentes, e a prova está em
elas contarem a mesma história. Se alguém tivesse falado direto com o runtime, a
do NOMOS estaria vazia; se o NOMOS tivesse autorizado sem nada acontecer, a do
runtime estaria.

Uso: python3 verificar-gate-a1.py <session_id> [raiz_das_sessoes]
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

TOOL = "browser_tab_switch"
NIVEL = "A1"
ROTA = "browser.switch_tab"


def carregar(p: Path) -> list[dict]:
    if not p.exists():
        return []
    fora = []
    for l in p.read_text(encoding="utf-8", errors="replace").splitlines():
        l = l.strip()
        if not l:
            continue
        try:
            fora.append(json.loads(l))
        except Exception:
            pass
    return fora


def main() -> int:
    if len(sys.argv) < 2:
        print("uso: verificar-gate-a1.py <session_id> [raiz_das_sessoes]", file=sys.stderr)
        return 2
    sid = sys.argv[1]
    raiz = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ga-gate-a1-sessoes")

    rt = carregar(raiz / sid / "actions.jsonl")
    if not rt:
        print(f"ABORTADO: trilha do runtime vazia em {raiz / sid / 'actions.jsonl'}")
        return 2

    # A janela de tempo é a da SESSÃO, tirada da própria trilha do runtime —
    # não um número escolhido a dedo.
    ts = [d.get("ts") for d in rt if isinstance(d.get("ts"), (int, float))]
    if not ts:
        # A trilha do runtime usa carimbo ISO; converte.
        import datetime as dt
        for d in rt:
            v = d.get("at") or d.get("timestamp") or d.get("time")
            if isinstance(v, str):
                try:
                    ts.append(dt.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp())
                except Exception:
                    pass
    t0, t1 = (min(ts) - 5, max(ts) + 5) if ts else (0, 10**12)

    nomos = [d for d in carregar(Path.home() / ".nomos/logs/audit.jsonl")
             if t0 <= float(d.get("ts", 0)) <= t1 and str(d.get("event", "")).startswith("mcp")]

    negadas = [d for d in nomos if d.get("event") == "mcp.client.tool.negada"]
    aceitas = [d for d in nomos if d.get("event") == "mcp.client.tool"]
    neg_a1 = [d for d in negadas if d.get("tool") == TOOL and d.get("nivel") == NIVEL]
    ace_a1 = [d for d in aceitas if d.get("tool") == TOOL and d.get("nivel") == NIVEL]
    neg_altas = [d for d in negadas if d.get("nivel") in ("A2", "A3", "A4", "A5")]
    ace_altas = [d for d in aceitas if d.get("nivel") in ("A2", "A3", "A4", "A5")]

    mutacoes = [d for d in rt if str(d.get("action", "")).startswith("browser.")
                and d.get("action") not in ("browser.tabs",)]
    trocas = [d for d in mutacoes if d.get("action") == ROTA]
    outras = [d for d in mutacoes if d.get("action") != ROTA]
    donos = {d.get("owner") for d in trocas}

    print(f"sessao ............................. {sid}")
    print(f"linhas na trilha do runtime ........ {len(rt)}")
    print(f"eventos MCP na janela .............. {len(nomos)}")
    print()
    print(f"negativas de {TOOL} ({NIVEL}) ....... {len(neg_a1)}")
    print(f"execucoes de {TOOL} ({NIVEL}) ....... {len(ace_a1)}")
    print(f"negativas de nivel A2+ ............. {len(neg_altas)}"
          f"  ({', '.join(sorted({d.get('tool','?') for d in neg_altas})) or '-'})")
    print(f"EXECUCOES de nivel A2+ ............. {len(ace_altas)}   <- tem de ser 0")
    print()
    print(f"rota {ROTA} na trilha do runtime .... {len(trocas)}")
    print(f"outras mutacoes de navegador ....... {len(outras)}"
          f"  ({', '.join(sorted({d.get('action','?') for d in outras})) or 'nenhuma'})")
    print(f"dono das trocas .................... {', '.join(sorted(x for x in donos if x))}")
    print()

    # ── os sete gates ────────────────────────────────────────────────────────
    # 1 e 2: quatro negativas de A1 — uma sem TTY e tres com palavra errada.
    g1 = "DENIED" if len(neg_a1) >= 1 else "FAIL"
    g2 = "DENIED" if len(neg_a1) >= 4 else "FAIL"
    # 3: o NOMOS registrou execucao de A1 E o runtime executou a rota.
    g3 = "PASS" if (len(ace_a1) >= 1 and len(trocas) >= 1) else "FAIL"
    # 4: as duas trilhas, nao uma.
    g4 = "YES" if (len(ace_a1) >= 1 and len(trocas) >= 1 and len(nomos) > 0) else "NO"
    # 5: so a rota aprovada mutou. `browser.new_tab` do preparo e' do lancador e
    #    aparece rotulado; qualquer OUTRA mutacao seria escopo estourado.
    outras_sem_preparo = [d for d in outras if d.get("action") != "browser.new_tab"]
    g5 = "EXATO" if (len(trocas) >= 1 and not outras_sem_preparo) else "FAIL"
    # 6: nenhuma tool acima de A1 executou, e houve negativa depois da aprovacao.
    g6 = "NO" if (len(ace_altas) == 0 and len(neg_altas) >= 1) else "SIM"
    # 7: quem executou e' o principal do MCP, e o NOMOS tem o registro par.
    g7 = "NO" if (donos and all(str(d).startswith("mcp:") for d in donos if d)
                  and len(ace_a1) >= 1) else "SIM"

    print(f"A1_WITHOUT_APPROVAL={g1}")
    print(f"A1_INVALID_APPROVAL={g2}")
    print(f"A1_WITH_REAL_APROVO={g3}")
    print(f"APPROVAL_AUDITED={g4}")
    print(f"SCOPE_EXACT={g5}")
    print(f"SILENT_ELEVATION={g6}")
    print(f"PRIVILEGE_BYPASS={g7}")

    verde = (g1 == "DENIED" and g2 == "DENIED" and g3 == "PASS" and g4 == "YES"
             and g5 == "EXATO" and g6 == "NO" and g7 == "NO")
    print(f"HUMAN_A1_GATE={'PASS' if verde else 'FAIL'}")
    return 0 if verde else 1


if __name__ == "__main__":
    raise SystemExit(main())
