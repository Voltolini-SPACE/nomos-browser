/**
 * REPRODUTOR MÍNIMO — cenário 16 (negação de política auditada).
 *
 * SINTOMA: o CONTROLE POSITIVO do cenário falhou. Com a capability `download`
 * CONCEDIDA, a mesma rota devolveu `403 DOWNLOAD_DENIED` em vez de baixar — e o
 * cenário, corretamente, reprovou.
 *
 * CAUSA RAIZ (do INSTRUMENTO): o daemon do bloco D subiu SEM `download_root`.
 * Sem raiz configurada não existe "dentro da raiz", e `handleDownload` nega
 * fail-closed antes de olhar capability nenhuma. O controle positivo estava,
 * portanto, medindo a ausência de configuração — não a capability.
 *
 * O ponto que este arquivo fixa: os DOIS "não" têm códigos DIFERENTES, e é isso
 * que torna o cenário 16 capaz de reprovar de verdade.
 *   • sem capability          ⇒ 403 CAPABILITY_DENIED
 *   • sem download_root       ⇒ 403 DOWNLOAD_DENIED
 *
 * CONSERTO APLICADO na bateria: o daemon do bloco D passou a receber
 * `NOMOS_BROWSER_DOWNLOAD_ROOT`.
 *
 * Uso: node evidence/nomos-browser-final-loop/19-e2e/out/repro-16.ts
 */
import { CAPS, daemonMinimo } from "./repro-comum.ts";

const d = await daemonMinimo(); // DE PROPÓSITO: sem NOMOS_BROWSER_DOWNLOAD_ROOT
let ok = false;
try {
  const sessao = async (download: boolean): Promise<string> =>
    (
      await d.post<{ session_id: string }>("/api/v1/sessions", {
        owner: `REPRO-16-${download ? "com" : "sem"}`,
        profile: "sandbox",
        headless: true,
        capabilities: { ...CAPS, download },
      })
    ).body.session_id;

  const baixar = async (sid: string): Promise<{ status: number; code: string | null }> => {
    const r = await d.post<{ error?: { code?: string } }>("/api/v1/browser.download", {
      session_id: sid,
      url: "http://127.0.0.1:1/nada",
    });
    return { status: r.status, code: r.body.error?.code ?? null };
  };

  const sem = await baixar(await sessao(false));
  const com = await baixar(await sessao(true));
  console.log(`capability download=false : http=${sem.status} code=${sem.code}`);
  console.log(`capability download=true  : http=${com.status} code=${com.code}   (download_root NÃO configurado)`);

  ok = sem.code === "CAPABILITY_DENIED" && com.code === "DOWNLOAD_DENIED";
  console.log(`\nCONCLUSÃO: os dois "não" são DISTINGUÍVEIS pelo código = ${ok ? "CONFIRMADO" : "NÃO CONFIRMADO"}`);
  console.log("Sem download_root, o controle positivo do cenário 16 mediria a CONFIGURAÇÃO, não a capability.");
  console.log(`REPRO_16=${ok ? "CONFIRMA_CAUSA_RAIZ" : "NAO_REPRODUZ"}`);
} finally {
  await d.fechar();
}
process.exit(ok ? 0 : 1);
