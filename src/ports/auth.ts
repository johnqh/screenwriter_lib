/** Who is signed in. `uid` is the API's user id (Firebase uid, or the dev uid). */
export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

/**
 * The lib's only view of authentication. The app implements it (Firebase in production, `DevAuthPort`
 * in local development); the lib never imports an auth SDK.
 */
export interface AuthPort {
  readonly currentUser: AuthUser | null;
  /** Argument shape is implementation-specific (dev auth takes an email, Firebase a provider). */
  signIn(input?: unknown): Promise<AuthUser>;
  signOut(): Promise<void>;
  /** Bearer token for REST and the sync socket's `auth` frame. Null when signed out. */
  getToken(forceRefresh?: boolean): Promise<string | null>;
  /** Called on sign in, sign out and user change. Returns the unsubscribe function. */
  onChange(listener: (user: AuthUser | null) => void): () => void;
}
