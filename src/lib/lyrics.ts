import type { SubsonicCredentials, SubsonicSong } from "./subsonic";
import { getStructuredLyrics, getPlainLyrics } from "./subsonic";
import { getServerLyrics } from "./automix";
import { parseLrc, type Lyrics } from "./lrc";

export type { Lyrics, LyricLine } from "./lrc";
export { activeLine } from "./lrc";

// `error`: a lookup failed (service down, offline), so "none" would be a guess.
export interface LyricsResult {
  lyrics: Lyrics | null;
  error: boolean;
}

const cache = new Map<string, Lyrics | null>();
const DURATION_SLACK = 5; // seconds a LRCLIB match may differ from the file

async function fromServer(creds: SubsonicCredentials, song: SubsonicSong): Promise<Lyrics | null> {
  try {
    const list = await getStructuredLyrics(creds, song.id);
    const pick = list.find((l) => l.synced) ?? list[0];
    if (pick && pick.line.length > 0) {
      const synced = pick.synced && pick.line.every((l) => typeof l.start === "number");
      return {
        synced,
        lines: pick.line.map((l) => ({ time: synced ? l.start! / 1000 : null, text: l.value })),
      };
    }
  } catch { /* server without the OpenSubsonic endpoint */ }
  try {
    const text = await getPlainLyrics(creds, song.artist ?? "", song.title);
    return text ? parseLrc(text) : null;
  } catch {
    return null;
  }
}

interface LrclibHit {
  duration?: number;
  instrumental?: boolean;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
}

function fromHit(hit: LrclibHit): Lyrics | null {
  const text = hit.syncedLyrics || hit.plainLyrics;
  return text ? parseLrc(text) : null;
}

// LRCLIB is the fallback when the server has none. This sends the song's title,
// artist, album and length to lrclib.net.
async function fromLrclib(song: SubsonicSong): Promise<LyricsResult> {
  const base = "https://lrclib.net/api";
  try {
    const exact = await fetch(`${base}/get?${new URLSearchParams({
      track_name: song.title,
      artist_name: song.artist ?? "",
      album_name: song.album ?? "",
      duration: String(Math.round(song.duration)),
    })}`);
    if (exact.ok) {
      const lyrics = fromHit((await exact.json()) as LrclibHit);
      if (lyrics) return { lyrics, error: false };
    }
    // No exact match (tags differ from LRCLIB's): search by title and artist.
    const res = await fetch(`${base}/search?${new URLSearchParams({
      track_name: song.title,
      artist_name: song.artist ?? "",
    })}`);
    if (!res.ok) return { lyrics: null, error: true };
    const hits = ((await res.json()) as LrclibHit[])
      .filter((h) => !h.instrumental && (h.syncedLyrics || h.plainLyrics)
        && Math.abs((h.duration ?? song.duration) - song.duration) <= DURATION_SLACK)
      .sort((a, b) =>
        Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics)
        || Math.abs((a.duration ?? 0) - song.duration) - Math.abs((b.duration ?? 0) - song.duration));
    return { lyrics: hits[0] ? fromHit(hits[0]) : null, error: false };
  } catch {
    return { lyrics: null, error: true };
  }
}

// Lookup order: the song's own tags or .lrc file (Navidrome), then the Brook
// server, which asks LRCLIB with retries and caches. The browser only asks
// LRCLIB itself when the Brook server can't be reached or lacks the endpoint.
async function fromBrookServer(song: SubsonicSong): Promise<LyricsResult> {
  try {
    const r = await getServerLyrics(song);
    if (r.status === "unavailable") return { lyrics: null, error: true };
    return { lyrics: r.status === "ok" && r.lrc ? parseLrc(r.lrc) : null, error: false };
  } catch {
    return fromLrclib(song);
  }
}

export async function fetchLyrics(creds: SubsonicCredentials, song: SubsonicSong): Promise<LyricsResult> {
  if (cache.has(song.id)) return { lyrics: cache.get(song.id)!, error: false };
  let lyrics = await fromServer(creds, song);
  let error = false;
  if (!lyrics) ({ lyrics, error } = await fromBrookServer(song));
  if (!error) cache.set(song.id, lyrics); // a failed lookup is retried, not remembered
  return { lyrics, error };
}
