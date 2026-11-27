// The songs that will play after the current one, in order: the Play Next
// queue first, then the play order from the current song onwards (wrapping
// round, as the player does when it reaches the end of the list).
export function upcomingSongs<T extends { id: string }>(
  playNextQueue: T[],
  playOrder: T[],
  currentId: string | null,
  count: number,
): T[] {
  const out: T[] = [];
  const seen = new Set<string>(currentId ? [currentId] : []);
  const add = (s: T) => {
    if (out.length < count && !seen.has(s.id)) { seen.add(s.id); out.push(s); }
  };
  for (const s of playNextQueue) add(s);
  const at = currentId ? playOrder.findIndex((s) => s.id === currentId) : -1;
  for (let i = 1; i <= playOrder.length && out.length < count; i++) {
    add(playOrder[(at + i + playOrder.length) % playOrder.length]!);
  }
  return out;
}
