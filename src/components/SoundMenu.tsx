import { useEffect, useMemo, useRef, useState } from "react";
import {
  EQ_BANDS, EQ_RANGE_DB, PRESETS, autoPreampDb, clampGain, isFlat, presetFor, type SoundSettings,
} from "@/lib/sound";
import { ChevronIcon } from "./icons";
import styles from "./SoundMenu.module.css";

interface Props {
  value: SoundSettings;
  onChange: (next: SoundSettings) => void;
  // The Android app plays gapless by itself, so the Gapless switch is not shown there.
  native?: boolean;
}

function bandLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

function formatDb(db: number): string {
  return `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db).toFixed(1)} dB`;
}

// One vertical EQ band: drag it, or use the arrow keys.
function Band({ hz, db, onChange }: { hz: number; db: number; onChange: (db: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  function setFromPointer(e: React.PointerEvent) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)); // 0 = top = +range
    onChange(clampGain((0.5 - p) * 2 * EQ_RANGE_DB));
  }

  function onKey(e: React.KeyboardEvent) {
    const step = e.shiftKey ? 3 : 0.5;
    let next: number | null = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") next = db + step;
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = db - step;
    else if (e.key === "Home") next = -EQ_RANGE_DB;
    else if (e.key === "End") next = EQ_RANGE_DB;
    else if (e.key === "0") next = 0;
    if (next === null) return;
    e.preventDefault();
    onChange(clampGain(next));
  }

  const pct = ((db + EQ_RANGE_DB) / (2 * EQ_RANGE_DB)) * 100; // 0 bottom
  return (
    <div className={styles.band}>
      <div
        ref={ref}
        className={styles.track}
        role="slider"
        tabIndex={0}
        aria-label={`${bandLabel(hz)} Hz`}
        aria-orientation="vertical"
        aria-valuemin={-EQ_RANGE_DB}
        aria-valuemax={EQ_RANGE_DB}
        aria-valuenow={db}
        aria-valuetext={formatDb(db)}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setFromPointer(e); }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) setFromPointer(e); }}
        onKeyDown={onKey}
        onDoubleClick={() => onChange(0)}
      >
        <div className={styles.zero} />
        <div
          className={styles.fill}
          style={db >= 0 ? { bottom: "50%", height: `${pct - 50}%` } : { top: "50%", height: `${50 - pct}%` }}
        />
        <div className={styles.thumb} style={{ bottom: `${pct}%` }} />
      </div>
      <span className={styles.hz}>{bandLabel(hz)}</span>
    </div>
  );
}

function Switch({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button className={styles.row} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        <span className={styles.rowHint}>{hint}</span>
      </span>
      <span className={`${styles.switch} ${on ? styles.switchOn : ""}`} aria-hidden="true"><i /></span>
    </button>
  );
}

// Sound chip: volume normalising, gapless playback and a 10-band equaliser.
export function SoundMenu({ value, onChange, native = false }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const preset = presetFor(value.eq);
  const flat = isFlat(value.eq);
  const headroom = useMemo(() => autoPreampDb(value.eq), [value.eq]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setOpen(false); buttonRef.current?.focus(); }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const set = (patch: Partial<SoundSettings>) => onChange({ ...value, ...patch });

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        ref={buttonRef}
        className={`${styles.chip} ${!flat ? styles.chipOn : ""} ${open ? styles.chipOpen : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Sound settings: equaliser ${flat ? "off" : preset?.label ?? "custom"}`}
      >
        <span>Sound</span>
        <ChevronIcon size={14} />
      </button>

      {open && (
        <div className={styles.menu} role="dialog" aria-label="Sound settings">
          <Switch
            label="Normalize volume"
            hint="Every song at about the same loudness"
            on={value.normalize}
            onChange={(normalize) => set({ normalize })}
          />
          {!native && (
            <Switch
              label="Gapless playback"
              hint="Next song starts as this one ends (Crossfade off)"
              on={value.gapless}
              onChange={(gapless) => set({ gapless })}
            />
          )}

          <div className={styles.eqHead}>
            <p className={styles.heading}>Equaliser</p>
            <span className={styles.headroom} aria-live="polite">
              {flat ? "Off" : `Headroom ${formatDb(headroom)}`}
            </span>
          </div>

          <div className={styles.presets} role="radiogroup" aria-label="Equaliser preset">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                role="radio"
                aria-checked={preset?.id === p.id}
                className={`${styles.preset} ${preset?.id === p.id ? styles.presetOn : ""}`}
                onClick={() => set({ eq: p.gains.slice() })}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className={styles.bands}>
            {EQ_BANDS.map((hz, i) => (
              <Band
                key={hz}
                hz={hz}
                db={value.eq[i] ?? 0}
                onChange={(db) => set({ eq: value.eq.map((g, j) => (j === i ? db : g)) })}
              />
            ))}
          </div>
          <p className={styles.note}>
            {preset || flat ? "Drag a band to make your own curve." : "Custom curve."} Double-tap a band to zero it.
          </p>
        </div>
      )}
    </div>
  );
}
