// Sound settings: a 10-band equaliser with automatic headroom, volume
// normalising and gapless playback. The filter maths here mirrors the Web Audio
// BiquadFilterNode (RBJ cookbook), so the preamp can be worked out before any
// audio runs and tested without a browser.

export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const EQ_RANGE_DB = 12;
export const EQ_Q = 1.41; // about one octave wide per band

export type FilterKind = "lowshelf" | "peaking" | "highshelf";

// The outer bands shelve, so a boost at 31 Hz or 16 kHz lifts everything beyond it.
export function bandKind(i: number): FilterKind {
  return i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
}

export interface Preset {
  id: string;
  label: string;
  gains: number[];
}

export const PRESETS: Preset[] = [
  { id: "flat", label: "Flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: "bass", label: "Bass boost", gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: "treble", label: "Treble boost", gains: [0, 0, 0, 0, 0, 0, 1, 3, 4, 5] },
  { id: "vocal", label: "Vocal", gains: [-2, -1, 0, 1, 3, 3, 2, 1, 0, -1] },
  { id: "loudness", label: "Loudness", gains: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5] },
  { id: "rock", label: "Rock", gains: [4, 3, 1, -1, -2, -1, 1, 3, 4, 4] },
  { id: "electronic", label: "Electronic", gains: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5] },
];

export interface SoundSettings {
  eq: number[]; // dB per band, EQ_BANDS order
  normalize: boolean; // bring every song to about the same loudness
  gapless: boolean; // start the next song just before this one ends
}

export const DEFAULT_SOUND: SoundSettings = {
  eq: PRESETS[0]!.gains.slice(),
  normalize: true,
  gapless: true,
};

export function clampGain(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(-EQ_RANGE_DB, Math.min(EQ_RANGE_DB, Math.round(db * 2) / 2));
}

export function isFlat(gains: number[]): boolean {
  return gains.every((g) => g === 0);
}

// The preset these gains are exactly, or null for a custom curve.
export function presetFor(gains: number[]): Preset | null {
  return PRESETS.find((p) => p.gains.length === gains.length && p.gains.every((g, i) => g === gains[i])) ?? null;
}

interface Coefs { b0: number; b1: number; b2: number; a1: number; a2: number }

// RBJ audio-EQ-cookbook coefficients, normalised by a0.
export function biquadCoefs(kind: FilterKind, freq: number, gainDb: number, q: number, sampleRate: number): Coefs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (kind === "peaking") {
    b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
  } else {
    // Shelves use S = 1 (the steepest slope without overshoot), as Web Audio does.
    const shelfAlpha = (sin / 2) * Math.SQRT2;
    const t = 2 * Math.sqrt(A) * shelfAlpha;
    if (kind === "lowshelf") {
      b0 = A * ((A + 1) - (A - 1) * cos + t);
      b1 = 2 * A * ((A - 1) - (A + 1) * cos);
      b2 = A * ((A + 1) - (A - 1) * cos - t);
      a0 = (A + 1) + (A - 1) * cos + t;
      a1 = -2 * ((A - 1) + (A + 1) * cos);
      a2 = (A + 1) + (A - 1) * cos - t;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cos + t);
      b1 = -2 * A * ((A - 1) + (A + 1) * cos);
      b2 = A * ((A + 1) + (A - 1) * cos - t);
      a0 = (A + 1) - (A - 1) * cos + t;
      a1 = 2 * ((A - 1) - (A + 1) * cos);
      a2 = (A + 1) - (A - 1) * cos - t;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function magnitudeDb(c: Coefs, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const cw = Math.cos(w), sw = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cw + c.b2 * c2;
  const ni = -(c.b1 * sw + c.b2 * s2);
  const dr = 1 + c.a1 * cw + c.a2 * c2;
  const di = -(c.a1 * sw + c.a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

// Combined level of the whole chain at one frequency, in dB.
export function responseDb(gains: number[], freq: number, sampleRate = 48000): number {
  let db = 0;
  for (let i = 0; i < EQ_BANDS.length; i++) {
    const g = gains[i] ?? 0;
    if (g === 0) continue;
    db += magnitudeDb(biquadCoefs(bandKind(i), EQ_BANDS[i]!, g, EQ_Q, sampleRate), freq, sampleRate);
  }
  return db;
}

// The loudest point of the combined curve. Neighbouring bands overlap, so this
// can exceed the largest single gain (two +6 dB bands side by side give about +10).
export function peakResponseDb(gains: number[], sampleRate = 48000): number {
  let peak = -Infinity;
  for (let i = 0; i <= 240; i++) {
    const f = 20 * Math.pow(1000, i / 240); // 20 Hz .. 20 kHz
    peak = Math.max(peak, responseDb(gains, f, sampleRate));
  }
  return peak;
}

// Cut that keeps the equaliser from clipping: the curve's peak, if it boosts.
// Rounded up to 0.1 dB so it never under-corrects.
export function autoPreampDb(gains: number[], sampleRate = 48000): number {
  const peak = peakResponseDb(gains, sampleRate);
  if (!(peak > 0.05)) return 0;
  return -Math.ceil(peak * 10) / 10;
}

const SOUND_KEY = "deepakmusic_sound";

export function sanitizeSound(raw: unknown): SoundSettings {
  const out: SoundSettings = { ...DEFAULT_SOUND, eq: DEFAULT_SOUND.eq.slice() };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.eq) && r.eq.length === EQ_BANDS.length) {
    out.eq = r.eq.map((v) => clampGain(typeof v === "number" ? v : 0));
  }
  if (typeof r.normalize === "boolean") out.normalize = r.normalize;
  if (typeof r.gapless === "boolean") out.gapless = r.gapless;
  return out;
}

export function loadSound(): SoundSettings {
  try {
    const text = localStorage.getItem(SOUND_KEY);
    if (text) return sanitizeSound(JSON.parse(text));
  } catch { /* storage blocked or corrupt: use the defaults */ }
  return sanitizeSound(null);
}

export function saveSound(s: SoundSettings): void {
  try { localStorage.setItem(SOUND_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
