import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useStore } from "zustand";
import type { BatchResult, CommandInvocation, DocumentModel } from "@sudobility/writing_core";
import type { ProjectCreateRequest } from "@sudobility/screenwriter_types";
import type { DocumentSession, ExecuteOptions, RemoteCursor, SessionSyncStatus } from "../session/types";
import type { DocumentsState } from "../stores/documents-store";
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

export function useTemplates() {
  const { stores } = useScreenwriter();
  const s = useStore(stores.templates);
  const uid = useStore(stores.auth, a => a.user?.uid ?? null);
  useEffect(() => {
    if (uid && !stores.templates.getState().loaded) void stores.templates.getState().load();
  }, [uid, stores]);
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
