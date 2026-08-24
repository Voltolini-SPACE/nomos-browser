/**
 * FASE 16 — Formato `.nomosskill` v1.
 *
 * Uma Web Skill é uma navegação que já deu certo, congelada em passos nomeados
 * e verificáveis. Ela não substitui o agente: substitui a redescoberta.
 *
 * Duas decisões que valem explicação:
 *
 * 1. Parser YAML próprio, de subconjunto restrito. Nenhuma dependência de YAML
 *    está instalada e a missão proíbe dependência nova. Um subconjunto pequeno
 *    e determinístico (mapas por indentação, listas com `-`, escalares simples)
 *    cobre o formato da missão sem trazer a superfície de um parser completo —
 *    e sem âncoras/aliases, que são justamente a parte perigosa do YAML.
 *
 * 2. Skill não se atualiza sozinha. A FASE 15 permite curar um alvo em tempo de
 *    execução, mas gravar a cura de volta no arquivo exige evidência de que a
 *    execução inteira foi verificada. Cura silenciosa transformaria um erro
 *    pontual em regra permanente.
 */

export const SKILL_SCHEMA_VERSION = 1 as const;

export interface SkillRequirements {
  profile?: string;
  capabilities?: string[];
  /** Domínios que a skill pode tocar. Vazio = herda a política da sessão. */
  domains?: string[];
}

export interface SkillStep {
  name: string;
  action: string;
  target?: Record<string, unknown>;
  value?: string;
  /** Referência ao vault. Nunca um valor literal — ver `validateSkill`. */
  credential_ref?: string;
  /** Expressão sobre `variables`; passo é pulado se avaliar falso. */
  condition?: string;
  verification?: { kind: string; expect?: string; timeout_ms?: number };
  retry?: { max: number; backoff_ms?: number };
  /** Passo alternativo se este falhar, por nome. */
  fallback?: string;
  optional?: boolean;
}

export interface WebSkill {
  name: string;
  version: number;
  description?: string;
  requirements: SkillRequirements;
  variables: Record<string, unknown>;
  steps: SkillStep[];
  verification: string[];
}

export interface SkillValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser de subconjunto YAML
// ─────────────────────────────────────────────────────────────────────────────

type Scalar = string | number | boolean | null;
type Node = Scalar | Node[] | { [k: string]: Node };

interface Line {
  indent: number;
  content: string;
  n: number;
}

function scanLines(src: string): Line[] {
  const out: Line[] = [];
  const raw = src.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!;
    if (line.includes("\t")) {
      throw new Error(`nomosskill: tab na linha ${i + 1} — use espaços (YAML proíbe tab em indentação)`);
    }
    const stripped = stripComment(line);
    if (stripped.trim() === "") continue;
    out.push({ indent: stripped.length - stripped.trimStart().length, content: stripped.trim(), n: i + 1 });
  }
  return out;
}

/** Remove `#` de comentário sem quebrar `#` dentro de aspas. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw: string): Scalar {
  const s = raw.trim();
  if (s === "") return "";
  if ((s.startsWith('"') && s.endsWith('"') && s.length > 1) || (s.startsWith("'") && s.endsWith("'") && s.length > 1)) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return Number.parseFloat(s);
  return s;
}

function parseBlock(lines: Line[], start: number, indent: number): [Node, number] {
  let i = start;
  if (i >= lines.length) return [null, i];

  if (lines[i]!.content.startsWith("- ") || lines[i]!.content === "-") {
    const arr: Node[] = [];
    while (i < lines.length && lines[i]!.indent === indent && (lines[i]!.content.startsWith("- ") || lines[i]!.content === "-")) {
      const rest = lines[i]!.content === "-" ? "" : lines[i]!.content.slice(2).trim();
      if (rest === "") {
        const [child, next] = parseBlock(lines, i + 1, i + 1 < lines.length ? lines[i + 1]!.indent : indent + 2);
        arr.push(child);
        i = next;
      } else if (rest.includes(":") && !rest.startsWith('"') && !rest.startsWith("'")) {
        // "- name: valor" abre um mapa cujo primeiro par está na própria linha do traço.
        const inner: Line[] = [{ indent: indent + 2, content: rest, n: lines[i]!.n }];
        let j = i + 1;
        while (j < lines.length && lines[j]!.indent > indent) {
          inner.push({ ...lines[j]!, indent: lines[j]!.indent });
          j++;
        }
        const norm = normalizeIndent(inner, indent + 2);
        const [child] = parseBlock(norm, 0, indent + 2);
        arr.push(child);
        i = j;
      } else {
        arr.push(parseScalar(rest));
        i++;
      }
    }
    return [arr, i];
  }

  const map: { [k: string]: Node } = {};
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    const colon = findColon(line.content);
    if (colon === -1) throw new Error(`nomosskill: linha ${line.n} não é par chave:valor — "${line.content}"`);
    const key = line.content.slice(0, colon).trim().replace(/^["']|["']$/g, "");
    const rest = line.content.slice(colon + 1).trim();
    if (rest !== "") {
      map[key] = parseScalar(rest);
      i++;
    } else {
      const childIndent = i + 1 < lines.length ? lines[i + 1]!.indent : indent;
      if (i + 1 < lines.length && childIndent > indent) {
        const [child, next] = parseBlock(lines, i + 1, childIndent);
        map[key] = child;
        i = next;
      } else {
        map[key] = null;
        i++;
      }
    }
  }
  return [map, i];
}

function normalizeIndent(lines: Line[], base: number): Line[] {
  const min = Math.min(...lines.map((l) => l.indent));
  return lines.map((l) => ({ ...l, indent: l.indent - min + base }));
}

function findColon(s: string): number {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ":" && (i + 1 === s.length || /\s/.test(s[i + 1]!))) {
      return i;
    }
  }
  return -1;
}

export function parseNomosSkill(source: string): WebSkill {
  const lines = scanLines(source);
  if (lines.length === 0) throw new Error("nomosskill: arquivo vazio");
  const [node] = parseBlock(lines, 0, lines[0]!.indent);
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    throw new Error("nomosskill: raiz precisa ser um mapa");
  }
  const raw = node as Record<string, Node>;

  const steps: SkillStep[] = [];
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  for (const s of rawSteps) {
    if (typeof s === "string") {
      // Forma curta do exemplo da missão: `- navigate`. O nome é a própria ação.
      steps.push({ name: s, action: s });
    } else if (s !== null && typeof s === "object" && !Array.isArray(s)) {
      const o = s as Record<string, Node>;
      steps.push({
        name: String(o.name ?? o.action ?? `step_${steps.length + 1}`),
        action: String(o.action ?? o.name ?? ""),
        target: (o.target ?? undefined) as Record<string, unknown> | undefined,
        value: o.value === undefined || o.value === null ? undefined : String(o.value),
        credential_ref: o.credential_ref === undefined || o.credential_ref === null ? undefined : String(o.credential_ref),
        condition: o.condition === undefined || o.condition === null ? undefined : String(o.condition),
        verification: (o.verification ?? undefined) as SkillStep["verification"],
        retry: (o.retry ?? undefined) as SkillStep["retry"],
        fallback: o.fallback === undefined || o.fallback === null ? undefined : String(o.fallback),
        optional: o.optional === true,
      });
    }
  }

  return {
    name: String(raw.name ?? ""),
    version: typeof raw.version === "number" ? raw.version : Number.parseInt(String(raw.version ?? "1"), 10),
    description: raw.description === undefined || raw.description === null ? undefined : String(raw.description),
    requirements: (raw.requirements ?? {}) as SkillRequirements,
    variables: (raw.variables ?? {}) as Record<string, unknown>,
    steps,
    verification: Array.isArray(raw.verification) ? raw.verification.map(String) : [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validação
// ─────────────────────────────────────────────────────────────────────────────

/** Heurística de segredo literal. Falso positivo aqui custa um aviso; falso negativo custa uma credencial. */
const SUSPEITA_SEGREDO = /^(?:[A-Za-z0-9+/]{24,}={0,2}|(?:sk|pk|ghp|xox[baprs])[-_][A-Za-z0-9]{16,})$/;
const CAMPOS_SENSIVEIS = /senha|password|secret|token|api[_-]?key|credential/i;

export function validateSkill(skill: WebSkill): SkillValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (skill.name.trim() === "") errors.push("name é obrigatório");
  else if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(skill.name)) {
    errors.push(`name "${skill.name}" deve ser minúsculo, no formato dominio.acao`);
  }
  if (!Number.isInteger(skill.version) || skill.version < 1) errors.push("version deve ser inteiro >= 1");
  if (skill.steps.length === 0) errors.push("steps não pode ser vazio");
  if (skill.verification.length === 0) {
    // Sem verificação a skill não é reexecutável com segurança: ela repetiria os
    // cliques sem provar que chegou ao mesmo lugar.
    warnings.push("skill sem bloco verification — reexecução não é verificável");
  }

  const nomes = new Set<string>();
  for (const [i, step] of skill.steps.entries()) {
    const onde = `steps[${i}] (${step.name})`;
    if (step.action.trim() === "") errors.push(`${onde}: action é obrigatório`);
    if (nomes.has(step.name)) errors.push(`${onde}: nome duplicado — fallback por nome ficaria ambíguo`);
    nomes.add(step.name);

    if (step.value !== undefined && CAMPOS_SENSIVEIS.test(step.name + " " + JSON.stringify(step.target ?? {}))) {
      errors.push(`${onde}: campo sensível com valor literal — use credential_ref`);
    }
    if (step.value !== undefined && SUSPEITA_SEGREDO.test(step.value)) {
      errors.push(`${onde}: value parece um segredo literal — use credential_ref`);
    }
    if (step.retry !== undefined && (!Number.isInteger(step.retry.max) || step.retry.max < 0 || step.retry.max > 10)) {
      errors.push(`${onde}: retry.max deve estar entre 0 e 10 (retry infinito é proibido)`);
    }
    if (step.target !== undefined) {
      const chaves = Object.keys(step.target);
      if (chaves.length === 1 && chaves[0] === "selector") {
        warnings.push(`${onde}: alvo só por selector é frágil — acrescente text, role ou semantic`);
      }
      if (chaves.length === 1 && chaves[0] === "coordinates") {
        warnings.push(`${onde}: alvo só por coordenada quebra a qualquer mudança de layout`);
      }
    }
  }

  for (const step of skill.steps) {
    if (step.fallback !== undefined && !nomes.has(step.fallback)) {
      errors.push(`steps (${step.name}): fallback "${step.fallback}" não existe`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Substitui `${var}` pelos valores de `variables`. Variável ausente é erro, não string vazia. */
export function resolveVariables(text: string, variables: Record<string, unknown>): string {
  return text.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_m, nome: string) => {
    if (!(nome in variables)) throw new Error(`nomosskill: variável "${nome}" não definida`);
    return String(variables[nome]);
  });
}
