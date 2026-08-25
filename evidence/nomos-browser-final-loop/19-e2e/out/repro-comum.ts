/**
 * FASE 19 — mínimo comum aos reprodutores.
 *
 * Sobe UM daemon real em processo separado, devolve URL, token e um `post`.
 * Nada de asserção aqui: cada reprodutor imprime o FATO e sai 0/1 sozinho.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export interface Mini {
  url: string;
  token: string;
  proc: ChildProcess;
  post: <T>(rota: string, corpo: unknown) => Promise<{ status: number; body: T }>;
  fechar: () => Promise<void>;
}

export async function daemonMinimo(extra: Record<string, string> = {}): Promise<Mini> {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-repro19-"));
  const runtimeDir = path.join(raiz, "rt");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NOMOS_RUNTIME_DIR: runtimeDir,
    NOMOS_BROWSER_PORT: "0",
    NOMOS_BROWSER_HOST: "127.0.0.1",
    NOMOS_BROWSER_HEADLESS: "true",
    NOMOS_BROWSER_ALLOW_INTERNAL: "true",
    NOMOS_BROWSER_PROFILES_ROOT: path.join(raiz, "perfis"),
    NOMOS_SESSIONS_ROOT: path.join(raiz, "sessoes"),
    ...extra,
  };
  delete env.NOMOS_BROWSER_CONFIG;
  const proc = spawn(process.execPath, [path.join(RAIZ, "packages/api/src/daemon.ts")], {
    cwd: RAIZ,
    stdio: ["ignore", "ignore", "pipe"],
    env,
  });
  let buf = "";
  const url = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`daemon não subiu: ${buf.slice(-800)}`)), 120_000);
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (d: string) => {
      buf += d;
      const m = /nomos-browser em (http:\/\/\S+)/.exec(buf);
      if (m !== null) {
        clearTimeout(t);
        resolve(m[1]!);
      }
    });
  });
  const token = fs.readFileSync(path.join(runtimeDir, "control-token"), "utf8").trim();
  return {
    url,
    token,
    proc,
    post: async <T,>(rota: string, corpo: unknown) => {
      const r = await fetch(`${url}${rota}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(corpo),
      });
      return { status: r.status, body: (await r.json()) as T };
    },
    fechar: async () => {
      proc.kill("SIGTERM");
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          proc.kill("SIGKILL");
          r();
        }, 15_000);
        proc.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
      fs.rmSync(raiz, { recursive: true, force: true });
    },
  };
}

export const CAPS = {
  navigate: true,
  read: true,
  click: true,
  type: true,
  download: false,
  upload: false,
  send: false,
  purchase: false,
  payment: false,
  delete: false,
};
