import type { SubsonicSong, SubsonicCredentials } from "@/lib/subsonic";
import { coverArtUrl } from "@/lib/subsonic";
import { PlayIcon, PauseIcon, NoteIcon, SpinnerIcon } from "./icons";
import styles from "./MiniPlayer.module.css";

interface Props {
  song: SubsonicSong;
  creds: SubsonicCredentials;
  playing: boolean;
  loading: boolean; // the server is preparing the song at the chosen quality
  progress: number;
  onToggle: () => void;
  onClick: () => void;
}

export function MiniPlayer({ song, creds, playing, loading, progress, onToggle, onClick }: Props) {
  return (
    <div
      className={styles.bar}
      role="button"
      tabIndex={0}
      aria-label={`Open player: ${song.title}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {song.coverArt ? (
        <img className={styles.art} src={coverArtUrl(creds, song.coverArt, "96")} alt="" />
      ) : (
        <div className={styles.artPlaceholder}><NoteIcon size={20} /></div>
      )}
      <div className={styles.info}>
        <div className={styles.title}>{song.title}</div>
        <div className={styles.artist}>{song.artist ?? "Unknown artist"}</div>
      </div>
      <button
        className={styles.playBtn}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        aria-label={loading ? "Loading song" : playing ? "Pause" : "Play"}
        aria-busy={loading}
      >
        {loading ? <SpinnerIcon size={22} /> : playing ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
      </button>
      <div className={styles.progress} style={{ transform: `scaleX(${progress})` }} />
    </div>
  );
}
