/** The API keys flow against the REAL API: create (one-time secret), list without it, use it, revoke. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Screenwriter } from "../src";
import { BASE, makeScreenwriter, startApi, stopApi } from "./helpers";

let A: Screenwriter;
beforeAll(async () => {
  await startApi();
  A = await makeScreenwriter("lib-keys@example.com");
});
afterAll(async () => {
  A?.dispose();
  await stopApi();
});

describe("api keys flow (real API)", () => {
  it("creates a key, reveals the secret once, lists prefix only, and revokes", async () => {
    const flow = A.createApiKeys();
    await flow.refresh();
    expect(await flow.create({ name: "lib test", scope: "read" })).toBe(true);
    const key = flow.getState().revealed!.key;
    expect(key).toMatch(/^fwk_[a-z0-9]{8}_/);
    const listed = flow.getState().keys.find(k => k.name === "lib test")!;
    expect(JSON.stringify(flow.getState().keys)).not.toContain(key);
    expect(key.startsWith(`fwk_${listed.prefix}_`)).toBe(true);

    const me = () => fetch(`${BASE}/api/v1/me`, { headers: { Authorization: `Bearer ${key}` } });
    expect((await me()).status).toBe(200);

    flow.dismissReveal();
    expect(flow.getState().revealed).toBeNull();
    expect(await flow.revoke(listed.id)).toBe(true);
    expect(flow.getState().keys.find(k => k.id === listed.id)?.revokedAt).not.toBeNull();
    expect((await me()).status).toBe(401);
    expect(await flow.revoke(listed.id)).toBe(true); // already revoked: fine
    flow.dispose();
  });

  it("describes errors in plain language", async () => {
    const { describeApiKeyError } = await import("../src");
    expect(describeApiKeyError("LIMIT_EXCEEDED").message).toMatch(/maximum/);
  });
});
