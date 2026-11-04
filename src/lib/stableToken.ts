import md5 from "md5";

// Image URLs must be identical every time they are built. With a fresh random
// salt per call (as the API calls use), every redraw of the song list gave each
// cover a new URL, so neither the browser cache nor the service worker's
// cover-art cache could ever hit: each redraw fetched every cover again
// (thousands of requests a day, many rejected by Navidrome with 429).
//
// Cover URLs use one salt instead, kept in localStorage so the URLs also stay
// the same across restarts. The token is still md5(password + salt), as the
// Subsonic API expects; the salt is just no longer fresh for every request.

const SALT_KEY = "brook.coverSalt";

let salt: string | null = null;
let cached: { password: string; salt: string; token: string } | null = null;

function loadSalt(): string {
  if (salt) return salt;
  try { salt = localStorage.getItem(SALT_KEY); } catch { /* storage blocked */ }
  if (!salt) {
    salt = Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem(SALT_KEY, salt); } catch { /* kept in memory for this session */ }
  }
  return salt;
}

export function stableToken(password: string): { salt: string; token: string } {
  const s = loadSalt();
  if (!cached || cached.password !== password || cached.salt !== s) {
    cached = { password, salt: s, token: md5(password + s) };
  }
  return { salt: cached.salt, token: cached.token };
}

// For tests: forget the in-memory copy, as a page reload would.
export function resetStableToken(): void {
  salt = null;
  cached = null;
}
