// The bridge to the Android app's own player (android/.../BrookPlayerPlugin.kt).
// Inside the app, songs are played by a native service that Android keeps alive
// with the screen off; the web UI only sends it commands and shows its state.
// In a normal browser none of this exists and the web player is used.

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface NativeItem {
  id: string;
  title: string;
  artist: string;
  album: string;
  url: string;
  // The player's cache is keyed by this, not by the URL (which carries a login token).
  cacheKey: string;
  // Fetch it into the phone's cache ahead of time (false for big original files).
  prefetch: boolean;
  // Loudness trim in dB for this song (from the server's LUFS or ReplayGain tags); 0 when unknown.
  gainDb: number;
  artUrl: string | null;
  durationMs: number;
}

export type NativePlayState = "idle" | "buffering" | "ready" | "ended";

export interface NativeState {
  playing: boolean;
  state: NativePlayState;
  id: string | null;
  index: number;
  positionMs: number;
  durationMs: number;
  queueSize: number;
  queue?: string[]; // ids, in order
  epoch?: number;   // the setQueue this report belongs to (see setQueue)
}

export interface NativeTrackChange {
  id: string | null;
  index: number;
  // "auto": the previous song ended; "seek": next/previous (app, lock screen, headset); "playlist": the queue changed.
  reason: "auto" | "seek" | "playlist" | "repeat";
  epoch?: number;
}

export interface NativeError {
  message: string;
  code: number;
  id: string | null;
}

export interface NativeDownloads {
  done: string[]; // song ids saved on the phone
  active: Record<string, { status: "queued" | "downloading" | "failed"; pct?: number; reason?: string }>;
}

export interface NativeDownloadItem {
  id: string;
  url: string;      // the original file
  cacheKey: string; // "orig:<id>", the key playback reads
}

export interface NativePlanIn {
  fromId: string;
  toId: string;
  cueOutMs: number;
  inStartMs: number;
  fadeMs: number;
  rate: number;
}

export interface NativeCrossfadeEvent {
  phase: "start" | "end" | "abort";
  smart: boolean; // a beat-matched mix from a plan, not a plain fade
  fadeMs: number;
}

export interface NativeSleep {
  endsAt: number;     // epoch ms the music stops, or 0
  endOfSong: boolean; // stops when the current song ends
}

export interface BrookPlayerPlugin {
  // Replace the whole queue and start at `startIndex`.
  // `epoch` counts the queues the web UI has loaded: reports older than it are stale.
  setQueue(o: { items: NativeItem[]; startIndex: number; positionMs?: number; play: boolean; epoch: number }): Promise<void>;
  // Replace everything after the current item (the playing song is not touched). `currentId` is the
  // song the web UI thinks is playing; if the player has moved on meanwhile, the call is ignored.
  setUpcoming(o: { currentId: string; items: NativeItem[] }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(o: { positionMs: number }): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  getState(): Promise<NativeState>;
  // The equaliser (10 band gains in dB), the preamp that keeps boosts from clipping, and volume normalizing.
  setSound(o: { gains: number[]; preampDb: number; normalize: boolean }): Promise<void>;
  // Crossfade on/off and the plain-fade length; plans are the smart mixes for upcoming pairs (replaced as a set).
  setCrossfade(o: { enabled: boolean; fadeMs: number }): Promise<void>;
  setTransitionPlans(o: { plans: NativePlanIn[] }): Promise<void>;
  setSleepTimer(o: { minutes?: number; endOfSong?: boolean }): Promise<NativeSleep>;
  getSleepTimer(): Promise<NativeSleep>;
  getDownloads(): Promise<NativeDownloads>;
  download(o: { items: NativeDownloadItem[] }): Promise<void>;
  removeDownloads(o: { ids: string[] }): Promise<void>;
  removeAllDownloads(): Promise<void>;
  cancelDownloads(): Promise<void>;
  addListener(event: "state", fn: (s: NativeState) => void): Promise<PluginListenerHandle>;
  addListener(event: "trackChanged", fn: (t: NativeTrackChange) => void): Promise<PluginListenerHandle>;
  addListener(event: "error", fn: (e: NativeError) => void): Promise<PluginListenerHandle>;
  addListener(event: "downloads", fn: (d: NativeDownloads) => void): Promise<PluginListenerHandle>;
  addListener(event: "sleep", fn: (s: NativeSleep) => void): Promise<PluginListenerHandle>;
  addListener(event: "crossfade", fn: (e: NativeCrossfadeEvent) => void): Promise<PluginListenerHandle>;
}

export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export const BrookPlayer = registerPlugin<BrookPlayerPlugin>("BrookPlayer");
