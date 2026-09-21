import { createStore, type StoreApi } from "zustand/vanilla";
import type { TemplateSummary } from "@sudobility/screenwriter_types";
import type { ScreenwriterClient } from "@sudobility/screenwriter_client";
import { message } from "./auth-store";

export interface TemplatesState {
  items: TemplateSummary[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  load(category?: string): Promise<void>;
  reset(): void;
}

export type TemplatesClient = Pick<ScreenwriterClient, "listTemplates">;
export type TemplatesStore = StoreApi<TemplatesState>;

export function createTemplatesStore(client: TemplatesClient): TemplatesStore {
  return createStore<TemplatesState>(set => ({
    items: [],
    loaded: false,
    loading: false,
    error: null,
    async load(category) {
      set({ loading: true, error: null });
      try {
        set({ items: await client.listTemplates(category), loaded: true });
      } catch (e) {
        set({ error: message(e) });
      } finally {
        set({ loading: false });
      }
    },
    reset: () => set({ items: [], loaded: false, loading: false, error: null }),
  }));
}
