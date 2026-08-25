#!/usr/bin/env node
/**
 * FASE 17 — gerador do schema de configuração.
 *
 * NÃO contém tabela nenhuma. Ele imprime o que `packages/api/src/config.ts`
 * sabe sobre si mesmo — é por isso que a tabela publicada não pode divergir do
 * produto: ela é o produto respondendo, não um humano descrevendo.
 *
 * Uso:
 *   node scripts/config-schema.ts              # JSON (a mesma forma da rota /config/schema)
 *   node scripts/config-schema.ts --markdown   # tabela
 *   node scripts/config-schema.ts --markdown --escrever   # grava docs/_gerado/CONFIGURATION.generated.md
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configSchema, configSchemaMarkdown } from "../packages/api/src/config.ts";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESTINO = path.join(RAIZ, "docs", "_gerado", "CONFIGURATION.generated.md");

const args = new Set(process.argv.slice(2));
const desconhecido = [...args].filter((a) => a !== "--markdown" && a !== "--escrever" && a !== "--json");
if (desconhecido.length > 0) {
  // Flag desconhecida não é ignorada: um `--markdow` silenciosamente aceito
  // gravaria JSON por cima da tabela e ninguém notaria até o dia da leitura.
  console.error(`argumento desconhecido: ${desconhecido.join(", ")}`);
  process.exit(2);
}

if (args.has("--markdown")) {
  const md = configSchemaMarkdown();
  if (args.has("--escrever")) {
    fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
    fs.writeFileSync(DESTINO, md, "utf8");
    console.error(`gravado: ${path.relative(RAIZ, DESTINO)} (${configSchema().length} chaves)`);
  } else {
    process.stdout.write(md);
  }
} else {
  // `valores_efetivos: false` é declaração, não decoração: quem consome esta
  // saída precisa saber que ela descreve a FORMA e não o estado do daemon.
  process.stdout.write(
    `${JSON.stringify({ versao_schema: 1, valores_efetivos: false, chaves: configSchema() }, null, 2)}\n`,
  );
}
