/** Tiny typed emitter; a throwing listener never breaks the others. */
export class Emitter<E extends Record<string, unknown>> {
  private readonly map = new Map<keyof E, Set<(p: never) => void>>();

  on<K extends keyof E>(event: K, fn: (payload: E[K]) => void): () => void {
    let set = this.map.get(event);
    if (!set) this.map.set(event, (set = new Set()));
    set.add(fn as (p: never) => void);
    return () => set.delete(fn as (p: never) => void);
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    for (const fn of [...(this.map.get(event) ?? [])]) {
      try {
        (fn as (p: E[K]) => void)(payload);
      } catch {
        /* listener errors are the listener's problem */
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}
