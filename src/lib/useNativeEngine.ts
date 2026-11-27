import { useCallback, useEffect, useRef, useState } from "react";
import type { SubsonicCredentials, SubsonicSong } from "./subsonic";
import type { Quality } from "./quality";
import { streamFormat } from "./quality";
import { BrookPlayer, type NativeState } from "./native";
import { toNativeItem } from "./nativeItem";
import { nativeQueue, sameQueue } from "./nativeQueue";
import { diag } from "./diag";

interface Options {
  enabled: boolean;
  song: SubsonicSong | null;
  before: SubsonicSong[];
  after: SubsonicSong[];
  creds: SubsonicCredentials;
  quality: Quality;
  findSong: (id: string) => SubsonicSong | undefined;
  onAdvance: (song: SubsonicSong) => void;
  setPlaying: (v: boolean) => void;
  setPreparing: (v: boolean) => void;
  setCurrentTime: (s: number) => void;
  setDuration: (s: number) => void;
  onProgress: (playing: boolean, ratio: number) => void;
}

const POLL_MS = 500;

// Drives the Android player from the web UI. The native side owns playback and the
// queue (it keeps playing with the screen off); this hook only starts songs, mirrors
// the queue, and reflects the native state into the UI's React state.
export function useNativeEngine(o: Options) {
  const opts = useRef(o);
  opts.current = o;
  const nativeId = useRef<string | null>(null);   // the song the native player is on
  const queueSent = useRef<{ id: string; url?: string }[]>([]);
  const lastPos = useRef({ ms: 0, at: 0, playing: false });
  // False until we know what the native service is already playing (see below).
  const [ready, setReady] = useState(false);
  const firstRun = useRef(false);

  const itemsFor = useCallback((songs: SubsonicSong[]) => {
    const { creds, quality } = opts.current;
    return songs.map((s) => toNativeItem(s, creds, quality, streamFormat()));
  }, []);

  const applyState = useCallback((s: NativeState) => {
    const c = opts.current;
    lastPos.current = { ms: s.positionMs, at: Date.now(), playing: s.playing };
    c.setPlaying(s.playing);
    c.setPreparing(s.state === "buffering" && !s.playing);
    if (s.durationMs > 0) c.setDuration(s.durationMs / 1000);
    c.setCurrentTime(s.positionMs / 1000);
    if (s.durationMs > 0) c.onProgress(s.playing, Math.min(1, s.positionMs / s.durationMs));
  }, []);

  // The native player moved to another song (it ended, or next/previous from the
  // lock screen, a headset or the app): follow it.
  const follow = useCallback((id: string | null) => {
    nativeId.current = id;
    const c = opts.current;
    if (id && id !== c.song?.id) {
      const s = c.findSong(id);
      if (s) c.onAdvance(s);
    }
  }, []);

  // Start: adopt what the native service is already playing (the app was reopened
  // while it kept playing), otherwise load the restored song paused.
  useEffect(() => {
    if (!o.enabled) return;
    let alive = true;
    const handles: { remove: () => Promise<void> }[] = [];
    void (async () => {
      handles.push(await BrookPlayer.addListener("state", (s) => alive && applyState(s)));
      handles.push(await BrookPlayer.addListener("trackChanged", (t) => alive && follow(t.id)));
      handles.push(await BrookPlayer.addListener("error", (e) => diag("native error", e)));
      try {
        const s = await BrookPlayer.getState();
        if (!alive) return;
        if (s.id) { follow(s.id); applyState(s); }
      } catch (e) {
        diag("native getState failed", String(e));
      }
      if (alive) setReady(true);
    })();
    return () => { alive = false; handles.forEach((h) => void h.remove()); };
  }, [o.enabled, applyState, follow]);

  // A song chosen in the web UI (library tap, next/previous button, shuffle): load it with its queue.
  useEffect(() => {
    if (!o.enabled || !ready) return;
    // Only the song restored at launch is prepared without playing; later picks play.
    const wasFirst = !firstRun.current;
    firstRun.current = true;
    if (!o.song) return;
    const song = o.song;
    if (nativeId.current === song.id) return;
    const { songs, startIndex } = nativeQueue(song, opts.current.before, opts.current.after);
    const items = itemsFor(songs);
    nativeId.current = song.id;
    queueSent.current = items;
    // The first song after a launch is only prepared: the app must not start playing by itself.
    void BrookPlayer.setQueue({ items, startIndex, play: !wasFirst });
  }, [o.enabled, ready, o.song?.id, itemsFor]);

  // The songs after the current one changed (Play Next, shuffle, new quality): resend them.
  const afterKey = o.after.map((s) => s.id).join(",") + "|" + o.quality + "|" + (o.song?.id ?? "");
  useEffect(() => {
    if (!o.enabled || !ready || !o.song || nativeId.current !== o.song.id) return;
    const { songs, startIndex } = nativeQueue(o.song, opts.current.before, opts.current.after);
    const items = itemsFor(songs.slice(startIndex + 1));
    const sent = queueSent.current;
    const tail = sent.slice(sent.findIndex((x) => x.id === o.song!.id) + 1);
    if (sameQueue(tail, items)) return;
    queueSent.current = [...sent.slice(0, sent.length - tail.length), ...items];
    void BrookPlayer.setUpcoming({ currentId: o.song.id, items });
  }, [o.enabled, ready, afterKey, itemsFor]);

  // Position, while the app is on screen. Off screen the native side needs nothing from us.
  useEffect(() => {
    if (!o.enabled) return;
    let busy = false;
    const poll = async () => {
      if (document.hidden || busy) return;
      busy = true;
      try {
        const s = await BrookPlayer.getState();
        if (s.id && s.id !== nativeId.current) follow(s.id);
        applyState(s);
      } catch { /* the bridge is not ready yet */ } finally { busy = false; }
    };
    const id = setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", poll); };
  }, [o.enabled, applyState, follow]);

  return {
    play: () => void BrookPlayer.play(),
    pause: () => void BrookPlayer.pause(),
    seek: (seconds: number) => { void BrookPlayer.seekTo({ positionMs: Math.max(0, Math.round(seconds * 1000)) }); },
    // The playhead in seconds, moving smoothly between polls (for synced lyrics).
    getTime: () => {
      const p = lastPos.current;
      return (p.ms + (p.playing ? Date.now() - p.at : 0)) / 1000;
    },
  };
}
