import styles from "./BottomNav.module.css";

export type View = "nowplaying" | "library";

interface Props {
  active: View;
  onChange: (view: View) => void;
}

export function BottomNav({ active, onChange }: Props) {
  return (
    <nav className={styles.nav}>
      <button
        className={`${styles.item} ${active === "nowplaying" ? styles.active : ""}`}
        onClick={() => onChange("nowplaying")}
      >
        <span className={styles.icon}>&#127925;</span>
        Now Playing
      </button>
      <button
        className={`${styles.item} ${active === "library" ? styles.active : ""}`}
        onClick={() => onChange("library")}
      >
        <span className={styles.icon}>&#9835;</span>
        Library
      </button>
    </nav>
  );
}
