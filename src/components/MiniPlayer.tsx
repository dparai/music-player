import type { SubsonicSong, SubsonicCredentials } from "@/lib/subsonic";
import { coverArtUrl } from "@/lib/subsonic";
import styles from "./MiniPlayer.module.css";

interface Props {
  song: SubsonicSong;
  creds: SubsonicCredentials;
  playing: boolean;
  progress: number;
  onToggle: () => void;
  onClick: () => void;
}

export function MiniPlayer({ song, creds, playing, progress, onToggle, onClick }: Props) {
  return (
    <div className={styles.bar} onClick={onClick}>
      {song.coverArt ? (
        <img className={styles.art} src={coverArtUrl(creds, song.coverArt, "80")} alt="" />
      ) : (
        <div className={styles.artPlaceholder}>&#9835;</div>
      )}
      <div className={styles.info}>
        <div className={styles.title}>{song.title}</div>
        <div className={styles.artist}>{song.artist ?? "Unknown"}</div>
      </div>
      <button
        className={styles.playBtn}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? (
          <span className={styles.pauseIcon}><span /><span /></span>
        ) : "▶"}
      </button>
      <div className={styles.progress} style={{ width: `${progress * 100}%` }} />
    </div>
  );
}
