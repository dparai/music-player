import { useState, useEffect, useCallback } from "react";
import type { SubsonicCredentials, SubsonicSong } from "@/lib/subsonic";
import { getAllSongs } from "@/lib/subsonic";
import { saveCredentials, loadCredentials, clearCredentials, saveQueue, loadQueue } from "@/lib/storage";
import { Login } from "@/components/Login";
import { SongList } from "@/components/SongList";
import { Player } from "@/components/Player";
import styles from "./App.module.css";

export function App() {
  const [creds, setCreds] = useState<SubsonicCredentials | null>(loadCredentials);
  const [songs, setSongs] = useState<SubsonicSong[]>([]);
  const [loading, setLoading] = useState(false);
  const [queue, setQueue] = useState<SubsonicSong[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);

  const currentSong = currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] ?? null : null;

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
          }
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [creds]);

  useEffect(() => {
    if (queue.length > 0) {
      saveQueue(
        queue.map((s) => s.id),
        currentIndex,
        0,
      );
    }
  }, [queue, currentIndex]);

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
  }

  const handleNext = useCallback(() => {
    setCurrentIndex((i) => (i < queue.length - 1 ? i + 1 : i));
  }, [queue.length]);

  const handlePrev = useCallback(() => {
    setCurrentIndex((i) => (i > 0 ? i - 1 : i));
  }, []);

  if (!creds) return <Login onLogin={handleLogin} />;

  return (
    <div className={styles.layout}>
      <header className={styles.topBar}>
        <h1 className={styles.logo}>Brook</h1>
        <button className={styles.logoutBtn} onClick={handleLogout}>
          Log out
        </button>
      </header>

      <main className={styles.main}>
        {loading ? (
          <p className={styles.loading}>Loading your library...</p>
        ) : (
          <SongList
            songs={songs}
            creds={creds}
            currentSongId={currentSong?.id ?? null}
            onPlay={handlePlay}
          />
        )}
      </main>

      <Player
        song={currentSong}
        queue={queue}
        currentIndex={currentIndex}
        creds={creds}
        onNext={handleNext}
        onPrev={handlePrev}
      />
    </div>
  );
}
