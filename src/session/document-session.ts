import * as Y from "yjs";
import {
  createSessionOrigins,
  createSessionUndo,
  cryptoIdSource,
  executeBatch,
  openDocument,
  registerBuiltinCommands,
  type Actor,
  type Capability,
  type BatchResult,
  type CommandInvocation,
  type DocumentModel,
  type IdSource,
  type ModelChangeBatch,
  type SessionUndo,
} from "@sudobility/writing_core";
import type { DocSubscription, ScreenwriterClient, SyncClient } from "@sudobility/screenwriter_client";
import type { DocumentDetail } from "@sudobility/screenwriter_types";
import type { OfflineDocStore } from "../ports/offline";
import { Emitter } from "./emitter";
import type {
  DocumentSession,
  ExecuteOptions,
  RebasedEvent,
  RemoteCursor,
  SessionEvents,
  SessionSyncState,
  SessionSyncStatus,
} from "./types";

registerBuiltinCommands();

export type SessionClient = Pick<
  ScreenwriterClient,
  | "getDocument"
  | "getDocumentState"
  | "getSnapshotState"
  | "listSnapshots"
  | "createSnapshot"
  | "openSnapshot"
  | "forkSnapshot"
  | "listVersions"
  | "restoreVersion"
>;

export interface SessionDeps {
  client: SessionClient;
  sync: SyncClient;
  offline: OfflineDocStore;
  getActor: () => Actor;
  ids?: IdSource;
  clock?: () => number;
}

export interface OpenSessionOptions {
  /** How long to wait for the initial sync. With an offline copy the session then opens anyway. Default 10 s. */
  syncTimeoutMs?: number;
  /** Debounce for writing the offline store. Default 400 ms. */
  persistDebounceMs?: number;
}

const OFFLINE_ORIGIN = { offline: true };

class EpochRace extends Error {}

const isNetworkError = (e: unknown) => (e as { code?: string } | null)?.code === "NETWORK_ERROR";
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** A stable colour per user, derived from the uid. */
export function colorForUid(uid: string): string {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 45%)`;
}

/**
 * Open one document for editing. See CLAUDE.md "Session lifecycle". In short: fetch detail, load the offline
 * copy, subscribe through the SyncClient at the document's epoch, wait for sync, open the writing_core model
 * (repair off), and from then on persist, relay presence and rebase when the epoch changes.
 */
export async function openDocumentSession(
  deps: SessionDeps,
  documentId: string,
  options: OpenSessionOptions = {}
): Promise<DocumentSession> {
  const syncTimeoutMs = options.syncTimeoutMs ?? 10_000;
  const persistMs = options.persistDebounceMs ?? 400;
  const { client, sync, offline } = deps;
  const ids = deps.ids ?? cryptoIdSource;
  const clock = deps.clock ?? (() => Date.now());
  const actor = deps.getActor();
  const origins = createSessionOrigins(actor);
  const me = { id: actor.userId, name: actor.displayName, color: actor.color };

  const events = new Emitter<SessionEvents>();
  const modelListeners = new Set<(b: ModelChangeBatch | null) => void>();

  // ── mutable session state ──
  let detail: DocumentDetail | null = null;
  let epoch = 0;
  let doc!: Y.Doc;
  let model!: DocumentModel;
  let undo!: SessionUndo;
  let handle!: DocSubscription;
  let offModel: (() => void) | null = null;
  let phase: "opening" | "live" | "rebasing" | "closed" = "opening";
  let revision = 0;
  let remoteCursors: ReadonlyMap<number, RemoteCursor> = new Map();
  let localCursor: unknown = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let rebaseRun: Promise<void> | null = null;
  let rebaseAgain = false;
  let statusCache: SessionSyncStatus | null = null;
  let hadOfflineCopy = false;

  const bump = () => void revision++;

  // ── status ──
  const computeStatus = (): SessionSyncStatus => {
    let state: SessionSyncState;
    if (phase === "closed") state = "closed";
    else if (phase === "rebasing") state = "rebasing";
    else if (!handle) state = "syncing";
    else if (handle.state === "stale") state = "stale";
    else state = handle.status;
    return { connection: sync.status, state, epoch };
  };
  const refreshStatus = () => {
    const next = computeStatus();
    const prev = statusCache;
    if (prev && prev.connection === next.connection && prev.state === next.state && prev.epoch === next.epoch) return;
    statusCache = next;
    bump();
    events.emit("status", next);
  };

  // ── doc attach / detach ──
  const onDocUpdate = (_u: Uint8Array, origin: unknown) => {
    if (origin === OFFLINE_ORIGIN) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => void flush().catch(() => undefined), persistMs);
  };

  const flush = async (): Promise<void> => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    if (!doc) return;
    await offline.save(documentId, { epoch, state: Y.encodeStateAsUpdateV2(doc) });
  };

  const attach = (d: Y.Doc, e: number) => {
    doc = d;
    epoch = e;
    model = openDocument(d, { ids, clock, locale: detail?.language ?? "en" }, { repair: false });
    undo = createSessionUndo(d, origins, { clock });
    offModel = model.subscribe(batch => {
      bump();
      for (const l of [...modelListeners]) l(batch);
      events.emit("change", batch);
    });
    d.on("updateV2", onDocUpdate);
  };

  const detach = () => {
    offModel?.();
    offModel = null;
    doc.off("updateV2", onDocUpdate);
    undo.destroy();
    model.dispose();
    doc.destroy();
  };

  const onAwareness = (states: Map<number, unknown>) => {
    const out = new Map<number, RemoteCursor>();
    for (const [clientId, s] of states) {
      const st = (s ?? {}) as { user?: RemoteCursor["user"]; cursor?: unknown };
      out.set(clientId, { clientId, user: st.user ?? null, cursor: st.cursor ?? null });
    }
    remoteCursors = out;
    bump();
    events.emit("presence", out);
  };

  const subscribeSync = (d: Y.Doc, e: number): DocSubscription => {
    const h = sync.subscribe(documentId, d, { epoch: e, onAwareness });
    if (localCursor !== null) h.setLocalAwareness({ user: me, cursor: localCursor });
    void sync.connect().catch(() => undefined); // idempotent; failures surface through status/stopped
    return h;
  };

  /** Resolves on synced; rejects on a fatal subscription problem, an epoch race, or the timeout. */
  const waitSynced = (h: DocSubscription, timeoutMs: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const offs: Array<() => void> = [];
      const done = (err?: Error) => {
        clearTimeout(timer);
        offs.forEach(f => f());
        err ? reject(err) : resolve();
      };
      const check = () => {
        if (h.state === "stale") done(new EpochRace("epoch changed during open"));
        else if (h.status === "synced") done();
      };
      const timer = setTimeout(() => done(new Error("timed out waiting for initial sync")), timeoutMs);
      offs.push(
        sync.on("docStatus", e => e.documentId === documentId && check()),
        sync.on("epochChanged", e => e.documentId === documentId && done(new EpochRace("epoch changed during open"))),
        sync.on("subscribeError", e => e.documentId === documentId && done(new Error(`subscribe failed: ${e.code}`))),
        sync.on("stopped", e => done(new Error(`sync stopped: ${e.reason}`)))
      );
      check();
    });

  // ── initial open ──
  const load = await offline.load(documentId);
  for (let attempt = 0; ; attempt++) {
    let offlineOnly = false;
    try {
      detail = await client.getDocument(documentId);
    } catch (e) {
      if (isNetworkError(e) && load) offlineOnly = true;
      else throw e;
    }
    const startEpoch = detail ? detail.epoch : load!.epoch;
    const d = new Y.Doc();
    hadOfflineCopy = false;
    if (load && load.epoch === startEpoch) {
      Y.applyUpdateV2(d, load.state, OFFLINE_ORIGIN);
      hadOfflineCopy = true;
    }
    // (An offline copy from an older epoch cannot be merged; it is dropped. See Known gaps.)
    handle = subscribeSync(d, startEpoch);
    try {
      if (offlineOnly) {
        // No network: start from the local copy; the socket keeps trying and rebases if needed.
      } else {
        try {
          await waitSynced(handle, syncTimeoutMs);
        } catch (e) {
          if (!(e instanceof EpochRace) && hadOfflineCopy && !(e as Error).message.startsWith("subscribe failed")) {
            // slow or unreachable server but a local copy: open anyway, sync continues in the background
          } else throw e;
        }
      }
    } catch (e) {
      handle.unsubscribe();
      d.destroy();
      if (e instanceof EpochRace && attempt < 3) continue;
      throw e;
    }
    attach(d, startEpoch);
    break;
  }
  phase = "live";
  statusCache = computeStatus();
  void flush().catch(() => undefined);

  // ── epoch rebase (spec 03 section 6.3) ──
  const stateVectorOf = (update: Uint8Array): Map<number, number> => {
    const t = new Y.Doc();
    try {
      Y.applyUpdateV2(t, update);
      return Y.decodeStateVector(Y.encodeStateVector(t));
    } finally {
      t.destroy();
    }
  };

  /** State vector of the server's newest pre-open/pre-restore snapshot (its live state at the bump). */
  const preBumpVector = async (): Promise<Map<number, number>> => {
    try {
      const { snapshots } = await client.listSnapshots(documentId, { includeAutomatic: true });
      const pre = snapshots.find(s => s.kind === "auto" && (s.autoReason === "pre-open" || s.autoReason === "pre-restore"));
      if (!pre) return new Map();
      return stateVectorOf((await client.getSnapshotState(pre.id)).state);
    } catch {
      return new Map();
    }
  };

  const rebaseOnce = async (): Promise<void> => {
    const fromEpoch = epoch;
    const cur = await client.getDocumentState(documentId);
    if (cur.epoch === epoch) {
      // Spurious (e.g. a 4409 close after we already resubscribed): just resubscribe the same doc.
      handle = subscribeSync(doc, epoch);
      refreshStatus();
      return;
    }
    const preVec = await preBumpVector();
    phase = "rebasing";
    refreshStatus();

    // Anything local that neither the pre-bump server state nor the new live state has is lost.
    const curVec = stateVectorOf(cur.state);
    let lost = false;
    for (const [client_, clock_] of Y.decodeStateVector(Y.encodeStateVector(doc))) {
      if (clock_ > Math.max(preVec.get(client_) ?? 0, curVec.get(client_) ?? 0)) lost = true;
    }
    let preservedKey: string | null = null;
    if (lost) {
      // The API cannot ingest a client-state snapshot (createSnapshot pins the server's live state), so the
      // copy is kept in the offline store instead of an `offline-edits` snapshot. See Known gaps.
      preservedKey = `${documentId}#lost@${fromEpoch}@${clock()}`;
      await offline.save(preservedKey, { epoch: fromEpoch, state: Y.encodeStateAsUpdateV2(doc) });
    }

    handle.unsubscribe();
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    const nd = new Y.Doc();
    Y.applyUpdateV2(nd, cur.state, OFFLINE_ORIGIN);
    detach();
    attach(nd, cur.epoch);
    handle = subscribeSync(nd, cur.epoch);
    phase = "live";
    bump();
    for (const l of [...modelListeners]) l(null);
    events.emit("change", null);
    refreshStatus();
    void flush().catch(() => undefined);
    const ev: RebasedEvent = { fromEpoch, toEpoch: cur.epoch, lostLocalEdits: lost, preservedKey };
    events.emit("rebased", ev);
    void waitSynced(handle, syncTimeoutMs).catch(() => undefined);
  };

  const runRebase = () => {
    if (rebaseRun) {
      rebaseAgain = true;
      return;
    }
    rebaseRun = (async () => {
      let failures = 0;
      do {
        rebaseAgain = false;
        try {
          if (phase !== "closed") await rebaseOnce();
          failures = 0;
        } catch (e) {
          if (phase === "rebasing") phase = "live";
          events.emit("error", e instanceof Error ? e : new Error(String(e)));
          refreshStatus();
          if (++failures < 5) {
            await sleep(1000 * failures);
            rebaseAgain = true;
          }
        }
      } while (rebaseAgain && phase !== "closed");
    })().finally(() => {
      rebaseRun = null;
    });
  };

  const offSync = [
    sync.on("epochChanged", e => e.documentId === documentId && runRebase()),
    sync.on("docStatus", e => e.documentId === documentId && refreshStatus()),
    sync.on("status", () => refreshStatus()),
    sync.on("stopped", () => refreshStatus()),
  ];

  // ── snapshot flows ──
  const waitUntil = async (cond: () => boolean, ms: number) => {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < ms) await sleep(25);
    return cond();
  };
  const settled = () => phase === "live" && handle.state === "active" && handle.status === "synced" && handle.unackedCount === 0;

  const session: DocumentSession = {
    documentId,
    get model() {
      return model;
    },
    get detail() {
      return detail;
    },
    get epoch() {
      return epoch;
    },
    get syncStatus() {
      return statusCache ?? computeStatus();
    },
    get remoteCursors() {
      return remoteCursors;
    },
    get revision() {
      return revision;
    },

    execute(commands: readonly CommandInvocation[], opts: ExecuteOptions = {}): BatchResult {
      if (phase !== "live") return { ok: false, index: -1, reason: "readOnly", detail: { why: phase } };
      const role = detail?.role;
      const origin = origins.make(opts.kind ?? "local-command", opts.groupKey ? { groupKey: opts.groupKey } : {});
      return executeBatch({
        doc,
        model,
        commands,
        actor,
        origin,
        capabilities: new Set<Capability>(role === "viewer" ? [] : role === "commenter" ? ["comment"] : ["write", "comment"]),
        ids,
        clock,
        ...(role === "viewer" || role === "commenter" ? { readOnly: true } : {}),
      });
    },
    undo: () => phase === "live" && undo.undo(),
    redo: () => phase === "live" && undo.redo(),
    canUndo: () => phase === "live" && undo.canUndo(),
    canRedo: () => phase === "live" && undo.canRedo(),
    noteCaret: id => undo.noteCaret(id),

    subscribe(listener) {
      modelListeners.add(listener);
      return () => void modelListeners.delete(listener);
    },
    on: (event, fn) => events.on(event, fn),
    setLocalCursor(cursor) {
      localCursor = cursor;
      handle.setLocalAwareness(cursor === null ? null : { user: me, cursor });
    },

    listSnapshots: opts => client.listSnapshots(documentId, opts),
    async createSnapshot(name, note) {
      await waitUntil(settled, 3000); // the snapshot pins the server's state: let our edits land first
      return client.createSnapshot(documentId, {
        clientSnapshotId: `cs_${globalThis.crypto.randomUUID()}`,
        name,
        ...(note ? { note } : {}),
        sourceEpoch: epoch,
      });
    },
    async openSnapshot(snapshotId) {
      const res = await client.openSnapshot(snapshotId);
      await waitUntil(() => epoch >= res.epoch && phase === "live", 10_000);
      return res;
    },
    forkSnapshot: (snapshotId, title, targetProjectId) =>
      client.forkSnapshot(snapshotId, { title, ...(targetProjectId ? { targetProjectId } : {}) }),
    listVersions: () => client.listVersions(documentId),
    async restoreVersion(versionId) {
      const res = await client.restoreVersion(documentId, versionId);
      await waitUntil(() => epoch >= res.epoch && phase === "live", 10_000);
      return res;
    },

    settle: (ms = 3000) => waitUntil(settled, ms),
    flush,
    async close() {
      if (phase === "closed") return;
      const wasLive = phase === "live";
      if (wasLive) await flush().catch(() => undefined);
      phase = "closed";
      offSync.forEach(f => f());
      if (persistTimer) clearTimeout(persistTimer);
      handle.unsubscribe();
      refreshStatus();
      detach();
      modelListeners.clear();
      events.clear();
    },
  };
  return session;
}
