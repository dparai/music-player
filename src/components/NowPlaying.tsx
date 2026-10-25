import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import type { SubsonicSong, SubsonicCredentials, SongAnalysis } from "@/lib/subsonic";
import { streamUrl, coverArtUrl } from "@/lib/subsonic";
import { CROSSFADE_DURATION, bpmRatio } from "@/lib/dj";
import styles from "./NowPlaying.module.css";

interface Props {
  song: SubsonicSong | null;
  queue: SubsonicSong[];
  currentIndex: number;
  creds: SubsonicCredentials;
  analysis: SongAnalysis | null;
  djMode: boolean;
  onDjModeToggle: () => void;
  onNext: () => void;
  onPrev: () => void;
  onQueueRemove: (index: number) => void;
  onQueueReorder: (from: number, to: number) => void;
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
  song, queue, currentIndex, creds, analysis,
  djMode, onDjModeToggle, onNext, onPrev,
  onQueueRemove, onQueueReorder,
  nextAnalysis, nextSong,
}: Props) {
  const audioARef = useRef<HTMLAudioElement>(null);
  const audioBRef = useRef<HTMLAudioElement>(null);
  const [activeDeck, setActiveDeck] = useState<"A" | "B">("A");
  const activeDeckRef = useRef<"A" | "B">("A");
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showQueue, setShowQueue] = useState(false);
  const [crossfading, setCrossfading] = useState(false);
  const waveformRef = useRef<HTMLDivElement>(null);
  const crossfadeTimerRef = useRef<number | null>(null);
  const crossfadeStartedRef = useRef(false);
  const lastSongIdRef = useRef<string | null>(null);

  const waveformBars = useMemo(() => {
    return Array.from({ length: 60 }, () => 10 + Math.random() * 35);
  }, [song?.id]);

  const getActiveAudio = useCallback(() => {
    return activeDeckRef.current === "A" ? audioARef.current : audioBRef.current;
  }, []);

  const getInactiveAudio = useCallback(() => {
    return activeDeckRef.current === "A" ? audioBRef.current : audioARef.current;
  }, []);

  // Load and play the current song
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

  // Crossfade logic: monitor time and trigger crossfade near end
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

    // Load next track into inactive audio
    incoming.src = streamUrl(creds, nextSong.id);
    incoming.volume = 0;

    // Apply beat-matched playback rate
    if (analysis && nextAnalysis) {
      const rate = bpmRatio(analysis.bpm, nextAnalysis.bpm);
      incoming.playbackRate = rate;
    } else {
      incoming.playbackRate = 1;
    }

    incoming.play().catch(() => {});

    const steps = CROSSFADE_DURATION * 20; // 50ms intervals
    let step = 0;

    if (crossfadeTimerRef.current) clearInterval(crossfadeTimerRef.current);

    crossfadeTimerRef.current = window.setInterval(() => {
      step++;
      const progress = step / steps;

      // Equal-power crossfade curve
      outgoing.volume = Math.cos(progress * Math.PI / 2);
      incoming.volume = Math.sin(progress * Math.PI / 2);

      if (step >= steps) {
        clearInterval(crossfadeTimerRef.current!);
        crossfadeTimerRef.current = null;
        outgoing.pause();
        outgoing.src = "";
        incoming.volume = 1;
        incoming.playbackRate = 1; // Reset after fade complete

        // Swap active
        const newDeck = activeDeckRef.current === "A" ? "B" : "A";
        activeDeckRef.current = newDeck;
        setActiveDeck(newDeck);
        setCrossfading(false);

        // Tell App to advance
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
    // In DJ mode, crossfade handles the transition
  }

  const progress = duration > 0 ? currentTime / duration : 0;
  const coverSrc = song?.coverArt ? coverArtUrl(creds, song.coverArt, "512") : null;
  const upNext = queue.slice(currentIndex + 1);

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

      {!showQueue ? (
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
              className={styles.queueToggle}
              onClick={() => setShowQueue(true)}
            >
              Queue ({upNext.length})
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
      ) : (
        <div className={styles.queueView}>
          <div className={styles.queueHeader}>
            <button className={styles.queueBack} onClick={() => setShowQueue(false)}>&#8592;</button>
            <h2 className={styles.queueTitle}>Queue</h2>
            <span className={styles.queueCount}>
              {djMode && <span className={styles.djBadge}>DJ</span>}
              {upNext.length} songs
            </span>
          </div>

          <div className={styles.queueNow}>
            <div className={styles.queueNowLabel}>Now Playing</div>
            <div className={styles.queueNowCard}>
              {coverSrc ? (
                <img className={styles.queueNowArt} src={coverArtUrl(creds, song.coverArt!, "80")} alt="" />
              ) : (
                <div className={styles.queueNowArtPlaceholder}>&#9835;</div>
              )}
              <div className={styles.queueNowInfo}>
                <div className={styles.queueNowTitle}>{song.title}</div>
                <div className={styles.queueNowArtist}>{song.artist ?? "Unknown"}</div>
              </div>
              <div className={styles.eqBars}>
                <span /><span /><span />
              </div>
            </div>
          </div>

          <div className={styles.queueList}>
            <div className={styles.queueListLabel}>Up Next</div>
            {upNext.length === 0 && (
              <p className={styles.queueEmpty}>
                {djMode ? "DJ Mode will auto-pick the next track." : "Queue is empty. Add songs from Library."}
              </p>
            )}
            {upNext.map((s, i) => {
              const realIndex = currentIndex + 1 + i;
              return (
                <div key={`${s.id}-${realIndex}`} className={styles.queueItem}>
                  <span className={styles.queueDrag}>&#9776;</span>
                  {s.coverArt ? (
                    <img className={styles.queueItemArt} src={coverArtUrl(creds, s.coverArt, "80")} alt="" loading="lazy" />
                  ) : (
                    <div className={styles.queueItemArtPlaceholder}>&#9835;</div>
                  )}
                  <div className={styles.queueItemInfo}>
                    <div className={styles.queueItemTitle}>{s.title}</div>
                    <div className={styles.queueItemArtist}>{s.artist ?? "Unknown"}</div>
                  </div>
                  <button
                    className={styles.queueRemove}
                    onClick={() => onQueueRemove(realIndex)}
                    aria-label="Remove"
                  >
                    &times;
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
