import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import type { SubsonicSong, SubsonicCredentials, SongAnalysis } from "@/lib/subsonic";
import { streamUrl, coverArtUrl } from "@/lib/subsonic";
import {
  CROSSFADE_DURATION, EARLY_FADE_WINDOW, SILENCE_THRESHOLD,
  tempoMatch, fadeDurationFor, buildCrossfadeCurves, loudnessTrimDb, planTransition,
  downbeatAtOrBefore, phaseError, trustedHook, planHookTransition, djCueOut, buildHookFxCurves,
} from "@/lib/dj";
import type { AutoMixTrack, AutoMixTrackDetail } from "@/lib/automix";
import { findAutoMixTrack, getAutoMixTrack } from "@/lib/automix";
import styles from "./NowPlaying.module.css";
import type { TrackShape, MixMode, HookPlan } from "@/lib/dj";

interface Props {
  song: SubsonicSong | null;
  creds: SubsonicCredentials;
  analysis: SongAnalysis | null;
  mixMode: MixMode;
  onMixModeChange: (mode: MixMode) => void;
  shuffled: boolean;
  onShuffleToggle: () => void;
  onNext: () => void;
  onPrev: () => void;
  // Called when a crossfade finishes: `song` is already playing on the new deck.
  onAdvance: (song: SubsonicSong) => void;
  nextAnalysis: SongAnalysis | null;
  nextSong: SubsonicSong | null;
  onPlayingChange?: (playing: boolean, progress: number) => void;
  togglePlayRef?: React.MutableRefObject<(() => void) | null>;
  autoMixTracks?: AutoMixTrack[];
}

type Deck = "A" | "B";

// Per-deck channel strip:
// <audio> → source → preGain (loudness trim) → analyser → lowshelf (bass) → mid (vocal pocket)
//   → highpass (DJ filter dive) ┬→ fader → master limiter
//                               └→ echo send → delay ⇄ (lowpass → feedback) → master limiter
// The echo is tapped before the fader and returns straight to the master, so
// its tail keeps ringing after the deck is faded out and stopped.
interface DeckNodes {
  source: MediaElementAudioSourceNode;
  preGain: GainNode;
  analyser: AnalyserNode;
  shelf: BiquadFilterNode;
  mid: BiquadFilterNode;
  hpf: BiquadFilterNode;
  fader: GainNode;
  echoSend: GainNode;
  echoDelay: DelayNode;
}

interface BeatSync {
  outAnchor: number; // outgoing downbeat the mix starts on (track seconds)
  inAnchor: number;  // incoming downbeat it is aligned to
  outBeat: number;   // seconds per beat, outgoing
  inBeat: number;    // seconds per (tempo-matched) beat, incoming track time
  outRate: number;   // outgoing playbackRate during the mix
}

interface Fade {
  song: SubsonicSong;
  outDeck: Deck;
  inDeck: Deck;
  end: number;  // AudioContext time the curves finish
  rate: number; // incoming playbackRate while mixing
  bar: number;  // seconds per bar, for the tempo ramp afterwards
  sync: BeatSync | null;
  // Audio not unlocked yet: fade element volumes from a timer instead.
  legacy: { start: number; length: number } | null;
}

interface Preload {
  songId: string;
  deck: Deck;
  anchor: number | null; // first downbeat the deck is cued to, if known
  hook: boolean;         // DJ mode: cued to the build before its hook
}

const PRELOAD_LEAD = 30;    // seconds before the cue to start buffering the next song
const SCHEDULE_LEAD = 1.5;  // seconds before the cue to arm the precise start timer
const MIN_CONFIDENCE = 0.4; // beat-grid confidence needed to beat-sync
const MAX_INTRO_CUE = 30;   // don't skip more intro than this to reach the first downbeat
const CURVE_POINTS = 128;
const HPF_OPEN = 10;   // Hz: high-pass "off"
const SILENCE_READINGS = 8; // × 200 ms polls
const MAX_CUE_EXTENSIONS = 2; // DJ: incoming not buffered at the cue → wait 4 bars, at most this often

function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function shapeOf(
  track: AutoMixTrack | null,
  detail: AutoMixTrackDetail | null,
  bpm: number | null,
  duration: number,
  fullVocals = false,
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
    // DJ mixes mid-track, where only the hook pass's filled-in estimate exists.
    barVocal: fullVocals && d?.bar_vocal_full?.length ? d.bar_vocal_full : d?.bar_vocal,
  };
}

// Whether `seconds` of audio from `t` are already buffered.
function isBuffered(audio: HTMLAudioElement, t: number, seconds: number): boolean {
  const b = audio.buffered;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= t + 0.05 && b.end(i) >= Math.min(t + seconds, audio.duration - 0.1)) return true;
  }
  return false;
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function stopDeck(audio: HTMLAudioElement) {
  audio.pause();
  // Not `src = ""`: that resolves to the page URL and fetches index.html as audio.
  audio.removeAttribute("src");
  audio.load();
}

export function NowPlaying({
  song, creds, analysis,
  mixMode, onMixModeChange,
  shuffled, onShuffleToggle,
  onNext, onPrev, onAdvance,
  nextAnalysis, nextSong,
  onPlayingChange, togglePlayRef,
  autoMixTracks,
}: Props) {
  // DJ mixes like Crossfade until hook cues exist (docs/HOOK-MIX.md).
  const mixing = mixMode !== "off";
  const mixModeRef = useRef(mixMode);
  mixModeRef.current = mixMode;
  const cueExtendRef = useRef(0); // DJ: bars the current cue was pushed back (incoming not ready)
  // DJ: the hand-off planned for this song pair and hook end, kept while the
  // cue approaches (re-planning each poll would shrink the blend as time runs out).
  const djPlanRef = useRef<{ key: string; plan: HookPlan | null } | null>(null);
  const audioARef = useRef<HTMLAudioElement>(null);
  const audioBRef = useRef<HTMLAudioElement>(null);
  const [activeDeck, setActiveDeck] = useState<Deck>("A");
  const activeDeckRef = useRef<Deck>("A");
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [crossfading, setCrossfading] = useState(false);
  const [mixLabel, setMixLabel] = useState("CROSSFADING");
  const waveformRef = useRef<HTMLDivElement>(null);
  const lastSongIdRef = useRef<string | null>(null);
  const skipNextLoadRef = useRef<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<DynamicsCompressorNode | null>(null);
  const decksRef = useRef<Partial<Record<Deck, DeckNodes>>>({});
  const trimDbRef = useRef<Partial<Record<Deck, number>>>({});
  const fadeRef = useRef<Fade | null>(null);
  const fadeTimerRef = useRef<number | null>(null);
  const startTimerRef = useRef<number | null>(null);
  const rampTimerRef = useRef<number | null>(null);
  const preloadRef = useRef<Preload | null>(null);
  const crossfadeStartedRef = useRef(false);
  const currentDetailRef = useRef<AutoMixTrackDetail | null>(null);
  const nextDetailRef = useRef<AutoMixTrackDetail | null>(null);
  const onNextRef = useRef(onNext);
  const onPrevRef = useRef(onPrev);
  const onAdvanceRef = useRef(onAdvance);
  const nextSongRef = useRef(nextSong);
  onNextRef.current = onNext;
  onPrevRef.current = onPrev;
  onAdvanceRef.current = onAdvance;
  nextSongRef.current = nextSong;
  const songIdRef = useRef(song?.id);
  songIdRef.current = song?.id;

  const serverTrack = useMemo(
    () => song && autoMixTracks ? findAutoMixTrack(autoMixTracks, song) : null,
    [song?.id, autoMixTracks],
  );
  const serverNextTrack = useMemo(
    () => nextSong && autoMixTracks ? findAutoMixTrack(autoMixTracks, nextSong) : null,
    [nextSong?.id, autoMixTracks],
  );

  // `||`, not `??`: the server stores bpm 0 when it found no beat.
  const effectiveBpm = serverTrack?.bpm || analysis?.bpm || null;
  const effectiveNextBpm = serverNextTrack?.bpm || nextAnalysis?.bpm || null;

  // The DJ loop and timers run outside React renders; read live values via refs.
  const liveRef = useRef({ serverTrack, serverNextTrack, effectiveBpm, effectiveNextBpm });
  liveRef.current = { serverTrack, serverNextTrack, effectiveBpm, effectiveNextBpm };

  useEffect(() => {
    currentDetailRef.current = null;
    if (!serverTrack) return;
    let alive = true;
    getAutoMixTrack(serverTrack.id).then((d) => { if (alive) currentDetailRef.current = d; });
    return () => { alive = false; };
  }, [serverTrack?.id]);

  useEffect(() => {
    nextDetailRef.current = null;
    if (!serverNextTrack) return;
    let alive = true;
    getAutoMixTrack(serverNextTrack.id).then((d) => { if (alive) nextDetailRef.current = d; });
    return () => { alive = false; };
  }, [serverNextTrack?.id]);

  function audioFor(deck: Deck) {
    return deck === "A" ? audioARef.current : audioBRef.current;
  }

  const getActiveAudio = useCallback(() => {
    return activeDeckRef.current === "A" ? audioARef.current : audioBRef.current;
  }, []);

  const getInactiveAudio = useCallback(() => {
    return activeDeckRef.current === "A" ? audioBRef.current : audioARef.current;
  }, []);

  // Routes both decks through Web Audio, but only once the AudioContext is
  // running. An element wired into a context that is still suspended (no
  // user gesture yet, e.g. an autoplayed restore) stalls at 0:00 while
  // reporting that it plays. Until then decks play directly and mixes fall
  // back to element-volume fades. Returns whether the graph is live.
  function ensureAudioGraph(): boolean {
    if (!audioCtxRef.current) {
      const ctx = new AudioContext({ latencyHint: "playback" });
      const master = ctx.createDynamicsCompressor();
      // Safety limiter for summed peaks during a mix.
      master.threshold.value = -1;
      master.knee.value = 0;
      master.ratio.value = 20;
      master.attack.value = 0.003;
      master.release.value = 0.25;
      master.connect(ctx.destination);
      audioCtxRef.current = ctx;
      masterRef.current = master;
    }
    const ctx = audioCtxRef.current;
    if (decksRef.current.A && decksRef.current.B) return true;
    if (ctx.state !== "running") {
      ctx.resume().then(() => { ensureAudioGraph(); }).catch(() => {});
      return false;
    }
    for (const deck of ["A", "B"] as const) {
      const audio = audioFor(deck);
      if (!audio || decksRef.current[deck]) continue;
      const source = ctx.createMediaElementSource(audio);
      const preGain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048; // ~45 ms window for the silence detector
      const shelf = ctx.createBiquadFilter();
      shelf.type = "lowshelf";
      shelf.frequency.value = 200;
      shelf.gain.value = 0;
      preGain.gain.value = dbToGain(trimDbRef.current[deck] ?? 0);
      const fader = ctx.createGain();
      // During a legacy fade both decks are audible and element volume does the fading.
      fader.gain.value = deck === activeDeckRef.current || fadeRef.current?.legacy ? 1 : 0;
      const mid = ctx.createBiquadFilter();
      mid.type = "peaking";
      mid.frequency.value = 1000;
      mid.Q.value = 0.8;
      mid.gain.value = 0;
      const hpf = ctx.createBiquadFilter();
      hpf.type = "highpass";
      hpf.frequency.value = HPF_OPEN;
      hpf.Q.value = 0.7;
      const echoSend = ctx.createGain();
      echoSend.gain.value = 0;
      const echoDelay = ctx.createDelay(2);
      const echoTone = ctx.createBiquadFilter(); // each repeat duller: a dub echo, not a metallic one
      echoTone.type = "lowpass";
      echoTone.frequency.value = 2500;
      const echoFeedback = ctx.createGain();
      echoFeedback.gain.value = 0.45;
      source.connect(preGain).connect(analyser).connect(shelf).connect(mid).connect(hpf).connect(fader).connect(masterRef.current!);
      hpf.connect(echoSend).connect(echoDelay).connect(masterRef.current!);
      echoDelay.connect(echoTone).connect(echoFeedback).connect(echoDelay);
      decksRef.current[deck] = { source, preGain, analyser, shelf, mid, hpf, fader, echoSend, echoDelay };
    }
    return true;
  }

  // Any tap or key press unlocks audio; wire the graph as soon as one happens.
  useEffect(() => {
    const unlock = () => { if (audioCtxRef.current) ensureAudioGraph(); };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  function resumeCtx() {
    const ctx = audioCtxRef.current;
    // iOS uses "interrupted" (calls, Siri) as well as "suspended".
    if (ctx && ctx.state !== "running" && ctx.state !== "closed") ctx.resume().catch(() => {});
  }

  // Drop any automation (including a curve already in progress) and hold `value`.
  function setParam(param: AudioParam, value: number) {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    param.cancelScheduledValues(0);
    param.setValueAtTime(value, ctx.currentTime);
  }

  function setTrim(deck: Deck, s: SubsonicSong, track: AutoMixTrack | null) {
    const db = loudnessTrimDb(track?.lufs, s.replayGain);
    trimDbRef.current[deck] = db; // applied when the graph is wired, if it isn't yet
    const nodes = decksRef.current[deck];
    if (nodes) setParam(nodes.preGain.gain, dbToGain(db));
  }

  function resetStrip(deck: Deck, fader: number) {
    const audio = audioFor(deck);
    if (audio) audio.volume = 1;
    const nodes = decksRef.current[deck];
    if (!nodes) return;
    setParam(nodes.fader.gain, fader);
    setParam(nodes.shelf.gain, 0);
    setParam(nodes.mid.gain, 0);
    setParam(nodes.hpf.frequency, HPF_OPEN);
    setParam(nodes.echoSend.gain, 0); // the echo tail already in the delay rings out
  }

  function clearTimers() {
    if (fadeTimerRef.current) { clearInterval(fadeTimerRef.current); fadeTimerRef.current = null; }
    if (startTimerRef.current) { clearTimeout(startTimerRef.current); startTimerRef.current = null; }
    if (rampTimerRef.current) { clearInterval(rampTimerRef.current); rampTimerRef.current = null; }
  }

  // Abort a scheduled or running mix and any preload; the active deck keeps playing.
  function cancelCrossfade() {
    clearTimers();
    const inactive = getInactiveAudio();
    if (inactive && (fadeRef.current || preloadRef.current)) stopDeck(inactive);
    const active = activeDeckRef.current;
    resetStrip(active, 1);
    resetStrip(active === "A" ? "B" : "A", 0);
    fadeRef.current = null;
    preloadRef.current = null;
    crossfadeStartedRef.current = false;
    setCrossfading(false);
  }

  function updateMediaSession(s: SubsonicSong) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title,
      artist: s.artist ?? "Unknown",
      album: s.album ?? "Unknown",
      artwork: s.coverArt
        ? [{ src: coverArtUrl(creds, s.coverArt, "512"), sizes: "512x512", type: "image/jpeg" }]
        : [],
    });
    navigator.mediaSession.setActionHandler("play", () => playRef.current());
    navigator.mediaSession.setActionHandler("pause", () => pauseRef.current());
    navigator.mediaSession.setActionHandler("previoustrack", () => onPrevRef.current());
    navigator.mediaSession.setActionHandler("nexttrack", () => onNextRef.current());
  }

  function setStreamSrc(audio: HTMLAudioElement, songId: string) {
    const url = streamUrl(creds, songId);
    // A cross-origin stream routed through Web Audio is silent without CORS.
    try {
      if (new URL(url, window.location.href).origin !== window.location.origin) {
        audio.crossOrigin = "anonymous";
      }
    } catch {}
    audio.src = url;
  }

  const waveformBars = useMemo(() => {
    return Array.from({ length: 60 }, () => 10 + Math.random() * 35);
  }, [song?.id]);

  useEffect(() => {
    if (!song) return;

    if (skipNextLoadRef.current === song.id) {
      // A crossfade already brought this song in on the new deck.
      skipNextLoadRef.current = null;
      lastSongIdRef.current = song.id;
      updateMediaSession(song);
      return;
    }
    skipNextLoadRef.current = null;

    if (song.id === lastSongIdRef.current) return;
    lastSongIdRef.current = song.id;

    // "Next" pressed mid-mix lands on the incoming song: finish the mix now.
    if (fadeRef.current?.song.id === song.id) {
      finishCrossfade(false);
      updateMediaSession(song);
      return;
    }

    cancelCrossfade();
    const audio = getActiveAudio();
    if (!audio) return;

    ensureAudioGraph();
    resumeCtx();
    setTrim(activeDeckRef.current, song, serverTrack);
    audio.preservesPitch = true;
    audio.playbackRate = 1;
    setStreamSrc(audio, song.id);
    cueExtendRef.current = 0;
    // DJ mode keeps the hook flow: a song picked by hand starts at its build.
    const hook = mixModeRef.current === "dj" ? trustedHook(serverTrack) : null;
    if (hook) {
      const id = song.id;
      const seek = () => { if (lastSongIdRef.current === id && audio.currentTime < hook.in) audio.currentTime = hook.in; };
      if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
      else audio.addEventListener("loadedmetadata", seek, { once: true });
    }
    audio.play().then(() => setPlaying(true)).catch(() => {});
    updateMediaSession(song);
  }, [song, creds, getActiveAudio]);

  // Buffer the next song on the idle deck, cued to its first downbeat.
  function preload(next: SubsonicSong) {
    const deck: Deck = activeDeckRef.current === "A" ? "B" : "A";
    const audio = audioFor(deck);
    if (!audio) return;
    ensureAudioGraph();
    const { serverNextTrack: track } = liveRef.current;
    const detail = track && nextDetailRef.current?.id === track.id ? nextDetailRef.current : null;
    const first = detail?.downbeats?.[0] ?? null;
    const hook = mixModeRef.current === "dj" ? trustedHook(track) : null;
    // DJ: cue two bars before the build (a swap starts one bar before it); the
    // mix may start later, a short seek inside what is already buffered.
    const nextBar = liveRef.current.effectiveNextBpm ? 240 / liveRef.current.effectiveNextBpm : 2;
    const anchor = hook ? Math.max(0, hook.in - 2 * nextBar) : first !== null && first <= MAX_INTRO_CUE ? first : null;

    audio.pause();
    audio.preload = "auto";
    resetStrip(deck, 0);
    setTrim(deck, next, track);
    setStreamSrc(audio, next.id);
    if (anchor !== null) {
      // Skip if a newer preload replaced this one before metadata arrived.
      const cue = () => { if (preloadRef.current?.songId === next.id) audio.currentTime = anchor; };
      if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) cue();
      else audio.addEventListener("loadedmetadata", cue, { once: true });
    }
    preloadRef.current = { songId: next.id, deck, anchor, hook: !!hook };
  }

  // DJ: plan the hand-off whose incoming drop lands at `mixEnd` (outgoing time).
  // The outgoing hook keeps its first half (at most 8 bars) to itself.
  function djPlanFor(mixEnd: number, now: number): HookPlan | null {
    const { serverTrack: outTrack, serverNextTrack: inTrack, effectiveBpm: outBpm, effectiveNextBpm: inBpm } = liveRef.current;
    const inHook = trustedHook(inTrack);
    if (!inHook || !outBpm) return null;
    const key = `${outTrack?.id}|${inTrack?.id}|${mixEnd.toFixed(2)}|${inBpm}`;
    if (djPlanRef.current?.key === key) return djPlanRef.current.plan;
    const bar = 240 / outBpm;
    const outHook = trustedHook(outTrack);
    const keep = outHook ? Math.min(8, Math.floor((outHook.out - outHook.drop) / bar / 2)) * bar + outHook.drop : 0;
    const room = Math.floor((mixEnd - Math.max(now + SCHEDULE_LEAD + 0.5, keep)) / bar + 0.01);
    const match = inBpm ? tempoMatch(outBpm, inBpm) : null;
    const outShape = shapeOf(outTrack, currentDetailRef.current, outBpm, NaN, true);
    const inShape = shapeOf(inTrack, nextDetailRef.current, inBpm, NaN, true);
    const plan = planHookTransition(outShape, inShape, match, mixEnd, inHook.drop, room, inHook.in);
    djPlanRef.current = { key, plan };
    return plan;
  }

  // Where the outgoing track should start mixing out, in its own time.
  function cueOutFor(audio: HTMLAudioElement): { at: number; onDownbeat: boolean; hook: boolean; plan: HookPlan | null } {
    const { serverTrack: track, effectiveBpm: bpm } = liveRef.current;
    const detail = track && currentDetailRef.current?.id === track.id ? currentDetailRef.current : null;
    const grid = !!(detail?.downbeats?.length && bpm && track!.confidence >= MIN_CONFIDENCE);
    // DJ: the incoming hook lands where this hook ends (pushed back by whole
    // bars while the incoming deck isn't ready); the mix starts the plan's
    // length before that.
    const hook = mixModeRef.current === "dj" ? trustedHook(track) : null;
    if (hook && bpm) {
      const at = djCueOut(detail?.downbeats, hook, audio.currentTime);
      const mixEnd = at === null ? null : at + cueExtendRef.current * (240 / bpm);
      if (mixEnd !== null && mixEnd < audio.duration - 2) {
        const plan = djPlanFor(mixEnd, audio.currentTime);
        return { at: plan ? plan.cueOut : mixEnd, onDownbeat: grid, hook: true, plan };
      }
    }
    // The server's mix_out_point is phrase-aligned and leaves room for a
    // mix; the transition planner decides how long the mix is from there.
    const fadeLen = fadeDurationFor(bpm);
    let at = track?.mix_out_point ? track.mix_out_point : audio.duration - fadeLen;
    at = Math.min(at, audio.duration - (bpm ? 240 / bpm : 2));
    at = Math.max(at, audio.duration / 2);

    if (grid) {
      const snapped = downbeatAtOrBefore(detail!.downbeats, at);
      if (snapped !== null && at - snapped <= (4 * 4 * 60) / bpm!) return { at: snapped, onDownbeat: true, hook: false, plan: null };
    }
    return { at, onDownbeat: false, hook: false, plan: null };
  }

  // Mean-square level of the last SILENCE_READINGS polls (~1.6 s). Three
  // 12 ms snapshots used to be enough to "detect silence" in the gaps of a
  // sparse breakdown and start an unsynced mix early.
  const silenceLevelsRef = useRef<number[]>([]);

  useEffect(() => {
    if (!mixing) return;

    const check = () => {
      const audio = getActiveAudio();
      if (!audio || audio.paused || !isFinite(audio.duration)) return;
      const next = nextSongRef.current;
      if (crossfadeStartedRef.current || !next) return;
      // Just after a mix, until React catches up, props still describe the
      // previous song (its cues, and the song now playing as "next").
      if (songIdRef.current !== lastSongIdRef.current || next.id === lastSongIdRef.current) return;

      const cue = cueOutFor(audio);
      const remaining = audio.duration - audio.currentTime;

      // DJ songs last ~50 s: buffer the next one as soon as this one is on.
      const lead = mixModeRef.current === "dj" ? Infinity : PRELOAD_LEAD;
      // Re-buffer when the cue point changed with the mode (Crossfade <-> DJ).
      const wantHook = mixModeRef.current === "dj" && !!trustedHook(liveRef.current.serverNextTrack);
      const stale = preloadRef.current?.songId !== next.id || preloadRef.current.hook !== wantHook;
      if (audio.currentTime >= cue.at - lead && stale) {
        preload(next);
      }

      if (audio.currentTime >= cue.at - SCHEDULE_LEAD && remaining > 0) {
        crossfadeStartedRef.current = true;
        // The 200 ms poll is too coarse to land on a beat; time the start exactly.
        const delay = Math.max(0, (cue.at - audio.currentTime) / audio.playbackRate);
        startTimerRef.current = window.setTimeout(() => {
          startTimerRef.current = null;
          startCrossfade(cue.at, cue.onDownbeat, cue.hook, cue.plan);
        }, delay * 1000);
        return;
      }

      if (remaining <= EARLY_FADE_WINDOW && remaining > CROSSFADE_DURATION) {
        const analyser = decksRef.current[activeDeckRef.current]?.analyser;
        if (analyser) {
          const buf = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
          const levels = silenceLevelsRef.current;
          levels.push(sum / buf.length);
          if (levels.length > SILENCE_READINGS) levels.shift();
          const meanSquare = levels.reduce((a, b) => a + b, 0) / levels.length;
          if (levels.length === SILENCE_READINGS && Math.sqrt(meanSquare) < SILENCE_THRESHOLD) {
            crossfadeStartedRef.current = true;
            silenceLevelsRef.current = [];
            startCrossfade(null, false);
          }
        }
      } else {
        silenceLevelsRef.current = [];
      }
    };

    const interval = setInterval(check, 200);
    return () => {
      clearInterval(interval);
      silenceLevelsRef.current = [];
      // DJ mode turned off: a mix armed for the next second must not start.
      if (startTimerRef.current) {
        clearTimeout(startTimerRef.current);
        startTimerRef.current = null;
        crossfadeStartedRef.current = false;
      }
    };
  }, [mixing, getActiveAudio]);

  // `target`: the outgoing time this start was timed to (null: start now, e.g.
  // silence detected). `onDownbeat`: target is a downbeat, so beat-sync.
  function startCrossfade(target: number | null, onDownbeat: boolean, outHook = false, djPlan: HookPlan | null = null) {
    const outgoing = getActiveAudio();
    const incoming = getInactiveAudio();
    const next = nextSongRef.current;
    if (!outgoing || !incoming || !next) { crossfadeStartedRef.current = false; return; }

    if (outgoing.paused) { crossfadeStartedRef.current = false; return; } // re-arm on resume
    let anchor = onDownbeat ? target : null;
    if (target !== null && Math.abs(outgoing.currentTime - target) > 0.15) {
      // A seek or stall moved the playhead: re-arm if we are early, else start unsynced.
      if (outgoing.currentTime < target) { crossfadeStartedRef.current = false; return; }
      anchor = null;
    }
    // A short song can still be easing out of the previous mix's tempo. Hold
    // its current rate and match the incoming deck to it, not to 1.0.
    if (rampTimerRef.current) { clearInterval(rampTimerRef.current); rampTimerRef.current = null; }
    const outRate = outgoing.playbackRate;

    if (preloadRef.current?.songId !== next.id) {
      preload(next);
      anchor = null; // not buffered or cued in time to sync
    }
    const live = ensureAudioGraph();
    const ctx = audioCtxRef.current;

    const outDeck = activeDeckRef.current;
    const inDeck: Deck = outDeck === "A" ? "B" : "A";
    const { serverTrack: outTrack, serverNextTrack: inTrack, effectiveBpm: outBpm, effectiveNextBpm: inBpm } = liveRef.current;

    const match = outBpm && inBpm ? tempoMatch(outBpm, inBpm) : null;
    incoming.preservesPitch = true;
    incoming.playbackRate = (match?.rate ?? 1) * outRate;

    // DJ: the incoming build is timed so its hook lands where the mix ends.
    const inHook = mixModeRef.current === "dj" && preloadRef.current?.hook ? trustedHook(inTrack) : null;
    const outShape = shapeOf(outTrack, currentDetailRef.current, outBpm, outgoing.duration, !!inHook);
    const inShape = shapeOf(inTrack, nextDetailRef.current, inBpm, incoming.duration, !!inHook);
    // Planned with the cue; else (a late or unsynced start) a one-bar swap from now.
    const hookPlan = inHook
      ? djPlan ?? planHookTransition(outShape, inShape, match, outgoing.currentTime + (outBpm ? 240 / outBpm : 2), inHook.drop, 0, inHook.in)
      : null;
    if (hookPlan && target !== null) {
      // Not buffered at the build yet: let the outgoing play on 4 more bars
      // (past its hook) instead of starting into a stall.
      const ready = incoming.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && isBuffered(incoming, hookPlan.inStart, 4);
      if (!ready && outHook && cueExtendRef.current < 4 * MAX_CUE_EXTENSIONS) {
        cueExtendRef.current += 4;
        crossfadeStartedRef.current = false;
        console.info("[brook] dj: next song not buffered, mixing 4 bars later");
        return;
      }
    }
    if (hookPlan && Math.abs(incoming.currentTime - hookPlan.inStart) > 0.03) incoming.currentTime = hookPlan.inStart;

    const inAnchor = hookPlan ? hookPlan.inStart : preloadRef.current?.anchor ?? null;
    const sync: BeatSync | null =
      anchor !== null && inAnchor !== null && match && outBpm && inBpm &&
      (outTrack?.confidence ?? 0) >= MIN_CONFIDENCE && (inTrack?.confidence ?? 0) >= MIN_CONFIDENCE
        ? { outAnchor: anchor, inAnchor, outBeat: 60 / outBpm, inBeat: 60 / (inBpm * match.factor), outRate }
        : null;

    const plan = hookPlan ?? planTransition(outShape, inShape, match, outgoing.currentTime, inAnchor ?? 0);
    const fadeLen = plan.seconds;
    const bar = outBpm ? 240 / outBpm : fadeLen / 8;
    const curves = buildCrossfadeCurves(CURVE_POINTS, plan.swapStart, plan.swapEnd);
    setMixLabel(hookPlan
      ? hookPlan.style === "cut" ? "DJ SWAP" : `DJ ${plan.bars} BARS`
      : plan.bars ? `MIX ${plan.bars} BAR${plan.bars > 1 ? "S" : ""}` : "CROSSFADING");
    console.info("[brook] mix plan", plan);

    let end = 0;
    let legacy: Fade["legacy"] = null;
    if (live && ctx) {
      const out = decksRef.current[outDeck]!;
      const inn = decksRef.current[inDeck]!;
      const t0 = ctx.currentTime + 0.02;
      const schedule = (param: AudioParam, curve: Float32Array) => {
        param.cancelScheduledValues(0);
        param.setValueAtTime(curve[0]!, ctx.currentTime);
        param.setValueCurveAtTime(curve, t0, fadeLen);
      };
      schedule(out.fader.gain, curves.gainOut);
      schedule(inn.fader.gain, curves.gainIn);
      schedule(out.shelf.gain, curves.shelfOut);
      schedule(inn.shelf.gain, curves.shelfIn);
      if (hookPlan) {
        const fx = buildHookFxCurves(CURVE_POINTS, hookPlan.style, hookPlan.bars ?? 1);
        schedule(inn.hpf.frequency, fx.hpfIn);
        schedule(inn.mid.gain, fx.midIn);
        if (hookPlan.style === "cut" && outBpm) {
          // Swap: the outgoing washes out through a rising high-pass into a
          // dotted-eighth dub echo that keeps ringing (damped) after the deck is gone.
          schedule(out.hpf.frequency, fx.hpfOut);
          const beat = 60 / outBpm;
          out.echoDelay.delayTime.cancelScheduledValues(0);
          out.echoDelay.delayTime.setValueAtTime(Math.min(1.9, beat * 0.75), ctx.currentTime);
          schedule(out.echoSend.gain, fx.echoOut);
        }
      }
      end = t0 + fadeLen;
    } else {
      incoming.volume = 0;
      legacy = { start: performance.now(), length: fadeLen };
    }

    incoming.play().catch(() => {});
    fadeRef.current = { song: next, outDeck, inDeck, end, rate: incoming.playbackRate, bar, sync, legacy };
    setCrossfading(true);

    if (fadeTimerRef.current) clearInterval(fadeTimerRef.current);
    fadeTimerRef.current = window.setInterval(tickFade, 100);
  }

  // Runs every 100 ms during a mix: keeps the beats locked and ends the mix.
  // Gain and EQ curves run on the audio thread and don't depend on this timer.
  function tickFade() {
    const fade = fadeRef.current;
    if (!fade) return;
    const out = audioFor(fade.outDeck);
    const inc = audioFor(fade.inDeck);
    if (fade.legacy) {
      if (out?.paused) { fade.legacy.start += 100; return; } // hold the fade while paused
      const p = Math.min(1, (performance.now() - fade.legacy.start) / 1000 / fade.legacy.length);
      if (out) out.volume = Math.cos((p * Math.PI) / 2);
      if (inc) inc.volume = Math.sin((p * Math.PI) / 2);
      if (p >= 1) { finishCrossfade(true); return; }
    } else {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      if (ctx.currentTime >= fade.end) { finishCrossfade(true); return; }
    }

    const sync = fade.sync;
    if (!sync || !out || !inc || out.paused || inc.paused) return;
    if (inc.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;

    const err = phaseError(out.currentTime, sync.outAnchor, sync.outBeat, inc.currentTime, sync.inAnchor, sync.inBeat);
    const errSec = (err * sync.outBeat) / sync.outRate; // wall-clock seconds; > 0: incoming is ahead
    if (Math.abs(errSec) > 0.08) {
      // Way off (start latency, buffering stall): jump into phase.
      inc.currentTime = inc.currentTime - err * sync.inBeat;
    } else if (Math.abs(errSec) > 0.005) {
      // Small drift (play() latency, BPM estimate error): nudge tempo, like a DJ on the jog wheel.
      const nudge = Math.max(-0.02, Math.min(0.02, errSec / 2));
      inc.playbackRate = fade.rate * (1 - nudge);
    } else {
      inc.playbackRate = fade.rate;
    }
  }

  // Hand over to the incoming deck. `advance`: tell App the song changed.
  function finishCrossfade(advance: boolean) {
    const fade = fadeRef.current;
    if (!fade) return;
    clearTimers();
    const out = audioFor(fade.outDeck);
    const inc = audioFor(fade.inDeck);
    if (out) stopDeck(out);
    resetStrip(fade.inDeck, 1);
    resetStrip(fade.outDeck, 0);

    activeDeckRef.current = fade.inDeck;
    setActiveDeck(fade.inDeck);
    setCrossfading(false);
    fadeRef.current = null;
    preloadRef.current = null;
    crossfadeStartedRef.current = false;
    cueExtendRef.current = 0;
    lastSongIdRef.current = fade.song.id;

    if (inc) {
      // The incoming deck loaded while inactive, so its metadata event was never handled.
      if (isFinite(inc.duration)) setDuration(inc.duration);
      setPlaying(!inc.paused);
      rampRate(inc, fade.bar * 4);
    }

    if (advance) {
      skipNextLoadRef.current = fade.song.id;
      onAdvanceRef.current(fade.song);
    }
  }

  // Ease the tempo back to the track's own speed instead of snapping to 1.0.
  function rampRate(audio: HTMLAudioElement, seconds: number) {
    const from = audio.playbackRate;
    if (Math.abs(from - 1) < 0.001) { audio.playbackRate = 1; return; }
    const steps = Math.max(1, Math.round((seconds * 1000) / 100));
    let step = 0;
    rampTimerRef.current = window.setInterval(() => {
      step++;
      audio.playbackRate = from + (1 - from) * (step / steps);
      if (step >= steps) {
        audio.playbackRate = 1;
        clearInterval(rampTimerRef.current!);
        rampTimerRef.current = null;
      }
    }, 100);
  }

  function playAll() {
    const audio = getActiveAudio();
    if (!audio) return;
    ensureAudioGraph();
    resumeCtx();
    audio.play().catch(() => {});
    if (fadeRef.current) audioFor(fadeRef.current.inDeck)?.play().catch(() => {});
  }

  function pauseAll() {
    getActiveAudio()?.pause();
    if (fadeRef.current) {
      audioFor(fadeRef.current.inDeck)?.pause();
      // Freeze the automation clock so the mix resumes where it stopped.
      audioCtxRef.current?.suspend().catch(() => {});
    }
  }

  const playRef = useRef(playAll);
  const pauseRef = useRef(pauseAll);
  playRef.current = playAll;
  pauseRef.current = pauseAll;

  const togglePlay = useCallback(() => {
    const audio = getActiveAudio();
    if (!audio) return;
    if (audio.paused) playRef.current();
    else pauseRef.current();
  }, [getActiveAudio]);

  useEffect(() => {
    if (togglePlayRef) togglePlayRef.current = togglePlay;
    return () => { if (togglePlayRef) togglePlayRef.current = null; };
  }, [togglePlay, togglePlayRef]);

  const onPlayingChangeRef = useRef(onPlayingChange);
  onPlayingChangeRef.current = onPlayingChange;

  function handleTimeUpdate() {
    const audio = getActiveAudio();
    if (audio) {
      setCurrentTime(audio.currentTime);
      if (onPlayingChangeRef.current && audio.duration > 0) {
        onPlayingChangeRef.current(!audio.paused, audio.currentTime / audio.duration);
      }
    }
  }

  function handleLoadedMetadata() {
    const audio = getActiveAudio();
    if (audio) setDuration(audio.duration);
  }

  function handleWaveformClick(e: React.MouseEvent) {
    const audio = getActiveAudio();
    const el = waveformRef.current;
    if (!audio || !el) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (fadeRef.current) fadeRef.current.sync = null; // a seek breaks the beat alignment
    audio.currentTime = ratio * duration;
    setCurrentTime(audio.currentTime);
  }

  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimers();
      // Close on a real unmount only. StrictMode's test unmount/remount keeps
      // the same <audio> elements, and an element wired into a closed context
      // can never be rewired: playback would stall for good.
      setTimeout(() => {
        if (mountedRef.current || !audioCtxRef.current) return;
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
        masterRef.current = null;
        decksRef.current = {};
      }, 0);
    };
  }, []);

  function handleEnded() {
    if (fadeRef.current) {
      // The outgoing track ran out before the curves did.
      finishCrossfade(true);
      return;
    }
    // Also in DJ mode: if no mix could start (no next song yet), don't stall.
    cancelCrossfade();
    onNextRef.current();
  }

  const progress = duration > 0 ? currentTime / duration : 0;
  const coverSrc = useMemo(
    () => song?.coverArt ? coverArtUrl(creds, song.coverArt, "512") : null,
    [song?.id, song?.coverArt, creds],
  );

  // The decks stay mounted even with no song: they are wired into the
  // AudioContext once, and a remounted element would play outside the graph.
  const decks = (
    <>
      <audio
        ref={audioARef}
        onTimeUpdate={activeDeck === "A" ? handleTimeUpdate : undefined}
        onLoadedMetadata={activeDeck === "A" ? handleLoadedMetadata : undefined}
        onPlay={activeDeck === "A" ? () => { setPlaying(true); const a = audioARef.current; if (a && a.duration > 0) onPlayingChangeRef.current?.(true, a.currentTime / a.duration); } : undefined}
        onPause={activeDeck === "A" ? () => { setPlaying(false); const a = audioARef.current; if (a && a.duration > 0) onPlayingChangeRef.current?.(false, a.currentTime / a.duration); } : undefined}
        onEnded={activeDeck === "A" ? handleEnded : undefined}
      />
      <audio
        ref={audioBRef}
        onTimeUpdate={activeDeck === "B" ? handleTimeUpdate : undefined}
        onLoadedMetadata={activeDeck === "B" ? handleLoadedMetadata : undefined}
        onPlay={activeDeck === "B" ? () => { setPlaying(true); const a = audioBRef.current; if (a && a.duration > 0) onPlayingChangeRef.current?.(true, a.currentTime / a.duration); } : undefined}
        onPause={activeDeck === "B" ? () => { setPlaying(false); const a = audioBRef.current; if (a && a.duration > 0) onPlayingChangeRef.current?.(false, a.currentTime / a.duration); } : undefined}
        onEnded={activeDeck === "B" ? handleEnded : undefined}
      />
    </>
  );

  if (!song) {
    return (
      <div className={styles.empty}>
        {decks}
        <div className={styles.emptyIcon}>&#9835;</div>
        <p className={styles.emptyText}>No song playing</p>
        <p className={styles.emptyHint}>Go to Library and pick a song</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {decks}
      {coverSrc && <div className={styles.bgBlur} style={{ backgroundImage: `url(${coverSrc})` }} />}
      <div className={styles.bgOverlay} />

      <div className={styles.player}>
        <div className={styles.coverWrap}>
          {coverSrc ? (
            <img className={styles.cover} src={coverSrc} alt="" />
          ) : (
            <div className={styles.coverPlaceholder}>&#9835;</div>
          )}
          {coverSrc && <div className={styles.coverGlow} style={{ backgroundImage: `url(${coverSrc})` }} />}
        </div>

        <div className={styles.songInfo}>
          <div className={styles.titlePill}>{song.title}</div>
          <div className={styles.albumPill}>{song.album ?? "Unknown"}</div>
          <div className={styles.artist}>{song.artist ?? "Unknown"}</div>
        </div>

        <div className={styles.waveformWrap} ref={waveformRef} onClick={handleWaveformClick}>
          {waveformBars.map((h, i) => (
            <div
              key={i}
              className={`${styles.bar} ${i / waveformBars.length < progress ? styles.barPast : styles.barFuture}`}
              style={{ height: `${h}px` }}
            />
          ))}
        </div>

        <div className={styles.timeRow}>
          <span>{formatTime(currentTime)}</span>
          <span>
            {crossfading && <span className={styles.crossfadeLabel}>{mixLabel}</span>}
            {formatTime(duration)}
          </span>
        </div>

        <div className={styles.controls}>
          <button className={styles.ctrlSide} onClick={onPrev} aria-label="Previous">&#9198;</button>
          <button className={styles.ctrlPlay} onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
            {playing ? (
              <span className={styles.pauseIcon}>
                <span /><span />
              </span>
            ) : "▶"}
          </button>
          <button className={styles.ctrlSide} onClick={onNext} aria-label="Next">&#9197;</button>
        </div>

        <div className={styles.extras}>
          <button
            className={`${styles.djToggle} ${mixMode === "crossfade" ? styles.djActive : ""}`}
            onClick={() => onMixModeChange(mixMode === "crossfade" ? "off" : "crossfade")}
            aria-pressed={mixMode === "crossfade"}
          >
            Crossfade
          </button>
          <button
            className={`${styles.djToggle} ${mixMode === "dj" ? styles.djActive : ""}`}
            onClick={() => onMixModeChange(mixMode === "dj" ? "off" : "dj")}
            aria-pressed={mixMode === "dj"}
          >
            DJ
          </button>
          <button
            className={`${styles.shuffleToggle} ${shuffled ? styles.shuffleActive : ""}`}
            onClick={onShuffleToggle}
          >
            Shuffle
          </button>
        </div>

        <div className={styles.quality}>
          {song.suffix?.toUpperCase() ?? "MP3"} &middot; {song.bitRate ? `${song.bitRate} KBPS` : ""}
          {effectiveBpm && (
            <> &middot; {Math.round(effectiveBpm)} BPM</>
          )}
          {(serverTrack?.key ?? analysis?.key) && (
            <> &middot; {serverTrack?.key ?? analysis?.key}</>
          )}
          {serverTrack && (
            <> &middot; v2</>
          )}
        </div>
      </div>
    </div>
  );
}
