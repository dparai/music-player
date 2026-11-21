// Near-gapless handoff between songs. An <audio> element can't be started on an
// exact sample, and it takes a moment (tens of ms) between play() and the first
// sound. So the next song's play() is called that much early, and the two songs
// are joined with a very short equal-power overlap instead of leaving a gap.

export const GAPLESS_FADE_S = 0.03;        // length of the joining overlap
export const GAPLESS_PRELOAD_S = 25;       // buffer the next song this long before the end
export const GAPLESS_ARM_S = 1.5;          // arm the precise start timer this long before the end
export const DEFAULT_START_LATENCY_S = 0.06;
const MIN_LATENCY_S = 0.01;
const MAX_LATENCY_S = 0.3;

export function clampLatency(s: number): number {
  if (!Number.isFinite(s)) return DEFAULT_START_LATENCY_S;
  return Math.max(MIN_LATENCY_S, Math.min(MAX_LATENCY_S, s));
}

// Smoothed estimate of play() → first sound. One slow start (a busy phone)
// moves it a little, not all the way.
export function updateLatency(prev: number, sample: number): number {
  if (!Number.isFinite(sample) || sample <= 0) return clampLatency(prev);
  return clampLatency(prev * 0.7 + clampLatency(sample) * 0.3);
}

// Seconds from now to call play() on the next song so its first sound lands in
// the middle of the overlap, which ends with the outgoing song. `remaining` is
// the outgoing song's time left; `rate` its playbackRate. Never negative.
export function gaplessStartDelayS(remaining: number, latency: number, rate = 1): number {
  const wall = remaining / (rate > 0 ? rate : 1);
  return Math.max(0, wall - clampLatency(latency) - GAPLESS_FADE_S / 2);
}

export interface FadeCurves {
  out: Float32Array;
  in: Float32Array;
}

// Equal-power cross curves, exact at the ends (out: 1 → 0, in: 0 → 1).
export function equalPowerCurves(points = 16): FadeCurves {
  const out = new Float32Array(points);
  const inn = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const p = i / (points - 1);
    out[i] = Math.cos((p * Math.PI) / 2);
    inn[i] = Math.sin((p * Math.PI) / 2);
  }
  out[points - 1] = 0;
  inn[0] = 0;
  return { out, in: inn };
}

// Whether a handoff should be attempted at all.
export function canGapless(o: {
  enabled: boolean;
  hidden: boolean;     // a locked phone refuses play() outside a user gesture or `ended`
  hasNext: boolean;
  graphLive: boolean;  // the Web Audio faders can carry the overlap
  nextReady: boolean;  // the next song is buffered enough to start at once
}): boolean {
  return o.enabled && !o.hidden && o.hasNext && o.graphLive && o.nextReady;
}
