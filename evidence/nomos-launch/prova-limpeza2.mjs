import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { removerArvore } from "/Users/AI/Projects/nomos-browser/tests/fixtures/limpeza.ts";

function arvore(n = 80, m = 40) {
  const raiz = mkdtempSync(path.join(tmpdir(), "prova-limpeza-"));
  for (let i = 0; i < n; i += 1) { const d = path.join(raiz, `ses_${i}`); mkdirSync(d, { recursive: true });
    for (let j = 0; j < m; j += 1) writeFileSync(path.join(d, `a${j}.jsonl`), "x".repeat(600)); }
  return raiz;
}
function espera(ms){ Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms); }

function cenario(remover) {
  const raiz = arvore();
  const p = spawn(process.execPath, ["/tmp/escritor.mjs", raiz, "2500"], { stdio: "ignore" });
  espera(150);                       // deixa o escritor entrar em ritmo
  const r = remover(raiz);
  try { p.kill("SIGKILL"); } catch {}
  espera(100); try { rmSync(raiz, { recursive: true, force: true }); } catch {}
  return r;
}

const cru = cenario((raiz) => { try { rmSync(raiz, { recursive: true, force: true }); return { ok: true, err: null }; }
                                catch (e) { return { ok: false, err: e.code ?? String(e) }; } });
const hlp = cenario((raiz) => removerArvore(raiz));

console.log(`RMSYNC_CRU: ok=${cru.ok} erro=${cru.err ?? "nenhum"}`);
console.log(`HELPER:     removido=${hlp.removido} tentativas=${hlp.tentativas} ultimoErro=${hlp.ultimoErro ?? "nenhum"}`);
console.log(!cru.ok && hlp.removido ? "CONTROLE=VALIDO (o cru quebra, o helper aguenta)"
  : !cru.ok && !hlp.removido ? "CONTROLE=PARCIAL (o cru quebra e o helper tambem)"
  : "CONTROLE=INCONCLUSIVO (a corrida nao reproduziu)");
