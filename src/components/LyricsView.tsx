import { useEffect, useRef } from "react";
import type { Lyrics } from "@/lib/lyrics";
import { activeLine } from "@/lib/lyrics";
import styles from "./LyricsView.module.css";

interface Props {
  status: "loading" | "ready" | "none" | "error";
  lyrics: Lyrics | null;
  time: number;
  open: boolean;
  onRetry: () => void;
  onSeek: (seconds: number) => void;
}

const LEAD = 0.25; // highlight a touch early: time updates arrive about 4 times a second
const PAUSE_AFTER_TOUCH_MS = 3500;

export function LyricsView({ status, lyrics, time, open, onRetry, onSeek }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const userUntil = useRef(0);
  const synced = !!lyrics?.synced;
  const idx = synced ? activeLine(lyrics!.lines, time + LEAD) : -1;

  useEffect(() => {
    const el = box.current;
    if (!open || !el || idx < 0 || Date.now() < userUntil.current) return;
    const line = el.children[idx] as HTMLElement | undefined;
    if (!line) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({
      top: line.offsetTop - el.clientHeight / 2 + line.clientHeight / 2,
      behavior: reduce ? "auto" : "smooth",
    });
  }, [idx, open, lyrics]);

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
  );
}
