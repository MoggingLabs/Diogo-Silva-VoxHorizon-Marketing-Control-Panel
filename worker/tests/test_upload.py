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


# ---------------------------------------------------------------------------
# _download_creative_bytes — normalize across supabase-py versions
# ---------------------------------------------------------------------------


def test_download_creative_bytes_returns_bytes_directly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``bytes`` already-normalized response: pass-through."""
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    sb.storage.from_.return_value.download.return_value = b"RAW"
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)
    assert upload_mod._download_creative_bytes(path="x") == b"RAW"


def test_download_creative_bytes_unwraps_response_with_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Lines 86-88: supabase-py older paths return a Response-shaped object."""
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()

    class FakeResp:
        content = b"FROM-RESP"

    sb.storage.from_.return_value.download.return_value = FakeResp()
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)
    assert upload_mod._download_creative_bytes(path="x") == b"FROM-RESP"


def test_download_creative_bytes_raises_on_unknown_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Line 89: raise if neither bytes nor a ``.content`` attribute is set."""
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    sb.storage.from_.return_value.download.return_value = object()
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)
    with pytest.raises(RuntimeError) as exc:
        upload_mod._download_creative_bytes(path="x")
    assert "unexpected Storage download response" in str(exc.value)


# ---------------------------------------------------------------------------
# _coerce_branded / _coerce_state edges
# ---------------------------------------------------------------------------


def test_coerce_branded_defaults_when_payload_not_dict() -> None:
    """Line 100: non-dict payload defaults branded=True."""
    from src.routes.upload import _coerce_branded

    assert _coerce_branded(None) is True
    assert _coerce_branded("not-a-dict") is True  # type: ignore[arg-type]


def test_coerce_branded_defaults_when_branded_missing() -> None:
    from src.routes.upload import _coerce_branded

    assert _coerce_branded({}) is True


def test_coerce_branded_respects_explicit_value() -> None:
    from src.routes.upload import _coerce_branded

    assert _coerce_branded({"branded": False}) is False
    assert _coerce_branded({"branded": True}) is True


def test_coerce_state_returns_none_when_payload_not_dict() -> None:
    """Line 116: payload not a dict → None."""
    from src.routes.upload import _coerce_state

    assert _coerce_state(None) is None
    assert _coerce_state("not-a-dict") is None  # type: ignore[arg-type]


def test_coerce_state_returns_state_from_targeting() -> None:
    """Line 121: pulls state code out of targeting dict."""
    from src.routes.upload import _coerce_state

    assert _coerce_state({"targeting": {"state": "TX"}}) == "TX"
    # whitespace trimmed
    assert _coerce_state({"targeting": {"state": "  CA  "}}) == "CA"


def test_coerce_state_uses_market_when_no_targeting() -> None:
    from src.routes.upload import _coerce_state

    assert _coerce_state({"market": "Austin, TX"}) == "TX"
    # Empty/short tails don't match.
    assert _coerce_state({"market": "Austin, T"}) is None
    assert _coerce_state({"market": "Austin"}) is None
    # Targeting present but state missing — falls through to market path.
    assert _coerce_state({"targeting": {}, "market": "Phoenix, AZ"}) == "AZ"


# ---------------------------------------------------------------------------
# image upload edges — service type guard, brief dict cast, cleanup
# ---------------------------------------------------------------------------


def test_image_upload_409_when_service_type_unsupported(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Line 169: unsupported service_type surfaces a 409."""
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
            "briefs": {
                "id": "b1",
                "payload": {},
                "clients": {"slug": "x", "name": "X", "service_type": "junk"},
            },
        },
    )
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    resp = client.post(
        "/work/upload/drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "c1"},
    )
    assert resp.status_code == 409
    assert "unsupported service_type" in resp.json()["detail"]


def test_image_upload_handles_client_as_non_dict(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Line 165: client field isn't a dict; fall back to {}."""
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
            "briefs": {
                "id": "b1",
                "payload": {},
                "clients": "weirdly-not-a-dict",
            },
        },
    )
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    async def fake_upload(*_a, **_kw):
        return "https://drive.google.com/file/d/X/view"

    monkeypatch.setattr(upload_mod, "upload_to_drive", fake_upload)

    resp = client.post(
        "/work/upload/drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "c1"},
    )
    assert resp.status_code == 200, resp.text
    # Falls back to "VoxHorizon" default client name.
    body = resp.json()
    assert body["filename"].startswith("VoxHorizon")


def test_image_upload_cleanup_tolerates_missing_tmp_file(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Lines 215-216: unlink() FileNotFoundError swallowed."""
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
            "briefs": {
                "id": "b1",
                "payload": {},
                "clients": {"slug": "x", "name": "X", "service_type": "roofing"},
            },
        },
    )
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    async def fake_upload(local_path, *_, **_kw):
        # Pretend that something else cleaned up the temp file before we did.
        try:
            Path(local_path).unlink()
        except FileNotFoundError:
            pass
        return "https://drive.google.com/file/d/X/view"

    monkeypatch.setattr(upload_mod, "upload_to_drive", fake_upload)

    resp = client.post(
        "/work/upload/drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "c1"},
    )
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# video upload edges
# ---------------------------------------------------------------------------


def test_video_upload_409_when_service_type_unsupported(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Line 303: bad service_type on video creative also 409."""
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    _set_select_data(
        sb,
        {
            "id": "v1",
            "version": 1,
            "captioned_path": "b1/captioned.mp4",
            "composed_path": "b1/composed.mp4",
            "duration_actual_s": 30,
            "brief_id": "b1",
            "video_briefs": {
                "id": "b1",
                "payload": {},
                "target_duration_s": 30,
                "clients": {"slug": "x", "name": "X", "service_type": "bogus"},
            },
        },
    )
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    resp = client.post(
        "/work/video/upload-drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"video_creative_id": "v1"},
    )
    assert resp.status_code == 409


def test_video_upload_handles_client_as_non_dict(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Line 299: clients on video brief not a dict → fall back to {}."""
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    _set_select_data(
        sb,
        {
            "id": "v1",
            "version": 2,
            "captioned_path": "b1/cap.mp4",
            "composed_path": "b1/composed.mp4",
            "duration_actual_s": 30,
            "brief_id": "b1",
            "video_briefs": {
                "id": "b1",
                "payload": {},
                "target_duration_s": 30,
                "clients": "weirdly-not-a-dict",
            },
        },
    )
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    async def fake_upload(*_a, **_kw):
        return "https://drive.google.com/file/d/X/view"

    monkeypatch.setattr(upload_mod, "upload_to_drive", fake_upload)

    resp = client.post(
        "/work/video/upload-drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"video_creative_id": "v1"},
    )
    assert resp.status_code == 200, resp.text


def test_video_upload_falls_back_to_30s_when_duration_invalid(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Line 315: zero / non-int duration falls back to 30s default."""
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    _set_select_data(
        sb,
        {
            "id": "v1",
            "version": 1,
            "captioned_path": "b1/cap.mp4",
            "composed_path": "b1/composed.mp4",
            "duration_actual_s": 0,  # invalid
            "brief_id": "b1",
            "video_briefs": {
                "id": "b1",
                "payload": {},
                "target_duration_s": None,  # also missing
                "clients": {"slug": "x", "name": "X", "service_type": "roofing"},
            },
        },
    )
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    captured: dict = {}

    async def fake_upload(local_path, *, filename, **_kw):
        captured["filename"] = filename
        return "https://drive.google.com/file/d/X/view"

    monkeypatch.setattr(upload_mod, "upload_to_drive", fake_upload)

    resp = client.post(
        "/work/video/upload-drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"video_creative_id": "v1"},
    )
    assert resp.status_code == 200
    assert "30s" in captured["filename"]


def test_video_upload_uses_default_concept_when_missing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Line 319: concept field empty/missing → fallback 'video creative'."""
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    _set_select_data(
        sb,
        {
            "id": "v1",
            "version": 1,
            "captioned_path": "b1/cap.mp4",
            "composed_path": "b1/composed.mp4",
            "duration_actual_s": 30,
            "brief_id": "b1",
            "video_briefs": {
                "id": "b1",
                "payload": {"concept": ""},  # empty
                "target_duration_s": 30,
                "clients": {"slug": "x", "name": "X", "service_type": "roofing"},
            },
        },
    )
    monkeypatch.setattr(upload_mod, "get_supabase_admin", lambda: sb)

    captured: dict = {}

    async def fake_upload(local_path, *, filename, **_kw):
        captured["filename"] = filename
        return "https://drive.google.com/file/d/X/view"

    monkeypatch.setattr(upload_mod, "upload_to_drive", fake_upload)

    resp = client.post(
        "/work/video/upload-drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"video_creative_id": "v1"},
    )
    assert resp.status_code == 200
    assert "video creative" in captured["filename"]


def test_video_upload_503_when_gog_missing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Lines 349-351: drive upload failure surfaces as 503."""
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    _set_select_data(
        sb,
        {
            "id": "v1",
            "version": 1,
            "captioned_path": "b1/cap.mp4",
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

    async def fake_upload(*_a, **_kw):
        raise RuntimeError("gog CLI not found on PATH")

    monkeypatch.setattr(upload_mod, "upload_to_drive", fake_upload)

    resp = client.post(
        "/work/video/upload-drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"video_creative_id": "v1"},
    )
    assert resp.status_code == 503


def test_video_upload_cleanup_tolerates_missing_tmp_file(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Lines 355-356: tmp cleanup absorbs FileNotFoundError."""
    from src.routes import upload as upload_mod

    sb = _build_mock_supabase()
    _set_select_data(
        sb,
        {
            "id": "v1",
            "version": 1,
            "captioned_path": "b1/cap.mp4",
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

    async def fake_upload(local_path, *_, **_kw):
        try:
            Path(local_path).unlink()
        except FileNotFoundError:
            pass
        return "https://drive.google.com/file/d/X/view"

    monkeypatch.setattr(upload_mod, "upload_to_drive", fake_upload)

    resp = client.post(
        "/work/video/upload-drive",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"video_creative_id": "v1"},
    )
    assert resp.status_code == 200, resp.text
