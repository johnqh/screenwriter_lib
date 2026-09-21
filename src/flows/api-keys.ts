import type { ApiKeyCreated, ApiKeyCreateRequest, ApiKeySummary } from "@sudobility/screenwriter_types";
import { isApiError, type ScreenwriterClient } from "@sudobility/screenwriter_client";

export type ApiKeysFlowClient = Pick<ScreenwriterClient, "listApiKeys" | "createApiKey" | "revokeApiKey">;

export interface ApiKeysFlowError {
  code: string;
  message: string;
}

const MESSAGES: Record<string, string> = {
  LIMIT_EXCEEDED: "You already have the maximum number of active API keys. Revoke one you no longer use, then try again.",
  CONFIG_MISSING: "API keys are not set up on this server yet.",
  API_KEY_FORBIDDEN: "API keys can only be managed when you are signed in, not with another API key.",
  NOT_FOUND: "That key no longer exists. The list has been refreshed.",
  VALIDATION_ERROR: "Check the key name (1 to 60 characters) and options.",
  NETWORK_ERROR: "Could not reach the server. Check your connection and try again.",
};

/** Plain-language text for an API key error (falls back to the server's own message). */
export function describeApiKeyError(code: string, fallback?: string): ApiKeysFlowError {
  return { code, message: MESSAGES[code] ?? fallback ?? "Something went wrong with the API key request." };
}

const toError = (e: unknown): ApiKeysFlowError =>
  isApiError(e) ? describeApiKeyError(e.code, e.message) : describeApiKeyError("UNKNOWN", e instanceof Error ? e.message : undefined);

export interface ApiKeysState {
  keys: ApiKeySummary[];
  loaded: boolean;
  loading: boolean;
  creating: boolean;
  /** Ids being revoked. */
  revoking: string[];
  /**
   * The just-created key including its one-time secret. Lives only here, only until `dismissReveal()`.
   * Never written to a store, storage or a log.
   */
  revealed: ApiKeyCreated | null;
  error: ApiKeysFlowError | null;
}

export interface ApiKeysFlow {
  getState(): ApiKeysState;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  /** Creates a key in the caller's workspace (`workspaceId` is added by the flow). Resolves true on success. */
  create(input: Omit<ApiKeyCreateRequest, "workspaceId">): Promise<boolean>;
  /** Drops the secret from memory. */
  dismissReveal(): void;
  revoke(id: string): Promise<boolean>;
  clearError(): void;
  dispose(): void;
}

/** Personal API keys: list, create (one-time secret), revoke. */
export function createApiKeysFlow(client: ApiKeysFlowClient, getWorkspaceId: () => Promise<string>): ApiKeysFlow {
  let state: ApiKeysState = { keys: [], loaded: false, loading: false, creating: false, revoking: [], revealed: null, error: null };
  const listeners = new Set<() => void>();
  let disposed = false;
  const set = (patch: Partial<ApiKeysState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    listeners.forEach(l => l());
  };

  const refresh = async () => {
    set({ loading: true });
    try {
      set({ keys: await client.listApiKeys(), loaded: true, loading: false });
    } catch (e) {
      set({ loading: false, loaded: true, error: toError(e) });
    }
  };

  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    refresh() {
      disposed = false; // a StrictMode remount re-runs the effect on the same flow
      return refresh();
    },
    async create(input) {
      if (state.creating) return false;
      set({ creating: true, error: null });
      try {
        const created = await client.createApiKey({ ...input, workspaceId: await getWorkspaceId() });
        set({ creating: false, revealed: created });
        await refresh();
        return true;
      } catch (e) {
        set({ creating: false, error: toError(e) });
        return false;
      }
    },
    dismissReveal: () => set({ revealed: null }),
    async revoke(id) {
      set({ revoking: [...state.revoking, id], error: null });
      let ok = true;
      try {
        await client.revokeApiKey(id); // idempotent on the server: a second revoke is not an error
      } catch (e) {
        ok = false;
        set({ error: toError(e) });
      }
      set({ revoking: state.revoking.filter(x => x !== id) });
      await refresh();
      return ok;
    },
    clearError: () => set({ error: null }),
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
