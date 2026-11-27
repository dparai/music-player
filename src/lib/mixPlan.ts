// The smart mix for the Android app: the web UI works out, for a pair of songs, where the outgoing one
// should start to fade, where the incoming one should start from, how long to mix and what tempo change
// to apply, from the server's beat data (needs internet). The native player carries the plan out
// later, even with the screen off. With no plan (offline, no beat data) it does a plain fade.

import type { AutoMixTrack, AutoMixTrackDetail } from "./automix";
import {
  chooseTransition, downbeatAtOrBefore, fadeDurationFor, tempoMatch, type TrackShape,
} from "./dj.ts";

export const MIN_CONFIDENCE = 0.4;   // beat-grid confidence needed to beat-match
export const MAX_INTRO_CUE = 30;     // don't skip more intro than this to reach the first downbeat

export interface NativePlan {
  fromId: string;
  toId: string;
  cueOutMs: number;
  inStartMs: number;
  fadeMs: number;
  rate: number;
}

export function shapeOf(
  track: AutoMixTrack | null,
  detail: AutoMixTrackDetail | null,
  bpm: number | null,
  duration: number,
): TrackShape | null {
  if (!bpm && !track) return null;
  const d = detail && track && detail.id === track.id ? detail : null;
  return {
    bpm,
    duration: isFinite(duration) ? duration : track?.duration ?? 0,
    downbeats: d?.downbeats,
    introEnd: d?.intro_end ?? null,
    outroEnd: d?.outro_end ?? null,
    barEnergy: d?.bar_energy,
    barVocal: d?.bar_vocal,
  };
}

// Where the outgoing song starts mixing out by default: the server's phrase-aligned cue, snapped to a bar.
export function defaultCueOut(
  track: AutoMixTrack | null,
  detail: AutoMixTrackDetail | null,
  bpm: number | null,
  duration: number,
): { at: number; onDownbeat: boolean } {
  const fadeLen = fadeDurationFor(bpm);
  let at = track?.mix_out_point ? track.mix_out_point : duration - fadeLen;
  at = Math.min(at, duration - (bpm ? 240 / bpm : 2));
  at = Math.max(at, duration / 2);
  if (detail?.downbeats?.length && bpm && track && track.confidence >= MIN_CONFIDENCE) {
    const snapped = downbeatAtOrBefore(detail.downbeats, at);
    if (snapped !== null && at - snapped <= (4 * 4 * 60) / bpm) return { at: snapped, onDownbeat: true };
  }
  return { at, onDownbeat: false };
}

export interface PairInput {
  outId: string;
  inId: string;
  outTrack: AutoMixTrack | null;
  outDetail: AutoMixTrackDetail | null;
  inTrack: AutoMixTrack | null;
  inDetail: AutoMixTrackDetail | null;
  outBpm: number | null;
  inBpm: number | null;
  outDuration: number; // seconds
}

// The mix for one pair, or null when there is no sound basis for it (then the player does a plain fade).
export function planPair(p: PairInput): NativePlan | null {
  const { outTrack, inTrack, outDetail, inDetail, outBpm, inBpm } = p;
  if (!outTrack || !inTrack || !outDetail || !inDetail || !outBpm || !inBpm) return null;
  const match = tempoMatch(outBpm, inBpm);
  if (!match) return null;
  const def = defaultCueOut(outTrack, outDetail, outBpm, p.outDuration);
  const first = inDetail.downbeats?.[0];
  if (!def.onDownbeat || first === undefined || first > MAX_INTRO_CUE) return null;
  if (outTrack.confidence < MIN_CONFIDENCE || inTrack.confidence < MIN_CONFIDENCE) return null;
  const c = chooseTransition(
    shapeOf(outTrack, outDetail, outBpm, p.outDuration),
    shapeOf(inTrack, inDetail, inBpm, NaN),
    match, def.at, first,
  );
  return {
    fromId: p.outId,
    toId: p.inId,
    cueOutMs: Math.round(c.cue * 1000),
    inStartMs: Math.round(c.inStart * 1000),
    fadeMs: Math.round(c.plan.seconds * 1000),
    rate: match.rate,
  };
}
