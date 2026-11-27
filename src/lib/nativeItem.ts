import type { SubsonicCredentials, SubsonicSong } from "./subsonic";
import { coverArtUrl, streamUrl } from "./subsonic";
import { transcodeFor, type Quality, type StreamFormat } from "./quality";
import type { NativeItem } from "./native";

// The native player has no page to resolve against: a relative URL (the dev server) needs the origin.
function absolute(url: string): string {
  try { return new URL(url, window.location.href).href; } catch { return url; }
}

export function toNativeItem(
  song: SubsonicSong,
  creds: SubsonicCredentials,
  quality: Quality,
  format: StreamFormat,
): NativeItem {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist ?? "",
    album: song.album ?? "",
    url: absolute(streamUrl(creds, song.id, transcodeFor(song, quality, format))),
    artUrl: song.coverArt ? absolute(coverArtUrl(creds, song.coverArt, "512")) : null,
    durationMs: Math.round((song.duration || 0) * 1000),
  };
}
