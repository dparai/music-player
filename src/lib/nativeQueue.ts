// Turning Brook's play order into the queue the native player holds. The native
// player has to know the songs after the current one by itself: with the screen
// off the web page is frozen and cannot answer "what plays next".

import type { SubsonicSong } from "./subsonic";

export const NATIVE_QUEUE_AFTER = 100; // songs after the current one sent to the player
export const NATIVE_QUEUE_BEFORE = 1;  // so "previous" works from the lock screen

// [previous song, current song, ...songs after it], and where the current one is.
export function nativeQueue(
  current: SubsonicSong,
  before: SubsonicSong[],
  after: SubsonicSong[],
): { songs: SubsonicSong[]; startIndex: number } {
  const seen = new Set<string>([current.id]);
  const b = before.filter((s) => !seen.has(s.id)).slice(-NATIVE_QUEUE_BEFORE);
  b.forEach((s) => seen.add(s.id));
  const a: SubsonicSong[] = [];
  for (const s of after) {
    if (!seen.has(s.id) && a.length < NATIVE_QUEUE_AFTER) { seen.add(s.id); a.push(s); }
  }
  return { songs: [...b, current, ...a], startIndex: b.length };
}

// The same songs, in the same order? (so a re-render does not resend the queue)
export function sameQueue(a: { id: string; url?: string }[], b: { id: string; url?: string }[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.url === b[i]!.url);
}
