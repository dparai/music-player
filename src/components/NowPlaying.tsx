import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import type { SubsonicSong, SubsonicCredentials, SongAnalysis } from "@/lib/subsonic";
import { streamUrl, coverArtUrl } from "@/lib/subsonic";
import { CROSSFADE_DURATION, bpmRatio } from "@/lib/dj";
import styles from "./NowPlaying.module.css";

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
  nextAnalysis: SongAnalysis | null;
  nextSong: SubsonicSong | null;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function NowPlaying({
  song, creds, analysis,
  djMode, onDjModeToggle,
  shuffled, onShuffleToggle,
  onNext, onPrev,
  nextAnalysis, nextSong,
}: Props) {
  const audioARef = useRef<HTMLAudioElement>(null);
  const audioBRef = useRef<HTMLAudioElement>(null);
  const [activeDeck, setActiveDeck] = useState<"A" | "B">("A");
  const activeDeckRef = useRef<"A" | "B">("A");
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [crossfading, setCrossfading] = useState(false);
  const waveformRef = useRef<HTMLDivElement>(null);
  const crossfadeTimerRef = useRef<number | null>(null);
  const crossfadeStartedRef = useRef(false);
  const lastSongIdRef = useRef<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodesRef = useRef<{ A?: MediaElementAudioSourceNode; B?: MediaElementAudioSourceNode }>({});
  const filtersRef = useRef<{ A?: BiquadFilterNode; B?: BiquadFilterNode }>({});

  function ensureAudioGraph(deck: "A" | "B") {
    const audio = deck === "A" ? audioARef.current : audioBRef.current;
    if (!audio || sourceNodesRef.current[deck]) return;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    const ctx = audioCtxRef.current;
    const source = ctx.createMediaElementSource(audio);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowshelf";
    filter.frequency.value = 200;
    filter.gain.value = 0;
    source.connect(filter).connect(ctx.destination);
    sourceNodesRef.current[deck] = source;
    filtersRef.current[deck] = filter;
  }

  const waveformBars = useMemo(() => {
    return Array.from({ length: 60 }, () => 10 + Math.random() * 35);
  }, [song?.id]);

  const getActiveAudio = useCallback(() => {
    return activeDeckRef.current === "A" ? audioARef.current : audioBRef.current;
  }, []);

  const getInactiveAudio = useCallback(() => {
    return activeDeckRef.current === "A" ? audioBRef.current : audioARef.current;
  }, []);

  useEffect(() => {
    if (!song || song.id === lastSongIdRef.current) return;
    lastSongIdRef.current = song.id;

    const audio = getActiveAudio();
    if (!audio) return;

    crossfadeStartedRef.current = false;
    audio.volume = 1;
    audio.playbackRate = 1;
    audio.src = streamUrl(creds, song.id);
    audio.play().then(() => setPlaying(true)).catch(() => {});

    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist ?? "Unknown",
        album: song.album ?? "Unknown",
        artwork: song.coverArt
          ? [{ src: coverArtUrl(creds, song.coverArt, "512"), sizes: "512x512", type: "image/jpeg" }]
          : [],
      });
      navigator.mediaSession.setActionHandler("play", () => audio.play());
      navigator.mediaSession.setActionHandler("pause", () => audio.pause());
      navigator.mediaSession.setActionHandler("previoustrack", onPrev);
      navigator.mediaSession.setActionHandler("nexttrack", onNext);
    }
  }, [song, creds, onNext, onPrev, getActiveAudio]);

  useEffect(() => {
    if (!djMode) return;

    const check = () => {
      const audio = getActiveAudio();
      if (!audio || audio.paused || !isFinite(audio.duration)) return;

      const remaining = audio.duration - audio.currentTime;

      if (remaining <= CROSSFADE_DURATION && remaining > 0 && !crossfadeStartedRef.current && nextSong) {
        crossfadeStartedRef.current = true;
        startCrossfade();
      }
    };

    const interval = setInterval(check, 200);
    return () => clearInterval(interval);
  }, [djMode, nextSong, getActiveAudio, getInactiveAudio]);

  function startCrossfade() {
    const outgoing = getActiveAudio();
    const incoming = getInactiveAudio();
    if (!outgoing || !incoming || !nextSong) return;

    setCrossfading(true);

    const outDeck = activeDeckRef.current;
    const inDeck = outDeck === "A" ? "B" : "A";
    ensureAudioGraph(outDeck);
    ensureAudioGraph(inDeck);

    incoming.src = streamUrl(creds, nextSong.id);
    incoming.volume = 0;

    if (analysis && nextAnalysis) {
      const rate = bpmRatio(analysis.bpm, nextAnalysis.bpm);
      incoming.playbackRate = rate;
    } else {
      incoming.playbackRate = 1;
    }

    const outFilter = filtersRef.current[outDeck];
    const inFilter = filtersRef.current[inDeck];
    if (outFilter) outFilter.gain.value = 0;
    if (inFilter) inFilter.gain.value = -40;

    if (audioCtxRef.current?.state === "suspended") {
      audioCtxRef.current.resume();
    }

    incoming.play().catch(() => {});

    const steps = CROSSFADE_DURATION * 20;
    let step = 0;

    if (crossfadeTimerRef.current) clearInterval(crossfadeTimerRef.current);

    crossfadeTimerRef.current = window.setInterval(() => {
      step++;
      const progress = step / steps;

      outgoing.volume = Math.cos(progress * Math.PI / 2);
      incoming.volume = Math.sin(progress * Math.PI / 2);

      if (outFilter) outFilter.gain.value = -40 * progress;
      if (inFilter) inFilter.gain.value = -40 * (1 - progress);

      if (step >= steps) {
        clearInterval(crossfadeTimerRef.current!);
        crossfadeTimerRef.current = null;
        outgoing.pause();
        outgoing.src = "";
        incoming.volume = 1;
        incoming.playbackRate = 1;
        if (outFilter) outFilter.gain.value = 0;
        if (inFilter) inFilter.gain.value = 0;

        const newDeck = activeDeckRef.current === "A" ? "B" : "A";
        activeDeckRef.current = newDeck;
        setActiveDeck(newDeck);
        setCrossfading(false);

        onNext();
      }
    }, 50);
  }

  const togglePlay = useCallback(() => {
    const audio = getActiveAudio();
    if (!audio) return;
    if (audio.paused) audio.play();
    else audio.pause();
  }, [getActiveAudio]);

  function handleTimeUpdate() {
    const audio = getActiveAudio();
    if (audio) setCurrentTime(audio.currentTime);
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
    audio.currentTime = ratio * duration;
    setCurrentTime(audio.currentTime);
  }

  function handleEnded() {
    if (!djMode) {
      onNext();
    }
  }

  const progress = duration > 0 ? currentTime / duration : 0;
  const coverSrc = song?.coverArt ? coverArtUrl(creds, song.coverArt, "512") : null;

  if (!song) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>&#9835;</div>
        <p className={styles.emptyText}>No song playing</p>
        <p className={styles.emptyHint}>Go to Library and pick a song</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <audio
        ref={audioARef}
        onTimeUpdate={activeDeck === "A" ? handleTimeUpdate : undefined}
        onLoadedMetadata={activeDeck === "A" ? handleLoadedMetadata : undefined}
        onPlay={activeDeck === "A" ? () => setPlaying(true) : undefined}
        onPause={activeDeck === "A" ? () => setPlaying(false) : undefined}
        onEnded={activeDeck === "A" ? handleEnded : undefined}
      />
      <audio
        ref={audioBRef}
        onTimeUpdate={activeDeck === "B" ? handleTimeUpdate : undefined}
        onLoadedMetadata={activeDeck === "B" ? handleLoadedMetadata : undefined}
        onPlay={activeDeck === "B" ? () => setPlaying(true) : undefined}
        onPause={activeDeck === "B" ? () => setPlaying(false) : undefined}
        onEnded={activeDeck === "B" ? handleEnded : undefined}
      />

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
            {crossfading && <span className={styles.crossfadeLabel}>CROSSFADING</span>}
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
          {analysis && (
            <>
              {" "}&middot; {analysis.bpm} BPM &middot; {analysis.key}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
