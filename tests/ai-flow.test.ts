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

  describe("a new run clears what the last one left", () => {
    const report = (summary: string) => ({ kind: "report", report: { summary, strengths: [], weaknesses: [], notesByScene: [] } }) as unknown as NonNullable<AiJob["result"]>;
    const job = (id: string, status: AiJob["status"], result?: AiJob["result"], task = "coverage") =>
      ({ id, documentId: "doc_1", task, status, result, createdAt: "2026-09-27T10:00:00Z", finishedAt: "2026-09-27T10:01:00Z" }) as AiJob;
    const wait = async (until: () => boolean) => {
      for (let i = 0; i < 100 && !until(); i++) await new Promise(r => setTimeout(r, 10));
    };

    it("the old report goes when a new review starts, and stays gone when that review fails", async () => {
      const c = fake({ statuses: ["running"] });
      c.listAiJobs = async () => ({ items: [job("job_0", "succeeded", report("old"))] });
      let polls = 0;
      c.getAiJob = async () => (polls++ < 2 ? job("job_1", "running") : ({ ...job("job_1", "failed"), error: { code: "AI_GENERATION_FAILED", message: "cut off" } } as AiJob));
      const flow = createAiFlow(c, "doc_1", { pollMs: 5 });
      await flow.refresh();
      expect(flow.getState().report?.summary).toBe("old");
      await flow.startReview();
      expect(flow.getState().report).toBeNull(); // while it runs
      expect(flow.getState().reportCreatedAt).toBeNull();
      await wait(() => !!flow.getState().error);
      expect(flow.getState().error?.code).toBe("AI_GENERATION_FAILED");
      expect(flow.getState().report).toBeNull(); // and after it failed
      flow.dispose();
    });

    it("a new review replaces the old report with its own", async () => {
      const c = fake({ statuses: ["running"] });
      c.listAiJobs = async () => ({ items: [job("job_0", "succeeded", report("old"))] });
      let polls = 0;
      c.getAiJob = async () => (polls++ < 1 ? job("job_1", "running") : job("job_1", "succeeded", report("new")));
      const flow = createAiFlow(c, "doc_1", { pollMs: 5 });
      await flow.refresh();
      await flow.startReview();
      await wait(() => !!flow.getState().report);
      expect(flow.getState().report?.summary).toBe("new");
      flow.dispose();
    });

    it("a review the API refuses to start replaces nothing", async () => {
      const c = fake({ statuses: ["running"] });
      c.listAiJobs = async () => ({ items: [job("job_0", "succeeded", report("old"))] });
      c.startAiJob = async () => {
        throw new ApiError("x", "AI_CONSENT_REQUIRED", 403);
      };
      const flow = createAiFlow(c, "doc_1");
      await flow.refresh();
      await flow.startReview();
      expect(flow.getState().report?.summary).toBe("old");
    });

    it("after a reload: the latest review's report only if that review succeeded", async () => {
      const failedLast = fake({ statuses: ["running"] });
      failedLast.listAiJobs = async () => ({ items: [job("job_2", "failed"), job("job_p", "succeeded", undefined, "polish.dialogue"), job("job_0", "succeeded", report("old"))] });
      const a = createAiFlow(failedLast, "doc_1");
      await a.refresh();
      expect(a.getState().report).toBeNull();

      const succeededLast = fake({ statuses: ["running"] });
      succeededLast.listAiJobs = async () => ({ items: [job("job_p", "failed", undefined, "polish.dialogue"), job("job_2", "succeeded", report("latest")), job("job_0", "succeeded", report("old"))] });
      const b = createAiFlow(succeededLast, "doc_1");
      await b.refresh();
      expect(b.getState().report?.summary).toBe("latest");

      const running = fake({ statuses: ["running"] });
      running.listAiJobs = async () => ({ items: [job("job_3", "running"), job("job_0", "succeeded", report("old"))] });
      running.getAiJob = async () => job("job_3", "running");
      const d = createAiFlow(running, "doc_1", { pollMs: 5 });
      await d.refresh();
      expect(d.getState().report).toBeNull();
      d.dispose();
    });

    it("a new polish drops the old suggestions and rejects the undecided ones, so a reload cannot bring them back", async () => {
      const c = fake({ statuses: ["succeeded"], result: { kind: "suggestions", suggestionSetId: undefined as never, count: 0, droppedItems: 0 } });
      c.listSuggestionSets = async () => ({ items: [set()] }) as never;
      const rejected: string[] = [];
      c.rejectSuggestions = async id => {
        rejected.push(id);
        return set({ status: "rejected" });
      };
      const flow = createAiFlow(c, "doc_1", { pollMs: 5 });
      await flow.refresh();
      expect(flow.getState().suggestionSet?.id).toBe("sset_1");
      await flow.startPolish({ sceneIds: ["sc_1"] });
      expect(rejected).toEqual(["sset_1"]);
      expect(flow.getState().suggestionSet).toBeNull();
      expect(flow.getState().polishFoundNothing).toBe(true);
      // a review does not touch suggestions, a polish does not touch the report
      flow.dispose();
    });
  });

  it("a review of one scene sends its scope; a complete review sends none", async () => {
    const c = fake({ statuses: ["succeeded"] });
    const sent: unknown[] = [];
    c.startAiJob = async (_did, body) => {
      sent.push(body);
      return { jobId: "job_1", status: "queued" };
    };
    const flow = createAiFlow(c, "doc_1");
    await flow.startReview(undefined, { sceneIds: ["sc_3"], storySoFar: true });
    await flow.startReview();
    expect(sent).toEqual([{ task: "coverage", scope: { sceneIds: ["sc_3"], storySoFar: true } }, { task: "coverage" }]);
    expect(describeAiError("SCENE_SUMMARIES_MISSING").message).toMatch(/complete script first/);
  });
});
