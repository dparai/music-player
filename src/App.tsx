import { useState, useEffect, useCallback, useRef } from "react";
import type { SubsonicCredentials, SubsonicSong } from "@/lib/subsonic";
import { getAllSongs } from "@/lib/subsonic";
import {
  saveCredentials, loadCredentials, clearCredentials,
  saveQueue, loadQueue,
  saveLastPlayed, loadLastPlayed,
  saveView, loadView,
} from "@/lib/storage";
import { Login } from "@/components/Login";
import { Library } from "@/components/Library";
import { NowPlaying } from "@/components/NowPlaying";
import { MiniPlayer } from "@/components/MiniPlayer";
import { BottomNav, type View } from "@/components/BottomNav";
import styles from "./App.module.css";

export function App() {
  const [creds, setCreds] = useState<SubsonicCredentials | null>(loadCredentials);
  const [songs, setSongs] = useState<SubsonicSong[]>([]);
  const [loading, setLoading] = useState(false);
  const [queue, setQueue] = useState<SubsonicSong[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [view, setView] = useState<View>(() => (loadView() as View) ?? "nowplaying");
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const currentSong = currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] ?? null : null;

  // Expose audio state for MiniPlayer via NowPlaying's audio element
  const audioStateCallback = useRef<(() => { playing: boolean; progress: number }) | null>(null);

  useEffect(() => {
    if (!creds) return;
    setLoading(true);
    getAllSongs(creds)
      .then((s) => {
        setSongs(s);
        const saved = loadQueue();
        if (saved) {
          const restored = saved.songIds
            .map((id) => s.find((song) => song.id === id))
            .filter((x): x is SubsonicSong => !!x);
          if (restored.length > 0) {
            setQueue(restored);
            setCurrentIndex(Math.min(saved.currentIndex, restored.length - 1));
            return;
          }
        }
        // No saved queue — check last played or default to first song
        const lastId = loadLastPlayed();
        if (lastId) {
          const lastSong = s.find((song) => song.id === lastId);
          if (lastSong) {
            setQueue([lastSong]);
            setCurrentIndex(0);
            return;
          }
        }
        if (s.length > 0) {
          setQueue([s[0]!]);
          setCurrentIndex(0);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [creds]);

  useEffect(() => {
    if (queue.length > 0) {
      saveQueue(queue.map((s) => s.id), currentIndex, 0);
    }
  }, [queue, currentIndex]);

  useEffect(() => {
    if (currentSong) saveLastPlayed(currentSong.id);
  }, [currentSong]);

  useEffect(() => {
    saveView(view);
  }, [view]);

  // Listen for logout event from Library
  useEffect(() => {
    function onLogout() { handleLogout(); }
    window.addEventListener("brook-logout", onLogout);
    return () => window.removeEventListener("brook-logout", onLogout);
  }, []);

  function handleLogin(c: SubsonicCredentials) {
    saveCredentials(c);
    setCreds(c);
  }

  function handleLogout() {
    clearCredentials();
    setCreds(null);
    setSongs([]);
    setQueue([]);
    setCurrentIndex(-1);
  }

  function handlePlay(song: SubsonicSong, songList: SubsonicSong[]) {
    setQueue(songList);
    setCurrentIndex(songList.findIndex((s) => s.id === song.id));
    setView("nowplaying");
  }

  const handleNext = useCallback(() => {
    setCurrentIndex((i) => (i < queue.length - 1 ? i + 1 : i));
  }, [queue.length]);

  const handlePrev = useCallback(() => {
    setCurrentIndex((i) => (i > 0 ? i - 1 : i));
  }, []);

  function handlePlayNext(song: SubsonicSong) {
    setQueue((prev) => {
      const insertAt = currentIndex + 1;
      const filtered = prev.filter((s) => s.id !== song.id);
      return [...filtered.slice(0, insertAt), song, ...filtered.slice(insertAt)];
    });
  }

  function handleAddToQueue(song: SubsonicSong) {
    setQueue((prev) => {
      if (prev.some((s) => s.id === song.id)) return prev;
      return [...prev, song];
    });
  }

  function handleQueueRemove(index: number) {
    setQueue((prev) => {
      const next = [...prev];
      next.splice(index, 1);
      return next;
    });
    setCurrentIndex((i) => {
      if (index < i) return i - 1;
      if (index === i) return Math.min(i, queue.length - 2);
      return i;
    });
  }

  function handleQueueReorder(from: number, to: number) {
    setQueue((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  }

  function handleTogglePlay() {
    // Toggle via the audio element in NowPlaying
    const audio = document.querySelector("audio");
    if (audio) {
      if (audio.paused) audio.play();
      else audio.pause();
    }
  }

  // Poll audio state for mini player
  useEffect(() => {
    const interval = setInterval(() => {
      const audio = document.querySelector("audio");
      if (audio) {
        setPlaying(!audio.paused);
        setProgress(audio.duration > 0 ? audio.currentTime / audio.duration : 0);
      }
    }, 300);
    return () => clearInterval(interval);
  }, []);

  if (!creds) return <Login onLogin={handleLogin} />;

  return (
    <div className={styles.layout}>
      <main className={styles.main}>
        {loading ? (
          <p className={styles.loading}>Loading your library...</p>
        ) : (
          <>
            <div className={styles.view} style={{ display: view === "nowplaying" ? "flex" : "none" }}>
              <NowPlaying
                song={currentSong}
                queue={queue}
                currentIndex={currentIndex}
                creds={creds}
                onNext={handleNext}
                onPrev={handlePrev}
                onQueueRemove={handleQueueRemove}
                onQueueReorder={handleQueueReorder}
              />
            </div>
            <div className={styles.view} style={{ display: view === "library" ? "flex" : "none" }}>
              <Library
                songs={songs}
                creds={creds}
                currentSongId={currentSong?.id ?? null}
                onPlay={handlePlay}
                onPlayNext={handlePlayNext}
                onAddToQueue={handleAddToQueue}
              />
            </div>
          </>
        )}
      </main>

      {view === "library" && currentSong && creds && (
        <MiniPlayer
          song={currentSong}
          creds={creds}
          playing={playing}
          progress={progress}
          onToggle={handleTogglePlay}
          onClick={() => setView("nowplaying")}
        />
      )}

      <BottomNav active={view} onChange={setView} />
    </div>
  );
}
