import { DiscIcon, LibraryIcon } from "./icons";
import styles from "./BottomNav.module.css";

export type View = "nowplaying" | "library";

interface Props {
  active: View;
  onChange: (view: View) => void;
}

export function BottomNav({ active, onChange }: Props) {
  return (
    <nav className={styles.nav} aria-label="Main">
      <button
        className={`${styles.item} ${active === "nowplaying" ? styles.active : ""}`}
        onClick={() => onChange("nowplaying")}
        aria-current={active === "nowplaying" ? "page" : undefined}
      >
        <DiscIcon size={24} />
        Now Playing
      </button>
      <button
        className={`${styles.item} ${active === "library" ? styles.active : ""}`}
        onClick={() => onChange("library")}
        aria-current={active === "library" ? "page" : undefined}
      >
        <LibraryIcon size={24} />
        Library
      </button>
    </nav>
  );
}
