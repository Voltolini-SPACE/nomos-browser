// Escritor em PROCESSO SEPARADO. Precisa ser: rmSync e sincrono e bloqueia o
// event loop de quem remove, entao um setInterval no mesmo processo nunca roda
// durante a remocao — foi assim que a primeira tentativa de controle deu falso.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const raiz = process.argv[2]; const fim = Date.now() + Number(process.argv[3] ?? 3000);
while (Date.now() < fim) {
  for (let i = 0; i < 80; i += 1) {
    try { const d = path.join(raiz, `ses_${i}`); mkdirSync(d, { recursive: true });
          writeFileSync(path.join(d, `t_${Date.now()}_${i}.jsonl`), "y"); } catch {}
  }
}
