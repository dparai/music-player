import type { SubsonicSong } from "./subsonic";
import { buildNameIndex, matchByName, type NameIndex } from "./match";
import { loadCredentials } from "./storage";
import md5 from "md5";

function automixUrl(path: string): string {
  const base = import.meta.env.DEV ? "" : window.location.origin;
  return `${base}/automix${path}`;
}

// The server verifies these against Navidrome (server/automix/auth.py), so
// the app needs no secret of its own in the bundle.
function subsonicAuthHeaders(): Record<string, string> {
  const creds = loadCredentials();
  if (!creds) return {};
  const salt = Math.random().toString(36).slice(2, 10);
  return {
    // Header values must be Latin-1: a non-Latin username would make fetch throw.
    "X-Subsonic-User": encodeURIComponent(creds.username),
    "X-Subsonic-Token": md5(creds.password + salt),
    "X-Subsonic-Salt": salt,
  };
}

async function automixFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(automixUrl(path), {
    ...init,
    headers: {
      ...init?.headers,
      ...subsonicAuthHeaders(),
    },
  });
  if (!res.ok) throw new Error(`AutoMix ${res.status}`);
  return res.json();
}

export interface AutoMixTrack {
  id: string;
  filename: string;
  bpm: number;
  confidence: number;
  mix_in_point: number;
  mix_out_point: number;
  duration: number;
  // Added by analysis v2 (server/automix); absent on older servers.
  navidrome_id?: string | null;
  key?: string | null;
  lufs?: number | null;
}

export interface AutoMixTrackDetail extends AutoMixTrack {
  path: string;
  beats: number[];
  downbeats: number[];
  // Structure profile (analysis version 3); empty/absent on older rows.
  intro_end?: number | null;
  outro_end?: number | null;
  bar_energy?: number[];
  bar_bass?: number[];
  bar_vocal?: (number | null)[];  // 0..1 singing score, null where not measured
  vocal_source?: "demucs" | "repet" | "none" | null;
}

let trackCache: AutoMixTrack[] | null = null;

export async function getAutoMixTracks(): Promise<AutoMixTrack[]> {
  if (trackCache) return trackCache;
  trackCache = await automixFetch<AutoMixTrack[]>("/tracks");
  return trackCache;
}

const detailCache = new Map<string, Promise<AutoMixTrackDetail | null>>();

// Full beat grid for one track. Cached; resolves null on failure so callers
// can fall back to an unsynced crossfade.
export function getAutoMixTrack(trackId: string): Promise<AutoMixTrackDetail | null> {
  let p = detailCache.get(trackId);
  if (!p) {
    p = automixFetch<AutoMixTrackDetail>(`/tracks/${trackId}`).catch(() => {
      detailCache.delete(trackId);
      return null;
    });
    detailCache.set(trackId, p);
  }
  return p;
}

interface TrackIndex {
  byNavidromeId: Map<string, AutoMixTrack>;
  byName: NameIndex<AutoMixTrack>;
}

const trackIndexes = new WeakMap<AutoMixTrack[], TrackIndex>();

export function findAutoMixTrack(
  tracks: AutoMixTrack[],
  song: SubsonicSong,
): AutoMixTrack | null {
  let index = trackIndexes.get(tracks);
  if (!index) {
    const byNavidromeId = new Map<string, AutoMixTrack>();
    for (const t of tracks) if (t.navidrome_id) byNavidromeId.set(t.navidrome_id, t);
    index = { byNavidromeId, byName: buildNameIndex(tracks.map((t) => [t.filename, t])) };
    trackIndexes.set(tracks, index);
  }
  return index.byNavidromeId.get(song.id) ?? matchByName(index.byName, song);
}

export interface AutoMixStats {
  total_tracks: number;
  analyzed: number;
  average_bpm: number | null;
}

export async function getAutoMixStats(): Promise<AutoMixStats> {
  return automixFetch<AutoMixStats>("/stats");
}

export function invalidateTrackCache(): void {
  trackCache = null;
  detailCache.clear();
}
