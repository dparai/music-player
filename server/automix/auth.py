"""AutoMix auth that checks the real Brook user against Navidrome.

The bearer token "brook-automix-2026" is compiled into the PWA bundle, so
anyone can read it. That was harmless for read-only endpoints, but /rescan and
the planned /transitions render endpoint burn CPU on request. The PWA now also
sends X-Subsonic-User / -Token / -Salt (same salted-MD5 scheme as /rest/*);
this dependency verifies them with Navidrome's /rest/ping.

    from auth import require_user
    @app.post("/automix/rescan", dependencies=[Depends(require_user)])

Set AUTOMIX_ALLOW_BEARER=0 once every client sends Subsonic headers.
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request

from fastapi import HTTPException, Request

NAVIDROME = os.environ.get("AUTOMIX_NAVIDROME", "http://127.0.0.1:4533")
BEARER = os.environ.get("AUTOMIX_TOKEN", "brook-automix-2026")
ALLOW_BEARER = os.environ.get("AUTOMIX_ALLOW_BEARER", "1") == "1"


def _navidrome_ok(user: str, token: str, salt: str) -> bool | None:
    """True/False from Navidrome; None if Navidrome couldn't be asked (restarting)."""
    q = urllib.parse.urlencode({"u": user, "t": token, "s": salt, "v": "1.16.1", "c": "automix", "f": "json"})
    try:
        with urllib.request.urlopen(f"{NAVIDROME}/rest/ping?{q}", timeout=3) as r:
            return json.load(r)["subsonic-response"]["status"] == "ok"
    except Exception:
        return None


def require_user(request: Request) -> str:
    h = request.headers
    user, token, salt = h.get("x-subsonic-user"), h.get("x-subsonic-token"), h.get("x-subsonic-salt")
    bearer_ok = ALLOW_BEARER and h.get("authorization") == f"Bearer {BEARER}"
    if user and token and salt:
        ok = _navidrome_ok(urllib.parse.unquote(user), token, salt)  # the PWA URL-encodes it
        if ok:
            return user
        if ok is None and bearer_ok:
            return "bearer"  # Navidrome unreachable: don't lock the app out meanwhile
        raise HTTPException(status_code=401 if ok is False else 503, detail="could not verify Subsonic credentials")
    if bearer_ok:
        return "bearer"
    raise HTTPException(status_code=401, detail="missing credentials")
