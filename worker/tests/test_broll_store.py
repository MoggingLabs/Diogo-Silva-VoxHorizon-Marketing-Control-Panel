"""Tests for LocalBrollStore (dedup + signed URLs)."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from src.services.broll_store import (
    LocalBrollStore,
    SupabaseBrollStore,
    compute_clip_id,
    sign_clip,
    verify_clip_signature,
)


SIGNING_SECRET = "test-signing-secret"
BASE_URL = "http://worker.local:8000"


@pytest.fixture
def store(tmp_path: Path) -> LocalBrollStore:
    return LocalBrollStore(
        root=tmp_path / "broll-pool",
        signing_secret=SIGNING_SECRET,
        base_url=BASE_URL,
    )


@pytest.fixture
def sample_clip(tmp_path: Path) -> Path:
    """Tiny fake MP4 — content matters for hashing, not validity."""
    path = tmp_path / "sample.mp4"
    path.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"x" * 1024)
    return path


def test_put_is_idempotent_on_same_file(
    store: LocalBrollStore, sample_clip: Path
) -> None:
    first = asyncio.run(
        store.put("https://example.com/clip.mp4", sample_clip, theme="ocean", duration_s=4.2)
    )
    second = asyncio.run(
        store.put("https://example.com/clip.mp4", sample_clip, theme="ocean", duration_s=4.2)
    )

    assert first.clip_id == second.clip_id
    assert first.store_backend == "local"
    assert first.local_path is not None
    assert Path(first.local_path).exists()
    # Sidecar exists too
    assert store.meta_path(first.clip_id).exists()


def test_put_different_files_yields_different_clip_ids(
    store: LocalBrollStore, tmp_path: Path
) -> None:
    clip_a = tmp_path / "a.mp4"
    clip_b = tmp_path / "b.mp4"
    clip_a.write_bytes(b"alpha-bytes")
    clip_b.write_bytes(b"beta-bytes")

    a = asyncio.run(store.put("https://example.com/a", clip_a, theme="sky"))
    b = asyncio.run(store.put("https://example.com/b", clip_b, theme="sky"))

    assert a.clip_id != b.clip_id


def test_get_signed_url_has_exp_and_sig(
    store: LocalBrollStore, sample_clip: Path
) -> None:
    clip = asyncio.run(store.put("https://example.com/clip.mp4", sample_clip))
    url = asyncio.run(store.get_signed_url(clip.clip_id, ttl_s=60))

    parsed = urlparse(url)
    assert parsed.netloc == "worker.local:8000"
    assert parsed.path == f"/work/broll/{clip.clip_id}"

    qs = parse_qs(parsed.query)
    assert "exp" in qs
    assert "sig" in qs

    exp = int(qs["exp"][0])
    sig = qs["sig"][0]
    assert exp > int(time.time())
    assert verify_clip_signature(clip.clip_id, exp, sig, SIGNING_SECRET)


def test_signature_fails_on_wrong_secret(
    store: LocalBrollStore, sample_clip: Path
) -> None:
    clip = asyncio.run(store.put("https://example.com/clip.mp4", sample_clip))
    url = asyncio.run(store.get_signed_url(clip.clip_id, ttl_s=60))
    qs = parse_qs(urlparse(url).query)

    assert not verify_clip_signature(
        clip.clip_id, int(qs["exp"][0]), qs["sig"][0], "other-secret"
    )


def test_signature_fails_when_expired() -> None:
    clip_id = "abcdef0123456789"
    past = int(time.time()) - 10
    sig = sign_clip(clip_id, past, SIGNING_SECRET)
    assert not verify_clip_signature(clip_id, past, sig, SIGNING_SECRET)


def test_list_pool_filters_by_theme(
    store: LocalBrollStore, tmp_path: Path
) -> None:
    ocean_clip = tmp_path / "ocean.mp4"
    ocean_clip.write_bytes(b"ocean-bytes")
    sky_clip = tmp_path / "sky.mp4"
    sky_clip.write_bytes(b"sky-bytes")

    asyncio.run(store.put("https://example.com/ocean", ocean_clip, theme="ocean"))
    asyncio.run(store.put("https://example.com/sky", sky_clip, theme="sky"))

    ocean_only = asyncio.run(store.list_pool("ocean"))
    assert len(ocean_only) == 1
    assert ocean_only[0].theme == "ocean"


def test_compute_clip_id_is_stable(sample_clip: Path) -> None:
    assert compute_clip_id(sample_clip) == compute_clip_id(sample_clip)
    assert len(compute_clip_id(sample_clip)) == 16


def test_supabase_backend_raises_on_construction() -> None:
    with pytest.raises(NotImplementedError):
        SupabaseBrollStore()
