export interface LyricLine {
  time: number | null; // seconds; null when the lyrics are not synced
  text: string;
}

export interface Lyrics {
  lines: LyricLine[];
  synced: boolean;
}

// "[01:23.45] some words" -> a line at 83.45 s. Several stamps may share one text.
const STAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(text: string): Lyrics | null {
  const lines: LyricLine[] = [];
  let synced = false;
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(STAMP)];
    const words = raw.replace(STAMP, "").trim();
    if (stamps.length === 0) {
      if (/^\[[a-z]+:.*\]$/i.test(raw.trim())) continue; // [ar:..] [ti:..] tags
      if (words) lines.push({ time: null, text: words });
      continue;
    }
    synced = true;
    for (const m of stamps) {
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      lines.push({ time: Number(m[1]) * 60 + Number(m[2]) + frac, text: words });
    }
  }
  if (lines.length === 0) return null;
  if (synced) {
    const timed = lines.filter((l) => l.time !== null);
    timed.sort((a, b) => a.time! - b.time!);
    return { lines: timed, synced: true };
  }
  return { lines, synced: false };
}

// Index of the line being sung at `t`, or -1 before the first one.
export function activeLine(lines: LyricLine[], t: number): number {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const lt = lines[mid]!.time;
    if (lt !== null && lt <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
