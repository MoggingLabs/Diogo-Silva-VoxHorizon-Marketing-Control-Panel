"""Tests for the GET /work/broll/{clip_id} streaming route.

The route is intentionally unprotected by `verify_secret` — instead it
verifies an HMAC `sig` query param so the Vercel app can embed a
plain-URL <video> tag. We exercise:

* invalid / expired signature → 403
* valid signature but unknown clip_id → 404
* valid signature + clip exists → 200 with file bytes
* SupabaseBrollStore backend → 501 (worker does not proxy)
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.services.broll_store import sign_clip


SHARED_SECRET = "test-broll-route-secret"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path / "broll-pool"))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")

    from src.config import get_settings
    from src.services.queue import reset_queue

    get_settings.cache_clear()
    reset_queue()
    yield
    get_settings.cache_clear()
    reset_queue()


@pytest.fixture
def client() -> TestClient:
    from src.main import create_app

    return TestClient(create_app())


def _seed_clip(tmp_path: Path, clip_id: str, payload: bytes = b"VIDEOBYTES") -> Path:
    """Drop a fake mp4 + metadata sidecar into the local pool root."""
    pool_root = tmp_path / "broll-pool"
    pool_root.mkdir(parents=True, exist_ok=True)
    clip_path = pool_root / f"{clip_id}.mp4"
    clip_path.write_bytes(payload)
    return clip_path


def test_stream_broll_rejects_invalid_signature(
    client: TestClient,
) -> None:
    """No clip is seeded; the route should reject the bad signature first."""
    exp = int(time.time()) + 60
    resp = client.get(f"/work/broll/abc?exp={exp}&sig=deadbeef")
    assert resp.status_code == 403
    assert "Invalid or expired" in resp.json()["detail"]


def test_stream_broll_rejects_expired_signature(
    client: TestClient,
) -> None:
    """An expired exp must fail signature verification even when sig is valid
    against the (clip_id, exp) tuple."""
    clip_id = "abc123def4567890"
    past = int(time.time()) - 60
    sig = sign_clip(clip_id, past, SHARED_SECRET)
    resp = client.get(f"/work/broll/{clip_id}?exp={past}&sig={sig}")
    assert resp.status_code == 403


def test_stream_broll_404_when_clip_missing(
    client: TestClient,
) -> None:
    """Valid signature, but no on-disk clip → 404."""
    clip_id = "nope_does_not_exist"
    exp = int(time.time()) + 60
    sig = sign_clip(clip_id, exp, SHARED_SECRET)
    resp = client.get(f"/work/broll/{clip_id}?exp={exp}&sig={sig}")
    assert resp.status_code == 404
    assert "Unknown clip_id" in resp.json()["detail"]


def test_stream_broll_returns_file_when_valid(
    client: TestClient,
    tmp_path: Path,
) -> None:
    clip_id = "happypath0000001"
    _seed_clip(tmp_path, clip_id, payload=b"OK_VIDEO")
    exp = int(time.time()) + 60
    sig = sign_clip(clip_id, exp, SHARED_SECRET)
    resp = client.get(f"/work/broll/{clip_id}?exp={exp}&sig={sig}")
    assert resp.status_code == 200
    assert resp.content == b"OK_VIDEO"
    assert resp.headers["content-type"] == "video/mp4"


def test_stream_broll_501_for_supabase_backend(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the configured backend isn't local, the route refuses to serve."""
    from src.routes import broll as broll_route

    # The route looks up the store via get_broll_store; substitute a
    # non-LocalBrollStore object so the isinstance check fails.
    class FakeRemote:
        pass

    monkeypatch.setattr(broll_route, "get_broll_store", lambda: FakeRemote())

    clip_id = "doesnt_matter_xx"
    exp = int(time.time()) + 60
    sig = sign_clip(clip_id, exp, SHARED_SECRET)
    resp = client.get(f"/work/broll/{clip_id}?exp={exp}&sig={sig}")
    assert resp.status_code == 501
    assert "Supabase" in resp.json()["detail"]
