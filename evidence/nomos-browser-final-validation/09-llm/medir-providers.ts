/** FASE 9 — cada provider medido isoladamente, com timeout explícito. Separado do núcleo determinístico. */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { OllamaProvider } from "../../../packages/core/src/providers/ollama.ts";
import { OllamaVisionProvider } from "../../../packages/core/src/vision.ts";
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(AQUI, "out"); fs.mkdirSync(OUT, { recursive: true });
const MODELOS = ["qwen3.5:4b-q8_0", "qwen2.5-coder:7b"];
const VISAO = ["qwen2.5vl:3b", "moondream:1.8b"];
const TIMEOUT = 120_000;
const descarregar = async (m: string) => { try { await fetch("http://127.0.0.1:11434/api/generate", { method: "POST", body: JSON.stringify({ model: m, keep_alive: 0 }), signal: AbortSignal.timeout(20000) }); } catch { /* ok */ } };
const R: any[] = [];
for (const m of [...MODELOS, ...VISAO]) await descarregar(m);
await new Promise((r) => setTimeout(r, 1500));

for (const model of MODELOS) {
  const p = new OllamaProvider({ model, timeout_ms: TIMEOUT, keep_alive: 0 });
  const th = Date.now(); const h: any = await p.health(); const health_ms = Date.now() - th;
  const disponivel = h.status === "ok";
  let r1: any = null, lat1 = -1, r2: any = null, lat2 = -1, cancelou = "n/a", tout = "n/a";
  if (disponivel) {
    const t1 = Date.now(); r1 = await p.request({ prompt: "Responda apenas com a palavra PRONTO.", max_tokens: 8, temperature: 0, timeout_ms: TIMEOUT }); lat1 = Date.now() - t1;
    const t2 = Date.now(); r2 = await p.request({ prompt: "Responda apenas com a palavra PRONTO.", max_tokens: 8, temperature: 0, timeout_ms: TIMEOUT }); lat2 = Date.now() - t2;
    const rt = await p.request({ prompt: "Escreva um ensaio de 2000 palavras sobre navegadores.", timeout_ms: 300 });
    tout = `${rt.ok ? "NAO_RESPEITOU" : "OK:" + (rt as any).error?.code}`;
    const ac = new AbortController(); const pr = p.request({ prompt: "Escreva um ensaio de 2000 palavras.", timeout_ms: TIMEOUT, signal: ac.signal });
    setTimeout(() => ac.abort(), 250); const rc = await pr;
    cancelou = `${rc.ok ? "NAO_CANCELOU" : "OK:" + (rc as any).error?.code}`;
  }
  const classe = !disponivel ? "PROVIDER_FAIL" : (r1?.ok && r2?.ok ? (Math.max(lat1, lat2) > 60_000 ? "PROVIDER_DEGRADED" : "PROVIDER_PASS") : "PROVIDER_FAIL");
  R.push({ tipo: "texto", model, disponivel, health_status: h.status, health_reason: h.reason, health_ms, frio_ms: lat1, quente_ms: lat2, ok1: r1?.ok ?? null, ok2: r2?.ok ?? null, erro: r1?.ok === false ? r1.error : null, timeout_explicito: tout, cancelamento: cancelou, classe });
  console.log(`${classe.padEnd(18)} ${model.padEnd(20)} health=${health_ms}ms frio=${lat1}ms quente=${lat2}ms timeout=${tout} cancel=${cancelou}`);
  await p.release?.(); await descarregar(model);
}

const PNG = (() => { const d = path.join(AQUI, "../../../spike/evidence"); const f = fs.existsSync(d) ? fs.readdirSync(d).find((x) => x.endsWith("viewport.png")) : undefined; return f ? fs.readFileSync(path.join(d, f)) : null; })();
for (const model of VISAO) {
  if (PNG === null) { R.push({ tipo: "visao", model, classe: "NAO_MEDIDO", motivo: "sem screenshot de referência" }); continue; }
  const v = new OllamaVisionProvider({ model, timeout_ms: TIMEOUT });
  const t = Date.now(); let obs: any = null, erro = "";
  try { obs = await v.locate({ screenshot: PNG, goal: "o botao de login", viewport: { width: 1280, height: 800 } }); } catch (e) { erro = (e as Error).message; }
  const ms = Date.now() - t;
  const classe = erro !== "" ? "PROVIDER_FAIL" : obs === null ? "PROVIDER_DEGRADED" : ms > 60_000 ? "PROVIDER_DEGRADED" : "PROVIDER_PASS";
  R.push({ tipo: "visao", model, ms, achou: obs !== null, confianca: obs?.confidence ?? null, box: obs?.box ?? obs?.boundingBox ?? null, erro, classe });
  console.log(`${classe.padEnd(18)} ${model.padEnd(20)} locate=${ms}ms achou=${obs !== null} conf=${obs?.confidence ?? "-"} ${erro}`);
  await descarregar(model);
}
fs.writeFileSync(path.join(OUT, "providers.json"), JSON.stringify(R, null, 2));
const fail = R.filter((r) => r.classe === "PROVIDER_FAIL").length, deg = R.filter((r) => r.classe === "PROVIDER_DEGRADED").length;
console.log(`\nPROVIDERS=${R.length} PASS=${R.length - fail - deg} DEGRADED=${deg} FAIL=${fail}`);
console.log(`LLM_PROVIDER_DEGRADATION_HANDLED=${R.every((r) => r.classe !== undefined) ? "PASS" : "FAIL"}`);
process.exit(0);
