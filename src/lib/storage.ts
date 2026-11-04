import type { SubsonicCredentials, SubsonicSong } from "./subsonic";

const CREDS_KEY = "deepakmusic_creds";
const LAST_PLAYED_KEY = "deepakmusic_last_played";
const VIEW_KEY = "deepakmusic_view";
const SONGS_KEY = "deepakmusic_songs";
const SONGS_MAX_CHARS = 2_000_000; // stay well inside the ~5 MB localStorage quota

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
  try { localStorage.removeItem(SONGS_KEY); } catch {}
}

// The last library list, so the app can show it before the network answers.
// Tied to server + user; the password is never stored here.
function songsKey(creds: SubsonicCredentials): string {
  return `${creds.server}|${creds.username}`;
}

export function saveSongsCache(creds: SubsonicCredentials, songs: SubsonicSong[]): void {
  try {
    const json = JSON.stringify({ key: songsKey(creds), songs });
    if (json.length <= SONGS_MAX_CHARS) localStorage.setItem(SONGS_KEY, json);
  } catch {}
}

export function loadSongsCache(creds: SubsonicCredentials): SubsonicSong[] | null {
  try {
    const raw = localStorage.getItem(SONGS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as { key?: string; songs?: unknown };
    return data.key === songsKey(creds) && Array.isArray(data.songs) ? (data.songs as SubsonicSong[]) : null;
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
