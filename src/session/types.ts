import type { BatchResult, CommandInvocation, DocumentModel, ModelChangeBatch, OriginKind } from "@sudobility/writing_core";
import type { ConnectionStatus } from "@sudobility/screenwriter_client";
import type {
  DocumentDetail,
  DocumentMeta,
  Paginated,
  SnapshotCreateResponse,
  SnapshotListResponse,
  SnapshotOpenResponse,
  VersionListItem,
  VersionRestoreResponse,
} from "@sudobility/screenwriter_types";

export type Unsubscribe = () => void;

/**
 * `syncing`: not caught up with the server yet (or offline). `synced`: caught up and live.
 * `stale`: the epoch changed and the session has not rebuilt yet. `rebasing`: rebuilding.
 */
export type SessionSyncState = "syncing" | "synced" | "stale" | "rebasing" | "closed";

export interface SessionSyncStatus {
  readonly connection: ConnectionStatus;
  readonly state: SessionSyncState;
  readonly epoch: number;
}

export interface RemoteCursor {
  readonly clientId: number;
  readonly user: { id: string; name: string; color: string } | null;
  /** Whatever the caller passed to `setLocalCursor` (the UI defines the shape). */
  readonly cursor: unknown;
}

export interface RebasedEvent {
  fromEpoch: number;
  toEpoch: number;
  /**
   * True when this session had edits the server never received (made offline or after the server
   * bumped the epoch). They are not in the new document. A copy of the pre-rebase local state was kept in
   * the offline store under `preservedKey`.
   */
  lostLocalEdits: boolean;
  preservedKey: string | null;
}

export interface SessionEvents extends Record<string, unknown> {
  /** Model changed; `null` = the whole model was rebuilt (rebase). */
  change: ModelChangeBatch | null;
  status: SessionSyncStatus;
  presence: ReadonlyMap<number, RemoteCursor>;
  rebased: RebasedEvent;
  error: Error;
}

export interface ExecuteOptions {
  /** `local-typing` for keystrokes, `local-command` (default) for menu actions. Both are undoable. */
  kind?: Extract<OriginKind, "local-typing" | "local-command">;
  /** Consecutive commands with the same key merge into one undo step. */
  groupKey?: string;
}

export interface DocumentSession {
  readonly documentId: string;
  /** The current read model. Replaced on rebase: re-read it after `rebased`/`change(null)`. */
  readonly model: DocumentModel;
  /** Server metadata (null when the session was opened from the offline store without the network). */
  readonly detail: DocumentDetail | null;
  readonly epoch: number;
  readonly syncStatus: SessionSyncStatus;
  readonly remoteCursors: ReadonlyMap<number, RemoteCursor>;
  /** Bumps on every change, status change, presence change and rebase (for external-store hooks). */
  readonly revision: number;

  execute(commands: readonly CommandInvocation[], options?: ExecuteOptions): BatchResult;
  /** Undo/redo this session's own edits only; never a collaborator's. */
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Tell the undo manager the caret moved to another element (starts a new undo step). */
  noteCaret(elementId: string | null): void;

  subscribe(listener: (batch: ModelChangeBatch | null) => void): Unsubscribe;
  on<K extends keyof SessionEvents>(event: K, fn: (payload: SessionEvents[K]) => void): Unsubscribe;
  /** Publish this user's cursor/selection (`null` clears it). */
  setLocalCursor(cursor: unknown): void;

  listSnapshots(opts?: { includeAutomatic?: boolean }): Promise<SnapshotListResponse>;
  /** Waits until this session's edits are acknowledged, then pins the live state. */
  createSnapshot(name: string, note?: string): Promise<SnapshotCreateResponse>;
  /** Replaces the live document with the snapshot; resolves once this session has rebased onto it. */
  openSnapshot(snapshotId: string): Promise<SnapshotOpenResponse>;
  forkSnapshot(snapshotId: string, title: string, targetProjectId?: string): Promise<DocumentMeta>;
  listVersions(): Promise<Paginated<VersionListItem>>;
  restoreVersion(versionId: string): Promise<VersionRestoreResponse>;

  /** Persist to the offline store now. */
  flush(): Promise<void>;
  close(): Promise<void>;
}
