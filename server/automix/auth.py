"""AutoMix auth: Brook users are verified against Navidrome.

The PWA sends X-Subsonic-User / -Token / -Salt (same salted-MD5 scheme as
/rest/*); this dependency checks them with Navidrome's /rest/ping.

    from auth import require_user
    @app.post("/automix/rescan", dependencies=[Depends(require_user)])

The bearer token is for local scripts only (cron's /rescan call). It is read
from AUTOMIX_TOKEN (EnvironmentFile=/opt/automix/automix.env, mode 600) and
is only accepted on direct connections to 127.0.0.1:8000, never through
Caddy. The old token "brook-automix-2026" was public (it shipped in the JS
bundle and this repo), so it is no longer accepted from the internet.
"""

from __future__ import annotations

import hmac
import json
import os
import urllib.parse
import urllib.request

from fastapi import HTTPException, Request

NAVIDROME = os.environ.get("AUTOMIX_NAVIDROME", "http://127.0.0.1:4533")
BEARER = os.environ.get("AUTOMIX_TOKEN") or None


def _navidrome_ok(user: str, token: str, salt: str) -> bool | None:
    """True/False from Navidrome; None if Navidrome couldn't be asked (restarting)."""
    q = urllib.parse.urlencode({"u": user, "t": token, "s": salt, "v": "1.16.1", "c": "automix", "f": "json"})
    try:
        with urllib.request.urlopen(f"{NAVIDROME}/rest/ping?{q}", timeout=3) as r:
            return json.load(r)["subsonic-response"]["status"] == "ok"
    except Exception:
        return None


def _local_bearer_ok(request: Request) -> bool:
    """Valid bearer on a direct local connection (Caddy always adds X-Forwarded-For)."""
    if not BEARER or "x-forwarded-for" in request.headers:
        return False
    client = request.client.host if request.client else ""
    if client not in ("127.0.0.1", "::1"):
        return False
    return hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {BEARER}")


def require_user(request: Request) -> str:
    h = request.headers
    user, token, salt = h.get("x-subsonic-user"), h.get("x-subsonic-token"), h.get("x-subsonic-salt")
    if user and token and salt:
        ok = _navidrome_ok(urllib.parse.unquote(user), token, salt)  # the PWA URL-encodes it
        if ok:
            return user
        if ok is None:
            raise HTTPException(status_code=503, detail="Navidrome unavailable, try again shortly")
        raise HTTPException(status_code=401, detail="invalid Subsonic credentials")
    if _local_bearer_ok(request):
        return "local"
    raise HTTPException(status_code=401, detail="missing credentials")
