import { createStore, type StoreApi } from "zustand/vanilla";
import type { ProjectCreateRequest, ProjectSummary } from "@sudobility/screenwriter_types";
import type { ScreenwriterClient } from "@sudobility/screenwriter_client";
import { message } from "./auth-store";

export interface ProjectsState {
  items: ProjectSummary[];
  /** True when `items` is the trash listing. */
  showingTrash: boolean;
  loading: boolean;
  error: string | null;
  load(opts?: { trashed?: boolean }): Promise<void>;
  create(input: ProjectCreateRequest): Promise<ProjectSummary | null>;
  trash(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  reset(): void;
}

export type ProjectsClient = Pick<ScreenwriterClient, "listProjects" | "createProject" | "trashProject" | "restoreProject">;
export type ProjectsStore = StoreApi<ProjectsState>;

/** Projects of the personal workspace. `getWorkspaceId` resolves the workspace (from `me`). */
export function createProjectsStore(client: ProjectsClient, getWorkspaceId: () => Promise<string>): ProjectsStore {
  const store: ProjectsStore = createStore<ProjectsState>((set, get) => {
    const run = async (fn: () => Promise<void>) => {
      set({ loading: true, error: null });
      try {
        await fn();
      } catch (e) {
        set({ error: message(e) });
      } finally {
        set({ loading: false });
      }
    };
    return {
      items: [],
      showingTrash: false,
      loading: false,
      error: null,
      load: opts =>
        run(async () => {
          const trashed = opts?.trashed ?? false;
          const page = await client.listProjects(await getWorkspaceId(), { trashed });
          set({ items: page.items, showingTrash: trashed });
        }),
      async create(input) {
        let created: ProjectSummary | null = null;
        await run(async () => {
          created = await client.createProject(await getWorkspaceId(), input);
          if (!get().showingTrash) set({ items: [created, ...get().items] });
        });
        return created;
      },
      trash: id =>
        run(async () => {
          await client.trashProject(id);
          set({ items: get().items.filter(p => p.id !== id) });
        }),
      restore: id =>
        run(async () => {
          await client.restoreProject(id);
          set({ items: get().items.filter(p => p.id !== id) });
        }),
      reset: () => set({ items: [], showingTrash: false, loading: false, error: null }),
    };
  });
  return store;
}
