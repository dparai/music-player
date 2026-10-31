import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

// Picks an accent hue from the album art so the whole UI follows the song.
// Lightness is pinned so the accent always reads on the dark background and
// carries dark ink on top; covers with no real colour fall back to a neutral.

interface Accent {
  hue: number;
  sat: number;
  neutral: boolean;
}

const DEFAULT: Accent = { hue: 252, sat: 85, neutral: false };
const cache = new Map<string, Accent>();

function sample(url: string): Promise<Accent | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;

        let x = 0, y = 0, weight = 0, satSum = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]! / 255, g = data[i + 1]! / 255, b = data[i + 2]! / 255;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const d = max - min;
          if (max < 0.18 || d < 0.08) continue; // near-black or grey: no hue to offer
          const s = d / max;
          let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
          h *= 60;
          const w = s * max;
          x += Math.cos((h * Math.PI) / 180) * w;
          y += Math.sin((h * Math.PI) / 180) * w;
          weight += w;
          satSum += s * w;
        }
        if (weight < 1.5) return resolve({ hue: 220, sat: 12, neutral: true });
        const hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
        const sat = Math.max(55, Math.min(85, (satSum / weight) * 100));
        resolve({ hue: Math.round(hue), sat: Math.round(sat), neutral: false });
      } catch {
        resolve(null); // canvas tainted (no CORS on the cover): keep the default
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export function useAlbumAccent(coverUrl: string | null): CSSProperties {
  const [accent, setAccent] = useState<Accent>(DEFAULT);

  useEffect(() => {
    if (!coverUrl) { setAccent(DEFAULT); return; }
    const hit = cache.get(coverUrl);
    if (hit) { setAccent(hit); return; }
    let alive = true;
    sample(coverUrl).then((a) => {
      const result = a ?? DEFAULT;
      cache.set(coverUrl, result);
      if (alive) setAccent(result);
    });
    return () => { alive = false; };
  }, [coverUrl]);

  const { hue, sat, neutral } = accent;
  return {
    "--accent": neutral ? "hsl(220 14% 82%)" : `hsl(${hue} ${sat}% 68%)`,
    "--tint": neutral ? "hsl(220 10% 13%)" : `hsl(${hue} 45% 14%)`,
  } as CSSProperties;
}
