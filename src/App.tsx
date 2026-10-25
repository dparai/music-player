import { useState, useEffect, useCallback, useRef } from "react";
import type { SubsonicCredentials, SubsonicSong, SongAnalysis } from "@/lib/subsonic";
import { getAllSongs, fetchAnalysis, lookupAnalysis } from "@/lib/subsonic";
import { pickNextDJ } from "@/lib/dj";
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

const RECENT_HISTORY = 20;

export function App() {
  const [creds, setCreds] = useState<SubsonicCredentials | null>(loadCredentials);
  const [songs, setSongs] = useState<SubsonicSong[]>([]);
  const [loading, setLoading] = useState(false);
  const [queue, setQueue] = useState<SubsonicSong[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [view, setView] = useState<View>(() => (loadView() as View) ?? "nowplaying");
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [analysisData, setAnalysisData] = useState<Record<string, SongAnalysis>>({});
  const [djMode, setDjMode] = useState(false);
  const recentIdsRef = useRef<Set<string>>(new Set());

  const currentSong = currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] ?? null : null;
  const currentAnalysis = currentSong ? lookupAnalysis(analysisData, currentSong) : null;

  // Compute next song and its analysis for crossfade
  const nextSongInQueue = currentIndex >= 0 && currentIndex < queue.length - 1 ? queue[currentIndex + 1]! : null;

  // In DJ mode with no queued next song, pre-pick one
  const djNextSong = useRef<SubsonicSong | null>(null);

  // Determine the actual next song (queued or DJ-picked)
  const getNextSong = useCallback((): SubsonicSong | null => {
    if (nextSongInQueue) return nextSongInQueue;
    if (!djMode || !currentAnalysis || songs.length === 0) return null;

    if (!djNextSong.current) {
      djNextSong.current = pickNextDJ(
        currentAnalysis, songs, analysisData, recentIdsRef.current, lookupAnalysis,
      );
    }
    return djNextSong.current;
  }, [nextSongInQueue, djMode, currentAnalysis, songs, analysisData]);

  const nextSong = getNextSong();
  const nextAnalysis = nextSong ? lookupAnalysis(analysisData, nextSong) : null;

  // Clear DJ pre-pick when song changes
  useEffect(() => {
    djNextSong.current = null;
  }, [currentSong?.id]);

  // Track recently played
  useEffect(() => {
    if (currentSong) {
      recentIdsRef.current.add(currentSong.id);
      if (recentIdsRef.current.size > RECENT_HISTORY) {
        const first = recentIdsRef.current.values().next().value;
        if (first) recentIdsRef.current.delete(first);
      }
    }
  }, [currentSong]);

  useEffect(() => {
    if (!creds) return;
    setLoading(true);
    fetchAnalysis().then(setAnalysisData).catch(() => {});
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
    setDjMode(false);
  }

  function handlePlay(song: SubsonicSong, songList: SubsonicSong[]) {
    setQueue(songList);
    setCurrentIndex(songList.findIndex((s) => s.id === song.id));
    setView("nowplaying");
  }

  const handleNext = useCallback(() => {
    if (djMode && currentIndex >= queue.length - 1) {
      // No more queued songs — DJ auto-picks
      const picked = djNextSong.current;
      if (picked) {
        setQueue((prev) => [...prev, picked]);
        setCurrentIndex((i) => i + 1);
        djNextSong.current = null;
        return;
      }
      // Fallback: pick now
      if (currentAnalysis && songs.length > 0) {
        const next = pickNextDJ(currentAnalysis, songs, analysisData, recentIdsRef.current, lookupAnalysis);
        if (next) {
          setQueue((prev) => [...prev, next]);
          setCurrentIndex((i) => i + 1);
          return;
        }
      }
    }
    setCurrentIndex((i) => (i < queue.length - 1 ? i + 1 : i));
  }, [queue.length, djMode, currentIndex, currentAnalysis, songs, analysisData]);

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
    const audios = document.querySelectorAll("audio");
    for (const audio of audios) {
      if (audio.src && !audio.paused) {
        audio.pause();
        return;
      }
    }
    for (const audio of audios) {
      if (audio.src) {
        audio.play();
        return;
      }
    }
  }

  // Poll audio state for mini player (find the active audio)
  useEffect(() => {
    const interval = setInterval(() => {
      const audios = document.querySelectorAll("audio");
      for (const audio of audios) {
        if (audio.src && audio.duration > 0) {
          setPlaying(!audio.paused);
          setProgress(audio.currentTime / audio.duration);
          break;
        }
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
                analysis={currentAnalysis}
                djMode={djMode}
                onDjModeToggle={() => setDjMode((d) => !d)}
                onNext={handleNext}
                onPrev={handlePrev}
                onQueueRemove={handleQueueRemove}
                onQueueReorder={handleQueueReorder}
                nextAnalysis={nextAnalysis}
                nextSong={nextSong}
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
