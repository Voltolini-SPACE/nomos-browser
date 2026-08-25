/**
 * REPRODUTOR MÍNIMO — cenário 20 (supervisor). DEFEITO DO INSTRUMENTO, e o mais
 * grave dos quatro: um degrau que APROVAVA sem que o SIGKILL tivesse acontecido.
 *
 * SINTOMA: o cenário 20 rodou inteiro em 814 ms — impossível para um ciclo real
 * de launchd — e ainda assim marcou "após SIGKILL o launchd reiniciou com PID
 * NOVO" como OK.
 *
 * CAUSA RAIZ: a bateria lia `~/.nomos-browser/daemon.lock` IMEDIATAMENTE depois
 * do `start`. O daemon ainda não o havia escrito, então `pid1 = ""`. A partir
 * daí, três coisas erradas em sequência:
 *   1. `kill -9 ""`   → o shell não mata ninguém, e o erro é engolido;
 *   2. a espera pelo "PID novo" encontra o PID do arranque ORIGINAL;
 *   3. a comparação `"" !== "18644"` é verdadeira ⇒ PASSA.
 * O degrau media o ARRANQUE e chamava aquilo de REINÍCIO.
 *
 * Este arquivo não sobe daemon nenhum: o defeito é de LÓGICA, e reproduzi-lo
 * com launchd só esconderia isso atrás de I/O. Ele roda as duas versões da
 * checagem contra o mesmo cenário de falha e mostra que só a nova reprova.
 *
 * CONSERTO APLICADO na bateria:
 *   • esperar por um PID que exista, seja NUMÉRICO e esteja VIVO antes de matar;
 *   • exigir `kill` rc=0 E confirmar que o processo morreu;
 *   • só então esperar o sucessor.
 *
 * Uso: node evidence/nomos-browser-final-loop/19-e2e/out/repro-20.ts
 */

/** O que a 1ª versão fazia. */
function checagemAntiga(pid1: string, pid2: string): boolean {
  return pid2 !== "" && pid2 !== pid1;
}

/** O que a versão consertada faz. */
function checagemNova(pid1: string, killRc: number, morreu: boolean, pid2: string): boolean {
  const pid1Valido = /^\d+$/.test(pid1);
  const matouDeVerdade = killRc === 0 && morreu;
  return pid1Valido && matouDeVerdade && /^\d+$/.test(pid2) && pid2 !== pid1;
}

interface Caso {
  nome: string;
  pid1: string;
  killRc: number;
  morreu: boolean;
  pid2: string;
  deveriaPassar: boolean;
}

const CASOS: Caso[] = [
  // O caso REAL medido na 1ª execução: lock vazio, kill vazio, "sucessor" que é
  // na verdade o arranque original.
  { nome: "lock vazio no start; SIGKILL nunca aconteceu", pid1: "", killRc: -1, morreu: false, pid2: "18644", deveriaPassar: false },
  // O caso legítimo: PID vivo, morto de fato, sucessor diferente.
  { nome: "PID vivo, SIGKILL efetivo, launchd ressobe", pid1: "18644", killRc: 0, morreu: true, pid2: "18884", deveriaPassar: true },
  // Controle: o launchd NÃO ressobe — tem de reprovar nas duas versões.
  { nome: "SIGKILL efetivo e NENHUM sucessor", pid1: "18644", killRc: 0, morreu: true, pid2: "", deveriaPassar: false },
];

let falhas = 0;
console.log("caso                                              antiga  nova   esperado");
for (const c of CASOS) {
  const a = checagemAntiga(c.pid1, c.pid2);
  const n = checagemNova(c.pid1, c.killRc, c.morreu, c.pid2);
  if (n !== c.deveriaPassar) falhas += 1;
  console.log(`${c.nome.padEnd(50)}${(a ? "PASSA" : "reprova").padEnd(8)}${(n ? "PASSA" : "reprova").padEnd(7)}${c.deveriaPassar ? "PASSA" : "reprova"}`);
}

const vacuidadeReproduzida = checagemAntiga("", "18644") && !checagemNova("", -1, false, "18644");
console.log(`\nA checagem ANTIGA aprova o caso em que o SIGKILL nunca ocorreu : ${checagemAntiga("", "18644") ? "SIM (defeito)" : "não"}`);
console.log(`A checagem NOVA reprova esse mesmo caso                        : ${!checagemNova("", -1, false, "18644") ? "SIM (consertado)" : "não"}`);
console.log(`A checagem NOVA continua aprovando o reinício LEGÍTIMO         : ${checagemNova("18644", 0, true, "18884") ? "SIM" : "não"}`);
console.log(`\nREPRO_20=${vacuidadeReproduzida && falhas === 0 ? "CONFIRMA_CAUSA_RAIZ" : "NAO_REPRODUZ"}`);
process.exit(vacuidadeReproduzida && falhas === 0 ? 0 : 1);
