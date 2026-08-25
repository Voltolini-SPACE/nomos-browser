// ─────────────────────────────────────────────────────────────────────────────
// SONDA — o socket morre no cliente enquanto ele ainda o considera vivo?
//
// HIPÓTESE (a testar, não a assumir): o daemon não define `keepAliveTimeout`, e
// o default do Node é 5 s. Um cliente HTTP com keep-alive — `fetch` do Node, o
// SDK, a CLI, qualquer agente — guarda o socket ocioso e o REUSA na próxima
// ação. Se a pausa passar de 5 s, o servidor já fechou: o cliente escreve num
// socket morto e recebe ECONNRESET, que no `fetch` aparece como o inútil
// "TypeError: fetch failed".
//
// Por que isso importa NESTE produto: um agente pausa entre ações — pensa,
// chama um modelo, espera aprovação do dono. Pausa de mais de 5 s é o NORMAL
// aqui, não a exceção.
//
// Uso: node sonda-keepalive.mjs <url> <token> <segundos_de_pausa>
// Saída: uma linha `RESULTADO=...` e código de saída 0 (sobreviveu) ou 1 (caiu).
// ─────────────────────────────────────────────────────────────────────────────
import http from "node:http";

const [, , URL_BASE, TOKEN, PAUSA_S = "6"] = process.argv;
const pausa = Number(PAUSA_S) * 1000;
const u = new URL(URL_BASE);

// Agente com keep-alive EXPLÍCITO e janela ociosa maior que a pausa: é assim que
// `fetch`/undici, o SDK e qualquer cliente HTTP sério se comportam por default.
const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 1 });

function pedir(rotulo) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: "/health", method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` }, agent },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ ok: true, status: res.statusCode, rotulo }));
      });
    req.on("error", (e) => resolve({ ok: false, erro: e.code || e.message, rotulo }));
    req.end();
  });
}

const a = await pedir("primeira");
console.log(`PRIMEIRA=${a.ok ? `ok status=${a.status}` : `FALHOU ${a.erro}`}`);
if (!a.ok) { console.log("RESULTADO=INCONCLUSIVO (nem a primeira passou)"); process.exit(2); }

// Quantos sockets ociosos o agente guardou — prova de que há keep-alive de fato.
const ociosos = Object.values(agent.freeSockets).reduce((n, l) => n + l.length, 0);
console.log(`SOCKETS_OCIOSOS_GUARDADOS=${ociosos}`);
if (ociosos === 0) { console.log("RESULTADO=INCONCLUSIVO (cliente nao guardou socket)"); process.exit(2); }

console.log(`PAUSA_MS=${pausa}`);
await new Promise((r) => setTimeout(r, pausa));

const b = await pedir("segunda");
console.log(`SEGUNDA=${b.ok ? `ok status=${b.status}` : `FALHOU ${b.erro}`}`);
if (b.ok) { console.log("RESULTADO=SOBREVIVEU"); process.exit(0); }
console.log(`RESULTADO=SOCKET_MORREU (${b.erro})`);
process.exit(1);
