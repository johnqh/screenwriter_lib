import { createStore, type StoreApi } from "zustand/vanilla";
import type { TemplateSummary } from "@sudobility/screenwriter_types";
import type { ScreenwriterClient } from "@sudobility/screenwriter_client";
import { message } from "./auth-store";

export interface TemplatesState {
  items: TemplateSummary[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The `(category, locale)` pair `items` was last successfully loaded for (`templatesFilterKey`), `null` before
   * the first load — lets a caller (`useTemplates`) tell a stale list under a different filter from a fresh one,
   * instead of the plain `loaded` boolean, which only knew "has *a* load ever finished". */
  loadedFor: string | null;
  load(category?: string, locale?: string): Promise<void>;
  reset(): void;
}

export type TemplatesClient = Pick<ScreenwriterClient, "listTemplates">;
export type TemplatesStore = StoreApi<TemplatesState>;

/** A stable key for a `(category, locale)` filter pair. `\0` can't appear in either, so this can't collide. */
export const templatesFilterKey = (category?: string, locale?: string): string => `${category ?? ""}\0${locale ?? ""}`;

export function createTemplatesStore(client: TemplatesClient): TemplatesStore {
  return createStore<TemplatesState>(set => ({
    items: [],
    loaded: false,
    loading: false,
    error: null,
    loadedFor: null,
    async load(category, locale) {
      set({ loading: true, error: null });
      try {
        set({
          items: await client.listTemplates({ category, locale }),
          loaded: true,
          loadedFor: templatesFilterKey(category, locale),
        });
      } catch (e) {
        set({ error: message(e) });
      } finally {
        set({ loading: false });
      }
    },
    reset: () => set({ items: [], loaded: false, loading: false, error: null, loadedFor: null }),
  }));
}
