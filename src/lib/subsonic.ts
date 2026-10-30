import md5 from "md5";
import { buildNameIndex, matchByName, type NameIndex } from "./match";

interface SubsonicCredentials {
  server: string;
  username: string;
  password: string;
}

interface SubsonicSong {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  track: number;
  year: number;
  size: number;
  suffix: string;
  bitRate: number;
  contentType: string;
  coverArt?: string;
  created: string;
  path?: string;
  // OpenSubsonic extension; Navidrome fills it from file tags when present.
  replayGain?: {
    trackGain?: number;
    albumGain?: number;
    trackPeak?: number;
    albumPeak?: number;
  };
}

interface SubsonicResponse<T> {
  "subsonic-response": {
    status: "ok" | "failed";
    version: string;
    error?: { code: number; message: string };
  } & T;
}

const APP_NAME = "DeepakMusic";
const API_VERSION = "1.16.1";

function buildParams(creds: SubsonicCredentials): URLSearchParams {
  const salt = Math.random().toString(36).slice(2, 10);
  const token = md5(creds.password + salt);
  return new URLSearchParams({
    u: creds.username,
    t: token,
    s: salt,
    v: API_VERSION,
    c: APP_NAME,
    f: "json",
  });
}

function apiUrl(creds: SubsonicCredentials, endpoint: string, extra?: Record<string, string>): string {
  const params = buildParams(creds);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      params.set(k, v);
    }
  }
  const base = creds.server.replace(/\/+$/, "");
  return `${base}/rest/${endpoint}?${params}`;
}

async function fetchApi<T>(creds: SubsonicCredentials, endpoint: string, extra?: Record<string, string>): Promise<T> {
  const url = apiUrl(creds, endpoint, extra);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: SubsonicResponse<T> = await res.json();
  const inner = data["subsonic-response"];
  if (inner.status === "failed") {
    throw new Error(inner.error?.message ?? "Unknown Subsonic error");
  }
  return inner as T;
}

export async function ping(creds: SubsonicCredentials): Promise<boolean> {
  await fetchApi(creds, "ping");
  return true;
}

export async function getSongsByGenre(creds: SubsonicCredentials): Promise<SubsonicSong[]> {
  const data = await fetchApi<{ songsByGenre?: { song?: SubsonicSong[] } }>(creds, "getSongsByGenre", {
    genre: "",
    count: "10000",
  });
  return data.songsByGenre?.song ?? [];
}

export async function search(creds: SubsonicCredentials, query: string): Promise<SubsonicSong[]> {
  const data = await fetchApi<{ searchResult3?: { song?: SubsonicSong[] } }>(creds, "search3", {
    query,
    songCount: "50",
    albumCount: "0",
    artistCount: "0",
  });
  return data.searchResult3?.song ?? [];
}

export async function getAllSongs(creds: SubsonicCredentials): Promise<SubsonicSong[]> {
  const songs: SubsonicSong[] = [];
  let offset = 0;
  const size = 500;
  while (true) {
    const data = await fetchApi<{ searchResult3?: { song?: SubsonicSong[] } }>(creds, "search3", {
      query: "",
      songCount: String(size),
      songOffset: String(offset),
      albumCount: "0",
      artistCount: "0",
    });
    const batch = data.searchResult3?.song ?? [];
    songs.push(...batch);
    if (batch.length < size) break;
    offset += size;
  }
  return songs;
}

export function streamUrl(creds: SubsonicCredentials, songId: string): string {
  return apiUrl(creds, "stream", { id: songId });
}

export function coverArtUrl(creds: SubsonicCredentials, coverArtId: string, size = "300"): string {
  return apiUrl(creds, "getCoverArt", { id: coverArtId, size });
}

// BPM/Key analysis data
export interface SongAnalysis {
  bpm: number;
  key: string;
  // DJ mode (AutoMix hook pass): key and 0..1 energy over the hook, and
  // whether its hook cues are trusted enough to play.
  hookKey?: string | null;
  hookEnergy?: number | null;
  hookTrusted?: boolean;
}

let analysisCache: Record<string, SongAnalysis> | null = null;

export async function fetchAnalysis(): Promise<Record<string, SongAnalysis>> {
  if (analysisCache) return analysisCache;
  const base = import.meta.env.DEV ? "" : window.location.origin;
  const res = await fetch(`${base}/api/analysis.json`);
  if (!res.ok) return {};
  analysisCache = await res.json();
  return analysisCache!;
}

const analysisIndexes = new WeakMap<Record<string, SongAnalysis>, NameIndex<SongAnalysis>>();

export function lookupAnalysis(
  analysis: Record<string, SongAnalysis>,
  song: SubsonicSong,
): SongAnalysis | null {
  let index = analysisIndexes.get(analysis);
  if (!index) {
    index = buildNameIndex(Object.entries(analysis));
    analysisIndexes.set(analysis, index);
  }
  return matchByName(index, song);
}

export type { SubsonicCredentials, SubsonicSong };
