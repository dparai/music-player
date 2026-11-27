// Songs fetched ahead of time and held in memory. A locked phone cannot start a
// new network load: in the debug log of a real stall every song change that
// needed a fresh stream ended in `stalled` then "Format error", while a song
// fetched a few seconds after locking played fine. So the next few songs are
// downloaded while the screen is on (or right after it turns off), and the
// handoff plays them from memory as blob: URLs, with no network at all.

export interface AheadItem {
  key: string;
  url: () => string;
}

export interface AheadDeps {
  fetchFn: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  makeUrl: (blob: Blob) => string;
  revokeUrl: (url: string) => void;
  onEvent?: (event: string, data?: unknown) => void;
}

export const AHEAD_COUNT = 4; // songs held ahead of the one playing
export const AHEAD_MAX_BYTES = 120 * 1024 * 1024;
export const AHEAD_FETCH_TIMEOUT_MS = 90_000;
const MIN_BYTES = 10_000; // anything smaller is an error page, not a song

interface Entry { url: string; bytes: number }
interface Inflight { ctl: AbortController; done: Promise<void> }

export class AheadStore {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Inflight>();
  private generation = 0;

  private deps: AheadDeps;

  constructor(deps: AheadDeps) {
    this.deps = deps;
  }

  // The blob: URL for a fetched song, or null.
  urlFor(key: string): string | null {
    return this.entries.get(key)?.url ?? null;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get bytes(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.bytes;
    return n;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  // `keep`: songs that must stay (the one playing). `items`: what to hold, in
  // play order. Everything else is dropped; a fetch no longer wanted is
  // cancelled. Resolves when this round is done (or superseded by a newer one).
  async sync(keep: string[], items: AheadItem[]): Promise<void> {
    const gen = ++this.generation;
    const wanted = new Set([...keep, ...items.map((i) => i.key)]);

    for (const [key, e] of [...this.entries]) {
      if (!wanted.has(key)) { this.deps.revokeUrl(e.url); this.entries.delete(key); }
    }
    for (const [key, f] of [...this.inflight]) {
      if (!wanted.has(key)) f.ctl.abort();
    }

    for (const item of items) {
      if (gen !== this.generation) return; // a newer round took over
      if (this.entries.has(item.key)) continue;
      await this.fetchOne(item, gen);
    }
  }

  // Forget everything (logout).
  clear(): void {
    this.generation++;
    for (const f of this.inflight.values()) f.ctl.abort();
    for (const e of this.entries.values()) this.deps.revokeUrl(e.url);
    this.entries.clear();
  }

  private fetchOne(item: AheadItem, gen: number): Promise<void> {
    const existing = this.inflight.get(item.key);
    if (existing) return existing.done; // a round that was superseded already started it

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), AHEAD_FETCH_TIMEOUT_MS);
    const started = Date.now();
    const done = (async () => {
      try {
        const res = await this.deps.fetchFn(item.url(), { signal: ctl.signal });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (blob.size < MIN_BYTES) throw new Error(`too small (${blob.size} bytes)`);
        // Wanted by a later round? Check against the live generation, not `gen`:
        // the song may still be wanted even though the round that asked is over.
        if (ctl.signal.aborted) return;
        if (this.bytes + blob.size > AHEAD_MAX_BYTES) throw new Error("over the memory limit");
        this.entries.set(item.key, { url: this.deps.makeUrl(blob), bytes: blob.size });
        this.deps.onEvent?.("ahead ready", { key: item.key, bytes: blob.size, ms: Date.now() - started });
      } catch (e) {
        if (!ctl.signal.aborted) this.deps.onEvent?.("ahead failed", { key: item.key, err: String(e) });
      } finally {
        clearTimeout(timer);
        this.inflight.delete(item.key);
      }
    })();
    this.inflight.set(item.key, { ctl, done });
    void gen;
    return done;
  }
}
