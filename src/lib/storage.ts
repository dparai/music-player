import type { SubsonicCredentials } from "./subsonic";

const CREDS_KEY = "deepakmusic_creds";
const QUEUE_KEY = "deepakmusic_queue";
const LAST_PLAYED_KEY = "deepakmusic_last_played";
const VIEW_KEY = "deepakmusic_view";

export function saveCredentials(creds: SubsonicCredentials): void {
  localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
}

export function loadCredentials(): SubsonicCredentials | null {
  try {
    const raw = localStorage.getItem(CREDS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SubsonicCredentials;
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  localStorage.removeItem(CREDS_KEY);
}

export function saveQueue(songIds: string[], currentIndex: number, position: number): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify({ songIds, currentIndex, position }));
  } catch { /* quota exceeded — ignore */ }
}

export function loadQueue(): { songIds: string[]; currentIndex: number; position: number } | null {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveLastPlayed(songId: string): void {
  try { localStorage.setItem(LAST_PLAYED_KEY, songId); } catch {}
}

export function loadLastPlayed(): string | null {
  try { return localStorage.getItem(LAST_PLAYED_KEY); } catch { return null; }
}

export function saveView(view: string): void {
  try { localStorage.setItem(VIEW_KEY, view); } catch {}
}

export function loadView(): string | null {
  try { return localStorage.getItem(VIEW_KEY); } catch { return null; }
}
