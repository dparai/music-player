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

export function bpmRatio(fromBpm: number, toBpm: number): number {
  // How much to speed/slow the incoming track
  // Keep within ±8% to avoid noticeable pitch change
  const ratio = fromBpm / toBpm;
  if (ratio >= 0.92 && ratio <= 1.08) return ratio;
  // Try halving/doubling
  const halfRatio = fromBpm / (toBpm * 2);
  if (halfRatio >= 0.92 && halfRatio <= 1.08) return halfRatio;
  const doubleRatio = (fromBpm * 2) / toBpm;
  if (doubleRatio >= 0.92 && doubleRatio <= 1.08) return doubleRatio;
  return 1; // Too different, don't adjust
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

export const CROSSFADE_DURATION = 5; // seconds
