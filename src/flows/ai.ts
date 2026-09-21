import type {
  AiJob,
  AiJobCreateRequest,
  AiScope,
  AiStatus,
  CoverageReport,
  SuggestionSet,
} from "@sudobility/screenwriter_types";
import { isApiError, type ScreenwriterClient } from "@sudobility/screenwriter_client";

/** No browser APIs: timers only (`setTimeout`), the same in a browser, Node and React Native. */
export type AiFlowClient = Pick<
  ScreenwriterClient,
  | "getAiStatus"
  | "startAiJob"
  | "listAiJobs"
  | "getAiJob"
  | "cancelAiJob"
  | "listSuggestionSets"
  | "getSuggestionSet"
  | "acceptSuggestions"
  | "rejectSuggestions"
>;

/** A failure in plain language; `code` stays available for logic. */
export interface AiFlowError {
  code: string;
  message: string;
}

const MESSAGES: Record<string, string> = {
  AI_OUTPUT_INVALID: "The AI's answer could not be used, so nothing was changed. Please try again.",
  AI_UNAVAILABLE: "AI is not available right now. Please try again later.",
  JOB_ALREADY_RUNNING: "An AI job is already running on this script. Wait for it to finish or cancel it.",
  RATE_LIMITED: "You have reached today's AI limit. Please try again tomorrow.",
  AI_KEY_NOT_PERMITTED: "This access key is not allowed to use AI.",
  AI_INPUT_TOO_LARGE: "This script is too long for an AI review.",
  AI_GENERATION_FAILED: "The AI service failed to answer. Please try again.",
  AI_CONTENT_REFUSED: "The AI declined to work on this text.",
  AI_EXCLUDED_DOCUMENT: "AI is turned off for this script.",
  AI_DISABLED_FOR_WORKSPACE: "AI is turned off for this workspace.",
  SCOPE_TOO_LARGE: "That is too much to polish at once. Pick a smaller part of the script.",
  INTERRUPTED: "The AI job was interrupted. Please run it again.",
  SUGGESTION_UNAVAILABLE: "These suggestions can no longer be applied.",
  CONTENT_CHANGED: "The script changed since these suggestions were made.",
};

/** Plain-language text for an API or job error code (falls back to the server's own message). */
export function describeAiError(code: string, fallback?: string): AiFlowError {
  return { code, message: MESSAGES[code] ?? fallback ?? "Something went wrong with the AI request." };
}

const toFlowError = (e: unknown): AiFlowError =>
  isApiError(e) ? describeAiError(e.code, e.message) : describeAiError("UNKNOWN", e instanceof Error ? e.message : undefined);

export type AcceptResult =
  | { ok: true; applied: string[] }
  | { ok: false; reason: "stale"; suggestionIds: string[] }
  | { ok: false; reason: "unavailable" | "error"; error: AiFlowError };

export interface AiState {
  /** Null until loaded. `unavailable` mode means the panel should explain AI is not configured. */
  status: AiStatus | null;
  loaded: boolean;
  /** The job being run or last run in this panel. */
  job: AiJob | null;
  /** True between pressing a button and the job being accepted by the API. */
  starting: boolean;
  /** Most recent finished coverage report (also read back from the document's recent jobs after a reload). */
  report: CoverageReport | null;
  reportCreatedAt: string | null;
  /** The polish suggestion set being reviewed (also read back after a reload). */
  suggestionSet: SuggestionSet | null;
  /** A polish run that finished with nothing worth changing. */
  polishFoundNothing: boolean;
  deciding: boolean;
  /** Suggestion ids the last accept refused as stale (the set also marks them `stale`). */
  staleSuggestionIds: string[];
  error: AiFlowError | null;
}

export interface AiFlow {
  getState(): AiState;
  subscribe(listener: () => void): () => void;
  /** Load status, the last report and the pending suggestion set. Safe to call again. */
  refresh(): Promise<void>;
  startReview(options?: AiJobCreateRequest["options"]): Promise<void>;
  /** Polish dialogue in the given scope (max 8 scenes). */
  startPolish(scope: AiScope, options?: AiJobCreateRequest["options"]): Promise<void>;
  cancel(): Promise<void>;
  accept(suggestionIds: string[]): Promise<AcceptResult>;
  /** Accept every suggestion still pending in the set. */
  acceptAll(): Promise<AcceptResult>;
  /** Reject the given suggestions, or every pending one when omitted. */
  reject(suggestionIds?: string[]): Promise<void>;
  clearError(): void;
  dispose(): void;
}

export interface AiFlowOptions {
  /** Job poll interval in ms. Default 1500. */
  pollMs?: number;
}

const isActive = (j: AiJob | null) => j?.status === "queued" || j?.status === "running";

/** Review and polish for one document: start a job, poll it, hold its report or suggestion set, accept or reject. */
export function createAiFlow(client: AiFlowClient, documentId: string, options: AiFlowOptions = {}): AiFlow {
  const pollMs = options.pollMs ?? 1500;
  let state: AiState = {
    status: null,
    loaded: false,
    job: null,
    starting: false,
    report: null,
    reportCreatedAt: null,
    suggestionSet: null,
    polishFoundNothing: false,
    deciding: false,
    staleSuggestionIds: [],
    error: null,
  };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const set = (patch: Partial<AiState>) => {
    state = { ...state, ...patch };
    listeners.forEach(l => l());
  };
  const staleIds = (s: SuggestionSet | null) => s?.suggestions.filter(x => x.status === "stale").map(x => x.id) ?? [];

  const loadSet = async (id: string) => {
    const s = await client.getSuggestionSet(id);
    set({ suggestionSet: s, staleSuggestionIds: staleIds(s) });
    return s;
  };

  async function onFinished(job: AiJob) {
    if (job.status === "failed") {
      set({ error: describeAiError(job.error?.code ?? "AI_GENERATION_FAILED", job.error?.message) });
      return;
    }
    if (job.status !== "succeeded" || !job.result) return;
    if (job.result.kind === "report") {
      set({ report: job.result.report, reportCreatedAt: job.finishedAt ?? job.createdAt });
    } else if (job.result.suggestionSetId) {
      try {
        await loadSet(job.result.suggestionSetId);
      } catch (e) {
        set({ error: toFlowError(e) });
      }
    } else {
      set({ suggestionSet: null, staleSuggestionIds: [], polishFoundNothing: true });
    }
  }

  function schedule(jobId: string) {
    if (disposed) return;
    timer = setTimeout(async () => {
      timer = null;
      try {
        const job = await client.getAiJob(jobId);
        if (disposed || state.job?.id !== jobId) return;
        set({ job });
        if (isActive(job)) schedule(jobId);
        else await onFinished(job);
      } catch (e) {
        if (!disposed && state.job?.id === jobId) set({ error: toFlowError(e) });
      }
    }, pollMs);
  }

  async function start(body: AiJobCreateRequest) {
    if (state.starting || isActive(state.job)) return;
    set({ starting: true, error: null, polishFoundNothing: false, staleSuggestionIds: [] });
    try {
      const { jobId } = await client.startAiJob(documentId, body);
      const job = await client.getAiJob(jobId);
      set({ job, starting: false });
      if (isActive(job)) schedule(jobId);
      else await onFinished(job);
    } catch (e) {
      set({ starting: false, error: toFlowError(e) });
    }
  }

  async function decide(run: () => Promise<AcceptResult>): Promise<AcceptResult> {
    set({ deciding: true, error: null });
    try {
      return await run();
    } finally {
      set({ deciding: false });
    }
  }

  const flow: AiFlow = {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },

    async refresh() {
      disposed = false; // a StrictMode remount re-runs the effect on the same flow
      const [status, jobs, sets] = await Promise.all([
        client.getAiStatus().catch(() => ({ available: false, mode: "unavailable" }) as AiStatus),
        client.listAiJobs(documentId, 20).catch(() => ({ items: [] as AiJob[] })),
        client.listSuggestionSets(documentId).catch(() => ({ items: [] })),
      ]);
      const patch: Partial<AiState> = { status, loaded: true };
      const lastReport = jobs.items.find(j => j.task === "coverage" && j.status === "succeeded" && j.result?.kind === "report");
      if (lastReport?.result?.kind === "report" && !state.report) {
        patch.report = lastReport.result.report;
        patch.reportCreatedAt = lastReport.finishedAt ?? lastReport.createdAt;
      }
      const running = jobs.items.find(isActive);
      if (running && !state.job) {
        patch.job = running;
      }
      set(patch);
      if (running && state.job?.id === running.id && !timer) schedule(running.id);
      const pending = sets.items.find(s => s.status === "pending" || s.status === "partiallyAccepted" || s.status === "stale");
      if (pending && !state.suggestionSet) await loadSet(pending.id).catch(() => undefined);
    },

    startReview: options => start({ task: "coverage", ...(options ? { options } : {}) }),
    startPolish: (scope, options) => start({ task: "polish.dialogue", scope, ...(options ? { options } : {}) }),

    async cancel() {
      const job = state.job;
      if (!job || !isActive(job)) return;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        set({ job: await client.cancelAiJob(job.id) });
      } catch (e) {
        // JOB_FINISHED: it ended first; read the final state
        set({ job: await client.getAiJob(job.id).catch(() => job), error: null });
        if (!isApiError(e) || e.code !== "JOB_FINISHED") set({ error: toFlowError(e) });
        if (state.job && !isActive(state.job)) await onFinished(state.job);
      }
    },

    accept(ids) {
      const s = state.suggestionSet;
      if (!s) return Promise.resolve({ ok: false, reason: "error", error: describeAiError("UNKNOWN", "No suggestions to accept") });
      return decide(async () => {
        try {
          const r = await client.acceptSuggestions(s.id, ids);
          set({ suggestionSet: r.set, staleSuggestionIds: staleIds(r.set) });
          return { ok: true, applied: r.applied };
        } catch (e) {
          if (isApiError(e) && e.code === "CONTENT_CHANGED") {
            const fromServer = e.details?.suggestionIds;
            const suggestionIds = Array.isArray(fromServer) ? (fromServer as string[]) : ids;
            // the server marked them stale: re-read so the panel shows which
            await loadSet(s.id).catch(() => undefined);
            set({ staleSuggestionIds: [...new Set([...staleIds(state.suggestionSet), ...suggestionIds])] });
            return { ok: false, reason: "stale", suggestionIds };
          }
          const error = toFlowError(e);
          set({ error });
          return { ok: false, reason: isApiError(e) && e.code === "SUGGESTION_UNAVAILABLE" ? "unavailable" : "error", error };
        }
      });
    },
    acceptAll() {
      const ids = state.suggestionSet?.suggestions.filter(x => x.status === "pending").map(x => x.id) ?? [];
      return flow.accept(ids);
    },

    async reject(ids) {
      const s = state.suggestionSet;
      if (!s) return;
      set({ deciding: true, error: null });
      try {
        const next = await client.rejectSuggestions(s.id, ids);
        set({ suggestionSet: next, staleSuggestionIds: staleIds(next) });
      } catch (e) {
        set({ error: toFlowError(e) });
      } finally {
        set({ deciding: false });
      }
    },

    clearError: () => set({ error: null }),
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
  return flow;
}
