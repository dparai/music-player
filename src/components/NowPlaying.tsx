import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import type { SubsonicSong, SubsonicCredentials, SongAnalysis } from "@/lib/subsonic";
import { streamUrl, coverArtUrl } from "@/lib/subsonic";
import {
  CROSSFADE_DURATION, EARLY_FADE_WINDOW, SILENCE_THRESHOLD,
  tempoMatch, fadeDurationFor, buildCrossfadeCurves, loudnessTrimDb, planTransition,
  downbeatAtOrBefore, phaseError,
} from "@/lib/dj";
import type { AutoMixTrack, AutoMixTrackDetail } from "@/lib/automix";
import { findAutoMixTrack, getAutoMixTrack } from "@/lib/automix";
import styles from "./NowPlaying.module.css";
import type { TrackShape } from "@/lib/dj";

interface Props {
  song: SubsonicSong | null;
  creds: SubsonicCredentials;
  analysis: SongAnalysis | null;
  djMode: boolean;
  onDjModeToggle: () => void;
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
// <audio> → source → preGain (loudness trim) → analyser → lowshelf (bass) → fader → master limiter
interface DeckNodes {
  source: MediaElementAudioSourceNode;
  preGain: GainNode;
  analyser: AnalyserNode;
  shelf: BiquadFilterNode;
  fader: GainNode;
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
}

const PRELOAD_LEAD = 30;    // seconds before the cue to start buffering the next song
const SCHEDULE_LEAD = 1.5;  // seconds before the cue to arm the precise start timer
const MIN_CONFIDENCE = 0.4; // beat-grid confidence needed to beat-sync
const MAX_INTRO_CUE = 30;   // don't skip more intro than this to reach the first downbeat
const CURVE_POINTS = 128;
// Short fades for the moments that are not mixes (what Poweramp does for
// play/pause, seek and a manual skip): a hard start, stop or jump of a playing
// stream clicks, and skipping mid-phrase cuts the old song dead.
const FADE_PAUSE_S = 0.15;     // pause out / play in
const FADE_SEEK_OUT_S = 0.04;  // seek: mute, jump, then...
const FADE_SEEK_IN_S = 0.06;   // ...fade back in (about 100 ms in all)
const FADE_SKIP_OUT_S = 0.15;  // manual skip: old song out
const FADE_SKIP_IN_S = 0.25;   // ...new song in
const SILENCE_READINGS = 8; // × 200 ms polls

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
  djMode, onDjModeToggle,
  shuffled, onShuffleToggle,
  onNext, onPrev, onAdvance,
  nextAnalysis, nextSong,
  onPlayingChange, togglePlayRef,
  autoMixTracks,
}: Props) {
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
  const pauseTimerRef = useRef<number | null>(null);  // a fade-out before pause() is under way
  const seekRef = useRef<{ timer: number; target: number; deck: Deck } | null>(null);
  const skipTimerRef = useRef<number | null>(null);   // a fade-out before a manual skip loads
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
      source.connect(preGain).connect(analyser).connect(shelf).connect(fader).connect(masterRef.current!);
      decksRef.current[deck] = { source, preGain, analyser, shelf, fader };
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

  // Whether the Web Audio graph can carry a fade right now (it can't while the
  // context is suspended, e.g. before the first tap on some browsers).
  function fadeable(): boolean {
    const ctx = audioCtxRef.current;
    return !!ctx && ctx.state === "running" && !!decksRef.current[activeDeckRef.current];
  }

  // Ramp the active deck's fader to `to` from wherever it is. False: no fade
  // possible, nothing was changed. Never call during a mix (it owns the faders).
  function rampActiveFader(to: number, seconds: number): boolean {
    if (!fadeable()) return false;
    const ctx = audioCtxRef.current!;
    const g = decksRef.current[activeDeckRef.current]!.fader.gain;
    const now = ctx.currentTime;
    const from = g.value;
    g.cancelScheduledValues(0);
    g.setValueAtTime(from, now);
    g.linearRampToValueAtTime(to, now + seconds);
    return true;
  }

  // Fade the active deck back to full level; if fades are unavailable, just
  // make sure it isn't left silent.
  function rampUp(seconds: number) {
    if (!rampActiveFader(1, seconds)) resetStrip(activeDeckRef.current, 1);
  }

  // Apply a seek that was waiting for its mute, and drop pending fade-outs.
  function cancelPendingFades() {
    if (pauseTimerRef.current) { clearTimeout(pauseTimerRef.current); pauseTimerRef.current = null; }
    if (skipTimerRef.current) { clearTimeout(skipTimerRef.current); skipTimerRef.current = null; }
    const seek = seekRef.current;
    if (seek) {
      clearTimeout(seek.timer);
      seekRef.current = null;
      const audio = audioFor(seek.deck);
      if (audio) audio.currentTime = seek.target;
    }
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

    cancelPendingFades();
    const load = (fadeIn: boolean) => {
      if (lastSongIdRef.current !== song.id) return; // a newer pick took over while we faded out
      cancelCrossfade();
      const audio = getActiveAudio();
      if (!audio) return;

      ensureAudioGraph();
      resumeCtx();
      setTrim(activeDeckRef.current, song, serverTrack);
      audio.preservesPitch = true;
      audio.playbackRate = 1;
      // Start silent and fade in once audio is flowing (only when the fade can run).
      if (fadeIn && fadeable()) setParam(decksRef.current[activeDeckRef.current]!.fader.gain, 0);
      setStreamSrc(audio, song.id);
      audio.play().then(() => { setPlaying(true); if (fadeIn) rampUp(FADE_SKIP_IN_S); })
        .catch(() => { if (fadeIn) resetStrip(activeDeckRef.current, 1); });
      updateMediaSession(song);
    };

    // A manual skip while a song is playing (not mid-mix): fade it out first
    // instead of cutting it dead.
    const playing = getActiveAudio();
    if (playing && !playing.paused && !fadeRef.current && rampActiveFader(0, FADE_SKIP_OUT_S)) {
      clearTimers();
      crossfadeStartedRef.current = true; // no mix may start while we fade out
      skipTimerRef.current = window.setTimeout(() => { skipTimerRef.current = null; load(true); }, FADE_SKIP_OUT_S * 1000 + 20);
      return;
    }
    load(false);
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
    const anchor = first !== null && first <= MAX_INTRO_CUE ? first : null;

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
    preloadRef.current = { songId: next.id, deck, anchor };
  }

  // Where the outgoing track should start mixing out, in its own time.
  function cueOutFor(audio: HTMLAudioElement): { at: number; onDownbeat: boolean } {
    const { serverTrack: track, effectiveBpm: bpm } = liveRef.current;
    // The server's mix_out_point is phrase-aligned and leaves room for a
    // mix; the transition planner decides how long the mix is from there.
    const fadeLen = fadeDurationFor(bpm);
    let at = track?.mix_out_point ? track.mix_out_point : audio.duration - fadeLen;
    at = Math.min(at, audio.duration - (bpm ? 240 / bpm : 2));
    at = Math.max(at, audio.duration / 2);

    const detail = track && currentDetailRef.current?.id === track.id ? currentDetailRef.current : null;
    if (detail?.downbeats?.length && bpm && track!.confidence >= MIN_CONFIDENCE) {
      const snapped = downbeatAtOrBefore(detail.downbeats, at);
      if (snapped !== null && at - snapped <= (4 * 4 * 60) / bpm) return { at: snapped, onDownbeat: true };
    }
    return { at, onDownbeat: false };
  }

  // Mean-square level of the last SILENCE_READINGS polls (~1.6 s). Three
  // 12 ms snapshots used to be enough to "detect silence" in the gaps of a
  // sparse breakdown and start an unsynced mix early.
  const silenceLevelsRef = useRef<number[]>([]);

  useEffect(() => {
    if (!djMode) return;

    const check = () => {
      const audio = getActiveAudio();
      if (!audio || audio.paused || !isFinite(audio.duration)) return;
      const next = nextSongRef.current;
      if (crossfadeStartedRef.current || !next) return;

      const cue = cueOutFor(audio);
      const remaining = audio.duration - audio.currentTime;

      if (audio.currentTime >= cue.at - PRELOAD_LEAD && preloadRef.current?.songId !== next.id) {
        preload(next);
      }

      if (audio.currentTime >= cue.at - SCHEDULE_LEAD && remaining > 0) {
        crossfadeStartedRef.current = true;
        // The 200 ms poll is too coarse to land on a beat; time the start exactly.
        const delay = Math.max(0, (cue.at - audio.currentTime) / audio.playbackRate);
        startTimerRef.current = window.setTimeout(() => {
          startTimerRef.current = null;
          startCrossfade(cue.at, cue.onDownbeat);
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
  }, [djMode, getActiveAudio]);

  // `target`: the outgoing time this start was timed to (null: start now, e.g.
  // silence detected). `onDownbeat`: target is a downbeat, so beat-sync.
  function startCrossfade(target: number | null, onDownbeat: boolean) {
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

    const inAnchor = preloadRef.current?.anchor ?? null;
    const sync: BeatSync | null =
      anchor !== null && inAnchor !== null && match && outBpm && inBpm &&
      (outTrack?.confidence ?? 0) >= MIN_CONFIDENCE && (inTrack?.confidence ?? 0) >= MIN_CONFIDENCE
        ? { outAnchor: anchor, inAnchor, outBeat: 60 / outBpm, inBeat: 60 / (inBpm * match.factor), outRate }
        : null;

    const plan = planTransition(
      shapeOf(outTrack, currentDetailRef.current, outBpm, outgoing.duration),
      shapeOf(inTrack, nextDetailRef.current, inBpm, incoming.duration),
      match, outgoing.currentTime, inAnchor ?? 0,
    );
    const fadeLen = plan.seconds;
    const bar = outBpm ? 240 / outBpm : fadeLen / 8;
    const curves = buildCrossfadeCurves(CURVE_POINTS, plan.swapStart, plan.swapEnd);
    setMixLabel(plan.bars ? `MIX ${plan.bars} BAR${plan.bars > 1 ? "S" : ""}` : "CROSSFADING");
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
    if (pauseTimerRef.current) {
      // Pressed play while a pause was fading out: just fade back up.
      clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = null;
      setPlaying(true);
      rampUp(FADE_PAUSE_S);
      return;
    }
    const fade = !fadeRef.current && audio.paused && fadeable();
    if (fade) setParam(decksRef.current[activeDeckRef.current]!.fader.gain, 0);
    audio.play().then(() => { if (fade) rampUp(FADE_PAUSE_S); })
      .catch(() => { if (fade) resetStrip(activeDeckRef.current, 1); });
    if (fadeRef.current) audioFor(fadeRef.current.inDeck)?.play().catch(() => {});
  }

  function pauseAll() {
    const active = getActiveAudio();
    if (active && !active.paused && !fadeRef.current && !pauseTimerRef.current && rampActiveFader(0, FADE_PAUSE_S)) {
      // Fade out on the audio thread, then pause the element once it is silent.
      const deck = activeDeckRef.current;
      setPlaying(false); // the button flips now; the element pauses once it is silent
      pauseTimerRef.current = window.setTimeout(() => {
        pauseTimerRef.current = null;
        audioFor(deck)?.pause();
      }, FADE_PAUSE_S * 1000 + 20);
      return;
    }
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
    if (audio.paused || pauseTimerRef.current) playRef.current();
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
    const target = ratio * duration;
    if (!fadeRef.current && !audio.paused && !pauseTimerRef.current && rampActiveFader(0, FADE_SEEK_OUT_S)) {
      // Mute, jump while silent, fade back in: a jump in a playing stream clicks.
      cancelPendingFades();
      const deck = activeDeckRef.current;
      seekRef.current = {
        deck, target,
        timer: window.setTimeout(() => {
          seekRef.current = null;
          const a = audioFor(deck);
          if (a) a.currentTime = target;
          if (activeDeckRef.current === deck) rampUp(FADE_SEEK_IN_S);
        }, FADE_SEEK_OUT_S * 1000 + 10),
      };
      setCurrentTime(target);
      return;
    }
    audio.currentTime = target;
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
            className={`${styles.djToggle} ${djMode ? styles.djActive : ""}`}
            onClick={onDjModeToggle}
            aria-pressed={djMode}
          >
            Crossfade
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
