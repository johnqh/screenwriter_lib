import { cryptoIdSource, newId, type Actor } from "@sudobility/writing_core";
import {
  ScreenwriterClient,
  SyncClient,
  type NetworkClient,
  type SyncClientOptions,
} from "@sudobility/screenwriter_client";
import type { AuthPort } from "./ports/auth";
import type { OfflineDocStore } from "./ports/offline";
import { createAuthStore, type AuthStore } from "./stores/auth-store";
import { createDocumentsStore, type DocumentsStore } from "./stores/documents-store";
import { createProjectsStore, type ProjectsStore } from "./stores/projects-store";
import { createTemplatesStore, type TemplatesStore } from "./stores/templates-store";
import { colorForUid, openDocumentSession, type OpenSessionOptions } from "./session/document-session";
import { createImportExportFlow, type ImportExportFlow } from "./flows/import-export";
import { createAiFlow, type AiFlow, type AiFlowOptions } from "./flows/ai";
import { createApiKeysFlow, type ApiKeysFlow } from "./flows/api-keys";
import type { DocumentSession } from "./session/types";

export interface ScreenwriterConfig {
  /** The only door to the network (REST). */
  network: NetworkClient;
  /** API origin, e.g. `http://localhost:8042`. */
  baseUrl: string;
  auth: AuthPort;
  offline: OfflineDocStore;
  /** Extra `SyncClient` options (`WebSocketImpl`, `deviceId`, `awarenessTimeoutMs`, ...). `url`/`getToken` are wired here. */
  sync?: Partial<Omit<SyncClientOptions, "url" | "getToken">>;
  /** Defaults for `openDocumentSession`. */
  session?: OpenSessionOptions;
}

export interface Screenwriter {
  readonly client: ScreenwriterClient;
  readonly sync: SyncClient;
  readonly auth: AuthPort;
  readonly offline: OfflineDocStore;
  /** Import a script into a project, export a document (bytes in, bytes out). */
  readonly importExport: ImportExportFlow;
  /** A review-and-polish flow for one document. The caller owns it: `dispose()` when done. */
  createAi(documentId: string, options?: AiFlowOptions): AiFlow;
  /** Personal API keys for the signed-in user's personal workspace. The caller owns it: `dispose()` when done. */
  createApiKeys(): ApiKeysFlow;
  readonly stores: {
    auth: AuthStore;
    projects: ProjectsStore;
    documents: DocumentsStore;
    templates: TemplatesStore;
  };
  /**
   * Open a document. One live session per document: concurrent opens share it (reference counted), and the
   * session really closes when every holder has called `close()`. Call `close()` once per open.
   */
  openDocumentSession(documentId: string, options?: OpenSessionOptions): Promise<DocumentSession>;
  /** Stop sync and detach listeners. */
  dispose(): void;
}

/** Wires the injected ports into the client, sync client, stores and session factory. */
export function createScreenwriter(config: ScreenwriterConfig): Screenwriter {
  const { network, baseUrl, auth, offline } = config;
  const client = new ScreenwriterClient({ network, baseUrl, getToken: f => auth.getToken(f) });
  const sync = new SyncClient({ ...config.sync, url: client.syncUrl(), getToken: f => auth.getToken(f) });

  const authStore = createAuthStore(auth, client);
  const getWorkspaceId = async () => {
    const me = authStore.store.getState().me ?? (await client.me());
    return me.personalWorkspaceId;
  };
  const projects = createProjectsStore(client, getWorkspaceId);
  const documents = createDocumentsStore(client);
  const templates = createTemplatesStore(client);

  // A different user (or none) means everything cached belongs to someone else.
  let lastUid = auth.currentUser?.uid ?? null;
  const offAuth = auth.onChange(user => {
    const uid = user?.uid ?? null;
    if (uid === lastUid) return;
    lastUid = uid;
    projects.getState().reset();
    documents.getState().reset();
    templates.getState().reset();
    if (!user) sync.disconnect();
  });

  const getActor = (): Actor => {
    const u = auth.currentUser;
    if (!u) throw new Error("Sign in before opening a document");
    return { userId: u.uid, displayName: u.displayName ?? u.email ?? u.uid, color: colorForUid(u.uid), kind: "human" };
  };

  const open = new Map<string, { promise: Promise<DocumentSession>; refs: number }>();
  const closing = new Map<string, Promise<void>>();

  const importExport = createImportExportFlow(client, {
    newDocumentId: () => newId("doc", cryptoIdSource),
    onImported: (pid, doc) => documents.getState().upsert(pid, doc),
    // exporting reads the server's copy: let this device's open session push its edits first
    beforeExport: async id => {
      const entry = open.get(id);
      if (entry) await (await entry.promise).settle();
    },
  });

  return {
    client,
    sync,
    importExport,
    auth,
    offline,
    createAi: (documentId, options) => createAiFlow(client, documentId, options),
    createApiKeys: () => createApiKeysFlow(client, getWorkspaceId),
    stores: { auth: authStore.store, projects, documents, templates },

    openDocumentSession(documentId, options) {
      let entry = open.get(documentId);
      if (!entry) {
        // A previous session of this document may still be closing: let it finish first.
        const promise = (closing.get(documentId) ?? Promise.resolve()).then(() =>
          openDocumentSession({ client, sync, offline, getActor }, documentId, { ...config.session, ...options })
        );
        entry = { promise, refs: 0 };
        open.set(documentId, entry);
        promise.catch(() => {
          if (open.get(documentId) === entry) open.delete(documentId);
        });
      }
      const e = entry;
      e.refs++;
      return e.promise.then(session => {
        let released = false;
        // Same session for every holder; only `close` differs (release one reference).
        return Object.create(session, {
          close: {
            value: async () => {
              if (released) return;
              released = true;
              if (--e.refs > 0) return;
              if (open.get(documentId) === e) open.delete(documentId);
              const c = session.close();
              closing.set(documentId, c);
              await c;
              if (closing.get(documentId) === c) closing.delete(documentId);
            },
          },
        }) as DocumentSession;
      });
    },

    dispose() {
      offAuth();
      authStore.dispose();
      sync.disconnect();
    },
  };
}
