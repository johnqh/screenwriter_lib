import type { AuthPort, AuthUser } from "../ports/auth";

/** Minimal Storage shape (localStorage fits) so a dev sign-in can survive a reload. */
export interface DevAuthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Deterministic uid for an email: 64-bit FNV-1a, hex. Same email, same uid, on every device. */
export function devUidForEmail(email: string): string {
  const s = email.trim().toLowerCase();
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c ^ (i & 0xff), 0x01000193) >>> 0;
  }
  return `u${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * Local-development auth. The token is `dev:<uid>:<email>`, which the API accepts when it runs with
 * `AI_TEST_MODE=1` (both on REST and on the sync socket's `auth` frame). No password.
 */
export class DevAuthPort implements AuthPort {
  private user: AuthUser | null = null;
  private readonly listeners = new Set<(u: AuthUser | null) => void>();

  constructor(
    private readonly storage?: DevAuthStorage,
    private readonly storageKey = "screenwriter.devEmail"
  ) {
    let saved: string | null = null;
    try {
      saved = storage?.getItem(storageKey) ?? null;
    } catch {
      /* storage unavailable */
    }
    if (saved) this.user = DevAuthPort.userFor(saved);
  }

  private static userFor(email: string): AuthUser {
    const e = email.trim().toLowerCase();
    return { uid: devUidForEmail(e), email: e, displayName: e.split("@")[0] || e };
  }

  get currentUser(): AuthUser | null {
    return this.user;
  }

  async signIn(email: string): Promise<AuthUser> {
    if (typeof email !== "string" || !email.includes("@")) throw new Error("DevAuthPort.signIn needs an email address");
    this.user = DevAuthPort.userFor(email);
    try {
      this.storage?.setItem(this.storageKey, this.user.email!);
    } catch {
      /* storage unavailable */
    }
    this.emit();
    return this.user;
  }

  async signOut(): Promise<void> {
    this.user = null;
    try {
      this.storage?.removeItem(this.storageKey);
    } catch {
      /* storage unavailable */
    }
    this.emit();
  }

  async getToken(): Promise<string | null> {
    return this.user ? `dev:${this.user.uid}:${this.user.email}` : null;
  }

  onChange(listener: (user: AuthUser | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l(this.user);
  }
}
