#!/usr/bin/env node
/**
 * FASE 100 — `$VAR…` NÃO É `${VAR}…`: EXPANSÃO COLADA EM CARACTERE NÃO-ASCII.
 *
 * O DEFEITO QUE ESTE GUARDA EXISTE PARA IMPEDIR (observado, não hipotético):
 * `scripts/nomos-register.sh:109` imprimia
 *
 *     ok "JÁ REGISTRADO como confiável (impressão $CURTA…) — nada a fazer"
 *
 * O `…` (U+2026) é multibyte em UTF-8. O bash NÃO encerra o nome da variável
 * ali: ele tenta expandir `CURTA\xe2\x80\xa6`, que não existe. Sob `set -u`
 * — que estes scripts usam, e devem usar — isso é
 *
 *     line 109: CURTA…: unbound variable
 *
 * e o script MORRE. O detalhe cruel: esse ramo é o de SUCESSO ("já registrado
 * como confiável"). Enquanto o manifesto esteve experimental o ramo nunca
 * executou, então tudo parecia verde. O bug só apareceu no minuto em que o dono
 * registrou o manifesto — isto é, no primeiro uso real do caminho feliz.
 * Verbatim em `evidence/nomos-browser-final-100/02-integracao/`.
 *
 * A MESMA linha existia no instrumento de prova (`prova-nomos-real.sh:150`),
 * pelo mesmo motivo e com a mesma consequência. Produto e instrumento foram
 * corrigidos; este guarda impede que a classe volte por qualquer um dos dois.
 *
 * COMO FUNCIONA — puramente estático, sem executar nada:
 *   varre todo `*.sh` do repositório procurando `$NOME` seguido IMEDIATAMENTE
 *   por um byte não-ASCII. `${NOME}…`, `"$NOME"…`, `$NOME …` e `$NOME.` são
 *   todos aceitos: o que reprova é só a colagem ambígua.
 *
 * Controle negativo: `node scripts/verificar-shell-expansao.ts --autoteste`
 * injeta a linha defeituosa num arquivo temporário e exige que o guarda a pegue.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `$NOME` (sem chaves) colado num byte fora do ASCII de 7 bits. */
const COLAGEM = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/;

export interface Ocorrencia {
  arquivo: string;
  linha: number;
  texto: string;
}

function scripts(dir: string, saida: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scripts(p, saida);
    else if (e.name.endsWith(".sh")) saida.push(p);
  }
  return saida;
}

export function varrer(arquivos: string[]): Ocorrencia[] {
  const achados: Ocorrencia[] = [];
  for (const f of arquivos) {
    const linhas = fs.readFileSync(f, "utf8").split("\n");
    linhas.forEach((texto, i) => {
      // Linha inteiramente de comentário não expande nada — e a documentação
      // deste próprio guarda precisa citar a forma ruim para explicá-la.
      if (texto.trimStart().startsWith("#")) return;
      if (COLAGEM.test(texto)) {
        achados.push({ arquivo: path.relative(RAIZ, f), linha: i + 1, texto: texto.trim() });
      }
    });
  }
  return achados;
}

function autoteste(): void {
  // Controle negativo: o guarda tem de REPROVAR uma linha sabidamente ruim.
  const tmp = path.join(fs.mkdtempSync("/tmp/nb-shellguard-"), "ruim.sh");
  fs.writeFileSync(tmp, 'set -u\nCURTA=abc\necho "impressão $CURTA… fim"\n', "utf8");
  const achados = varrer([tmp]);
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  if (achados.length !== 1 || achados[0]!.linha !== 3) {
    console.error("AUTOTESTE=FALHOU — o guarda NÃO pegou a colagem conhecida. Guarda cego.");
    process.exit(1);
  }
  // Controle positivo: a forma correta não pode ser acusada.
  const tmp2 = path.join(fs.mkdtempSync("/tmp/nb-shellguard-"), "bom.sh");
  fs.writeFileSync(tmp2, 'set -u\nCURTA=abc\necho "impressão ${CURTA}… fim"\necho "$CURTA — x"\n# comentário citando a forma ruim: $CURTA… (não expande)\n', "utf8");
  const limpos = varrer([tmp2]);
  fs.rmSync(path.dirname(tmp2), { recursive: true, force: true });
  if (limpos.length !== 0) {
    console.error(`AUTOTESTE=FALHOU — falso positivo em forma correta: ${JSON.stringify(limpos)}`);
    process.exit(1);
  }
  console.log("AUTOTESTE=OK (pega a ruim, não acusa a boa)");
}

function main(): void {
  if (process.argv.includes("--autoteste")) {
    autoteste();
    return;
  }
  const arquivos = scripts(RAIZ);
  const achados = varrer(arquivos);
  if (achados.length > 0) {
    console.error("SHELL_EXPANSION_SAFE=NO");
    for (const a of achados) {
      console.error(`  - ${a.arquivo}:${a.linha}: expansão colada em não-ASCII — use \${VAR}`);
      console.error(`      ${a.texto}`);
    }
    process.exit(1);
  }
  console.log(`SHELL_EXPANSION_SAFE=YES (${arquivos.length} scripts .sh varridos)`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
