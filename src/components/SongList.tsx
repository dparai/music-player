import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type { SubsonicSong, SubsonicCredentials } from "@/lib/subsonic";
import { coverArtUrl } from "@/lib/subsonic";
import styles from "./SongList.module.css";

interface Props {
  songs: SubsonicSong[];
  creds: SubsonicCredentials;
  currentSongId: string | null;
  onPlay: (song: SubsonicSong, queue: SubsonicSong[]) => void;
}

type SortKey = "title" | "artist" | "album" | "created";

const ITEM_HEIGHT = 64;
const OVERSCAN = 5;

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function SongList({ songs, creds, currentSongId, onPlay }: Props) {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("title");
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    let list = songs;
    if (query) {
      const q = query.toLowerCase();
      list = list.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.artist?.toLowerCase().includes(q) ||
          s.album?.toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => {
      const av = a[sortBy] ?? "";
      const bv = b[sortBy] ?? "";
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv);
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
  }, [songs, query, sortBy]);

  const containerHeight = containerRef.current?.clientHeight ?? 600;
  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(filtered.length, Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + OVERSCAN);
  const visibleSongs = filtered.slice(startIndex, endIndex);

  const handleScroll = useCallback(() => {
    if (containerRef.current) setScrollTop(containerRef.current.scrollTop);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <input
          className={styles.search}
          type="text"
          placeholder="Search songs, artists, albums..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className={styles.sort}
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortKey)}
        >
          <option value="title">Title</option>
          <option value="artist">Artist</option>
          <option value="album">Album</option>
          <option value="created">Date Added</option>
        </select>
      </div>

      <p className={styles.count}>{filtered.length} songs</p>

      <div className={styles.list} ref={containerRef}>
        <div style={{ height: filtered.length * ITEM_HEIGHT, position: "relative" }}>
          {visibleSongs.map((song, i) => (
            <button
              key={song.id}
              className={`${styles.row} ${song.id === currentSongId ? styles.active : ""}`}
              style={{ position: "absolute", top: (startIndex + i) * ITEM_HEIGHT, height: ITEM_HEIGHT }}
              onClick={() => onPlay(song, filtered)}
            >
              {song.coverArt ? (
                <img
                  className={styles.cover}
                  src={coverArtUrl(creds, song.coverArt, "80")}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <div className={styles.coverPlaceholder}>&#9835;</div>
              )}
              <div className={styles.info}>
                <span className={styles.title}>{song.title}</span>
                <span className={styles.meta}>
                  {song.artist ?? "Unknown"} — {song.album ?? "Unknown"}
                </span>
              </div>
              <span className={styles.duration}>{formatDuration(song.duration)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
