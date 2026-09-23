import { spawn, type ChildProcess } from "node:child_process";
import { createFetchNetworkClient } from "@sudobility/screenwriter_client";
import { createScreenwriter, DevAuthPort, InMemoryOfflineDocStore, type OfflineDocStore, type Screenwriter } from "../src";

const API_DIR = new URL("../../screenwriter_api/", import.meta.url).pathname;
export const PORT = 19542 + Math.floor(Math.random() * 400);
export const BASE = `http://localhost:${PORT}`;

let server: ChildProcess | null = null;

/** Spawns the real API under Bun on a free port, dev auth bypass, local `screenwriter_test` database. */
export async function startApi(): Promise<void> {
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: API_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: "postgres://localhost:5432/screenwriter_test",
      PUBLIC_APP_URL: "http://localhost:5143",
      AI_TEST_MODE: "1",
      LOG_LEVEL: "error",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("API did not start");
}

export async function stopApi(): Promise<void> {
  const s = server;
  if (!s) return;
  const exited = new Promise(r => s.once("exit", r));
  s.kill("SIGTERM");
  await exited;
}

export async function waitFor(what: string, cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

/** A signed-in Screenwriter (its own SyncClient, so it acts as a separate device). */
export async function makeScreenwriter(email: string, offline: OfflineDocStore = new InMemoryOfflineDocStore()): Promise<Screenwriter> {
  const sw = createScreenwriter({ network: createFetchNetworkClient(), baseUrl: BASE, auth: new DevAuthPort(), offline });
  await sw.stores.auth.getState().signIn(email);
  await waitFor("me loaded", () => sw.stores.auth.getState().me !== null);
  return sw;
}
