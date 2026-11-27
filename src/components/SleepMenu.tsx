import { useEffect, useRef, useState } from "react";
import { BrookPlayer, type NativeSleep } from "@/lib/native";
import { ChevronIcon } from "./icons";
import styles from "./QualityMenu.module.css";

const CHOICES: { label: string; minutes?: number; endOfSong?: boolean }[] = [
  { label: "Off" },
  { label: "15 minutes", minutes: 15 },
  { label: "30 minutes", minutes: 30 },
  { label: "45 minutes", minutes: 45 },
  { label: "1 hour", minutes: 60 },
  { label: "End of this song", endOfSong: true },
];

function left(endsAt: number, now: number): string {
  const s = Math.max(0, Math.round((endsAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Sleep timer (Android app only): the native player stops the music, so it works with the screen off.
export function SleepMenu() {
  const [open, setOpen] = useState(false);
  const [sleep, setSleep] = useState<NativeSleep>({ endsAt: 0, endOfSong: false });
  const [now, setNow] = useState(Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const active = sleep.endsAt > 0 || sleep.endOfSong;

  useEffect(() => {
    let h: { remove: () => Promise<void> } | null = null;
    let alive = true;
    const update = (s: NativeSleep) => { setNow(Date.now()); setSleep(s); };
    void BrookPlayer.getSleepTimer().then((s) => alive && update(s)).catch(() => {});
    void BrookPlayer.addListener("sleep", update).then((x) => { if (alive) h = x; else void x.remove(); });
    return () => { alive = false; void h?.remove(); };
  }, []);

  useEffect(() => {
    if (!sleep.endsAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sleep.endsAt]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const label = sleep.endsAt ? left(sleep.endsAt, now) : sleep.endOfSong ? "End of song" : "Sleep";

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        className={`${styles.chip} ${active ? styles.chipOn : ""} ${open ? styles.chipOpen : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Sleep timer: ${active ? label : "off"}`}
      >
        <span>{label}</span>
        <ChevronIcon size={14} />
      </button>
      {open && (
        <div className={styles.menu} role="menu" aria-label="Sleep timer">
          <p className={styles.heading}>Sleep timer</p>
          {CHOICES.map((c) => (
            <button
              key={c.label}
              className={styles.option}
              role="menuitem"
              onClick={() => { void BrookPlayer.setSleepTimer({ minutes: c.minutes ?? 0, endOfSong: !!c.endOfSong }); setOpen(false); }}
            >
              <span className={styles.optionText}><span className={styles.optionLabel}>{c.label}</span></span>
            </button>
          ))}
          <p className={styles.note}>The music fades out, then stops.</p>
        </div>
      )}
    </div>
  );
}
