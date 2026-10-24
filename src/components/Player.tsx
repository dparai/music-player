import { useRef, useState, useEffect, useCallback } from "react";
import type { SubsonicSong, SubsonicCredentials } from "@/lib/subsonic";
import { streamUrl, coverArtUrl } from "@/lib/subsonic";
import styles from "./Player.module.css";

interface Props {
  song: SubsonicSong | null;
  queue: SubsonicSong[];
  currentIndex: number;
  creds: SubsonicCredentials;
  onNext: () => void;
  onPrev: () => void;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Player({ song, creds, onNext, onPrev }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !song) return;

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
  }, [song, creds, onNext, onPrev]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play();
    } else {
      audio.pause();
    }
  }, []);

  function handleTimeUpdate() {
    const audio = audioRef.current;
    if (audio) setCurrentTime(audio.currentTime);
  }

  function handleLoadedMetadata() {
    const audio = audioRef.current;
    if (audio) setDuration(audio.duration);
  }

  function handleSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const audio = audioRef.current;
    if (audio) {
      audio.currentTime = Number(e.target.value);
      setCurrentTime(audio.currentTime);
    }
  }

  if (!song) return null;

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className={styles.bar}>
      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={onNext}
      />

      {song.coverArt ? (
        <img
          className={styles.cover}
          src={coverArtUrl(creds, song.coverArt, "80")}
          alt=""
        />
      ) : (
        <div className={styles.coverPlaceholder}>&#9835;</div>
      )}

      <div className={styles.info}>
        <span className={styles.title}>{song.title}</span>
        <span className={styles.artist}>{song.artist ?? "Unknown"}</span>
      </div>

      <div className={styles.controls}>
        <button className={styles.controlBtn} onClick={onPrev} aria-label="Previous">
          &#9198;
        </button>
        <button className={styles.playBtn} onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "⏸" : "▶"}
        </button>
        <button className={styles.controlBtn} onClick={onNext} aria-label="Next">
          &#9197;
        </button>
      </div>

      <div className={styles.progress}>
        <span className={styles.time}>{formatTime(currentTime)}</span>
        <div className={styles.sliderWrap}>
          <div className={styles.sliderFill} style={{ width: `${progress}%` }} />
          <input
            className={styles.slider}
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
          />
        </div>
        <span className={styles.time}>{formatTime(duration)}</span>
      </div>
    </div>
  );
}
