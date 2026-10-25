import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { SubsonicCredentials, SubsonicSong, SongAnalysis } from "@/lib/subsonic";
import { getAllSongs, fetchAnalysis, lookupAnalysis } from "@/lib/subsonic";
import { pickNextDJ } from "@/lib/dj";
import {
  saveCredentials, loadCredentials, clearCredentials,
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

function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export function App() {
  const [creds, setCreds] = useState<SubsonicCredentials | null>(loadCredentials);
  const [songs, setSongs] = useState<SubsonicSong[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<View>(() => (loadView() as View) ?? "nowplaying");
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [analysisData, setAnalysisData] = useState<Record<string, SongAnalysis>>({});
  const [djMode, setDjMode] = useState(false);
  const [shuffled, setShuffled] = useState(false);
  const [currentSongId, setCurrentSongId] = useState<string | null>(null);
  const [playNextQueue, setPlayNextQueue] = useState<SubsonicSong[]>([]);
  const recentIdsRef = useRef<Set<string>>(new Set());
  const lastShuffleRef = useRef<string[] | null>(null);

  const sortedSongs = useMemo(() =>
    [...songs].sort((a, b) => a.title.localeCompare(b.title)),
  [songs]);

  const [shuffledSongs, setShuffledSongs] = useState<SubsonicSong[]>([]);

  const playOrder = shuffled ? shuffledSongs : sortedSongs;

  const currentIndex = useMemo(() => {
    if (!currentSongId) return -1;
    return playOrder.findIndex((s) => s.id === currentSongId);
  }, [currentSongId, playOrder]);

  const currentSong = currentIndex >= 0 ? playOrder[currentIndex] ?? null : null;
  const currentAnalysis = currentSong ? lookupAnalysis(analysisData, currentSong) : null;

  const djNextSong = useRef<SubsonicSong | null>(null);

  const getNextSong = useCallback((): SubsonicSong | null => {
    if (playNextQueue.length > 0) return playNextQueue[0]!;
    if (djMode) {
      if (!currentAnalysis || songs.length === 0) return null;
      if (!djNextSong.current) {
        djNextSong.current = pickNextDJ(
          currentAnalysis, songs, analysisData, recentIdsRef.current, lookupAnalysis,
        );
      }
      return djNextSong.current;
    }
    if (currentIndex >= 0 && currentIndex < playOrder.length - 1) {
      return playOrder[currentIndex + 1]!;
    }
    if (playOrder.length > 0) return playOrder[0]!;
    return null;
  }, [playNextQueue, djMode, currentAnalysis, songs, analysisData, currentIndex, playOrder]);

  const nextSong = getNextSong();
  const nextAnalysis = nextSong ? lookupAnalysis(analysisData, nextSong) : null;

  useEffect(() => {
    djNextSong.current = null;
  }, [currentSongId]);

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
        const lastId = loadLastPlayed();
        if (lastId && s.find((song) => song.id === lastId)) {
          setCurrentSongId(lastId);
        } else if (s.length > 0) {
          setCurrentSongId(s[0]!.id);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [creds]);

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
    setCurrentSongId(null);
    setPlayNextQueue([]);
    setDjMode(false);
    setShuffled(false);
  }

  function handlePlay(song: SubsonicSong) {
    setCurrentSongId(song.id);
    setView("nowplaying");
  }

  const handleNext = useCallback(() => {
    if (playNextQueue.length > 0) {
      const next = playNextQueue[0]!;
      setPlayNextQueue((q) => q.slice(1));
      setCurrentSongId(next.id);
      return;
    }

    if (djMode) {
      const picked = djNextSong.current;
      if (picked) {
        djNextSong.current = null;
        setCurrentSongId(picked.id);
        return;
      }
      if (currentAnalysis && songs.length > 0) {
        const next = pickNextDJ(currentAnalysis, songs, analysisData, recentIdsRef.current, lookupAnalysis);
        if (next) {
          setCurrentSongId(next.id);
          return;
        }
      }
    }

    if (currentIndex >= 0 && currentIndex < playOrder.length - 1) {
      setCurrentSongId(playOrder[currentIndex + 1]!.id);
    } else if (playOrder.length > 0) {
      setCurrentSongId(playOrder[0]!.id);
    }
  }, [playNextQueue, djMode, currentIndex, playOrder, currentAnalysis, songs, analysisData]);

  const handlePrev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentSongId(playOrder[currentIndex - 1]!.id);
    } else if (playOrder.length > 0) {
      setCurrentSongId(playOrder[playOrder.length - 1]!.id);
    }
  }, [currentIndex, playOrder]);

  function handlePlayNext(song: SubsonicSong) {
    setPlayNextQueue((q) => {
      const filtered = q.filter((s) => s.id !== song.id);
      return [song, ...filtered];
    });
  }

  function handleShuffle() {
    if (shuffled) {
      setShuffled(false);
      setShuffledSongs([]);
      lastShuffleRef.current = null;
    } else {
      let newOrder = shuffleArray(sortedSongs);
      if (lastShuffleRef.current && newOrder.length > 1) {
        const lastOrder = lastShuffleRef.current;
        const isSame = newOrder.every((s, i) => s.id === lastOrder[i]);
        if (isSame) newOrder = shuffleArray(sortedSongs);
      }
      lastShuffleRef.current = newOrder.map((s) => s.id);
      setShuffledSongs(newOrder);
      setShuffled(true);
    }
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
                creds={creds}
                analysis={currentAnalysis}
                djMode={djMode}
                onDjModeToggle={() => setDjMode((d) => !d)}
                shuffled={shuffled}
                onShuffleToggle={handleShuffle}
                onNext={handleNext}
                onPrev={handlePrev}
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
