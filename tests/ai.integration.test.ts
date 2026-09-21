/** The AI flow against the REAL API on the fixture transport: review report, polish, accept. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Screenwriter } from "../src";
import { makeScreenwriter, startApi, stopApi, waitFor } from "./helpers";

const FOUNTAIN = "Title: Lib AI\n\nINT. LAB - DAY\n\nDust floats.\n\nVOSS\nIt should not be running.\n\nEXT. ROOF - NIGHT\n\nWind.\n\nVOSS\nThe wind is loud up here.\n";
let A: Screenwriter;

beforeAll(async () => {
  await startApi();
  A = await makeScreenwriter("lib-ai@example.com");
});
afterAll(async () => {
  A?.dispose();
  await stopApi();
});

describe("ai flow (real API, fixture transport)", () => {
  it("reports status, runs a review, polishes a scene and accepts a suggestion", async () => {
    const pid = (await A.stores.projects.getState().create({ name: "AI" }))!.id;
    const { document } = await A.importExport.importScript(pid, { filename: "s.fountain", bytes: new TextEncoder().encode(FOUNTAIN) });
    const flow = A.createAi(document.id, { pollMs: 50 });
    await flow.refresh();
    expect(flow.getState().status).toEqual({ available: true, mode: "fixture" });

    await flow.startReview();
    await waitFor("report", () => flow.getState().report !== null || flow.getState().error !== null, 15000);
    expect(flow.getState().error).toBeNull();
    const report = flow.getState().report!;
    expect(report.summary.length).toBeGreaterThan(0);

    // a fresh flow (a reload) reads the last report back
    const again = A.createAi(document.id);
    await again.refresh();
    expect(again.getState().report?.summary).toBe(report.summary);

    const sceneId = report.notesByScene[0]!.sceneId;
    await flow.startPolish({ sceneIds: [sceneId] });
    await waitFor("set", () => flow.getState().suggestionSet !== null || flow.getState().error !== null, 15000);
    const s = flow.getState().suggestionSet!;
    expect(s.suggestions.length).toBeGreaterThan(0);
    const r = await flow.accept([s.suggestions[0]!.id]);
    expect(r).toMatchObject({ ok: true });
    const text = (await A.client.getDocumentContent(document.id)).elements.find(e => e.id === s.suggestions[0]!.elementId)!.text.plain;
    expect(text).toBe(s.suggestions[0]!.after);
    flow.dispose();
    again.dispose();
  });
});
