import { useState, useMemo, useCallback, useRef, useEffect, useSyncExternalStore } from "react";
import type { SubsonicSong, SubsonicCredentials } from "@/lib/subsonic";
import { coverArtUrl } from "@/lib/subsonic";
import { SearchIcon, MoreIcon, LogoutIcon, NoteIcon, NextIcon, TrashIcon, CheckIcon } from "./icons";
import {
  subscribeDownloads, downloadsVersion, isDownloaded, downloadState, cancelQueued,
  removeDownload, removeAllDownloads, downloadsSupported, downloadedCount,
} from "@/lib/downloads";
import { DEBUG_EVENT } from "./DiagPanel";
import styles from "./Library.module.css";

interface Props {
  songs: SubsonicSong[];
  creds: SubsonicCredentials;
  online: boolean;
  currentSongId: string | null;
  onPlay: (song: SubsonicSong) => void;
  onPlayNext: (song: SubsonicSong) => void;
}

type SortKey = "title" | "artist" | "album" | "created";

const ITEM_HEIGHT = 64;
const OVERSCAN = 5;

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Five taps within three seconds on the title open the debug log.
const titleTaps: number[] = [];
function onTitleTap() {
  const now = Date.now();
  titleTaps.push(now);
  while (titleTaps.length && now - titleTaps[0]! > 3000) titleTaps.shift();
  if (titleTaps.length >= 5) { titleTaps.length = 0; window.dispatchEvent(new Event(DEBUG_EVENT)); }
}

export function Library({ songs, creds, online, currentSongId, onPlay, onPlayNext }: Props) {
  useSyncExternalStore(subscribeDownloads, downloadsVersion); // redraw when a download starts, ends or is removed
  const [onlySaved, setOnlySaved] = useState(false);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("title");
  const [scrollTop, setScrollTop] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ song: SubsonicSong; x: number; y: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const filtered = useMemo(() => {
    let list = songs;
    if (onlySaved) list = list.filter((s) => isDownloaded(s.id));
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
  }, [songs, query, sortBy, onlySaved, downloadsVersion()]);

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
    const rect = e.currentTarget.getBoundingClientRect();
    const menuW = 170;
    const menuH = 130;
    const x = Math.min(rect.right, window.innerWidth - menuW - 8);
    const y = rect.bottom + menuH > window.innerHeight ? rect.top - menuH - 4 : rect.bottom + 4;
    setContextMenu({ song, x, y });
  }

  function handlePlayNext(song: SubsonicSong) {
    onPlayNext(song);
    showToast(`Play Next: ${song.title}`);
    setContextMenu(null);
  }

  function handleRemoveDownload(song: SubsonicSong) {
    setContextMenu(null);
    void removeDownload(song.id);
    showToast(`Removed from device: ${song.title}`);
  }

  function handleRemoveAll() {
    if (!window.confirm(`Remove all ${downloadedCount()} downloaded songs from this device?`)) return;
    cancelQueued();
    void removeAllDownloads();
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
        <h2 className={styles.title} onClick={onTitleTap}>Library</h2>
        <button className={styles.logoutBtn} aria-label="Log out" onClick={() => {
          // Logout handled by parent, but we expose via a custom event
          window.dispatchEvent(new CustomEvent("brook-logout"));
        }}>
          <LogoutIcon size={20} />
        </button>
      </div>

      <div className={styles.searchRow}>
        <label className={styles.searchBox}>
          <SearchIcon size={18} />
          <input
            className={styles.search}
            type="search"
            aria-label="Search songs, artists, albums"
            placeholder="Search songs, artists, albums"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          className={styles.sort}
          aria-label="Sort by"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortKey)}
        >
          <option value="title">A-Z</option>
          <option value="artist">Artist</option>
          <option value="album">Album</option>
          <option value="created">Date Added</option>
        </select>
      </div>

      {!online && <p className={styles.offlineNote}>Offline. Showing songs saved on this device.</p>}

      <div className={styles.countRow}>
        <p className={styles.count}>{filtered.length} {filtered.length === 1 ? "song" : "songs"}</p>
        {downloadsSupported && (
          <div className={styles.dlActions}>
            {online && (
              <button
                className={`${styles.dlChip} ${onlySaved ? styles.dlChipOn : ""}`}
                aria-pressed={onlySaved}
                onClick={() => setOnlySaved((v) => !v)}
              >
                Downloaded{downloadedCount() ? ` ${downloadedCount()}` : ""}
              </button>
            )}
            {downloadedCount() > 0 && <button className={styles.dlChip} onClick={handleRemoveAll}>Remove all</button>}
          </div>
        )}
      </div>

      {filtered.length === 0 && (
        <div className={styles.empty}>
          <NoteIcon size={36} />
          <p>{query ? `No songs match "${query}"` : "Your library is empty"}</p>
        </div>
      )}

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
                  onClick={() => onPlay(song)}
                  aria-current={song.id === currentSongId ? "true" : undefined}
                >
                  {song.coverArt ? (
                    <img
                      className={styles.cover}
                      src={coverArtUrl(creds, song.coverArt, "80")}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <div className={styles.coverPlaceholder}><NoteIcon size={20} /></div>
                  )}
                  <div className={styles.info}>
                    <span className={styles.songTitle}>{song.title}</span>
                    <span className={styles.meta}>
                      {isDownloaded(song.id) && <span className={styles.saved} title="Saved on this device"><CheckIcon size={12} /> </span>}
                      {(() => {
                        const st = downloadState(song.id);
                        if (!st) return null;
                        if (st.status === "queued") return <span className={styles.dlStatus}>Waiting · </span>;
                        if (st.status === "downloading") return <span className={styles.dlStatus}>{st.pct}% · </span>;
                        return <span className={styles.dlFail}>{st.reason} · </span>;
                      })()}
                      {song.artist ?? "Unknown"}
                    </span>
                  </div>
                  <span className={styles.duration}>{formatDuration(song.duration)}</span>
                </button>
                <button
                  className={styles.moreBtn}
                  onClick={(e) => handleMore(e, song)}
                  aria-label={`More options for ${song.title}`}
                >
                  <MoreIcon size={20} />
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
            <NextIcon size={16} /> Play next
          </button>
          {downloadsSupported && isDownloaded(contextMenu.song.id) && (
            <button className={styles.ctxOption} onClick={() => handleRemoveDownload(contextMenu.song)}>
              <TrashIcon size={16} /> Remove download
            </button>
          )}
        </div>
      )}

      {toast && <div className={styles.toast}>{toast}</div>}
    </div>
  );
}
