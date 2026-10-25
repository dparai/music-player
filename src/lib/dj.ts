import type { SubsonicSong, SongAnalysis } from "./subsonic";

// Camelot wheel: maps musical key notation to wheel position
// Number 1-12, letter A (minor) or B (major)
interface CamelotPosition {
  number: number;
  letter: "A" | "B";
}

const KEY_TO_CAMELOT: Record<string, CamelotPosition> = {
  "G#m": { number: 1, letter: "A" },  "Abm": { number: 1, letter: "A" },
  "B":   { number: 1, letter: "B" },
  "D#m": { number: 2, letter: "A" },  "Ebm": { number: 2, letter: "A" },
  "F#":  { number: 2, letter: "B" },  "Gb":  { number: 2, letter: "B" },
  "A#m": { number: 3, letter: "A" },  "Bbm": { number: 3, letter: "A" },
  "C#":  { number: 3, letter: "B" },  "Db":  { number: 3, letter: "B" },
  "Fm":  { number: 4, letter: "A" },
  "G#":  { number: 4, letter: "B" },  "Ab":  { number: 4, letter: "B" },
  "Cm":  { number: 5, letter: "A" },
  "D#":  { number: 5, letter: "B" },  "Eb":  { number: 5, letter: "B" },
  "Gm":  { number: 6, letter: "A" },
  "A#":  { number: 6, letter: "B" },  "Bb":  { number: 6, letter: "B" },
  "Dm":  { number: 7, letter: "A" },
  "F":   { number: 7, letter: "B" },
  "Am":  { number: 8, letter: "A" },
  "C":   { number: 8, letter: "B" },
  "Em":  { number: 9, letter: "A" },
  "G":   { number: 9, letter: "B" },
  "Bm":  { number: 10, letter: "A" },
  "D":   { number: 10, letter: "B" },
  "F#m": { number: 11, letter: "A" },  "Gbm": { number: 11, letter: "A" },
  "A":   { number: 11, letter: "B" },
  "C#m": { number: 12, letter: "A" },  "Dbm": { number: 12, letter: "A" },
  "E":   { number: 12, letter: "B" },
};

function getCamelot(key: string): CamelotPosition | null {
  return KEY_TO_CAMELOT[key] ?? null;
}

function camelotDistance(a: CamelotPosition, b: CamelotPosition): number {
  const numDist = Math.min(
    Math.abs(a.number - b.number),
    12 - Math.abs(a.number - b.number),
  );
  const letterDist = a.letter === b.letter ? 0 : 1;
  return numDist + letterDist;
}

export function isCompatibleKey(keyA: string, keyB: string): boolean {
  const a = getCamelot(keyA);
  const b = getCamelot(keyB);
  if (!a || !b) return false;
  // Compatible: same position, ±1 number same letter, or same number different letter
  return camelotDistance(a, b) <= 1;
}

// Largest tempo change applied to the incoming deck. Browsers keep pitch
// (preservesPitch) when stretching, but their real-time stretcher smears
// drums beyond a few percent, so stay well under the old 8%.
export const MAX_STRETCH = 0.06;

export interface TempoMatch {
  rate: number;   // playbackRate for the incoming deck
  factor: number; // 1 = same tempo, 2 = incoming is half-time, 0.5 = double-time
}

// How to play the incoming track at the outgoing tempo, trying straight,
// half-time and double-time matches. Null when no match is within MAX_STRETCH.
export function tempoMatch(fromBpm: number, toBpm: number): TempoMatch | null {
  if (!(fromBpm > 0) || !(toBpm > 0)) return null;
  for (const factor of [1, 2, 0.5]) {
    const rate = fromBpm / (toBpm * factor);
    if (Math.abs(rate - 1) <= MAX_STRETCH) return { rate, factor };
  }
  return null;
}

export function bpmRatio(fromBpm: number, toBpm: number): number {
  return tempoMatch(fromBpm, toBpm)?.rate ?? 1; // Too different, don't adjust
}

export interface ScoredSong {
  song: SubsonicSong;
  analysis: SongAnalysis;
  score: number;
}

export function pickNextDJ(
  currentAnalysis: SongAnalysis,
  allSongs: SubsonicSong[],
  analysisMap: Record<string, SongAnalysis>,
  recentIds: Set<string>,
  lookupFn: (analysis: Record<string, SongAnalysis>, song: SubsonicSong) => SongAnalysis | null,
): SubsonicSong | null {
  const candidates: ScoredSong[] = [];

  for (const song of allSongs) {
    if (recentIds.has(song.id)) continue;
    const analysis = lookupFn(analysisMap, song);
    if (!analysis) continue;

    let score = 0;

    // Key compatibility (Camelot wheel)
    const curCamelot = getCamelot(currentAnalysis.key);
    const candCamelot = getCamelot(analysis.key);
    if (curCamelot && candCamelot) {
      const dist = camelotDistance(curCamelot, candCamelot);
      if (dist === 0) score += 50;      // Perfect key match
      else if (dist === 1) score += 35;  // Adjacent key
      else if (dist === 2) score += 10;  // Two steps
      // else no key bonus
    }

    // BPM similarity (within ±10%)
    const bpmDiff = Math.abs(currentAnalysis.bpm - analysis.bpm) / currentAnalysis.bpm;
    if (bpmDiff <= 0.03) score += 40;       // Very close BPM
    else if (bpmDiff <= 0.06) score += 30;  // Close
    else if (bpmDiff <= 0.10) score += 15;  // Acceptable
    // Check half/double time
    else {
      const halfDiff = Math.abs(currentAnalysis.bpm - analysis.bpm * 2) / currentAnalysis.bpm;
      const dblDiff = Math.abs(currentAnalysis.bpm * 2 - analysis.bpm) / (currentAnalysis.bpm * 2);
      if (halfDiff <= 0.06 || dblDiff <= 0.06) score += 20;
    }

    // Small random factor to avoid always picking the same song
    score += Math.random() * 10;

    if (score > 10) {
      candidates.push({ song, analysis, score });
    }
  }

  if (candidates.length === 0) {
    // Fallback: random song not recently played
    const available = allSongs.filter((s) => !recentIds.has(s.id));
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)]!;
  }

  candidates.sort((a, b) => b.score - a.score);
  // Pick from top 5 weighted randomly
  const top = candidates.slice(0, 5);
  const totalScore = top.reduce((sum, c) => sum + c.score, 0);
  let pick = Math.random() * totalScore;
  for (const c of top) {
    pick -= c.score;
    if (pick <= 0) return c.song;
  }
  return top[0]!.song;
}

export const CROSSFADE_DURATION = 15;
export const EARLY_FADE_WINDOW = 20;
export const SILENCE_THRESHOLD = 0.01;

const FADE_BARS = 8;
const MIN_FADE = 8;
const MAX_FADE = 24;

// Crossfade length: 8 bars at the outgoing tempo, so the mix spans one
// musical phrase (15 s at 128 BPM, 21.3 s at 90 BPM). Without a tempo,
// the fixed CROSSFADE_DURATION is used.
export function fadeDurationFor(bpm: number | null | undefined): number {
  if (!bpm || !(bpm > 0)) return CROSSFADE_DURATION;
  let seconds = (FADE_BARS * 4 * 60) / bpm;
  // Very slow or very fast tracks: use 4 or 16 bars instead of leaving the range.
  while (seconds > MAX_FADE) seconds /= 2;
  while (seconds < MIN_FADE) seconds *= 2;
  return seconds;
}

export interface CrossfadeCurves {
  gainOut: Float32Array;
  gainIn: Float32Array;
  shelfOut: Float32Array; // low-shelf gain in dB
  shelfIn: Float32Array;
}

const SHELF_MIN_DB = -40;
const SHELF_MAX_DB = 6;

function toShelfDb(target: number, fader: number): number {
  if (target < 1e-4 || fader < 1e-4) return SHELF_MIN_DB;
  const db = 20 * Math.log10(target / fader);
  return Math.max(SHELF_MIN_DB, Math.min(SHELF_MAX_DB, db));
}

// Equal-power faders plus a bass swap. The old fade swept both low shelves
// to -20 dB at the midpoint while the faders were at -3 dB, losing ~20 dB
// of bass for several seconds. Here the outgoing bass stays at full level
// (the shelf compensates for its fader) until a short swap window in the
// middle, where the two basslines trade places on an equal-power curve;
// only one bassline is ever fully present.
export function buildCrossfadeCurves(points: number, swapStart: number, swapEnd: number): CrossfadeCurves {
  const gainOut = new Float32Array(points);
  const gainIn = new Float32Array(points);
  const shelfOut = new Float32Array(points);
  const shelfIn = new Float32Array(points);
  const swapLen = Math.max(1e-3, swapEnd - swapStart);
  for (let i = 0; i < points; i++) {
    const p = i / (points - 1);
    const gOut = Math.cos((p * Math.PI) / 2);
    const gIn = Math.sin((p * Math.PI) / 2);
    const s = Math.max(0, Math.min(1, (p - swapStart) / swapLen));
    const bassOut = Math.cos((s * Math.PI) / 2);
    const bassIn = Math.sin((s * Math.PI) / 2);
    gainOut[i] = gOut;
    gainIn[i] = gIn;
    shelfOut[i] = toShelfDb(bassOut, gOut);
    shelfIn[i] = toShelfDb(bassIn, gIn);
  }
  // Exact endpoints: the incoming deck must finish at unity.
  gainOut[points - 1] = 0;
  gainIn[points - 1] = 1;
  shelfIn[points - 1] = 0;
  return { gainOut, gainIn, shelfOut, shelfIn };
}

// Static trim that brings a track to roughly -14 LUFS. Prefers the AutoMix
// server's measured loudness, then ReplayGain tags (referenced to -18 LUFS),
// and never boosts past the track's peak.
export function loudnessTrimDb(
  lufs: number | null | undefined,
  replayGain?: { trackGain?: number; trackPeak?: number },
): number {
  let db: number;
  if (typeof lufs === "number" && isFinite(lufs)) db = -14 - lufs;
  else if (typeof replayGain?.trackGain === "number") db = replayGain.trackGain + 4;
  else return 0;
  const peak = replayGain?.trackPeak;
  if (typeof peak === "number" && peak > 0) db = Math.min(db, -20 * Math.log10(peak));
  return Math.max(-12, Math.min(6, db));
}

// Last downbeat at or before `t` (the start of the phrase to mix out on).
export function downbeatAtOrBefore(downbeats: number[], t: number): number | null {
  let best: number | null = null;
  for (const d of downbeats) {
    if (d <= t) best = d;
    else break;
  }
  return best;
}

// Signed beat-phase error of `inTime` against `outTime`, in beats, in [-0.5, 0.5).
export function phaseError(
  outTime: number, outAnchor: number, outBeat: number,
  inTime: number, inAnchor: number, inBeat: number,
): number {
  const outPhase = (outTime - outAnchor) / outBeat;
  const inPhase = (inTime - inAnchor) / inBeat;
  const d = inPhase - outPhase;
  return d - Math.round(d);
}
