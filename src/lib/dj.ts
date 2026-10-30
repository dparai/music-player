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

// "crossfade": whole songs, phrase-mixed outro to intro.
// "dj": hook mix (only the chorus/drop of each song); see docs/HOOK-MIX.md.
export type MixMode = "off" | "crossfade" | "dj";

export interface ScoredSong {
  song: SubsonicSong;
  analysis: SongAnalysis;
  score: number;
}

// How well two songs go together in a set: sound profile similarity (0..60)
// plus 30 for the same lyric language (instrumentals count as one language).
export function fitScore(a: { lang?: string | null; style?: number[] }, b: { lang?: string | null; style?: number[] }): number {
  let s = 0;
  if (a.style?.length && b.style?.length === a.style.length) {
    let dot = 0;
    for (let i = 0; i < a.style.length; i++) dot += a.style[i]! * b.style[i]!;
    s += 60 * Math.max(0, dot);
  }
  if (a.lang && b.lang && a.lang === b.lang) s += 30;
  return s;
}

export function pickNextDJ(
  currentAnalysis: SongAnalysis,
  allSongs: SubsonicSong[],
  analysisMap: Record<string, SongAnalysis>,
  recentIds: Set<string>,
  lookupFn: (analysis: Record<string, SongAnalysis>, song: SubsonicSong) => SongAnalysis | null,
  dj = false,
): SubsonicSong | null {
  const candidates: ScoredSong[] = [];
  const djReady = dj && allSongs.some((s) => !recentIds.has(s.id) && lookupFn(analysisMap, s)?.hookTrusted);

  for (const song of allSongs) {
    if (recentIds.has(song.id)) continue;
    const analysis = lookupFn(analysisMap, song);
    if (!analysis) continue;
    // DJ mode plays hooks: skip songs without trusted cues while others are left.
    if (djReady && !analysis.hookTrusted) continue;

    let score = 0;

    // Key compatibility (Camelot wheel). DJ mode hands off hook to hook, so
    // the keys that meet are the hooks' (a last chorus often modulates).
    const curCamelot = getCamelot((dj && currentAnalysis.hookKey) || currentAnalysis.key);
    const candCamelot = getCamelot((dj && analysis.hookKey) || analysis.key);
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

    // DJ energy flow: stay near the current level, drifting slightly up.
    if (dj && currentAnalysis.hookEnergy != null && analysis.hookEnergy != null) {
      const d = analysis.hookEnergy - currentAnalysis.hookEnergy;
      if (d >= -0.05 && d <= 0.12) score += 20;
      else if (Math.abs(d) <= 0.2) score += 8;
    }

    // DJ: songs that sound alike and are sung in the same language, so a set
    // doesn't lurch from metalcore to Punjabi pop to a game theme.
    if (dj) score += fitScore(currentAnalysis, analysis);

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
  // The faders cross where the bass swaps. A late swap (long incoming intro)
  // keeps the outgoing deck up until its bass hands over; with the crossover
  // left in the middle, the shelf (max +6 dB) can't hold the outgoing bass
  // up while its fader closes, and the bass would be missing for ~16% of the mix.
  const centre = Math.min(0.98, Math.max(0.02, (swapStart + swapEnd) / 2));
  const warp = (p: number) => (p <= centre ? 0.5 * (p / centre) : 0.5 + 0.5 * ((p - centre) / (1 - centre)));
  for (let i = 0; i < points; i++) {
    const p = i / (points - 1);
    const q = warp(p);
    const gOut = Math.cos((q * Math.PI) / 2);
    const gIn = Math.sin((q * Math.PI) / 2);
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

// --- Transition planning -------------------------------------------------

// What the planner knows about one track (from the AutoMix beat-grid detail).
export interface TrackShape {
  bpm: number | null;
  duration: number;
  downbeats?: number[];
  introEnd?: number | null;  // where the track's main part (bass) starts
  outroEnd?: number | null;  // end of audible audio
  barEnergy?: number[];      // per bar, 1.0 = typical bar of this track
  barVocal?: (number | null)[]; // per bar, 0..1 singing score; null = not measured
}

export interface TransitionPlan {
  seconds: number;      // fade length, wall clock
  bars: number | null;  // in outgoing bars; null without a tempo
  swapStart: number;    // bass-swap window, as fractions of the fade
  swapEnd: number;
  style: "blend" | "cut" | "fade";
  reason: string;       // shown in the UI, handy when a mix sounds off
}

export const VOCAL_ON = 0.5;      // bar_vocal is a 0..1 singing score (server analysis v4); 0.5 = singing
const MAX_FADE_BARS = 32;
const MAX_FADE_SECONDS = 45;
const DEFAULT_BARS = 8;           // incoming intro unknown
const HIGH_ENERGY = 0.85;         // both sides this loud: keep the overlap short

// Index of the bar containing `t`, or -1 before the first downbeat.
export function barIndexAt(downbeats: number[], t: number): number {
  let lo = 0, hi = downbeats.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (downbeats[mid]! <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function barValue(shape: TrackShape, values: (number | null)[] | undefined, t: number): number | null {
  if (!values?.length || !shape.downbeats?.length) return null;
  const i = barIndexAt(shape.downbeats, t);
  return i >= 0 && i < values.length ? values[i] ?? null : null;
}

function powerOfTwoAtMost(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

// Decide how this particular pair should be mixed. The length follows the
// music: as long as the incoming intro (so its bass arrives when the mix is
// done), never longer than the outgoing track has audio left, shorter when
// both are at full energy, and cut before two vocals would overlap. Lengths
// snap to 1/2/4/8/16/32 bars so the mix ends on a phrase line. The bass swap
// lands where the incoming bass enters (intro_end) when that's inside the mix.
//
// `cueOut`: outgoing time the mix starts. `inStart`: incoming time it starts
// from (its first downbeat). `match`: tempo match, null if too far apart.
export function planTransition(
  out: TrackShape | null,
  inn: TrackShape | null,
  match: TempoMatch | null,
  cueOut: number,
  inStart: number,
): TransitionPlan {
  const outBpm = out?.bpm ?? null;
  if (!out || !outBpm || !(outBpm > 0)) {
    return { seconds: CROSSFADE_DURATION, bars: null, swapStart: 0.45, swapEnd: 0.55, style: "fade", reason: "no tempo" };
  }
  const bar = 240 / outBpm;
  if (!match) {
    const seconds = Math.max(6, Math.min(10, 4 * bar));
    return { seconds, bars: Math.round(seconds / bar), swapStart: 0.4, swapEnd: 0.6, style: "fade", reason: "tempos too far apart" };
  }

  const reasons: string[] = [];
  const end = out.outroEnd && out.outroEnd > cueOut ? out.outroEnd : out.duration;
  const available = Math.floor((end - cueOut) / bar + 0.01);

  // Incoming intro length, converted to outgoing bars (wall clock).
  let introBars: number | null = null;
  if (inn?.introEnd != null && inn.introEnd > inStart) {
    introBars = Math.round((inn.introEnd - inStart) / match.rate / bar);
  }
  let n = introBars !== null ? Math.max(introBars, 4) : DEFAULT_BARS;
  reasons.push(introBars !== null ? `intro ${introBars} bars` : "intro unknown");
  if (available < n) { n = available; reasons.push(`outro ${available} bars`); }
  n = Math.min(n, MAX_FADE_BARS, Math.floor(MAX_FADE_SECONDS / bar));

  const inTimeAt = (k: number) => inStart + (k + 0.5) * bar * match.rate; // middle of mix bar k, incoming time
  const outTimeAt = (k: number) => cueOut + (k + 0.5) * bar;

  if (inn && n > 8) {
    let outE = 0, inE = 0, count = 0;
    for (let k = 0; k < n; k++) {
      const o = barValue(out, out.barEnergy, outTimeAt(k));
      const i = barValue(inn, inn.barEnergy, inTimeAt(k));
      if (o === null || i === null) continue;
      outE += o; inE += i; count++;
    }
    if (count > 0 && outE / count >= HIGH_ENERGY && inE / count >= HIGH_ENERGY) {
      n = 8;
      reasons.push("both loud");
    }
  }

  if (inn) {
    // First bar where both are singing for two bars in a row: end the mix before it.
    for (let k = 0; k < n - 1; k++) {
      const sings = (j: number) =>
        (barValue(out, out.barVocal, outTimeAt(j)) ?? 0) >= VOCAL_ON &&
        (barValue(inn, inn.barVocal, inTimeAt(j)) ?? 0) >= VOCAL_ON;
      if (sings(k) && sings(k + 1)) {
        n = k;
        reasons.push("vocals would overlap");
        break;
      }
    }
  }

  n = powerOfTwoAtMost(Math.max(1, n));
  const style = n <= 2 ? "cut" : "blend";
  let swapStart: number, swapEnd: number;
  if (n <= 2) {
    swapStart = 0.25; swapEnd = 0.75;
  } else {
    // Swap when the incoming bass arrives. An intro as long as (or longer than)
    // the mix means its bass only comes at the end: swap in the last bar, else
    // the middle of the mix would have no bass at all.
    const centre = introBars !== null ? Math.min(Math.max(introBars, 0.5), n - 0.5) / n : 0.5;
    const half = 0.5 / n; // one bar
    swapStart = Math.max(0.02, centre - half);
    swapEnd = Math.min(0.98, centre + half);
  }
  return { seconds: n * bar, bars: n, swapStart, swapEnd, style, reason: reasons.join(", ") };
}

// --- DJ mode (hook mix) --------------------------------------------------

// Hook cues from the AutoMix hook pass (server/automix/analysis_hooks.py).
export interface HookCues {
  in: number;       // start of the build before the hook
  drop: number;     // first bar of the hook
  out: number;      // end of the hook
  postBars: number; // bars the track may keep playing after `out`
}

export const MIN_HOOK_CONFIDENCE = 0.45;

export function trustedHook(t: {
  hook_in?: number | null; hook_drop?: number | null; hook_out?: number | null;
  hook_post_bars?: number | null; hook_confidence?: number | null;
} | null | undefined): HookCues | null {
  if (!t || t.hook_in == null || t.hook_drop == null || t.hook_out == null) return null;
  if ((t.hook_confidence ?? 0) < MIN_HOOK_CONFIDENCE || !(t.hook_out > t.hook_drop)) return null;
  return { in: t.hook_in, drop: t.hook_drop, out: t.hook_out, postBars: t.hook_post_bars ?? 0 };
}

export interface HookPlan extends TransitionPlan {
  cueOut: number;  // outgoing time the mix starts (its drop-to-be lands at cueOut + seconds)
  inStart: number; // incoming time the mix starts from (a downbeat; its drop lands at the mix end)
}

// Time `bars` bars before `t` on a track's grid (its own downbeats when known).
function barsBefore(shape: TrackShape | null, t: number, bars: number, barSec: number): number {
  const d = shape?.downbeats;
  if (d?.length) {
    const i = barIndexAt(d, t + 0.05);
    if (i >= 0 && Math.abs(d[i]! - t) < 0.2 && i - bars >= 0) return d[i - bars]!;
  }
  return Math.max(0, t - bars * barSec);
}

// DJ hand-off, hook to hook. The incoming hook lands on the bar where the
// outgoing hook ends (`mixEnd`); nothing plays past the outgoing hook, which
// is where the next verse (more singing) would start.
//
//   blend:  outgoing  … HOOK ………………… last n bars ……|
//           incoming      | build, filtered, rising   |DROP …
//
//   swap:   outgoing  … HOOK ………… last bar: filter up + echo |
//           incoming                  pickup, filtered, rising |DROP …
//
// Blend (8/4/2 bars) only where the two decks never sing at the same time
// before the last bar; a bar without vocal data counts as singing, since a
// clash is the worst a DJ can do and a clean swap is always fine. The blend
// may use at most `room` bars of the outgoing hook (the hook keeps a few bars
// to itself). Everything else, and any pair that can't be beat-matched, is a
// one-bar swap: the outgoing washes out into a dub echo while the incoming
// pickup rises, filtered, into its drop.
export function planHookTransition(
  out: TrackShape | null,
  inn: TrackShape | null,
  match: TempoMatch | null,
  mixEnd: number,
  inDrop: number,
  room: number,
): HookPlan {
  const outBpm = out?.bpm ?? null;
  const inBpm = inn?.bpm ?? null;
  const inBar = inBpm && inBpm > 0 ? 240 / inBpm : 2;
  const bar = outBpm && outBpm > 0 ? 240 / outBpm : 2;
  const swap = (why: string): HookPlan => {
    // Unmatched tempos: the incoming plays at its own speed; start it one of
    // ITS bars early so its drop still lands on the outgoing's last downbeat.
    const seconds = match ? bar : Math.max(1.5, Math.min(3, inBar));
    return {
      seconds, bars: outBpm ? 1 : null, swapStart: 0.75, swapEnd: 0.98, style: "cut",
      reason: `dj: swap on the drop, ${why}`, cueOut: mixEnd - seconds,
      // A half-time incoming bar is two outgoing bars: then start half a bar early.
      inStart: match && match.factor <= 1 ? barsBefore(inn, inDrop, Math.round(1 / match.factor), inBar)
        : Math.max(0, inDrop - seconds * (match?.rate ?? 1)),
    };
  };
  if (!out || !outBpm || !(outBpm > 0)) return swap("no tempo");
  if (!match) return swap("tempos too far apart");

  // Singing in the bar around time t (unknown counts as singing).
  const sings = (shape: TrackShape | null, t: number) => {
    const v = shape?.barVocal;
    const d = shape?.downbeats;
    if (!v?.length || !d?.length) return true;
    const i = barIndexAt(d, t);
    if (i < 0 || i >= v.length) return true;
    const x = v[i];
    return x == null || x >= VOCAL_ON;
  };

  const reasons: string[] = [];
  for (const n of [8, 4, 2]) {
    if (n > room) continue;
    const cueOut = mixEnd - n * bar;
    // One outgoing bar is 1/factor incoming bars (half-time incoming: half a bar).
    const inStart = barsBefore(inn, inDrop, Math.max(1, Math.round(n / match.factor)), inBar);
    let both = 0;
    for (let k = 0; k < n - 1; k++) {  // the last bar may carry a pickup into the hook
      if (sings(out, cueOut + (k + 0.5) * bar) && sings(inn, inStart + (k + 0.5) * bar * match.rate)) both++;
    }
    if (both > 0) { reasons.push(`${n} bars: both sing ${both}`); continue; }
    // Bass swap in the last bar: the incoming bass arrives with its hook.
    return {
      seconds: n * bar, bars: n, swapStart: (n - 1) / n, swapEnd: 0.98, style: "blend",
      reason: [`dj: ${n}-bar build into the drop`, ...reasons].join(", "),
      cueOut, inStart,
    };
  }
  return swap(reasons.join(", ") || `room ${room} bars`);
}

export interface HookFxCurves {
  hpfIn: Float32Array;   // incoming high-pass cutoff, Hz
  midIn: Float32Array;   // incoming 1 kHz gain, dB
  hpfOut: Float32Array;  // outgoing high-pass cutoff, Hz
  echoOut: Float32Array; // outgoing echo send, 0..1
}

// DJ effects on top of the fader/bass curves.
// Blend: the incoming build is thinned by a high-pass that dives from 400 Hz
// to nothing and its mids sit 6 dB down, so the outgoing hook stays in front;
// both open on the last bar, so the hook arrives full-range.
// Swap (one bar): the outgoing washes out, a high-pass rising to 1 kHz while
// a dub echo is fed from the third beat (its tail rings on after the fader is
// gone); the incoming pickup rises under a high-pass falling from 1.5 kHz, and
// opens on the drop.
export function buildHookFxCurves(points: number, style: "blend" | "cut" | "fade", bars: number): HookFxCurves {
  const hpfIn = new Float32Array(points);
  const midIn = new Float32Array(points);
  const hpfOut = new Float32Array(points);
  const echoOut = new Float32Array(points);
  const lastBar = bars > 1 ? (bars - 1) / bars : 0.5;
  for (let i = 0; i < points; i++) {
    const p = i / (points - 1);
    hpfOut[i] = 10;
    if (style === "blend") {
      // Exponential sweep (even in pitch), done by the start of the last bar.
      hpfIn[i] = p < lastBar ? 400 * Math.pow(20 / 400, p / lastBar) : 10;
      midIn[i] = p < lastBar ? -6 : -6 * (1 - (p - lastBar) / (1 - lastBar));
    } else if (style === "cut") {
      hpfIn[i] = p < 0.97 ? 1500 * Math.pow(30 / 1500, p / 0.97) : 10;
      midIn[i] = 0;
      hpfOut[i] = p < 0.25 ? 10 : 20 * Math.pow(1000 / 20, (p - 0.25) / 0.75);
      echoOut[i] = p < 0.5 ? 0 : p < 0.75 ? 0.7 * (p - 0.5) / 0.25 : 0.7;
    } else {
      hpfIn[i] = 10;
      midIn[i] = 0;
    }
  }
  midIn[points - 1] = 0;
  hpfIn[points - 1] = 10;
  hpfOut[points - 1] = style === "cut" ? 1000 : 10; // the outgoing is silent by now; reset on finish
  echoOut[points - 1] = 0;
  return { hpfIn, midIn, hpfOut, echoOut };
}

// Where to mix out in DJ mode: the end of the hook, or (when that has passed,
// e.g. DJ switched on late) the next 4-bar line at least `minAhead` s away,
// counted from the hook. Null when there is no grid to count on.
export function djCueOut(downbeats: number[] | undefined, hook: HookCues, now: number, minAhead = 8): number | null {
  if (now <= hook.out - 0.5) return hook.out;
  if (!downbeats?.length) return null;
  const base = barIndexAt(downbeats, hook.drop + 0.05);
  for (let i = Math.max(0, base); i < downbeats.length; i++) {
    if ((i - base) % 4 === 0 && downbeats[i]! >= now + minAhead) return downbeats[i]!;
  }
  return null;
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
