import { createStore, type StoreApi } from "zustand/vanilla";
import { cryptoIdSource, newId, type DocumentKind } from "@sudobility/writing_core";
import type { DocumentMeta } from "@sudobility/screenwriter_types";
import type { ScreenwriterClient } from "@sudobility/screenwriter_client";
import { message } from "./auth-store";

export interface ProjectDocuments {
  items: DocumentMeta[];
  showingTrash: boolean;
  loading: boolean;
  error: string | null;
}

export interface DocumentsState {
  byProject: Record<string, ProjectDocuments>;
  load(projectId: string, opts?: { trashed?: boolean }): Promise<void>;
  /** Creates from a template (`templateId`); the id is generated here so a retry is idempotent. */
  create(projectId: string, input: { title: string; kind?: DocumentKind; templateId?: string; language?: string }): Promise<DocumentMeta | null>;
  /** Add or replace a document made elsewhere (an import) in the project's list. */
  upsert(projectId: string, document: DocumentMeta): void;
  trash(projectId: string, documentId: string): Promise<void>;
  restore(projectId: string, documentId: string): Promise<void>;
  reset(): void;
}

export type DocumentsClient = Pick<ScreenwriterClient, "listDocuments" | "createDocument" | "trashDocument" | "restoreDocument">;
export type DocumentsStore = StoreApi<DocumentsState>;

const EMPTY: ProjectDocuments = { items: [], showingTrash: false, loading: false, error: null };

export function createDocumentsStore(client: DocumentsClient): DocumentsStore {
  return createStore<DocumentsState>((set, get) => {
    const patch = (pid: string, p: Partial<ProjectDocuments>) =>
      set(s => ({ byProject: { ...s.byProject, [pid]: { ...(s.byProject[pid] ?? EMPTY), ...p } } }));
    const cur = (pid: string) => get().byProject[pid] ?? EMPTY;
    const run = async (pid: string, fn: () => Promise<void>) => {
      patch(pid, { loading: true, error: null });
      try {
        await fn();
      } catch (e) {
        patch(pid, { error: message(e) });
      } finally {
        patch(pid, { loading: false });
      }
    };
    return {
      byProject: {},
      load: (pid, opts) =>
        run(pid, async () => {
          const trashed = opts?.trashed ?? false;
          const page = await client.listDocuments(pid, { trashed });
          patch(pid, { items: page.items, showingTrash: trashed });
        }),
      async create(pid, input) {
        let created: DocumentMeta | null = null;
        await run(pid, async () => {
          created = await client.createDocument(pid, {
            id: newId("doc", cryptoIdSource),
            title: input.title,
            kind: input.kind ?? "script",
            ...(input.templateId ? { templateId: input.templateId } : {}),
            ...(input.language ? { language: input.language } : {}),
          });
          if (!cur(pid).showingTrash) patch(pid, { items: [...cur(pid).items, created] });
        });
        return created;
      },
      upsert(pid, doc) {
        if (cur(pid).showingTrash) return;
        patch(pid, { items: [...cur(pid).items.filter(d => d.id !== doc.id), doc] });
      },
      trash: (pid, did) =>
        run(pid, async () => {
          await client.trashDocument(did);
          patch(pid, { items: cur(pid).items.filter(d => d.id !== did) });
        }),
      restore: (pid, did) =>
        run(pid, async () => {
          await client.restoreDocument(did);
          patch(pid, { items: cur(pid).items.filter(d => d.id !== did) });
        }),
      reset: () => set({ byProject: {} }),
    };
  });
}
