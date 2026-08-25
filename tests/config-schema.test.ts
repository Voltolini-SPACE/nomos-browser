/**
 * FASE 17 — O SCHEMA DE CONFIGURAÇÃO NÃO PODE DIVERGIR DO PRODUTO.
 *
 * Este arquivo é o instrumento que torna a divergência IMPOSSÍVEL de sobreviver
 * a um `ci.sh fast`, e não um teste de "o schema existe". Ele reprova em cinco
 * situações, cada uma um jeito diferente de a tabela virar ficção:
 *
 *   1. chave em `DaemonConfig` SEM entrada no schema      → chave invisível
 *   2. entrada no schema SEM chave real                   → schema inventando
 *   3. env em `ENV_KEYS` que `applyKey` não trata         → variável ignorada
 *   4. faixa declarada que o código não impõe             → documentação mentindo
 *   5. chave sensível saindo em claro pela API            → vazamento
 *
 * As faixas são provadas por COMPORTAMENTO — empurrando `min-1` e `max+1`
 * contra o coercitor real e exigindo recusa, e `min`/`max` e exigindo aceite.
 * Um teste que só lesse `spec.min` e o comparasse com ele mesmo provaria que
 * uma constante é igual a si própria, que é nada.
 *
 * Rodar: node --test tests/config-schema.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG_SCHEMA,
  ConfigError,
  ENV_KEYS,
  REDACAO,
  aplicarChaveIsolada,
  configSchema,
  configSchemaMarkdown,
  loadConfig,
  redigirConfig,
  type ConfigKeySpec,
} from "../packages/api/src/config.ts";

/** Config nascida só de defaults — sem arquivo e sem ambiente do operador. */
const limpa = () => loadConfig({ read_file: false, env: {} });

/** Chave achatada → chave raiz de `DaemonConfig` (`viewport.width` → `viewport`). */
const raizDe = (chave: string): string => (chave.includes(".") ? chave.slice(0, chave.indexOf(".")) : chave);

/** Valor INVÁLIDO por tipo. Nunca vazio: `""` é ignorado pelo laço de ambiente. */
function invalidoPara(spec: ConfigKeySpec): string {
  switch (spec.tipo) {
    case "boolean":
      return "talvez";
    case "inteiro":
    case "fracao":
      return "nao-e-numero";
    case "enum":
      return "__valor_que_nao_existe__";
    case "provider-ref":
      return "sem-dois-pontos";
    // string, caminho e url: só-espaços vira vazio no `trim` e é recusado, mas
    // não é `""`, então o laço de ambiente de fato o processa.
    default:
      return "   ";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 2 — nem chave órfã, nem entrada fantasma
// ─────────────────────────────────────────────────────────────────────────────

test("toda chave de DaemonConfig tem entrada no schema", () => {
  const cfg = limpa();
  const declaradas = new Set(Object.keys(CONFIG_SCHEMA));
  const faltando: string[] = [];

  for (const [chave, valor] of Object.entries(cfg)) {
    // `sources` é METADADO de proveniência, não configuração: não se escreve,
    // se lê. Declará-la no schema convidaria alguém a tentar configurá-la.
    if (chave === "sources") continue;
    if (valor !== null && typeof valor === "object" && !Array.isArray(valor)) {
      // Objeto aninhado (hoje só `viewport`): o schema fala o vocabulário
      // ACHATADO, o mesmo de `applyKey` e de `ENV_KEYS`.
      for (const sub of Object.keys(valor as Record<string, unknown>)) {
        if (!declaradas.has(`${chave}.${sub}`)) faltando.push(`${chave}.${sub}`);
      }
      continue;
    }
    if (!declaradas.has(chave)) faltando.push(chave);
  }

  assert.deepEqual(faltando, [], `chave(s) de DaemonConfig sem entrada em CONFIG_SCHEMA: ${faltando.join(", ")}`);
});

test("toda entrada do schema corresponde a uma chave real de DaemonConfig", () => {
  const cfg = limpa() as unknown as Record<string, unknown>;
  const fantasmas: string[] = [];

  for (const chave of Object.keys(CONFIG_SCHEMA)) {
    const raiz = raizDe(chave);
    if (!Object.hasOwn(cfg, raiz)) {
      fantasmas.push(chave);
      continue;
    }
    if (chave.includes(".")) {
      const pai = cfg[raiz];
      const sub = chave.slice(chave.indexOf(".") + 1);
      if (pai === null || typeof pai !== "object" || !Object.hasOwn(pai as object, sub)) fantasmas.push(chave);
      continue;
    }
    // Chave real mas que `applyKey` não sabe aplicar seria schema descrevendo
    // um campo que ninguém consegue configurar.
    assert.doesNotThrow(
      () => aplicarChaveIsolada(chave, CONFIG_SCHEMA[chave]!.exemplo, "probe"),
      `applyKey não trata a chave declarada "${chave}"`,
    );
  }

  assert.deepEqual(fantasmas, [], `entrada(s) de CONFIG_SCHEMA sem chave real: ${fantasmas.join(", ")}`);
});

test("CONFIG_SCHEMA e ENV_KEYS cobrem exatamente o mesmo conjunto, menos as exceções declaradas", () => {
  // `version` é a ÚNICA chave sem variável de ambiente, e isso é decisão:
  // versão se publica (vem do package.json), não se configura. Qualquer outra
  // chave sem env reprova aqui — para que "esqueci a env" nunca passe por
  // "foi de propósito".
  const SEM_ENV = new Set(["version"]);

  const semEnv = Object.keys(CONFIG_SCHEMA).filter((k) => ENV_KEYS[k] === undefined && !SEM_ENV.has(k));
  assert.deepEqual(semEnv, [], `chave de schema sem NOMOS_BROWSER_*: ${semEnv.join(", ")}`);

  const semSchema = Object.keys(ENV_KEYS).filter((k) => CONFIG_SCHEMA[k] === undefined);
  assert.deepEqual(semSchema, [], `env declarada sem entrada no schema: ${semSchema.join(", ")}`);

  // Toda variável tem o prefixo do produto — menos `sessions_root`, que herdou
  // `NOMOS_SESSIONS_ROOT` por ser compartilhada com o resto do NOMOS. A exceção
  // está aqui NOMEADA para que uma segunda não entre de carona.
  for (const [chave, nome] of Object.entries(ENV_KEYS)) {
    if (chave === "sessions_root") {
      assert.equal(nome, "NOMOS_SESSIONS_ROOT");
      continue;
    }
    assert.match(nome, /^NOMOS_BROWSER_[A-Z0-9_]+$/, `variável fora do padrão para ${chave}: ${nome}`);
  }

  // Nenhuma variável repetida: duas chaves com a mesma env fariam a segunda
  // sobrescrever a primeira em silêncio.
  const nomes = Object.values(ENV_KEYS);
  assert.equal(new Set(nomes).size, nomes.length, "duas chaves compartilham a mesma variável de ambiente");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 — toda env declarada é DE FATO aplicada, com proveniência
// ─────────────────────────────────────────────────────────────────────────────

test("toda variável de ambiente declarada muda a config e registra a proveniência", () => {
  for (const [chave, nome] of Object.entries(ENV_KEYS)) {
    const spec = CONFIG_SCHEMA[chave]!;
    const cfg = loadConfig({ read_file: false, env: { [nome]: spec.exemplo } });
    assert.equal(
      cfg.sources[chave],
      `env:${nome}`,
      `${nome}=${spec.exemplo} não foi aplicada em ${chave} (proveniência veio "${cfg.sources[chave]}")`,
    );
  }
});

test("controle negativo: sem a variável, a proveniência é default", () => {
  const cfg = limpa();
  for (const chave of Object.keys(ENV_KEYS)) {
    assert.equal(cfg.sources[chave], "default", `${chave} nasceu com proveniência ${cfg.sources[chave]}`);
  }
});

test("toda variável recusa valor inválido com mensagem que nomeia campo e origem", () => {
  for (const [chave, nome] of Object.entries(ENV_KEYS)) {
    const spec = CONFIG_SCHEMA[chave]!;
    const ruim = invalidoPara(spec);
    let erro: unknown;
    try {
      loadConfig({ read_file: false, env: { [nome]: ruim } });
    } catch (e) {
      erro = e;
    }
    assert.ok(erro instanceof ConfigError, `${nome}=${JSON.stringify(ruim)} foi ACEITO — coerção silenciosa`);
    const msg = (erro as ConfigError).message;
    assert.ok(msg.includes(chave), `mensagem de ${nome} não nomeia o campo: ${msg}`);
    assert.ok(msg.includes(`env:${nome}`), `mensagem de ${nome} não nomeia a origem: ${msg}`);
    if (spec.min !== undefined && spec.max !== undefined) {
      assert.ok(msg.includes(String(spec.min)) && msg.includes(String(spec.max)), `mensagem de ${nome} não diz a faixa: ${msg}`);
    }
    if (spec.valores !== undefined) {
      const known = ((erro as ConfigError).detail as { known?: unknown }).known;
      assert.ok(Array.isArray(known) && known.length > 0, `enum ${chave} não devolveu os valores válidos no detail`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 — a faixa declarada é a faixa IMPOSTA
// ─────────────────────────────────────────────────────────────────────────────

test("faixa declarada é imposta pelo código: min e max passam, min-1 e max+1 são recusados", () => {
  for (const [chave, spec] of Object.entries(CONFIG_SCHEMA)) {
    if (spec.min === undefined || spec.max === undefined) continue;
    assert.doesNotThrow(() => aplicarChaveIsolada(chave, String(spec.min), "probe"), `${chave}: mínimo declarado ${spec.min} foi recusado`);
    assert.doesNotThrow(() => aplicarChaveIsolada(chave, String(spec.max), "probe"), `${chave}: máximo declarado ${spec.max} foi recusado`);
    assert.throws(
      () => aplicarChaveIsolada(chave, String(spec.min! - 1), "probe"),
      ConfigError,
      `${chave}: ${spec.min! - 1} passou — a faixa declarada mente no piso`,
    );
    assert.throws(
      () => aplicarChaveIsolada(chave, String(spec.max! + 1), "probe"),
      ConfigError,
      `${chave}: ${spec.max! + 1} passou — a faixa declarada mente no teto`,
    );
  }
});

test("inteiro declarado não aceita fracionário — nem por arredondamento silencioso", () => {
  for (const [chave, spec] of Object.entries(CONFIG_SCHEMA)) {
    if (spec.tipo !== "inteiro" || spec.min === undefined) continue;
    assert.throws(
      () => aplicarChaveIsolada(chave, String(spec.min! + 0.5), "probe"),
      ConfigError,
      `${chave} aceitou fracionário sendo declarado inteiro`,
    );
  }
});

test("enum declarado aceita todos os seus valores e recusa qualquer outro", () => {
  for (const [chave, spec] of Object.entries(CONFIG_SCHEMA)) {
    if (spec.valores === undefined) continue;
    assert.ok(spec.valores.length > 0, `${chave} declara enum vazio`);
    for (const v of spec.valores) {
      assert.doesNotThrow(() => aplicarChaveIsolada(chave, v, "probe"), `${chave}: valor declarado "${v}" foi recusado`);
    }
    assert.throws(() => aplicarChaveIsolada(chave, "__nao_existe__", "probe"), ConfigError, `${chave} aceitou valor fora do enum`);
  }
});

test("todo exemplo declarado no schema é válido", () => {
  for (const [chave, spec] of Object.entries(CONFIG_SCHEMA)) {
    assert.doesNotThrow(() => aplicarChaveIsolada(chave, spec.exemplo, "probe"), `exemplo inválido em ${chave}: ${spec.exemplo}`);
  }
});

test("provider-ref declarado recusa backend desconhecido e modelo vazio", () => {
  for (const [chave, spec] of Object.entries(CONFIG_SCHEMA)) {
    if (spec.tipo !== "provider-ref") continue;
    assert.throws(() => aplicarChaveIsolada(chave, "gpt4:foo", "probe"), ConfigError, `${chave} aceitou backend desconhecido`);
    assert.throws(() => aplicarChaveIsolada(chave, "ollama:", "probe"), ConfigError, `${chave} aceitou modelo vazio`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 — redação
// ─────────────────────────────────────────────────────────────────────────────

test("chave sensível sai redigida e chave comum sai em claro", () => {
  const cfg = loadConfig({
    read_file: false,
    env: {},
    sessions_root: "/Users/dono-secreto/nomos/sessoes",
    upload_root: "/Users/dono-secreto/Uploads",
    download_root: "/Users/dono-secreto/Downloads",
    profiles_root: "/Users/dono-secreto/Perfis",
    tasks_root: "/Users/dono-secreto/Tasks",
  });
  const visto = redigirConfig(cfg);

  for (const [chave, spec] of Object.entries(CONFIG_SCHEMA)) {
    if (chave.includes(".")) continue;
    const v = visto[chave];
    if (spec.sensivel) {
      if (v === null) continue; // ausência não é segredo — ver `redigirConfig`
      assert.equal(v, REDACAO, `chave sensível ${chave} saiu em claro: ${String(v)}`);
    } else if (typeof v === "string") {
      assert.notEqual(v, REDACAO, `chave NÃO sensível ${chave} foi redigida sem motivo`);
    }
  }

  // Prova direta: nenhum pedaço do caminho do dono sobrevive na resposta.
  assert.ok(!JSON.stringify(visto).includes("dono-secreto"), "o caminho do dono vazou na resposta redigida");
  // Controle: `host` e `port` NÃO são redigidos — quem lê já falou com eles.
  assert.equal(visto.host, cfg.host);
  assert.equal(visto.port, cfg.port);
  // A proveniência continua viajando: "por que está assim?" é a pergunta da rota.
  assert.equal((visto.sources as Record<string, string>).sessions_root, "override");
});

test("controle negativo: describeConfig sem redação DEIXA o caminho passar", async () => {
  // Este teste existe para provar que a redação é o que pega o caso, e não uma
  // coincidência de um caminho que já saía vazio.
  const { describeConfig } = await import("../packages/api/src/config.ts");
  const cfg = loadConfig({ read_file: false, env: {}, sessions_root: "/Users/dono-secreto/nomos/sessoes" });
  assert.ok(JSON.stringify(describeConfig(cfg)).includes("dono-secreto"));
  assert.ok(!JSON.stringify(redigirConfig(cfg)).includes("dono-secreto"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Saída gerada
// ─────────────────────────────────────────────────────────────────────────────

test("o schema exposto carrega default e env LIDOS do código, não redigitados", () => {
  const cfg = limpa() as unknown as Record<string, unknown>;
  for (const e of configSchema()) {
    assert.equal(e.env, ENV_KEYS[e.chave] ?? null, `env divergente em ${e.chave}`);
    const esperado = e.chave.includes(".")
      ? (cfg[raizDe(e.chave)] as Record<string, unknown>)[e.chave.slice(e.chave.indexOf(".") + 1)]
      : cfg[e.chave];
    assert.deepEqual(e.default, esperado, `default divergente em ${e.chave}`);
    assert.ok(e.resumo.trim().length > 10, `${e.chave} sem resumo útil`);
  }
  assert.equal(configSchema().length, Object.keys(CONFIG_SCHEMA).length);
});

test("a tabela markdown lista TODAS as variáveis de ambiente", () => {
  const md = configSchemaMarkdown();
  for (const nome of Object.values(ENV_KEYS)) {
    assert.ok(md.includes(`\`${nome}\``), `${nome} não aparece na tabela gerada`);
  }
  for (const chave of Object.keys(CONFIG_SCHEMA)) {
    assert.ok(md.includes(`\`${chave}\``), `${chave} não aparece na tabela gerada`);
  }
  assert.ok(md.includes("NOMOS_BROWSER_CONFIG"), "a variável do arquivo de config não foi documentada");
});

test("a rota de schema não carrega valor efetivo nenhum", () => {
  // Contrato de `GET /api/v1/config/schema`: FORMA, nunca estado. Um valor
  // efetivo aqui furaria o ADMIN exigido por `GET /api/v1/config`.
  //
  // A propriedade que prova isso é INVARIÂNCIA: o schema tem de sair idêntico
  // com o daemon configurado e com o daemon virgem. Comparar contra `null` não
  // provaria nada — `providers_base_url` tem default de fábrica não nulo, e ele
  // é constante do PRODUTO (`http://127.0.0.1:11434`), não dado do dono.
  const antes = JSON.stringify(configSchema());
  loadConfig({
    read_file: false,
    env: { NOMOS_BROWSER_PORT: "9999", NOMOS_BROWSER_AUDIT: "false" },
    sessions_root: "/Users/dono-secreto/nomos/sessoes",
    providers_base_url: "http://localhost:1/segredo",
    providers_allow_remote: true,
  });
  const depois = JSON.stringify(configSchema());
  assert.equal(depois, antes, "o schema mudou depois de configurar o daemon — ele está carregando estado");
  assert.ok(!antes.includes("dono-secreto"), "caminho do dono apareceu no schema");
  assert.ok(!antes.includes("segredo"), "endpoint configurado apareceu no schema");
  // E o default publicado de toda chave sensível é o de FÁBRICA: nulo, ou uma
  // constante do produto que não nomeia nada desta máquina.
  for (const e of configSchema()) {
    if (!e.sensivel) continue;
    assert.ok(
      e.default === null || (typeof e.default === "string" && !e.default.includes(process.env.HOME ?? "\u0000")),
      `default de chave sensível ${e.chave} carrega caminho desta máquina: ${String(e.default)}`,
    );
  }
});
