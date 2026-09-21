/** One document's locally persisted Yjs state. `state` is a Yjs V2 update; `epoch` is the epoch it belongs to. */
export interface OfflineDocRecord {
  epoch: number;
  state: Uint8Array;
}

/**
 * Where a document's state is kept between sessions (spec 03 section 7.1). The app supplies the durable
 * adapter (IndexedDB on the web); `InMemoryOfflineDocStore` is for tests and as a default.
 */
export interface OfflineDocStore {
  load(documentId: string): Promise<OfflineDocRecord | null>;
  save(documentId: string, record: OfflineDocRecord): Promise<void>;
  delete(documentId: string): Promise<void>;
}

export class InMemoryOfflineDocStore implements OfflineDocStore {
  private readonly records = new Map<string, OfflineDocRecord>();

  async load(documentId: string): Promise<OfflineDocRecord | null> {
    const r = this.records.get(documentId);
    return r ? { epoch: r.epoch, state: r.state.slice() } : null;
  }

  async save(documentId: string, record: OfflineDocRecord): Promise<void> {
    this.records.set(documentId, { epoch: record.epoch, state: record.state.slice() });
  }

  async delete(documentId: string): Promise<void> {
    this.records.delete(documentId);
  }

  /** Test helper. */
  keys(): string[] {
    return [...this.records.keys()];
  }
}
