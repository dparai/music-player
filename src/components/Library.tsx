import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type { SubsonicSong, SubsonicCredentials } from "@/lib/subsonic";
import { coverArtUrl } from "@/lib/subsonic";
import styles from "./Library.module.css";

interface Props {
  songs: SubsonicSong[];
  creds: SubsonicCredentials;
  currentSongId: string | null;
  onPlay: (song: SubsonicSong, queue: SubsonicSong[]) => void;
  onPlayNext: (song: SubsonicSong) => void;
  onAddToQueue: (song: SubsonicSong) => void;
}

type SortKey = "title" | "artist" | "album" | "created";

const ITEM_HEIGHT = 64;
const OVERSCAN = 5;

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Library({ songs, creds, currentSongId, onPlay, onPlayNext, onAddToQueue }: Props) {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("title");
  const [scrollTop, setScrollTop] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ song: SubsonicSong; x: number; y: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

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

  // Group by first letter when sorted by title
  const letterGroups = useMemo(() => {
    if (sortBy !== "title") return null;
    const groups: { letter: string; startIndex: number }[] = [];
    let last = "";
    filtered.forEach((s, i) => {
      const first = (s.title[0] ?? "#").toUpperCase();
      const letter = /[A-Z]/.test(first) ? first : "#";
      if (letter !== last) {
        groups.push({ letter, startIndex: i });
        last = letter;
      }
    });
    return groups;
  }, [filtered, sortBy]);

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

  useEffect(() => {
    if (!contextMenu) return;
    function close() { setContextMenu(null); }
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  function showToast(msg: string) {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }

  function handleMore(e: React.MouseEvent, song: SubsonicSong) {
    e.stopPropagation();
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const menuW = 170;
    const menuH = 90;
    const x = Math.min(rect.right, window.innerWidth - menuW - 8);
    const y = rect.bottom + menuH > window.innerHeight ? rect.top - menuH - 4 : rect.bottom + 4;
    setContextMenu({ song, x, y });
  }

  function handlePlayNext(song: SubsonicSong) {
    onPlayNext(song);
    showToast(`Play Next: ${song.title}`);
    setContextMenu(null);
  }

  function handleAddToQueue(song: SubsonicSong) {
    onAddToQueue(song);
    showToast(`Added to Queue: ${song.title}`);
    setContextMenu(null);
  }

  // Find which letter badge should appear before a visible item
  function getLetterBadge(globalIndex: number): string | null {
    if (!letterGroups) return null;
    const group = letterGroups.find((g) => g.startIndex === globalIndex);
    return group?.letter ?? null;
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h2 className={styles.title}>Library</h2>
        <button className={styles.logoutBtn} onClick={() => {
          // Logout handled by parent, but we expose via a custom event
          window.dispatchEvent(new CustomEvent("brook-logout"));
        }}>
          Log out
        </button>
      </div>

      <div className={styles.searchRow}>
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
          <option value="title">A-Z</option>
          <option value="artist">Artist</option>
          <option value="album">Album</option>
          <option value="created">Date Added</option>
        </select>
      </div>

      <p className={styles.count}>{filtered.length} songs</p>

      <div className={styles.list} ref={containerRef}>
        <div style={{ height: filtered.length * ITEM_HEIGHT, position: "relative" }}>
          {visibleSongs.map((song, i) => {
            const globalIndex = startIndex + i;
            const badge = getLetterBadge(globalIndex);
            return (
              <div
                key={song.id}
                className={styles.rowWrap}
                style={{ position: "absolute", top: globalIndex * ITEM_HEIGHT, height: ITEM_HEIGHT }}
              >
                {badge && <div className={styles.letterBadge}>{badge}</div>}
                <button
                  className={`${styles.row} ${song.id === currentSongId ? styles.active : ""}`}
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
                    <span className={styles.songTitle}>{song.title}</span>
                    <span className={styles.meta}>{song.artist ?? "Unknown"}</span>
                  </div>
                  <span className={styles.duration}>{formatDuration(song.duration)}</span>
                </button>
                <button
                  className={styles.moreBtn}
                  onClick={(e) => handleMore(e, song)}
                  aria-label="More options"
                >
                  &#8942;
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {contextMenu && (
        <div
          className={styles.ctxMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className={styles.ctxOption} onClick={() => handlePlayNext(contextMenu.song)}>
            &#9654; Play Next
          </button>
          <button className={styles.ctxOption} onClick={() => handleAddToQueue(contextMenu.song)}>
            + Add to Queue
          </button>
        </div>
      )}

      {toast && <div className={styles.toast}>{toast}</div>}
    </div>
  );
}
