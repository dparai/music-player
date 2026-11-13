import { useEffect, useRef, useState } from "react";
import { QUALITIES, type Quality } from "@/lib/quality";
import { CheckIcon, ChevronIcon } from "./icons";
import styles from "./QualityMenu.module.css";

interface Props {
  value: Quality;
  onChange: (quality: Quality) => void;
}

// Rough download per minute of music at a bitrate.
function perMinute(kbps: number): string {
  const mb = (kbps * 60) / 8000;
  return `about ${Number(mb.toFixed(mb < 0.95 ? 1 : 0))} MB a minute`;
}

// Streaming quality picker: a chip that opens a small menu above itself.
export function QualityMenu({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = QUALITIES.find((q) => q.id === value) ?? QUALITIES[0]!;

  useEffect(() => {
    if (!open) return;
    // Start on the chosen option so the arrow keys move from it.
    menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }

  function onMenuKey(e: React.KeyboardEvent) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    let to = -1;
    if (e.key === "ArrowDown") to = (at + 1) % items.length;
    else if (e.key === "ArrowUp") to = (at - 1 + items.length) % items.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = items.length - 1;
    else if (e.key === "Escape") { e.preventDefault(); close(true); return; }
    else if (e.key === "Tab") { setOpen(false); return; }
    if (to >= 0) { e.preventDefault(); items[to]?.focus(); }
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        ref={buttonRef}
        className={`${styles.chip} ${value !== "original" ? styles.chipOn : ""} ${open ? styles.chipOpen : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Streaming quality: ${current.label}`}
      >
        {/* Name only: the bitrate is in the menu, and a short chip keeps the row on one line. */}
        <span>{current.label}</span>
        <ChevronIcon size={14} />
      </button>

      {open && (
        <div className={styles.menu} role="menu" aria-label="Streaming quality" ref={menuRef} onKeyDown={onMenuKey}>
          <p className={styles.heading}>Streaming quality</p>
          {QUALITIES.map((q) => {
            const on = q.id === value;
            return (
              <button
                key={q.id}
                className={`${styles.option} ${on ? styles.optionOn : ""}`}
                role="menuitemradio"
                aria-checked={on}
                onClick={() => { onChange(q.id); close(true); }}
              >
                <span className={styles.optionText}>
                  <span className={styles.optionLabel}>{q.label}</span>
                  <span className={styles.optionHint}>
                    {q.kbps ? `${q.kbps} kbps, ${perMinute(q.kbps)}` : "The file as it is, most data"}
                  </span>
                </span>
                <span className={styles.check}>{on && <CheckIcon size={18} />}</span>
              </button>
            );
          })}
          <p className={styles.note}>Applies from the next song.</p>
        </div>
      )}
    </div>
  );
}
