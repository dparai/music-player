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
}

export interface NativeTrackChange {
  id: string | null;
  index: number;
  // "auto": the previous song ended; "seek": next/previous (app, lock screen, headset); "playlist": the queue changed.
  reason: "auto" | "seek" | "playlist" | "repeat";
}

export interface NativeError {
  message: string;
  code: number;
  id: string | null;
}

export interface BrookPlayerPlugin {
  // Replace the whole queue and start at `startIndex`.
  setQueue(o: { items: NativeItem[]; startIndex: number; positionMs?: number; play: boolean }): Promise<void>;
  // Replace everything after the current item (the playing song is not touched). `currentId` is the
  // song the web UI thinks is playing; if the player has moved on meanwhile, the call is ignored.
  setUpcoming(o: { currentId: string; items: NativeItem[] }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(o: { positionMs: number }): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  getState(): Promise<NativeState>;
  addListener(event: "state", fn: (s: NativeState) => void): Promise<PluginListenerHandle>;
  addListener(event: "trackChanged", fn: (t: NativeTrackChange) => void): Promise<PluginListenerHandle>;
  addListener(event: "error", fn: (e: NativeError) => void): Promise<PluginListenerHandle>;
}

export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export const BrookPlayer = registerPlugin<BrookPlayerPlugin>("BrookPlayer");
