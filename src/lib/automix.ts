import type { SubsonicSong } from "./subsonic";

const AUTOMIX_TOKEN = "brook-automix-2026";

function automixUrl(path: string): string {
  const base = import.meta.env.DEV ? "" : window.location.origin;
  return `${base}/automix${path}`;
}

async function automixFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(automixUrl(path), {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${AUTOMIX_TOKEN}`,
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
}

export interface AutoMixTrackDetail extends AutoMixTrack {
  path: string;
  beats: number[];
  downbeats: number[];
}

let trackCache: AutoMixTrack[] | null = null;

export async function getAutoMixTracks(): Promise<AutoMixTrack[]> {
  if (trackCache) return trackCache;
  trackCache = await automixFetch<AutoMixTrack[]>("/tracks");
  return trackCache;
}

export async function getAutoMixTrack(trackId: string): Promise<AutoMixTrackDetail> {
  return automixFetch<AutoMixTrackDetail>(`/tracks/${trackId}`);
}

export function findAutoMixTrack(
  tracks: AutoMixTrack[],
  song: SubsonicSong,
): AutoMixTrack | null {
  const title = song.title;
  const artist = song.artist;
  const primaryArtist = artist?.split(/[;,&]/).map(s => s.trim())[0] ?? "";
  for (const t of tracks) {
    const name = t.filename.replace(/\.[^.]+$/, "");
    if (
      name === title ||
      name === `${artist} - ${title}` ||
      name === `${title} - ${artist}` ||
      name === `${primaryArtist} - ${title}` ||
      name === `${title} - ${primaryArtist}`
    ) {
      return t;
    }
  }
  return null;
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
}
