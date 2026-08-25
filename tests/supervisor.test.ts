/**
 * FASE 14 — SUPERVISÃO E ARRANQUE
 *
 * Este produto não tinha supervisor algum: o daemon subia à mão e morria com o
 * terminal. Esta suíte cobre o que dá para provar SEM mexer no launchd da
 * máquina, e é deliberada nessa separação:
 *
 *   AQUI   template do LaunchAgent, política de recusa do instalador, trava de
 *          instância única (processo real) e encerramento gracioso (SIGTERM real).
 *
 *   NO EVIDENCE   `evidence/nomos-browser-final-loop/14-supervisor/prova-supervisor.sh`
 *          faz o ciclo completo contra o launchd de verdade: install → start →
 *          health → duplo start → SIGTERM → SIGKILL (reinício com PID novo) →
 *          crash-loop → stop → uninstall.
 *
 * POR QUE A SEPARAÇÃO
 * -------------------
 * Esta máquina roda quatro serviços NOMOS de PRODUÇÃO sob launchd. Um teste de
 * suíte que instala e desinstala LaunchAgent a cada execução é um teste que, no
 * dia em que falhar no meio, deixa estado carregado na máquina do dono. O ciclo
 * completo é um ato deliberado, rodado por quem sabe o que está fazendo, e que
 * termina com o serviço DESINSTALADO.
 *
 * Tudo que este arquivo executa de `service.sh` roda com `HOME` apontando para
 * um diretório temporário: nenhum `~/Library/LaunchAgents` real é tocado.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE = path.join(RAIZ, "scripts", "service.sh");
const TEMPLATE = path.join(RAIZ, "packaging", "launchd", "ai.nomos.browser.plist");
const DAEMON = path.join(RAIZ, "packages", "api", "src", "daemon.ts");
const LABEL = "ai.nomos.browser";

/** Labels que este repositório JAMAIS pode tocar. Ver `scripts/service.sh`. */
const PRODUCAO = [
  "br.com.se7enpay.nomos.servico",
  "com.nomos.panel",
  "ai.sovereign.omniroute",
  "com.gijarvis.backend",
];

const GATE: Record<string, string> = {
  SUPERVISION: "FAIL",
  SINGLE_OWNER: "FAIL",
  RESTART_POLICY: "FAIL",
  GRACEFUL_SHUTDOWN: "FAIL",
  REBOOT_SAFETY: "FAIL",
};

let lar = "";
let runtimeDir = "";
let sessoesDir = "";
const filhos: ChildProcess[] = [];

before(() => {
  lar = mkdtempSync(path.join(os.tmpdir(), "nomos-sup-home-"));
  runtimeDir = mkdtempSync(path.join(os.tmpdir(), "nomos-sup-rt-"));
  sessoesDir = mkdtempSync(path.join(os.tmpdir(), "nomos-sup-sess-"));
  mkdirSync(path.join(lar, "Library", "LaunchAgents"), { recursive: true });
});

after(() => {
  for (const f of filhos) {
    try {
      f.kill("SIGKILL");
    } catch {
      // já morto
    }
  }
  for (const d of [lar, runtimeDir, sessoesDir]) rmSync(d, { recursive: true, force: true });
});

interface Saida {
  code: number;
  out: string;
}

/** Roda `service.sh` com HOME sandboxado. Nunca toca o LaunchAgents real. */
function servico(args: string[], env: Record<string, string> = {}): Saida {
  try {
    const out = execFileSync("/bin/bash", [SERVICE, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: lar,
        NOMOS_RUNTIME_DIR: runtimeDir,
        NOMOS_SESSIONS_ROOT: sessoesDir,
        NOMOS_BROWSER_LOG_DIR: path.join(lar, "Library", "Logs", "nomos-browser"),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ═════════════════════════════════════════════════════════════════════════════
// 1. O TEMPLATE
// ═════════════════════════════════════════════════════════════════════════════

test("1. o LaunchAgent existe, é plist válido e carrega a política exigida", () => {
  assert.ok(existsSync(TEMPLATE), `template ausente: ${TEMPLATE}`);
  // `plutil -lint` no TEMPLATE: ele tem placeholders, mas continua sendo XML
  // plist válido — um template que não lint não vira instalação que funciona.
  execFileSync("/usr/bin/plutil", ["-lint", TEMPLATE], { encoding: "utf8" });

  const texto = readFileSync(TEMPLATE, "utf8");

  // KeepAlive CONDICIONAL, não `true`. Saída 0 é o dono mandando parar; um
  // KeepAlive incondicional impediria o dono de parar o próprio serviço.
  assert.match(texto, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.doesNotMatch(texto, /<key>KeepAlive<\/key>\s*<true\/>/, "KeepAlive incondicional impede parar o serviço");

  // ThrottleInterval é a defesa contra laço de crash no nível do launchd.
  const throttle = /<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(texto);
  assert.ok(throttle !== null, "sem ThrottleInterval o launchd respawna em laço");
  assert.ok(Number(throttle[1]) >= 10, `ThrottleInterval ${throttle[1]}s é curto demais para segurar crash-loop`);

  assert.match(texto, /<key>RunAtLoad<\/key>\s*<true\/>/, "sem RunAtLoad não sobe no login");
  assert.match(texto, /<key>StandardOutPath<\/key>\s*<string>@LOG_DIR@\/stdout\.log<\/string>/);
  assert.match(texto, /<key>StandardErrorPath<\/key>\s*<string>@LOG_DIR@\/stderr\.log<\/string>/);
  // ExitTimeOut dá ao daemon tempo de fechar sessões e navegadores no SIGTERM.
  assert.match(texto, /<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/);

  // Label PRÓPRIA e sem colisão com produção.
  //
  // A checagem é sobre os VALORES do plist, não sobre o arquivo inteiro: o
  // comentário do template cita as labels de produção de propósito, para
  // explicar por que a nossa é separada. Proibir a menção proibiria explicar a
  // decisão — o que se proíbe é USAR uma delas.
  assert.match(texto, /<key>Label<\/key>\s*<string>@LABEL@<\/string>/);
  const semComentarios = texto.replace(/<!--[\s\S]*?-->/g, "");
  for (const p of PRODUCAO) {
    assert.ok(!semComentarios.includes(p), `o template USA a label de produção ${p}`);
  }
});

test("2. a label do produto não colide com nenhum serviço de produção", () => {
  assert.ok(!PRODUCAO.includes(LABEL), `${LABEL} é label de produção`);
  const sh = readFileSync(SERVICE, "utf8");
  assert.match(sh, /^LABEL="ai\.nomos\.browser"$/m);
  // A lista de intocáveis está NO script, não só nesta suíte: a proibição tem
  // de valer para quem roda o script à mão, não só para quem roda o teste.
  for (const p of PRODUCAO) assert.ok(sh.includes(p), `service.sh não conhece a label protegida ${p}`);
  assert.match(sh, /guarda_label/, "service.sh não tem guarda de label");
});

test("3. service.sh oferece os oito subcomandos e é sintaticamente válido", () => {
  execFileSync("/bin/bash", ["-n", SERVICE], { encoding: "utf8" });
  const sh = readFileSync(SERVICE, "utf8");
  for (const c of ["install", "uninstall", "start", "stop", "restart", "status", "health", "logs"]) {
    assert.match(sh, new RegExp(`^\\s*${c}\\)`, "m"), `subcomando ausente: ${c}`);
  }
  const semComando = servico([]);
  assert.equal(semComando.code, 2, "sem subcomando deveria ser erro de uso");
  assert.match(semComando.out, /uso:/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. A RECUSA QUE PROTEGE O VIZINHO
// ═════════════════════════════════════════════════════════════════════════════

test("4. install RECUSA quando o plist no nosso caminho declara outra label", () => {
  const alvo = path.join(lar, "Library", "LaunchAgents", `${LABEL}.plist`);
  // Um plist de terceiro ocupando o nosso caminho. Instalar por cima seria
  // sobrescrever a configuração de um serviço que não instalamos.
  writeFileSync(
    alvo,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.terceiro.servico</string>
  <key>ProgramArguments</key><array><string>/bin/echo</string></array>
</dict></plist>
`,
    "utf8",
  );
  const r = servico(["install"]);
  assert.equal(r.code, 4, `esperava recusa (4), veio ${r.code}: ${r.out}`);
  assert.match(r.out, /Recuso sobrescrever|não é nosso/);
  // E o arquivo do terceiro fica INTACTO.
  assert.match(readFileSync(alvo, "utf8"), /com\.terceiro\.servico/);
  rmSync(alvo);
  GATE.SUPERVISION = "PASS";
});

test("5. status responde sem serviço instalado, em vez de estourar", () => {
  const r = servico(["status"]);
  // `status` sai 1 quando não está rodando — é o contrato de um healthcheck de
  // shell, e é isso que permite usá-lo em `if`.
  assert.ok(r.code === 0 || r.code === 1, `status estourou: ${r.code} ${r.out}`);
  assert.match(r.out, /LABEL=ai\.nomos\.browser/);
  assert.match(r.out, /ESTADO=parado/);
});

test("6. health sem daemon de pé responde FAIL, não trava nem mente", () => {
  const r = servico(["health"], { NOMOS_BROWSER_PORT: "7999" });
  assert.equal(r.code, 1);
  assert.match(r.out, /HEALTH=FAIL/);
  assert.match(r.out, /sem_resposta/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. INSTÂNCIA ÚNICA — com PROCESSOS DE VERDADE
// ═════════════════════════════════════════════════════════════════════════════

interface Subido {
  proc: ChildProcess;
  porta: number;
  /**
   * Buffer VIVO. A primeira versão devolvia `saida: string` — uma cópia do
   * valor no instante do `return`, que ficava eternamente vazia enquanto o
   * processo escrevia. Os casos 7 e 8 falharam contra a string vazia e o
   * defeito era do instrumento, não do produto.
   */
  buf: { txt: string };
}

/** Sobe o daemon como PROCESSO e espera ele anunciar a porta. */
async function subirDaemon(rt: string, porta: number, extra: Record<string, string> = {}): Promise<Subido> {
  const proc = spawn(process.execPath, [DAEMON], {
    cwd: RAIZ,
    env: {
      ...process.env,
      NOMOS_RUNTIME_DIR: rt,
      NOMOS_BROWSER_PORT: String(porta),
      NOMOS_BROWSER_HEADLESS: "true",
      NOMOS_SESSIONS_ROOT: sessoesDir,
      NOMOS_BROWSER_WATCHDOG_ENABLED: "false",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  filhos.push(proc);
  const buf = { txt: "" };
  proc.stdout?.setEncoding("utf8");
  proc.stderr?.setEncoding("utf8");
  proc.stdout?.on("data", (c: string) => (buf.txt += c));
  proc.stderr?.on("data", (c: string) => (buf.txt += c));

  // Espera o daemon SE ANUNCIAR (ou morrer). Esperar o arquivo de trava aparecer
  // não serve: no caso da trava obsoleta ele já existe antes de o processo
  // nascer, e a espera terminava antes de o daemon ter feito coisa alguma.
  const prazo = Date.now() + 60_000;
  while (Date.now() < prazo) {
    if (/nomos-browser em http|já existe um nomos-browser vivo/.test(buf.txt)) break;
    if (proc.exitCode !== null) break;
    await dormir(150);
  }
  return { proc, porta, buf };
}

function lockDe(rt: string): { pid: number; port: number } | null {
  const f = path.join(rt, "daemon.lock");
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8")) as { pid: number; port: number };
}

test("7. DUAS instâncias sobre o mesmo runtime: a segunda RECUSA subir", async () => {
  const rt = mkdtempSync(path.join(os.tmpdir(), "nomos-sup-uno-"));
  const porta = 7911;
  try {
    const primeiro = await subirDaemon(rt, porta);
    assert.equal(primeiro.proc.exitCode, null, `o primeiro daemon nem subiu: ${primeiro.buf.txt.slice(-500)}`);
    const lock = lockDe(rt);
    assert.ok(lock !== null, "o primeiro daemon não gravou a trava de instância");
    assert.equal(lock.pid, primeiro.proc.pid);
    assert.equal(lock.port, porta);

    // Segundo daemon, MESMO runtime_dir. Sem a trava, dois Chromium disputariam
    // o mesmo `userDataDir` — que é como se corrompe o perfil do dono.
    const segundo = await subirDaemon(rt, porta + 1);
    const saiu = await new Promise<number | null>((r) => {
      if (segundo.proc.exitCode !== null) return r(segundo.proc.exitCode);
      const t = setTimeout(() => r(null), 20_000);
      segundo.proc.once("exit", (c) => {
        clearTimeout(t);
        r(c);
      });
    });
    assert.equal(saiu, 9, `a segunda instância deveria sair com 9 (já rodando), saiu ${String(saiu)}: ${segundo.buf.txt.slice(-400)}`);
    assert.match(segundo.buf.txt, /já existe um nomos-browser vivo/);
    // A trava continua sendo a do PRIMEIRO — o intruso não a reescreveu.
    assert.equal(lockDe(rt)?.pid, primeiro.proc.pid, "a segunda instância corrompeu a trava da primeira");

    // ── encerramento gracioso ────────────────────────────────────────────────
    primeiro.proc.kill("SIGTERM");
    const codigo = await new Promise<number | null>((r) => {
      const t = setTimeout(() => r(null), 40_000);
      primeiro.proc.once("exit", (c) => {
        clearTimeout(t);
        r(c);
      });
    });
    assert.equal(codigo, 0, `SIGTERM deveria encerrar limpo (0), veio ${String(codigo)}`);
    assert.match(primeiro.buf.txt, /SIGTERM recebido/);
    // A trava some no encerramento limpo — deixá-la faria o caminho normal
    // depender da checagem de PID morto, que é o caminho de exceção.
    assert.equal(existsSync(path.join(rt, "daemon.lock")), false, "SIGTERM deixou a trava para trás");
    // Nenhum processo residual: o pid morreu de verdade.
    assert.throws(() => process.kill(primeiro.proc.pid!, 0), /ESRCH/);

    GATE.SINGLE_OWNER = "PASS";
    GATE.GRACEFUL_SHUTDOWN = "PASS";
  } finally {
    rmSync(rt, { recursive: true, force: true });
  }
});

test("8. trava OBSOLETA (pid morto) não emparedeia o daemon", async () => {
  const rt = mkdtempSync(path.join(os.tmpdir(), "nomos-sup-obs-"));
  try {
    // Trava de um PID que não existe: é o que sobra depois de um SIGKILL.
    // Um daemon que respeitasse isso cegamente nunca mais subiria.
    mkdirSync(rt, { recursive: true });
    writeFileSync(
      path.join(rt, "daemon.lock"),
      JSON.stringify({ pid: 999_999, port: 7912, started_at: new Date().toISOString(), argv: "fantasma" }),
      "utf8",
    );
    const d = await subirDaemon(rt, 7912);
    assert.equal(d.proc.exitCode, null, `o daemon foi emparedeado por trava obsoleta: ${d.buf.txt.slice(-400)}`);
    assert.match(d.buf.txt, /trava obsoleta/);
    assert.equal(lockDe(rt)?.pid, d.proc.pid, "a trava não foi assumida pelo daemon novo");
    d.proc.kill("SIGTERM");
    await new Promise<void>((r) => d.proc.once("exit", () => r()));
    GATE.RESTART_POLICY = "PASS";
  } finally {
    rmSync(rt, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. REBOOT
// ═════════════════════════════════════════════════════════════════════════════

test("9. REBOOT_SAFETY — o que dá para provar, e a limitação declarada", () => {
  // LIMITAÇÃO DECLARADA: reiniciar esta máquina não é possível dentro do teste,
  // e não seria aceitável mesmo que fosse — ela roda quatro serviços NOMOS de
  // produção. O que se prova aqui é a CONDIÇÃO de sobreviver ao reboot:
  // `RunAtLoad` faz o launchd subir o agente quando o dono entra na sessão, e o
  // `KeepAlive` condicional o mantém de pé depois. A simulação equivalente
  // (`launchctl kickstart -k`, que mata e ressobe pelo launchd) está no
  // `prova-supervisor.sh` e é onde o comportamento é observado de fato.
  const texto = readFileSync(TEMPLATE, "utf8");
  assert.match(texto, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(texto, /<key>KeepAlive<\/key>\s*<dict>/);
  const sh = readFileSync(SERVICE, "utf8");
  // O `install` usa `bootstrap gui/<uid>`, que é o domínio POR SESSÃO DE LOGIN —
  // é ele que faz o agente voltar no login seguinte.
  assert.match(sh, /launchctl bootstrap "\$DOMINIO"/);
  assert.match(sh, /DOMINIO="gui\/\$\(id -u\)"/);
  GATE.REBOOT_SAFETY = "PASS (por RunAtLoad + bootstrap gui/UID; reboot real não executado — ver prova-supervisor.sh)";
});

test("99. portões da FASE 14", () => {
  for (const [k, v] of Object.entries(GATE)) process.stderr.write(`${k}=${v}\n`);
  const falhos = Object.entries(GATE).filter(([, v]) => v === "FAIL");
  assert.deepEqual(falhos, [], `portões não atingidos: ${falhos.map(([k]) => k).join(", ")}`);
});
