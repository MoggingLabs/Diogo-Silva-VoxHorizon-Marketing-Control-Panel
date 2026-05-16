"""B-roll pool storage.

`LocalBrollStore` is the v1 primary: deterministic SHA-256 dedup, JSON
sidecars for metadata, HMAC-signed URLs for the Vercel side to embed.

`SupabaseBrollStore` is a deferred backend — the factory will instantiate
it once we decide to migrate the pool to Supabase Storage. Until then it
raises on construction so a misconfigured env doesn't silently fall back.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable
from urllib.parse import urlencode

from ..config import get_settings


@dataclass
class StoredClip:
    """Pool entry. Survives a round-trip through `to_dict` / `from_dict`."""

    clip_id: str  # sha256(file_bytes)[:16]
    source_url: str
    duration_s: float | None
    dimensions: str | None  # "1920x1080" etc.
    store_backend: str  # "local" | "supabase"
    theme: str | None = None
    local_path: str | None = None  # only when store_backend == "local"
    supabase_path: str | None = None  # only when store_backend == "supabase"

    def to_dict(self) -> dict[str, object]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> "StoredClip":
        return cls(**data)  # type: ignore[arg-type]


@runtime_checkable
class BrollStore(Protocol):
    """Backend interface for the b-roll pool."""

    async def put(
        self,
        source_url: str,
        local_file: Path,
        *,
        theme: str | None = None,
        duration_s: float | None = None,
        dimensions: str | None = None,
    ) -> StoredClip:
        """Ingest a clip; idempotent on content hash."""
        ...

    async def get_signed_url(self, clip_id: str, ttl_s: int = 3600) -> str:
        """Return a time-limited URL the Vercel app can hand to a browser."""
        ...

    async def list_pool(self, theme: str, limit: int = 25) -> list[StoredClip]:
        """Return up to `limit` clips matching `theme`, newest first."""
        ...


# ---------------------------------------------------------------------------
# Hashing + signing helpers (also used by the /work/broll route)
# ---------------------------------------------------------------------------


def compute_clip_id(file_path: Path) -> str:
    """SHA-256 of file bytes, truncated to 16 hex chars — collision-resistant
    enough for a content pool of this size and short enough for URLs."""
    hasher = hashlib.sha256()
    with file_path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            hasher.update(chunk)
    return hasher.hexdigest()[:16]


def sign_clip(clip_id: str, exp: int, secret: str) -> str:
    """Return the hex HMAC-SHA256 of `f"{clip_id}|{exp}"`."""
    payload = f"{clip_id}|{exp}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def verify_clip_signature(clip_id: str, exp: int, sig: str, secret: str) -> bool:
    """Constant-time signature check + expiry check."""
    if exp < int(time.time()):
        return False
    expected = sign_clip(clip_id, exp, secret)
    return hmac.compare_digest(expected, sig)


# ---------------------------------------------------------------------------
# LocalBrollStore — primary v1 implementation
# ---------------------------------------------------------------------------


class LocalBrollStore:
    """Filesystem-backed b-roll pool.

    Layout under `root`:
        {hash}.mp4   the actual clip
        {hash}.json  the StoredClip metadata sidecar
    """

    def __init__(self, root: Path, signing_secret: str, base_url: str) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.signing_secret = signing_secret
        self.base_url = base_url.rstrip("/")

    def clip_path(self, clip_id: str) -> Path:
        return self.root / f"{clip_id}.mp4"

    def meta_path(self, clip_id: str) -> Path:
        return self.root / f"{clip_id}.json"

    async def put(
        self,
        source_url: str,
        local_file: Path,
        *,
        theme: str | None = None,
        duration_s: float | None = None,
        dimensions: str | None = None,
    ) -> StoredClip:
        return await asyncio.to_thread(
            self._put_sync,
            source_url,
            local_file,
            theme,
            duration_s,
            dimensions,
        )

    def _put_sync(
        self,
        source_url: str,
        local_file: Path,
        theme: str | None,
        duration_s: float | None,
        dimensions: str | None,
    ) -> StoredClip:
        local_file = Path(local_file)
        if not local_file.exists():
            raise FileNotFoundError(f"Source file not found: {local_file}")

        clip_id = compute_clip_id(local_file)
        target = self.clip_path(clip_id)

        # Dedup: if a clip with this content hash already exists, we re-use
        # the on-disk copy and refresh the metadata sidecar (so theme /
        # source_url stay current).
        if not target.exists():
            target.write_bytes(local_file.read_bytes())

        clip = StoredClip(
            clip_id=clip_id,
            source_url=source_url,
            duration_s=duration_s,
            dimensions=dimensions,
            store_backend="local",
            theme=theme,
            local_path=str(target),
        )
        self.meta_path(clip_id).write_text(json.dumps(clip.to_dict(), indent=2))
        return clip

    async def get_signed_url(self, clip_id: str, ttl_s: int = 3600) -> str:
        if not self.clip_path(clip_id).exists():
            raise FileNotFoundError(f"Unknown clip_id: {clip_id}")
        exp = int(time.time()) + ttl_s
        sig = sign_clip(clip_id, exp, self.signing_secret)
        query = urlencode({"exp": exp, "sig": sig})
        return f"{self.base_url}/work/broll/{clip_id}?{query}"

    async def list_pool(self, theme: str, limit: int = 25) -> list[StoredClip]:
        return await asyncio.to_thread(self._list_pool_sync, theme, limit)

    def _list_pool_sync(self, theme: str, limit: int) -> list[StoredClip]:
        entries: list[tuple[float, StoredClip]] = []
        for meta_file in self.root.glob("*.json"):
            try:
                data = json.loads(meta_file.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            clip = StoredClip.from_dict(data)
            if theme and clip.theme != theme:
                continue
            mtime = meta_file.stat().st_mtime
            entries.append((mtime, clip))

        entries.sort(key=lambda t: t[0], reverse=True)
        return [clip for _, clip in entries[:limit]]


# ---------------------------------------------------------------------------
# SupabaseBrollStore — deferred
# ---------------------------------------------------------------------------


class SupabaseBrollStore:
    """Future backend. Configure with BROLL_STORE_BACKEND=local for v1."""

    def __init__(self, *_: object, **__: object) -> None:
        raise NotImplementedError(
            "SupabaseBrollStore is deferred. Set BROLL_STORE_BACKEND=local for v1."
        )


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def get_broll_store() -> BrollStore:
    """Return the configured b-roll backend."""
    settings = get_settings()
    if settings.broll_store_backend == "local":
        return LocalBrollStore(
            root=settings.broll_local_root_path,
            signing_secret=settings.worker_shared_secret,
            base_url=settings.worker_public_base_url,
        )
    return SupabaseBrollStore()
