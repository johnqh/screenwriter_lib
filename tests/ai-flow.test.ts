import { describe, expect, it } from "vitest";
import { ApiError } from "@sudobility/screenwriter_client";
import type { AiJob, SuggestionSet } from "@sudobility/screenwriter_types";
import { createAiFlow, describeAiError, type AiFlowClient } from "../src";

const set = (over: Partial<SuggestionSet> = {}): SuggestionSet =>
  ({
    id: "sset_1",
    documentId: "doc_1",
    jobId: "job_2",
    task: "polish.dialogue",
    status: "pending",
    counts: { pending: 2, accepted: 0, rejected: 0, stale: 0 },
    suggestions: [
      { id: "sug_1", elementId: "el_1", kind: "replaceText", before: "a", after: "b", rationale: "r", contentHash: "h", status: "pending", decidedAt: null },
      { id: "sug_2", elementId: "el_2", kind: "replaceText", before: "c", after: "d", rationale: "r", contentHash: "h", status: "pending", decidedAt: null },
    ],
    ...over,
  }) as SuggestionSet;

function fake(script: { statuses: AiJob["status"][]; result?: AiJob["result"]; acceptError?: ApiError }) {
  let polls = 0;
  const c: AiFlowClient = {
    getAiStatus: async () => ({ available: true, mode: "fixture" }),
    startAiJob: async () => ({ jobId: "job_1", status: "queued" }),
    listAiJobs: async () => ({ items: [] }),
    getAiJob: async () => {
      const status = script.statuses[Math.min(polls++, script.statuses.length - 1)]!;
      return { id: "job_1", documentId: "doc_1", task: "polish.dialogue", status, result: status === "succeeded" ? script.result : undefined } as AiJob;
    },
    cancelAiJob: async () => ({ id: "job_1", status: "cancelled" }) as AiJob,
    listSuggestionSets: async () => ({ items: [] }),
    getSuggestionSet: async () =>
      script.acceptError
        ? set({ status: "partiallyAccepted", suggestions: set().suggestions.map(s => (s.id === "sug_2" ? { ...s, status: "stale" as const } : s)) })
        : set(),
    acceptSuggestions: async () => {
      if (script.acceptError) throw script.acceptError;
      return { applied: ["sug_1"], set: set({ status: "partiallyAccepted" }) };
    },
    rejectSuggestions: async () => set({ status: "rejected" }),
  };
  return c;
}

describe("ai flow", () => {
  it("polls a polish job to success and loads its suggestion set", async () => {
    const flow = createAiFlow(fake({ statuses: ["running", "running", "succeeded"], result: { kind: "suggestions", suggestionSetId: "sset_1", count: 2, droppedItems: 0 } }), "doc_1", { pollMs: 5 });
    await flow.startPolish({ sceneIds: ["sc_1"] });
    expect(flow.getState().job?.status).toBe("running");
    for (let i = 0; i < 100 && !flow.getState().suggestionSet; i++) await new Promise(r => setTimeout(r, 10));
    expect(flow.getState().suggestionSet?.suggestions).toHaveLength(2);
    expect(flow.getState().job?.status).toBe("succeeded");
    flow.dispose();
  });

  it("a stale accept resolves as a typed result and marks the stale suggestions", async () => {
    const err = new ApiError("changed", "CONTENT_CHANGED", 409, { suggestionIds: ["sug_2"] });
    const flow = createAiFlow(fake({ statuses: ["succeeded"], result: { kind: "suggestions", suggestionSetId: "sset_1", count: 2, droppedItems: 0 }, acceptError: err }), "doc_1", { pollMs: 5 });
    await flow.startPolish({ sceneIds: ["sc_1"] });
    const r = await flow.accept(["sug_1", "sug_2"]);
    expect(r).toEqual({ ok: false, reason: "stale", suggestionIds: ["sug_2"] });
    expect(flow.getState().staleSuggestionIds).toEqual(["sug_2"]);
    expect(flow.getState().error).toBeNull();
    flow.dispose();
  });

  it("start failures become plain-language errors", async () => {
    const c = fake({ statuses: ["running"] });
    c.startAiJob = async () => {
      throw new ApiError("x", "JOB_ALREADY_RUNNING", 409);
    };
    const flow = createAiFlow(c, "doc_1");
    await flow.startReview();
    expect(flow.getState().error?.code).toBe("JOB_ALREADY_RUNNING");
    expect(flow.getState().error?.message).toMatch(/already running/i);
    expect(describeAiError("RATE_LIMITED").message).not.toMatch(/RATE_LIMITED/);
  });
});
