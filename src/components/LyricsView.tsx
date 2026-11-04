import { useEffect, useRef, useState } from "react";
import type { Lyrics } from "@/lib/lyrics";
import { activeLine } from "@/lib/lyrics";
import styles from "./LyricsView.module.css";

interface Props {
  status: "loading" | "ready" | "none" | "error";
  lyrics: Lyrics | null;
  time: number;
  getTime?: () => number; // live playback position; the `time` prop only changes about 4 times a second
  open: boolean;
  onRetry: () => void;
  onSeek: (seconds: number) => void;
}

const LEAD = 0.3; // default: highlight early, so the line is already lit as the singer starts it
const STEP = 0.1;
const OFFSET_KEY = "brook.lyricsLead";

function loadLead(): number {
  try {
    const v = Number(localStorage.getItem(OFFSET_KEY));
    return localStorage.getItem(OFFSET_KEY) !== null && isFinite(v) ? v : LEAD;
  } catch { return LEAD; }
}
const PAUSE_AFTER_TOUCH_MS = 3500;

export function LyricsView({ status, lyrics, time, getTime, open, onRetry, onSeek }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const userUntil = useRef(0);
  const synced = !!lyrics?.synced;
  const [lead, setLead] = useState(loadLead);
  const nudge = (d: number) => setLead((v) => {
    const n = Math.round((v + d) * 10) / 10;
    try { localStorage.setItem(OFFSET_KEY, String(n)); } catch { /* private mode */ }
    return n;
  });
  const slowIdx = synced ? activeLine(lyrics!.lines, time + lead) : -1;
  const [liveIdx, setLiveIdx] = useState(-1);
  const idx = getTime && open && synced ? liveIdx : slowIdx;

  // Read the real playback position every frame, so a line lights up when it
  // is sung instead of up to a quarter second later.
  useEffect(() => {
    if (!getTime || !open || !lyrics?.synced) return;
    let raf = 0;
    const tick = () => {
      setLiveIdx(activeLine(lyrics.lines, getTime() + lead));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getTime, open, lyrics, lead]);

  const center = useRef<(smooth: boolean) => void>(() => {});
  center.current = (smooth) => {
    const el = box.current;
    if (!open || !el || idx < 0 || Date.now() < userUntil.current) return;
    const line = el.children[idx] as HTMLElement | undefined;
    if (!line) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({
      top: line.offsetTop - el.clientHeight / 2 + line.clientHeight / 2,
      behavior: smooth && !reduce ? "smooth" : "auto",
    });
  };

  useEffect(() => { center.current(true); }, [idx, open, lyrics]);

  // The box changes size while the lyrics panel opens (and when a phone shows
  // this tab again), so re-center then too, or the line lands off-middle.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => center.current(false));
    ro.observe(el);
    return () => ro.disconnect();
  }, [lyrics, status]);

  // Reopening should land on the current line, not wherever it was left.
  useEffect(() => { if (open) userUntil.current = 0; }, [open]);

  if (status !== "ready" || !lyrics) {
    return (
      <div className={styles.note} role="status">
        <p>
          {status === "loading" ? "Looking for lyrics…"
            : status === "error" ? "Couldn't reach the lyrics service."
            : "No lyrics for this song."}
        </p>
        {status === "error" && <button className={styles.retry} onClick={onRetry}>Try again</button>}
      </div>
    );
  }

  const pause = () => { userUntil.current = Date.now() + PAUSE_AFTER_TOUCH_MS; };

  return (
    <div className={styles.wrap}>
    <div
      ref={box}
      className={styles.box}
      onWheel={pause}
      onTouchStart={pause}
      tabIndex={open ? 0 : -1}
      aria-label="Lyrics"
    >
      {lyrics.lines.map((l, i) => {
        const cls = [
          styles.line,
          synced ? "" : styles.plain,
          i === idx ? styles.on : "",
          synced && i < idx ? styles.past : "",
          l.text ? "" : styles.gapLine,
        ].join(" ");
        return l.time !== null && l.text ? (
          <button key={i} className={cls} onClick={() => onSeek(l.time!)}>{l.text}</button>
        ) : (
          <p key={i} className={cls}>{l.text || " "}</p>
        );
      })}
    </div>
    {synced && (
      <div className={styles.sync} aria-label="Lyrics timing">
        <button onClick={() => nudge(STEP)} aria-label="Show lyrics earlier">Earlier</button>
        <span>{lead >= 0 ? "+" : ""}{lead.toFixed(1)}s</span>
        <button onClick={() => nudge(-STEP)} aria-label="Show lyrics later">Later</button>
      </div>
    )}
    </div>
  );
}
