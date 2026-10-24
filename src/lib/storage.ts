import type { SubsonicCredentials } from "./subsonic";

const CREDS_KEY = "deepakmusic_creds";
const QUEUE_KEY = "deepakmusic_queue";

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
