"""Tests for /work/upload/drive and /work/video/upload-drive.

Supabase + the gog CLI are both mocked so these run on Linux CI without
hitting the network or the Mac toolchain.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient


SHARED_SECRET = "test-secret-for-upload-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test")
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")

    from src.config import get_settings
    from src.services.queue import reset_queue
    from src.supabase_client import get_supabase_admin

    get_settings.cache_clear()
    get_supabase_admin.cache_clear()
    reset_queue()
    yield
    get_settings.cache_clear()
    get_supabase_admin.cache_clear()
    reset_queue()


@pytest.fixture
def client() -> TestClient:
    from src.main import create_app

    return TestClient(create_app())


def _build_mock_supabase() -> MagicMock:
    """A MagicMock shaped enough to drive the upload route end-to-end."""
    sb = MagicMock(name="supabase_client")

    # ``sb.table(...).select(...).eq(...).maybe_single().execute()``  for image
    # ``sb.table(...).update({...}).eq(...).execute()`` for the write-back
    # ``sb.table("events").insert({...}).execute()`` for the audit row
    # We don't need real chaining — each method just returns the same mock.
    table_mock = MagicMock(name="table")
    sb.table.return_value = table_mock
    table_mock.select.return_value = table_mock
    table_mock.eq.return_value = table_mock
    table_mock.maybe_single.return_value = table_mock
    table_mock.insert.return_value = table_mock
    table_mock.update.return_value = table_mock
    table_mock.execute.return_value = MagicMock(data={})

    # Storage download — return raw bytes.
    bucket_mock = MagicMock(name="bucket")
    bucket_mock.download.return_value = b"PNGDATA"
    sb.storage.from_.return_value = bucket_mock

    return sb


def _set_select_data(sb: MagicMock, payload: dict) -> None:
    """Pin the final .execute() chain to return ``payload``."""
    table_mock = sb.table.return_value
    table_mock.execute.return_value = MagicMock(data=payload)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def test_image_upload_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/upload/drive", json={"creative_id": "x"})
    assert resp.status_code == 401


def test_video_upload_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/video/upload-drive", json={"video_creative_id": "x"})
    assert resp.status_code == 401


def test_legacy_upload_returns_501(client: TestClient) -> None:
    resp = client.post(
        "/work/upload",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
    )
    assert resp.status_code == 501


# ---------------------------------------------------------------------------
# Image upload
# ---------------------------------------------------------------------------


def test_image_upload_happy_path(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    _set_select_data(
        sb,
        {
            "id": "c1",
            "concept": "Storm Damage",
            "ratio": "1x1",
            "version": "v1.0",
            "file_path_supabase": "b1/storm-damage-1x1-v1.0.png",
            "brief_id": "b1",
            "briefs": {
                "id": "b1",
                "payload": {"branded": True, "market": "Austin, TX"},
                "clients": {"slug": "sunny-day", "name": "Sunny Day Roofing", "service_type": "roofing"},
            },
        },
    )
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    async def fake_upload(local_path, *, filename, parent_folder_id, subpath="", account=None):
        return f"https://drive.google.com/file/d/UPLOADED-{filename.split(' | ')[0]}/view"

    monkeypatch.setattr(upload_mod, "upload_to_drive", fake_upload)

    resp = client.post(
        "/work/upload/drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "c1"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["creative_id"] == "c1"
    assert body["filename"] == "Sunny Day Roofing | Storm Damage | 1x1 | v1.0.png"
    assert body["subpath"] == "TX/sunny-day/"
    assert "drive.google.com" in body["drive_url"]

    # Persisted Drive URL back onto the creative.
    update_calls = [c for c in sb.table.return_value.update.call_args_list]
    assert any("file_path_drive" in c.args[0] for c in update_calls)


def test_image_upload_404_when_missing(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    _set_select_data(sb, None)
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    resp = client.post(
        "/work/upload/drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "missing"},
    )
    assert resp.status_code == 404


def test_image_upload_409_when_no_storage_path(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    _set_select_data(
        sb,
        {
            "id": "c1",
            "concept": "x",
            "ratio": "1x1",
            "version": "v1.0",
            "file_path_supabase": None,
            "brief_id": "b1",
            "briefs": {"id": "b1", "payload": {}, "clients": {"slug": "x", "name": "X", "service_type": "roofing"}},
        },
    )
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    resp = client.post(
        "/work/upload/drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "c1"},
    )
    assert resp.status_code == 409


def test_image_upload_503_when_gog_missing(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    _set_select_data(
        sb,
        {
            "id": "c1",
            "concept": "x",
            "ratio": "1x1",
            "version": "v1.0",
            "file_path_supabase": "b1/x.png",
            "brief_id": "b1",
            "briefs": {"id": "b1", "payload": {}, "clients": {"slug": "x", "name": "X", "service_type": "roofing"}},
        },
    )
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    async def fake_upload(*_a, **_kw):
        raise RuntimeError("gog CLI not found on PATH")

    monkeypatch.setattr(upload_mod, "upload_to_drive", fake_upload)

    resp = client.post(
        "/work/upload/drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "c1"},
    )
    assert resp.status_code == 503
    assert "gog" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Video upload
# ---------------------------------------------------------------------------


def test_video_upload_happy_path(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    _set_select_data(
        sb,
        {
            "id": "v1",
            "version": 1,
            "captioned_path": "b1/v1-captioned.mp4",
            "composed_path": "b1/v1-composed.mp4",
            "duration_actual_s": 30,
            "brief_id": "b1",
            "video_briefs": {
                "id": "b1",
                "payload": {"branded": True, "concept": "Storm Damage"},
                "target_duration_s": 30,
                "clients": {"slug": "sunny-day", "name": "Sunny Day Roofing", "service_type": "roofing"},
            },
        },
    )
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    async def fake_upload(local_path, *, filename, parent_folder_id, subpath="", account=None):
        return "https://drive.google.com/file/d/VIDEO/view"

    monkeypatch.setattr(upload_mod, "upload_to_drive", fake_upload)

    resp = client.post(
        "/work/video/upload-drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"video_creative_id": "v1"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["creative_id"] == "v1"
    assert body["filename"].endswith(" | 30s | v1.0.mp4")
    assert "Sunny Day Roofing" in body["filename"]


def test_video_upload_404(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    _set_select_data(sb, None)
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    resp = client.post(
        "/work/video/upload-drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"video_creative_id": "missing"},
    )
    assert resp.status_code == 404


def test_video_upload_409_when_source_missing(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    _set_select_data(
        sb,
        {
            "id": "v1",
            "version": 1,
            "captioned_path": None,
            "composed_path": "b1/composed.mp4",
            "duration_actual_s": 30,
            "brief_id": "b1",
            "video_briefs": {
                "id": "b1",
                "payload": {},
                "target_duration_s": 30,
                "clients": {"slug": "x", "name": "X", "service_type": "roofing"},
            },
        },
    )
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    # Default source is "captioned" — should 409 since captioned_path is None.
    resp = client.post(
        "/work/video/upload-drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"video_creative_id": "v1"},
    )
    assert resp.status_code == 409


def test_video_upload_uses_composed_when_requested(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    _set_select_data(
        sb,
        {
            "id": "v1",
            "version": 2,
            "captioned_path": None,
            "composed_path": "b1/composed.mp4",
            "duration_actual_s": 20,
            "brief_id": "b1",
            "video_briefs": {
                "id": "b1",
                "payload": {"branded": False, "concept": "Test"},
                "target_duration_s": 20,
                "clients": {"slug": "x", "name": "X", "service_type": "remodeling"},
            },
        },
    )
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    captured = {}

    async def fake_upload(local_path, *, filename, parent_folder_id, subpath="", account=None):
        captured["subpath"] = subpath
        captured["filename"] = filename
        return "https://drive.google.com/file/d/X/view"

    monkeypatch.setattr(upload_mod, "upload_to_drive", fake_upload)

    resp = client.post(
        "/work/video/upload-drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"video_creative_id": "v1", "source": "composed"},
    )
    assert resp.status_code == 200
    # Remodeling → _Universal/, regardless of branded flag.
    assert captured["subpath"] == "_Universal/"
    assert captured["filename"].endswith(" | 20s | v2.0.mp4")
