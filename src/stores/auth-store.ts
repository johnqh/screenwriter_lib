import { createStore, type StoreApi } from "zustand/vanilla";
import type { Me } from "@sudobility/screenwriter_types";
import type { ScreenwriterClient } from "@sudobility/screenwriter_client";
import type { AuthPort, AuthUser } from "../ports/auth";

export type AuthStatus = "signedOut" | "signingIn" | "signedIn";

export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  /** `GET /me` (creates the account and personal workspace on first sight). */
  me: Me | null;
  error: string | null;
  signIn(input?: unknown): Promise<void>;
  signOut(): Promise<void>;
}

export type AuthClient = Pick<ScreenwriterClient, "me">;

export type AuthStore = StoreApi<AuthState>;

/** Mirrors the `AuthPort` and loads `me` whenever a user is present. Call the returned function to detach. */
export function createAuthStore(auth: AuthPort, client: AuthClient): { store: AuthStore; dispose: () => void } {
  const store = createStore<AuthState>(set => ({
    status: auth.currentUser ? "signedIn" : "signedOut",
    user: auth.currentUser,
    me: null,
    error: null,
    async signIn(input) {
      set({ status: "signingIn", error: null });
      try {
        await auth.signIn(input); // onChange below completes the transition
      } catch (e) {
        set({ status: "signedOut", error: message(e) });
      }
    },
    async signOut() {
      await auth.signOut();
    },
  }));

  const loadMe = async (user: AuthUser) => {
    try {
      const me = await client.me();
      if (store.getState().user?.uid === user.uid) store.setState({ me, error: null });
    } catch (e) {
      if (store.getState().user?.uid === user.uid) store.setState({ error: message(e) });
    }
  };

  const apply = (user: AuthUser | null) => {
    store.setState({ user, status: user ? "signedIn" : "signedOut", me: null });
    if (user) void loadMe(user);
  };
  const off = auth.onChange(apply);
  if (auth.currentUser) void loadMe(auth.currentUser);
  return { store, dispose: off };
}

export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
