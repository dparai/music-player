import { useEffect, useState } from "react";
import { clearDiag, readDiag, type DiagEntry } from "../lib/diag";

// Opens with #debug at the end of the URL (also when the hash changes in an
// already-open page), or by tapping the "Library" title five times: an
// installed app has no address bar.
export const DEBUG_EVENT = "brook-debug";

export function DiagGate() {
  const [open, setOpen] = useState(() => window.location.hash === "#debug");
  useEffect(() => {
    const onHash = () => { if (window.location.hash === "#debug") setOpen(true); };
    const onTap = () => setOpen(true);
    window.addEventListener("hashchange", onHash);
    window.addEventListener(DEBUG_EVENT, onTap);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(DEBUG_EVENT, onTap);
    };
  }, []);
  return open ? <DiagPanel onClose={() => setOpen(false)} /> : null;
}

function DiagPanel({ onClose }: { onClose: () => void }) {
  const [log, setLog] = useState<DiagEntry[]>(readDiag);
  useEffect(() => {
    const id = setInterval(() => setLog(readDiag()), 1000);
    return () => clearInterval(id);
  }, []);

  const text = log
    .map((l) => `${new Date(l.t).toLocaleTimeString()} ${l.e}${l.d === undefined ? "" : " " + JSON.stringify(l.d)}`)
    .join("\n");

  return (
    <div style={{
      position: "fixed", inset: "auto 0 0 0", height: "45vh", zIndex: 9999, background: "#000d",
      color: "#9f9", font: "11px/1.3 monospace", padding: 8, display: "flex", flexDirection: "column", gap: 6,
    }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => navigator.clipboard?.writeText(text).catch(() => {})}>Copy</button>
        <button onClick={() => { clearDiag(); setLog([]); }}>Clear</button>
        <button onClick={onClose}>Close</button>
        <span>{log.length} events</span>
      </div>
      <pre style={{ margin: 0, overflow: "auto", flex: 1, whiteSpace: "pre-wrap" }}>{text}</pre>
    </div>
  );
}
