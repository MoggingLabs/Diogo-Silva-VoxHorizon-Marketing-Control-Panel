"""Shared-secret bearer auth.

Every route on the worker (with the deliberate exception of the b-roll
signed-URL streaming route, which uses its own HMAC) must depend on
`verify_secret`. Comparison is constant-time.
"""

from __future__ import annotations

import hmac

from fastapi import Depends, Header, HTTPException, status

from .config import Settings, get_settings


_BEARER_PREFIX = "Bearer "


def verify_secret(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    """Raise 401 unless the request bears the configured shared secret."""
    if not authorization or not authorization.startswith(_BEARER_PREFIX):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    presented = authorization[len(_BEARER_PREFIX) :].strip()
    expected = settings.worker_shared_secret

    if not hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
