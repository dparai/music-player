import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { SubsonicCredentials, SubsonicSong, SongAnalysis } from "@/lib/subsonic";
import { getAllSongs, fetchAnalysis, lookupAnalysis } from "@/lib/subsonic";
import { pickNextDJ, trustedHook, type MixMode } from "@/lib/dj";
import type { AutoMixTrack } from "@/lib/automix";
import { getAutoMixTracks, findAutoMixTrack } from "@/lib/automix";
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

// DJ mode plays ~50 s per song: 20 would repeat songs within ~17 minutes.
const RECENT_HISTORY = 40;

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
  const [miniPlaying, setMiniPlaying] = useState(false);
  const [miniProgress, setMiniProgress] = useState(0);
  const togglePlayRef = useRef<(() => void) | null>(null);
  const [analysisData, setAnalysisData] = useState<Record<string, SongAnalysis>>({});
  const [autoMixTracks, setAutoMixTracks] = useState<AutoMixTrack[]>([]);
  const [mixMode, setMixMode] = useState<MixMode>("off");
  // Both Crossfade and DJ pick the next song by key/BPM and mix into it.
  const mixing = mixMode !== "off";
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
  // Key/BPM for DJ picks: the AutoMix server's (whole-track key) when it has
  // them, else analysis.json (key from the first 2 minutes only).
  const lookupSong = useCallback(
    (map: Record<string, SongAnalysis>, song: SubsonicSong): SongAnalysis | null => {
      const t = findAutoMixTrack(autoMixTracks, song);
      const hook = t ? { hookKey: t.hook_key, hookEnergy: t.hook_energy, hookTrusted: !!trustedHook(t), lang: t.lyric_lang, style: t.style } : {};
      if (t?.key && t.bpm > 0) return { bpm: t.bpm, key: t.key, ...hook };
      const a = lookupAnalysis(map, song);
      return a ? { ...a, ...hook } : null;
    },
    [autoMixTracks],
  );

  const currentAnalysis = currentSong ? lookupSong(analysisData, currentSong) : null;

  const djNextSong = useRef<SubsonicSong | null>(null);

  // DJ pick for the song after `currentSongId`. Excludes the current song
  // explicitly: recentIds only learns about it in an effect after render.
  const pickDJ = useCallback((): SubsonicSong | null => {
    if (songs.length === 0) return null;
    const exclude = new Set(recentIdsRef.current);
    if (currentSongId) exclude.add(currentSongId);
    if (currentAnalysis) {
      return pickNextDJ(currentAnalysis, songs, analysisData, exclude, lookupSong, mixMode === "dj");
    }
    // No key/BPM for this song: keep the mix going with a random track
    // instead of returning null, which used to stop DJ mode dead.
    let available = songs.filter((s) => !exclude.has(s.id));
    if (mixMode === "dj") {
      const hooked = available.filter((s) => lookupSong(analysisData, s)?.hookTrusted);
      if (hooked.length > 0) available = hooked;
    }
    return available.length > 0 ? available[Math.floor(Math.random() * available.length)]! : null;
  }, [songs, currentSongId, currentAnalysis, analysisData, lookupSong, mixMode]);

  const getNextSong = useCallback((): SubsonicSong | null => {
    if (playNextQueue.length > 0) return playNextQueue[0]!;
    if (mixing) {
      if (!djNextSong.current || djNextSong.current.id === currentSongId) {
        djNextSong.current = pickDJ();
      }
      return djNextSong.current;
    }
    if (currentIndex >= 0 && currentIndex < playOrder.length - 1) {
      return playOrder[currentIndex + 1]!;
    }
    if (playOrder.length > 0) return playOrder[0]!;
    return null;
  }, [playNextQueue, mixing, pickDJ, currentSongId, currentIndex, playOrder]);

  const nextSong = getNextSong();
  const nextAnalysis = nextSong ? lookupSong(analysisData, nextSong) : null;

  // A new song, or a switch between Crossfade and DJ (different picking), re-picks.
  useEffect(() => {
    djNextSong.current = null;
  }, [currentSongId, mixMode]);

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
    getAutoMixTracks().then(setAutoMixTracks).catch(() => {});
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
    setMixMode("off");
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

    if (mixing) {
      const next = djNextSong.current ?? pickDJ();
      djNextSong.current = null;
      if (next) {
        setCurrentSongId(next.id);
        return;
      }
    }

    if (currentIndex >= 0 && currentIndex < playOrder.length - 1) {
      setCurrentSongId(playOrder[currentIndex + 1]!.id);
    } else if (playOrder.length > 0) {
      setCurrentSongId(playOrder[0]!.id);
    }
  }, [playNextQueue, mixing, currentIndex, playOrder, pickDJ]);

  // A DJ crossfade finished on `song`; it is already playing, so just follow it.
  const handleAdvance = useCallback((song: SubsonicSong) => {
    setPlayNextQueue((q) => (q[0]?.id === song.id ? q.slice(1) : q));
    djNextSong.current = null;
    setCurrentSongId(song.id);
  }, []);

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

  const handlePlayingChange = useCallback((isPlaying: boolean, prog: number) => {
    setMiniPlaying(isPlaying);
    setMiniProgress(prog);
  }, []);

  function handleTogglePlay() {
    togglePlayRef.current?.();
  }

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
                mixMode={mixMode}
                onMixModeChange={setMixMode}
                shuffled={shuffled}
                onShuffleToggle={handleShuffle}
                onNext={handleNext}
                onPrev={handlePrev}
                onAdvance={handleAdvance}
                nextAnalysis={nextAnalysis}
                nextSong={nextSong}
                onPlayingChange={handlePlayingChange}
                togglePlayRef={togglePlayRef}
                autoMixTracks={autoMixTracks}
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
          playing={miniPlaying}
          progress={miniProgress}
          onToggle={handleTogglePlay}
          onClick={() => setView("nowplaying")}
        />
      )}

      <BottomNav active={view} onChange={setView} />
    </div>
  );
}
