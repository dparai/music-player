// Songs saved on the device. Each is the original file, kept in Cache Storage
// under /offline/<id>. The service worker answers those URLs from the cache
// (with Range support, so seeking works), so a downloaded song plays with no
// network and the player only needs a plain URL it can set synchronously.

import { streamUrl, type SubsonicCredentials, type SubsonicSong } from "./subsonic";
import { BrookPlayer, isNativeApp, type NativeDownloads } from "./native";

// Inside the Android app the songs are saved by the native player as real files and played from there;
// everything below then just mirrors the native state. In a browser they go to Cache Storage as before.
const NATIVE = isNativeApp();

const CACHE = "brook-downloads";
const PREFIX = "/offline/";

export type DownloadState = { status: "queued" } | { status: "downloading"; pct: number } | { status: "failed"; reason: string };

const have = new Set<string>();
const active = new Map<string, DownloadState>();
const listeners = new Set<() => void>();
let version = 0;
let loadPromise: Promise<void> | null = null;

function changed() {
  version++;
  listeners.forEach((l) => l());
}

export function subscribeDownloads(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export const downloadsVersion = () => version;

export function offlineUrl(id: string): string {
  return PREFIX + encodeURIComponent(id);
}

// Sync, so the player can pick its source inside an event handler.
export function isDownloaded(id: string): boolean {
  return have.has(id);
}
export function downloadState(id: string): DownloadState | undefined {
  return active.get(id);
}
export function downloadedCount(): number {
  return have.size;
}

export const downloadsSupported = NATIVE || typeof caches !== "undefined";

// Reads which songs are already on the device. Call once at start.
export function loadDownloads(): Promise<void> {
  if (!downloadsSupported) return Promise.resolve();
  loadPromise ??= NATIVE ? readNative() : readDownloads();
  return loadPromise;
}

function applyNative(d: NativeDownloads) {
  have.clear();
  d.done.forEach((id) => have.add(id));
  active.clear();
  for (const [id, st] of Object.entries(d.active)) {
    if (st.status === "downloading") active.set(id, { status: "downloading", pct: st.pct ?? 0 });
    else if (st.status === "failed") active.set(id, { status: "failed", reason: st.reason ?? "Download failed" });
    else active.set(id, { status: "queued" });
  }
  changed();
}

async function readNative(): Promise<void> {
  try {
    await BrookPlayer.addListener("downloads", applyNative);
    applyNative(await BrookPlayer.getDownloads());
  } catch { /* the bridge is not ready: nothing is downloaded */ }
}

async function readDownloads(): Promise<void> {
  try {
    const cache = await caches.open(CACHE);
    for (const req of await cache.keys()) {
      const path = new URL(req.url).pathname;
      if (path.startsWith(PREFIX)) have.add(decodeURIComponent(path.slice(PREFIX.length)));
    }
    changed();
  } catch { /* storage blocked: nothing is downloaded */ }
}

export async function removeDownload(id: string): Promise<void> {
  if (NATIVE) {
    have.delete(id);
    changed();
    try { await BrookPlayer.removeDownloads({ ids: [id] }); } catch { /* already gone */ }
    return;
  }
  try {
    const cache = await caches.open(CACHE);
    await cache.delete(offlineUrl(id));
  } catch { /* already gone */ }
  have.delete(id);
  changed();
}

// A song deleted on the server is deleted from the device too. Pass the
// server's complete, freshly fetched list: never a cached or partial one, or
// saved songs would be wiped. An empty list is refused for the same reason.
export async function pruneDownloads(serverIds: Set<string>): Promise<number> {
  if (!downloadsSupported || serverIds.size === 0) return 0;
  await loadDownloads();
  const gone = [...have].filter((id) => !serverIds.has(id));
  for (const id of gone) await removeDownload(id);
  return gone.length;
}

export async function removeAllDownloads(): Promise<void> {
  if (NATIVE) {
    have.clear();
    changed();
    try { await BrookPlayer.removeAllDownloads(); } catch { /* ignore */ }
    return;
  }
  try { await caches.delete(CACHE); } catch { /* ignore */ }
  have.clear();
  changed();
}

async function fetchToCache(creds: SubsonicCredentials, song: SubsonicSong): Promise<void> {
  const res = await fetch(streamUrl(creds, song.id));
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || song.size || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array<ArrayBuffer>);
    got += value.length;
    if (total) active.set(song.id, { status: "downloading", pct: Math.min(99, Math.round((got / total) * 100)) });
    changed();
  }
  // A dropped connection can end the stream early without an error.
  if (total && got < total * 0.98) throw new Error("download cut short");
  const type = res.headers.get("content-type") || "audio/mpeg";
  const cache = await caches.open(CACHE);
  await cache.put(
    offlineUrl(song.id),
    new Response(new Blob(chunks, { type }), { status: 200, headers: { "content-type": type, "content-length": String(got) } }),
  );
}

// One at a time: several 40 MB files at once would only slow each other down.
const queue: { creds: SubsonicCredentials; song: SubsonicSong }[] = [];
let running = false;

async function pump() {
  if (running) return;
  running = true;
  try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
  while (queue.length) {
    const { creds, song } = queue.shift()!;
    active.set(song.id, { status: "downloading", pct: 0 });
    changed();
    try {
      await fetchToCache(creds, song);
      have.add(song.id);
      active.delete(song.id);
    } catch (e) {
      const full = e instanceof DOMException && e.name === "QuotaExceededError";
      active.set(song.id, { status: "failed", reason: full ? "Not enough storage" : String(e instanceof Error ? e.message : e) });
    }
    changed();
  }
  running = false;
}

export function downloadSongs(creds: SubsonicCredentials, songs: SubsonicSong[]): number {
  if (!downloadsSupported) return 0;
  if (NATIVE) {
    const todo = songs.filter((s) => !have.has(s.id) && (!active.has(s.id) || active.get(s.id)!.status === "failed"));
    if (todo.length === 0) return 0;
    for (const s of todo) active.set(s.id, { status: "queued" });
    changed();
    void BrookPlayer.download({
      items: todo.map((s) => ({
        id: s.id,
        url: new URL(streamUrl(creds, s.id), window.location.href).href,
        cacheKey: `orig:${s.id}`,
      })),
    });
    return todo.length;
  }
  let added = 0;
  for (const song of songs) {
    if (have.has(song.id)) continue;
    const st = active.get(song.id);
    if (st && st.status !== "failed") continue;
    active.set(song.id, { status: "queued" });
    queue.push({ creds, song });
    added++;
  }
  if (added) { changed(); void pump(); }
  return added;
}

export function cancelQueued(): void {
  if (NATIVE) { void BrookPlayer.cancelDownloads(); return; }
  for (const { song } of queue.splice(0)) active.delete(song.id);
  changed();
}

export function clearFailed(id: string): void {
  if (active.get(id)?.status === "failed") { active.delete(id); changed(); }
}
