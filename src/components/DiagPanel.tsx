import { useEffect, useState } from "react";
import { clearDiag, readDiag, type DiagEntry } from "../lib/diag";

// Shown only when the URL ends in #debug.
export function DiagPanel() {
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
        <span>{log.length} events</span>
      </div>
      <pre style={{ margin: 0, overflow: "auto", flex: 1, whiteSpace: "pre-wrap" }}>{text}</pre>
    </div>
  );
}
