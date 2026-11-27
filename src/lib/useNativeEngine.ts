import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SubsonicCredentials, SubsonicSong } from "./subsonic";
import type { Quality } from "./quality";
import { streamFormat } from "./quality";
import { BrookPlayer, type NativeState } from "./native";
import { toNativeItem } from "./nativeItem";
import { nativeQueue, sameQueue } from "./nativeQueue";
import { diag } from "./diag";
import { findAutoMixTrack, getAutoMixTrack, type AutoMixTrack } from "./automix";
import { planPair, type NativePlan } from "./mixPlan";
import { autoPreampDb, type SoundSettings } from "./sound";
import { downloadsVersion, isDownloaded, subscribeDownloads } from "./downloads";

interface Options {
  enabled: boolean;
  song: SubsonicSong | null;
  before: SubsonicSong[];
  after: SubsonicSong[];
  creds: SubsonicCredentials;
  quality: Quality;
  findSong: (id: string) => SubsonicSong | undefined;
  // The server's measured loudness for a song, when it has one.
  lufsOf?: (song: SubsonicSong) => number | null | undefined;
  onAdvance: (song: SubsonicSong) => void;
  setPlaying: (v: boolean) => void;
  setPreparing: (v: boolean) => void;
  setCurrentTime: (s: number) => void;
  setDuration: (s: number) => void;
  onProgress: (playing: boolean, ratio: number) => void;
  sound?: SoundSettings;
  // Crossfade: on or off, the server's beat data (for the smart mix) and a callback for the mix starting/ending.
  crossfade?: boolean;
  tracks?: AutoMixTrack[];
  online?: boolean;
  onCrossfade?: (phase: "start" | "end" | "abort", smart: boolean) => void;
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
  // The queue number we last loaded. A report from the player older than it is about a queue that is
  // already gone, and following it would undo what the user just chose.
  const epoch = useRef(0);
  const isStale = (e: number | undefined) => e !== undefined && e < epoch.current;

  const itemsFor = useCallback((songs: SubsonicSong[]) => {
    const { creds, quality } = opts.current;
    return songs.map((s) => toNativeItem(s, creds, quality, streamFormat(), isDownloaded(s.id), opts.current.lufsOf?.(s)));
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

  // The equaliser, preamp and normalizing live in the native audio path: send them on start and on every change.
  useEffect(() => {
    if (!o.enabled || !o.sound) return;
    const s = o.sound;
    void BrookPlayer.setSound({ gains: s.eq, preampDb: autoPreampDb(s.eq, 48000), normalize: s.normalize }).catch(() => {});
  }, [o.enabled, o.sound?.eq.join(","), o.sound?.normalize]);

  // Crossfade on/off for the native player.
  useEffect(() => {
    if (!o.enabled) return;
    void BrookPlayer.setCrossfade({ enabled: !!o.crossfade, fadeMs: 6000 }).catch(() => {});
  }, [o.enabled, o.crossfade]);

  // Smart mixes for the next few pairs of songs, made from the server's beat data (so only online) and
  // handed to the native player, which carries them out later even with the screen off. Without a plan a
  // pair gets a plain fade.
  const planKey = o.song?.id + ">" + o.after.slice(0, 3).map((s) => s.id).join(",");
  useEffect(() => {
    if (!o.enabled || !ready) return;
    let alive = true;
    void (async () => {
      const plans: NativePlan[] = [];
      const song = opts.current.song;
      const tracks = opts.current.tracks;
      if (opts.current.crossfade && opts.current.online !== false && song && tracks) {
        const chain = [song, ...opts.current.after.slice(0, 3)];
        for (let i = 0; i < chain.length - 1 && alive; i++) {
          const out = chain[i]!, inn = chain[i + 1]!;
          const oT = findAutoMixTrack(tracks, out), iT = findAutoMixTrack(tracks, inn);
          if (!oT || !iT) continue;
          const [oD, iD] = await Promise.all([getAutoMixTrack(oT.id), getAutoMixTrack(iT.id)]);
          const plan = planPair({
            outId: out.id, inId: inn.id, outTrack: oT, outDetail: oD, inTrack: iT, inDetail: iD,
            outBpm: oT.bpm || null, inBpm: iT.bpm || null, outDuration: out.duration,
          });
          if (plan) plans.push(plan);
        }
      }
      if (alive) await BrookPlayer.setTransitionPlans({ plans }).catch(() => {});
    })();
    return () => { alive = false; };
  }, [o.enabled, ready, o.crossfade, o.online, o.tracks, planKey]);

  // Start: adopt what the native service is already playing (the app was reopened
  // while it kept playing), otherwise load the restored song paused.
  useEffect(() => {
    if (!o.enabled) return;
    let alive = true;
    const handles: { remove: () => Promise<void> }[] = [];
    void (async () => {
      handles.push(await BrookPlayer.addListener("state", (s) => { if (alive && !isStale(s.epoch)) applyState(s); }));
      handles.push(await BrookPlayer.addListener("trackChanged", (t) => { if (alive && !isStale(t.epoch)) follow(t.id); }));
      handles.push(await BrookPlayer.addListener("error", (e) => diag("native error", e)));
      handles.push(await BrookPlayer.addListener("crossfade", (e) => alive && opts.current.onCrossfade?.(e.phase, e.smart)));
      try {
        const s = await BrookPlayer.getState();
        if (!alive) return;
        if (s.epoch !== undefined) epoch.current = Math.max(epoch.current, s.epoch);
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
    epoch.current += 1;
    void BrookPlayer.setQueue({ items, startIndex, play: !wasFirst, epoch: epoch.current });
  }, [o.enabled, ready, o.song?.id, itemsFor]);

  // The songs after the current one changed (Play Next, shuffle, new quality): resend them.
  // A song finishing its download changes how it should be played (from the saved file), so it is part of the key.
  const savedVersion = useSyncExternalStore(subscribeDownloads, downloadsVersion);
  const afterKey = o.after.map((s) => s.id).join(",") + "|" + o.quality + "|" + (o.song?.id ?? "") + "|" + savedVersion;
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
        if (isStale(s.epoch)) return; // made before our latest setQueue was applied
        if (s.epoch !== undefined) epoch.current = Math.max(epoch.current, s.epoch);
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
