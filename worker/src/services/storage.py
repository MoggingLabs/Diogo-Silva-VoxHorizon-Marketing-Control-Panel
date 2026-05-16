"""Supabase Storage helpers for the `creatives` bucket.

The bucket is private — only the service-role client can write; reads from
the UI use signed URLs (minted by the Next.js side, which uses its own
service-role client).

Path layout::

    creatives/{brief_id}/{concept_slug}-{ratio}-{version}.png

`brief_id` is the UUID; `concept_slug` strips spaces/special chars and is
truncated. The version string is treated opaquely — callers decide the
scheme (e.g. ``v1.0``).
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Literal

import structlog
from supabase import Client

from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


BUCKET = "creatives"
Ratio = Literal["1x1", "9x16", "16x9"]

_SLUG_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
_SLUG_DASH_RUN_RE = re.compile(r"-{2,}")
_MAX_SLUG_LEN = 80


def slugify(s: str) -> str:
    """Lowercase + collapse non-alnum runs to a single ``-``, trim to 80 chars.

    Returns ``"untitled"`` for empty / pure-symbol inputs so we never emit
    an empty path segment.
    """
    lowered = s.lower().strip()
    # Replace any run of non-alnum (which includes punctuation, whitespace
    # AND existing dashes) with a single dash.
    one_dash = _SLUG_NON_ALNUM_RE.sub("-", lowered)
    # Collapse any incidental remaining dash runs (defensive: the rule
    # above should already have done this, but be explicit).
    collapsed = _SLUG_DASH_RUN_RE.sub("-", one_dash).strip("-")
    truncated = collapsed[:_MAX_SLUG_LEN]
    return truncated or "untitled"


def build_creative_path(
    brief_id: str,
    concept: str,
    ratio: Ratio,
    version: str,
) -> str:
    """Compose the storage object path (relative to the bucket)."""
    return f"{brief_id}/{slugify(concept)}-{ratio}-{version}.png"


async def upload_creative(
    local_path: Path,
    *,
    brief_id: str,
    concept: str,
    ratio: Ratio,
    version: str = "v1.0",
    content_type: str = "image/png",
) -> str:
    """Upload a local file to the ``creatives`` bucket.

    Returns the storage path relative to the bucket (NOT a URL — callers
    that need a URL should request a signed one from the Next.js side).

    The supabase-py SDK is synchronous; the ``async def`` signature is for
    forward-compatibility and so FastAPI route handlers can ``await`` it
    naturally. The actual I/O runs on the FastAPI worker thread.
    """
    if not local_path.exists():
        raise FileNotFoundError(f"local_path does not exist: {local_path}")

    path = build_creative_path(brief_id, concept, ratio, version)
    sb: Client = get_supabase_admin()

    data = local_path.read_bytes()
    sb.storage.from_(BUCKET).upload(
        path=path,
        file=data,
        file_options={"content-type": content_type, "x-upsert": "true"},
    )

    log.info(
        "upload_creative_ok",
        bucket=BUCKET,
        path=path,
        bytes=len(data),
        brief_id=brief_id,
        ratio=ratio,
        version=version,
    )
    return path


def sha256_short(local_path: Path, n: int = 12) -> str:
    """Short SHA-256 hex digest of file bytes, useful for cache-busting names."""
    h = hashlib.sha256()
    with open(local_path, "rb") as fh:
        for chunk in iter(lambda: fh.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()[:n]
