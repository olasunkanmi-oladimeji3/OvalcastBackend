// In-memory caches. Hot data (a live match, a league table) is held by the server so
// thousands of viewers share one database read instead of making one each.

interface Entry<V> {
  value: V;
  expires: number;
}

/** A size-bounded map whose entries expire. Oldest entries go first when it's full. */
export class TtlCache<V> {
  private map = new Map<string, Entry<V>>();
  private inflight = new Map<string, Promise<V>>();
  /** Bumped whenever entries are dropped, so a load that started before can't put back an old value. */
  private generation = 0;

  constructor(private readonly max = 5000) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V, ttlMs: number) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  delete(key: string) {
    this.generation += 1;
    this.map.delete(key);
    this.inflight.delete(key);
  }

  /** Drops every entry whose key passes the test. */
  deleteWhere(test: (key: string) => boolean) {
    this.generation += 1;
    for (const k of this.map.keys()) if (test(k)) this.map.delete(k);
    for (const k of this.inflight.keys()) if (test(k)) this.inflight.delete(k);
  }

  clear() {
    this.generation += 1;
    this.map.clear();
    this.inflight.clear();
  }

  get size() {
    return this.map.size;
  }

  /**
   * The cached value, or loads it once. Requests that arrive while it's loading wait for
   * the same load rather than each going to the database.
   */
  async remember(key: string, ttlMs: number, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const gen = this.generation;
    const p: Promise<V> = load()
      .then((v) => {
        // Dropped while loading: the caller gets what was read, but it isn't kept.
        if (gen === this.generation) this.set(key, v, ttlMs);
        return v;
      })
      .finally(() => {
        if (this.inflight.get(key) === p) this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }
}

/** Every cache in the process, so tests and the seed script can empty them all at once. */
const registry = new Set<{ clear(): void }>();
export const registerCache = <T extends { clear(): void }>(c: T) => (registry.add(c), c);
export const clearAllCaches = () => registry.forEach((c) => c.clear());
