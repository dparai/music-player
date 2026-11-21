// A small event log kept in localStorage, to find out why playback stops on a
// locked phone. Read it by opening the app with #debug at the end of the URL.

const KEY = "brook_diag";
const MAX = 250;

export interface DiagEntry { t: number; e: string; d?: unknown }

export function readDiag(): DiagEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as DiagEntry[];
  } catch {
    return [];
  }
}

export function clearDiag(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

export function diag(e: string, d?: unknown): void {
  console.info("[brook diag]", e, d ?? "");
  try {
    const log = readDiag();
    log.push({ t: Date.now(), e, d });
    localStorage.setItem(KEY, JSON.stringify(log.slice(-MAX)));
  } catch { /* storage blocked or full: the console line above still exists */ }
}
