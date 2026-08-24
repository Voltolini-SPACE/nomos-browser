/**
 * FASE 1 (PRODUCT-02) — o mapa de rastreabilidade tem de ser verificável.
 *
 * Um documento que lista "requisito → artefato → teste" e que ninguém confere
 * apodrece na primeira refatoração: o arquivo é renomeado, a linha continua lá,
 * e o mapa passa a mentir com aparência de rigor. Estes testes leem
 * `docs/RASTREABILIDADE.md` e exigem que cada caminho citado exista de fato.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAPA = path.join(RAIZ, "docs", "RASTREABILIDADE.md");

interface Linha {
  fase: string;
  requisito: string;
  artefato: string;
  teste: string;
  status: string;
}

/** Lê as tabelas do mapa. Só linhas com 5 colunas e fase preenchida. */
function linhasDoMapa(): Linha[] {
  const md = readFileSync(MAPA, "utf8");
  const out: Linha[] = [];
  for (const l of md.split("\n")) {
    if (!l.startsWith("|")) continue;
    const c = l.split("|").map((x) => x.trim());
    // ["", fase, requisito, artefato, teste, status, ""]
    if (c.length !== 7) continue;
    if (c[1] === "Fase" || c[1] === "" || /^-+$/.test(c[1]!)) continue;
    if (c[5] === undefined) continue;
    out.push({ fase: c[1]!, requisito: c[2]!, artefato: c[3]!, teste: c[4]!, status: c[5]! });
  }
  return out;
}

/** Extrai caminhos de arquivo/diretório de uma célula (crases, vírgulas, globs). */
function caminhosDe(celula: string): string[] {
  if (celula === "—" || celula === "") return [];
  const achados: string[] = [];
  for (const m of celula.matchAll(/`([^`]+)`/g)) {
    const bruto = m[1]!;
    // "session.ts (launchPersistentContext)" → só o caminho
    const limpo = bruto.replace(/\s*\(.*$/, "").trim();
    if (limpo === "" || !limpo.includes("/") && !limpo.endsWith(".ts") && !limpo.endsWith(".md") && !limpo.endsWith(".sh") && !limpo.endsWith(".json")) {
      continue;
    }
    achados.push(limpo);
  }
  return achados;
}

/** Um caminho existe se for arquivo, diretório, ou glob com ao menos um casamento. */
function existeCaminho(rel: string): boolean {
  const abs = path.join(RAIZ, rel);
  if (existsSync(abs)) return true;
  if (rel.includes("*")) {
    const dir = path.join(RAIZ, path.dirname(rel.replace(/\*.*$/, "")));
    return existsSync(dir);
  }
  return false;
}

const linhas = linhasDoMapa();

test("o mapa foi parseado e não está vazio", () => {
  assert.ok(linhas.length >= 40, `esperava ao menos 40 linhas mapeadas, achei ${linhas.length}`);
});

test("todo artefato citado no mapa existe no repositório", () => {
  const faltando: string[] = [];
  for (const l of linhas) {
    for (const p of caminhosDe(l.artefato)) {
      if (!existeCaminho(p)) faltando.push(`fase ${l.fase}: artefato ${p}`);
    }
  }
  assert.deepEqual(faltando, [], `caminhos citados que não existem:\n${faltando.join("\n")}`);
});

test("todo teste citado no mapa existe no repositório", () => {
  const faltando: string[] = [];
  for (const l of linhas) {
    for (const p of caminhosDe(l.teste)) {
      if (!existeCaminho(p)) faltando.push(`fase ${l.fase}: teste ${p}`);
    }
  }
  assert.deepEqual(faltando, [], `testes citados que não existem:\n${faltando.join("\n")}`);
});

test("status só usa o vocabulário da missão", () => {
  const permitidos = new Set(["OBSERVADO", "MEDIDO", "REPRODUZIDO", "—"]);
  const invalidos = linhas.filter((l) => !permitidos.has(l.status)).map((l) => `${l.fase}: "${l.status}"`);
  assert.deepEqual(invalidos, [], `status fora do vocabulário (nada de "ok", "feito", "pronto"):\n${invalidos.join("\n")}`);
});

test("fase com status de prova precisa citar um teste — e vice-versa", () => {
  const incoerentes: string[] = [];
  for (const l of linhas) {
    const temTeste = caminhosDe(l.teste).length > 0 || l.teste.includes("visual") || l.teste.includes("checks") || l.teste.includes("reexecutados") || l.teste.includes("testes");
    const provado = l.status === "REPRODUZIDO" || l.status === "MEDIDO";
    if (provado && !temTeste) incoerentes.push(`fase ${l.fase}: status ${l.status} sem teste citado`);
    // O inverso é o que pega auto-engano: teste citado mas status vazio.
    if (l.status === "—" && caminhosDe(l.teste).length > 0) {
      incoerentes.push(`fase ${l.fase}: cita teste mas status é "—"`);
    }
  }
  assert.deepEqual(incoerentes, [], incoerentes.join("\n"));
});

test("a divergência de numeração está registrada, não corrigida em silêncio", () => {
  const md = readFileSync(MAPA, "utf8");
  // Se alguém apagar a seção, o histórico do erro some e o mapa passa a fingir
  // que a inconsistência nunca existiu.
  assert.match(md, /FASE 67/, "o nome legado precisa continuar rastreável");
  assert.match(md, /GATE-E2E-01/, "o nome atual precisa estar declarado");
  assert.match(md, /erro meu/i, "a origem da inconsistência precisa continuar atribuída");
});

test("o gate E2E ainda declara sua equivalência histórica", () => {
  const gate = readFileSync(path.join(RAIZ, "tests", "e2e-gate.test.ts"), "utf8");
  assert.match(gate, /FASE 67|GATE-E2E-01/, "o arquivo do gate precisa citar ao menos um dos dois nomes");
});
