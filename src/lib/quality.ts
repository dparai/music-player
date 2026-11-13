// Streaming quality: the server (Navidrome) transcodes to a lower bitrate on
// request, so a slow or metered connection downloads far less than the
// original file.

export type Quality = "original" | "high" | "normal" | "saver";

export const QUALITIES: { id: Quality; label: string; kbps: number | null }[] = [
  { id: "original", label: "Original", kbps: null },
  { id: "high", label: "High", kbps: 256 },
  { id: "normal", label: "Normal", kbps: 128 },
  { id: "saver", label: "Data saver", kbps: 64 },
];

export type StreamFormat = "opus" | "mp3";

export interface Transcode {
  format: StreamFormat;
  maxBitRate: number; // kbps
}

const QUALITY_KEY = "deepakmusic_quality";

export function loadQuality(): Quality {
  try {
    const v = localStorage.getItem(QUALITY_KEY);
    if (QUALITIES.some((q) => q.id === v)) return v as Quality;
  } catch { /* storage blocked */ }
  return "original";
}

export function saveQuality(quality: Quality): void {
  try { localStorage.setItem(QUALITY_KEY, quality); } catch { /* private mode */ }
}

let detected: StreamFormat | null = null;

// Opus is the better codec at these bitrates; MP3 is for browsers that cannot
// play Ogg Opus (Safari before 18.4).
export function streamFormat(): StreamFormat {
  if (!detected) {
    detected = new Audio().canPlayType('audio/ogg; codecs="opus"') ? "opus" : "mp3";
  }
  return detected;
}

// What to ask the server for, or null to stream the file as it is. A file
// already at or under the chosen bitrate is left alone: re-encoding it would
// cost quality and save no data.
export function transcodeFor(
  song: { bitRate?: number },
  quality: Quality,
  format: StreamFormat,
): Transcode | null {
  const kbps = QUALITIES.find((q) => q.id === quality)?.kbps ?? null;
  if (kbps === null) return null;
  if (song.bitRate && song.bitRate <= kbps) return null;
  return { format, maxBitRate: kbps };
}
