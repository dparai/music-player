import type { SubsonicSong } from "./subsonic";

// Matches Navidrome songs to analysis records keyed by filename.
// Filenames are normalized (case, punctuation, track-number prefixes,
// "feat." credits) so "01 - Insane (feat. X) - AP Dhillon.flac" still
// matches title "Insane" by "AP Dhillon; Shinda Kahlon".

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[([](feat|ft|featuring)\.?\s[^)\]]*[)\]]/g, " ")
    .replace(/\s(feat|ft|featuring)\.?\s.*$/, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function stripFilename(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  return base
    .replace(/\.[^.]+$/, "")
    .replace(/^\s*\d{1,3}\s*[-._)]\s*/, "");
}

export interface NameIndex<T> {
  byName: Map<string, T[]>;
}

export function buildNameIndex<T>(entries: Iterable<[string, T]>): NameIndex<T> {
  const byName = new Map<string, T[]>();
  for (const [filename, value] of entries) {
    const key = normalize(stripFilename(filename));
    const bucket = byName.get(key);
    if (bucket) bucket.push(value);
    else byName.set(key, [value]);
  }
  return { byName };
}

export function matchByName<T>(index: NameIndex<T>, song: SubsonicSong): T | null {
  const title = song.title ?? "";
  const artist = song.artist ?? "";
  const primaryArtist = artist.split(/[;,&]/).map((s) => s.trim())[0] ?? "";

  // Artist-qualified names first: these are unambiguous.
  const qualified = [
    `${primaryArtist} - ${title}`,
    `${title} - ${primaryArtist}`,
    `${artist} - ${title}`,
    `${title} - ${artist}`,
  ];
  for (const name of qualified) {
    const bucket = index.byName.get(normalize(name));
    if (bucket?.length) return bucket[0]!;
  }

  // Title alone only when exactly one file has that name ("Intro" is common).
  const bucket = index.byName.get(normalize(title));
  return bucket?.length === 1 ? bucket[0]! : null;
}
