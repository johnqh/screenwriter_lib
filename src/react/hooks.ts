import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import type { BatchResult, CommandInvocation, DocumentModel } from "@sudobility/writing_core";
import type { ProjectCreateRequest } from "@sudobility/screenwriter_types";
import type { ExportFormatId, FormatInfo } from "@sudobility/screenwriter_types";
import type { AiFlow, AiState } from "../flows/ai";
import type { ApiKeysState } from "../flows/api-keys";
import type { ExportOutcome, ImportOutcome, ImportScriptInput } from "../flows/import-export";
import type { DocumentSession, ExecuteOptions, RemoteCursor, SessionSyncStatus } from "../session/types";
import type { DocumentsState } from "../stores/documents-store";
import { templatesFilterKey } from "../stores/templates-store";
import { useScreenwriter } from "./context";

export function useAuth() {
  const { stores } = useScreenwriter();
  const s = useStore(stores.auth);
  return { status: s.status, user: s.user, me: s.me, error: s.error, signIn: s.signIn, signOut: s.signOut };
}

/** Projects of the personal workspace. Loads once when a user is signed in. */
export function useProjects() {
  const { stores } = useScreenwriter();
  const s = useStore(stores.projects);
  const uid = useStore(stores.auth, a => a.user?.uid ?? null);
  useEffect(() => {
    if (uid) void stores.projects.getState().load();
  }, [uid, stores]);
  return {
    projects: s.items,
    showingTrash: s.showingTrash,
    loading: s.loading,
    error: s.error,
    load: s.load,
    create: (input: ProjectCreateRequest) => s.create(input),
    trash: s.trash,
    restore: s.restore,
  };
}

const NO_DOCS: DocumentsState["byProject"][string] = { items: [], showingTrash: false, loading: false, error: null };

export function useDocuments(projectId: string | null | undefined) {
  const { stores } = useScreenwriter();
  const entry = useStore(stores.documents, s => (projectId ? s.byProject[projectId] : undefined)) ?? NO_DOCS;
  const actions = useStore(stores.documents, s => s);
  useEffect(() => {
    if (projectId) void stores.documents.getState().load(projectId);
  }, [projectId, stores]);
  return {
    documents: entry.items,
    showingTrash: entry.showingTrash,
    loading: entry.loading,
    error: entry.error,
    load: (opts?: { trashed?: boolean }) => (projectId ? actions.load(projectId, opts) : Promise.resolve()),
    create: (input: Parameters<DocumentsState["create"]>[1]) => (projectId ? actions.create(projectId, input) : Promise.resolve(null)),
    trash: (documentId: string) => (projectId ? actions.trash(projectId, documentId) : Promise.resolve()),
    restore: (documentId: string) => (projectId ? actions.restore(projectId, documentId) : Promise.resolve()),
  };
}

/**
 * Templates of the personal workspace, plus built-ins. `locale` (typically the app's current UI language) narrows
 * built-ins to that BCP-47 language — screenwriter_lib doesn't know the app's language itself, so this is the
 * app's own seam for supplying it (`user`/`workspace` templates are never filtered by it, see `TemplateSummary`).
 * Loads once per `(category, locale)` pair actually asked for; a caller switching `locale` re-fetches instead of
 * reusing a stale list loaded under a different one.
 */
export function useTemplates(locale?: string) {
  const { stores } = useScreenwriter();
  const s = useStore(stores.templates);
  const uid = useStore(stores.auth, a => a.user?.uid ?? null);
  useEffect(() => {
    if (!uid) return;
    const state = stores.templates.getState();
    if (state.loadedFor === templatesFilterKey(undefined, locale)) return;
    void state.load(undefined, locale);
  }, [uid, locale, stores]);
  return { templates: s.items, loading: s.loading, error: s.error, load: s.load };
}

export interface UseDocumentSession {
  session: DocumentSession | null;
  /** False until the session is open. */
  ready: boolean;
  error: Error | null;
  /** Null until ready. Read it during render; it is replaced after a rebase and this hook re-renders. */
  model: DocumentModel | null;
  syncStatus: SessionSyncStatus | null;
  remoteCursors: ReadonlyMap<number, RemoteCursor>;
  execute(commands: readonly CommandInvocation[], options?: ExecuteOptions): BatchResult | null;
  undo(): boolean;
  redo(): boolean;
  canUndo: boolean;
  canRedo: boolean;
  setLocalCursor(cursor: unknown): void;
}

const NO_CURSORS: ReadonlyMap<number, RemoteCursor> = new Map();

/** Opens the session on mount, closes it on unmount, re-renders on model, status and presence changes. */
export function useDocumentSession(documentId: string | null | undefined): UseDocumentSession {
  const sw = useScreenwriter();
  const [session, setSession] = useState<DocumentSession | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const sessionRef = useRef<DocumentSession | null>(null);

  useEffect(() => {
    if (!documentId) return;
    let cancelled = false;
    let opened: DocumentSession | null = null;
    let offs: Array<() => void> = [];
    setSession(null);
    setError(null);
    sw.openDocumentSession(documentId).then(
      s => {
        opened = s;
        if (cancelled) {
          void s.close();
          return;
        }
        sessionRef.current = s;
        offs = [s.subscribe(() => rerender()), s.on("status", () => rerender()), s.on("presence", () => rerender())];
        setSession(s);
      },
      e => !cancelled && setError(e instanceof Error ? e : new Error(String(e)))
    );
    return () => {
      cancelled = true;
      offs.forEach(f => f());
      sessionRef.current = null;
      if (opened) void opened.close();
    };
  }, [documentId, sw]);

  const execute = useCallback((c: readonly CommandInvocation[], o?: ExecuteOptions) => sessionRef.current?.execute(c, o) ?? null, []);
  const undo = useCallback(() => sessionRef.current?.undo() ?? false, []);
  const redo = useCallback(() => sessionRef.current?.redo() ?? false, []);
  const setLocalCursor = useCallback((c: unknown) => sessionRef.current?.setLocalCursor(c), []);

  return {
    session,
    ready: session !== null,
    error,
    model: session?.model ?? null,
    syncStatus: session?.syncStatus ?? null,
    remoteCursors: session?.remoteCursors ?? NO_CURSORS,
    execute,
    undo,
    redo,
    canUndo: session?.canUndo() ?? false,
    canRedo: session?.canRedo() ?? false,
    setLocalCursor,
  };
}

export interface UseImportExport {
  /** Formats the server supports (empty until loaded). */
  formats: FormatInfo[];
  importing: boolean;
  exporting: boolean;
  /** The last failure (an `ApiError` from the client library has `code` and `details`); cleared by the next call. */
  error: Error | null;
  importScript(projectId: string, input: ImportScriptInput): Promise<ImportOutcome | null>;
  exportDocument(documentId: string, format: ExportFormatId): Promise<ExportOutcome | null>;
  clearError(): void;
}

/** Import and export with loading/error state. Both resolve to `null` on failure (see `error`). */
export function useImportExport(): UseImportExport {
  const { importExport } = useScreenwriter();
  const [formats, setFormats] = useState<FormatInfo[]>([]);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    importExport.formats().then(
      f => !cancelled && setFormats(f),
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, [importExport]);

  const importScript = useCallback(
    async (projectId: string, input: ImportScriptInput) => {
      setImporting(true);
      setError(null);
      try {
        return await importExport.importScript(projectId, input);
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
        return null;
      } finally {
        setImporting(false);
      }
    },
    [importExport]
  );
  const exportDocument = useCallback(
    async (documentId: string, format: ExportFormatId) => {
      setExporting(true);
      setError(null);
      try {
        return await importExport.exportDocument(documentId, format);
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
        return null;
      } finally {
        setExporting(false);
      }
    },
    [importExport]
  );
  return { formats, importing, exporting, error, importScript, exportDocument, clearError: () => setError(null) };
}

export interface UseAi extends AiState {
  startReview: AiFlow["startReview"];
  startPolish: AiFlow["startPolish"];
  cancel: AiFlow["cancel"];
  accept: AiFlow["accept"];
  acceptAll: AiFlow["acceptAll"];
  reject: AiFlow["reject"];
  clearError: AiFlow["clearError"];
  refresh: AiFlow["refresh"];
  /** A job is queued or running. */
  busy: boolean;
}

/** AI review and polish for a document: status, the current job, its report or suggestion set, accept/reject. */
export function useAi(documentId: string): UseAi {
  const sw = useScreenwriter();
  const flow = useMemo(() => sw.createAi(documentId), [sw, documentId]);
  useEffect(() => {
    void flow.refresh();
    return () => flow.dispose();
  }, [flow]);
  const f = flow;
  const state = useSyncExternalStore(f.subscribe, f.getState, f.getState);
  return {
    ...state,
    startReview: f.startReview,
    startPolish: f.startPolish,
    cancel: f.cancel,
    accept: f.accept,
    acceptAll: f.acceptAll,
    reject: f.reject,
    clearError: f.clearError,
    refresh: f.refresh,
    busy: state.starting || state.job?.status === "queued" || state.job?.status === "running",
  };
}

export interface UseApiKeys extends ApiKeysState {
  create: (input: Parameters<import("../flows/api-keys").ApiKeysFlow["create"]>[0]) => Promise<boolean>;
  dismissReveal: () => void;
  revoke: (id: string) => Promise<boolean>;
  clearError: () => void;
  refresh: () => Promise<void>;
}

/** Personal API keys: the list, create (with a transient one-time `revealed` secret) and revoke. */
export function useApiKeys(): UseApiKeys {
  const sw = useScreenwriter();
  const flow = useMemo(() => sw.createApiKeys(), [sw]);
  useEffect(() => {
    void flow.refresh();
    return () => flow.dispose();
  }, [flow]);
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  return { ...state, create: flow.create, dismissReveal: flow.dismissReveal, revoke: flow.revoke, clearError: flow.clearError, refresh: flow.refresh };
}
