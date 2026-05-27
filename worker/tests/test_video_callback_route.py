"""Contract tests for the kie video completion-callback receiver (E5.2 / #514).

Drives ``POST /work/video/kie-callback`` via the shared ``client`` +
``fake_supabase`` harness. The route's auth is the kie HMAC signature (NOT the
worker bearer), so the tests build a valid ``X-Webhook-Signature`` over
``f"{taskId}.{timestamp}"`` with the configured ``KIE_AI_WEBHOOK_SECRET``.

Covered:
  * happy path -- verified callback for an in-flight render downloads + stores
    the clip and marks the row ``completed``;
  * bad signature -> 401 (nothing recorded);
  * missing-secret config -> 503;
  * duplicate / late callback for an already-terminal render -> 200 no-op
    (``deduped: true``), NEVER re-downloads, NEVER 5xxes;
  * unknown task -> 404;
  * a failure callback marks the row ``failed`` (no download).
"""

from __future__ import annotations

import base64
import hashlib
import hmac

import pytest
from fastapi.testclient import TestClient

from src.routes import video_callback

from .conftest import FakeSupabase


WEBHOOK_SECRET = "kie-webhook-test-secret"
TS = "1748000000"


@pytest.fixture(autouse=True)
def _kie_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Wire the kie webhook secret into the harness env for every test here."""
    monkeypatch.setenv("KIE_AI_WEBHOOK_SECRET", WEBHOOK_SECRET)
    from src.config import get_settings

    get_settings.cache_clear()


def _sig(task_id: str, ts: str = TS, secret: str = WEBHOOK_SECRET) -> str:
    return base64.b64encode(
        hmac.new(secret.encode(), f"{task_id}.{ts}".encode(), hashlib.sha256).digest()
    ).decode()


def _headers(task_id: str, **over: str) -> dict[str, str]:
    h = {
        "X-Webhook-Signature": _sig(task_id),
        "X-Webhook-Timestamp": TS,
    }
    h.update(over)
    return h


def _veo_success_body(task_id: str) -> dict[str, object]:
    return {
        "taskId": task_id,
        "data": {
            "successFlag": 1,
            "response": {"resultUrls": [f"https://kie/{task_id}.mp4"]},
        },
    }


def _seed_open_render(sb: FakeSupabase, task_id: str, **over: object) -> None:
    row: dict[str, object] = {
        "task_id": task_id,
        "is_veo": True,
        "status": "submitted",
        "theme": "roofing",
        "creative_id": "vc-1",
    }
    row.update(over)
    sb.set_single("_legacy_video_render_tasks", row)


@pytest.fixture
def _stub_store(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    """Stub the download+store side effect so the route test stays offline."""
    captured: dict[str, object] = {}

    async def _fake_store(*, task_id: str, theme, urls):  # noqa: ANN001, ANN202
        captured["task_id"] = task_id
        captured["theme"] = theme
        captured["urls"] = list(urls)
        return {"clip_id": f"clip-{task_id}", "source_url": urls[0]}

    monkeypatch.setattr(video_callback, "_store_render_result", _fake_store)
    return captured


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_callback_happy_records_and_completes(
    client: TestClient,
    fake_supabase: FakeSupabase,
    _stub_store: dict[str, object],
) -> None:
    _seed_open_render(fake_supabase, "veo-ok")
    resp = client.post(
        "/work/video/kie-callback",
        headers=_headers("veo-ok"),
        json=_veo_success_body("veo-ok"),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deduped"] is False
    assert body["status"] == "completed"
    assert body["clip_id"] == "clip-veo-ok"
    # The render row was marked completed with the clip.
    upd = [r for n, r in fake_supabase.updates if n == "_legacy_video_render_tasks"]
    assert upd and upd[-1]["status"] == "completed"
    assert upd[-1]["clip_id"] == "clip-veo-ok"
    # The clip was stored from the callback's result url.
    assert _stub_store["urls"] == ["https://kie/veo-ok.mp4"]
    assert _stub_store["theme"] == "roofing"


# ---------------------------------------------------------------------------
# Signature / auth
# ---------------------------------------------------------------------------


def test_callback_bad_signature_401(
    client: TestClient, fake_supabase: FakeSupabase, _stub_store: dict[str, object]
) -> None:
    _seed_open_render(fake_supabase, "veo-bad")
    resp = client.post(
        "/work/video/kie-callback",
        headers={"X-Webhook-Signature": "not-it", "X-Webhook-Timestamp": TS},
        json=_veo_success_body("veo-bad"),
    )
    assert resp.status_code == 401
    # Nothing recorded on a rejected signature.
    assert not [r for n, r in fake_supabase.updates if n == "_legacy_video_render_tasks"]
    assert "task_id" not in _stub_store


def test_callback_missing_signature_401(
    client: TestClient, fake_supabase: FakeSupabase, _stub_store: dict[str, object]
) -> None:
    _seed_open_render(fake_supabase, "veo-nosig")
    resp = client.post(
        "/work/video/kie-callback", json=_veo_success_body("veo-nosig")
    )
    assert resp.status_code == 401


def test_callback_no_secret_configured_503(
    client: TestClient,
    fake_supabase: FakeSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("KIE_AI_WEBHOOK_SECRET", raising=False)
    from src.config import get_settings

    get_settings.cache_clear()
    _seed_open_render(fake_supabase, "veo-x")
    resp = client.post(
        "/work/video/kie-callback",
        headers=_headers("veo-x"),
        json=_veo_success_body("veo-x"),
    )
    assert resp.status_code == 503


# ---------------------------------------------------------------------------
# Idempotency / never-5xx
# ---------------------------------------------------------------------------


def test_callback_duplicate_is_noop_200(
    client: TestClient,
    fake_supabase: FakeSupabase,
    _stub_store: dict[str, object],
) -> None:
    # The render is ALREADY completed: a late/duplicate callback must be a 200
    # no-op -- never re-download, never re-bill, never 5xx.
    _seed_open_render(fake_supabase, "veo-dup", status="completed")
    resp = client.post(
        "/work/video/kie-callback",
        headers=_headers("veo-dup"),
        json=_veo_success_body("veo-dup"),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deduped"] is True
    assert body["status"] == "completed"
    # No download/store attempted, no new write.
    assert "task_id" not in _stub_store
    assert not [r for n, r in fake_supabase.updates if n == "_legacy_video_render_tasks"]


def test_callback_duplicate_failed_is_noop_200(
    client: TestClient,
    fake_supabase: FakeSupabase,
    _stub_store: dict[str, object],
) -> None:
    _seed_open_render(fake_supabase, "veo-df", status="failed")
    resp = client.post(
        "/work/video/kie-callback",
        headers=_headers("veo-df"),
        json=_veo_success_body("veo-df"),
    )
    assert resp.status_code == 200
    assert resp.json()["deduped"] is True


def test_callback_unknown_task_404(
    client: TestClient,
    fake_supabase: FakeSupabase,
    _stub_store: dict[str, object],
) -> None:
    fake_supabase.set_single("_legacy_video_render_tasks", None)
    resp = client.post(
        "/work/video/kie-callback",
        headers=_headers("veo-unknown"),
        json=_veo_success_body("veo-unknown"),
    )
    assert resp.status_code == 404


def test_callback_missing_task_id_422(
    client: TestClient, fake_supabase: FakeSupabase
) -> None:
    # A body with no taskId can't be resolved; 422 before any signature work.
    resp = client.post(
        "/work/video/kie-callback",
        headers={"X-Webhook-Signature": "x", "X-Webhook-Timestamp": TS},
        json={"data": {"successFlag": 1}},
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Failure callback
# ---------------------------------------------------------------------------


def test_callback_failure_marks_failed(
    client: TestClient,
    fake_supabase: FakeSupabase,
    _stub_store: dict[str, object],
) -> None:
    _seed_open_render(fake_supabase, "veo-fail")
    body = {
        "taskId": "veo-fail",
        "data": {"successFlag": 2, "errorMessage": "unsafe content"},
    }
    resp = client.post(
        "/work/video/kie-callback", headers=_headers("veo-fail"), json=body
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "failed"
    upd = [r for n, r in fake_supabase.updates if n == "_legacy_video_render_tasks"]
    assert upd and upd[-1]["status"] == "failed"
    assert upd[-1]["error"] == "unsafe content"
    # A failure never downloads/stores.
    assert "task_id" not in _stub_store


def test_callback_success_without_urls_422(
    client: TestClient,
    fake_supabase: FakeSupabase,
) -> None:
    """A 'success' callback with no result URL is a 422 (nothing to store)."""
    _seed_open_render(fake_supabase, "veo-nourl")
    body = {"taskId": "veo-nourl", "data": {"successFlag": 1, "response": {}}}
    resp = client.post(
        "/work/video/kie-callback", headers=_headers("veo-nourl"), json=body
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Helper-level coverage
# ---------------------------------------------------------------------------


def test_extract_task_id_shapes() -> None:
    assert video_callback._extract_task_id({"taskId": "a"}) == "a"
    assert video_callback._extract_task_id({"task_id": "b"}) == "b"
    assert video_callback._extract_task_id({"data": {"taskId": "c"}}) == "c"
    assert video_callback._extract_task_id({"nope": 1}) is None


def test_extract_result_urls_shapes() -> None:
    assert video_callback._extract_result_urls(
        {"data": {"response": {"resultUrls": ["u1"]}}}
    ) == ["u1"]
    assert video_callback._extract_result_urls(
        {"data": {"response": {"originUrls": ["o1"]}}}
    ) == ["o1"]
    assert video_callback._extract_result_urls({"data": {"resultUrls": ["d1"]}}) == ["d1"]
    assert video_callback._extract_result_urls({"resultUrls": ["t1"]}) == ["t1"]
    assert video_callback._extract_result_urls({"data": {}}) == []


def test_callback_state_and_error_helpers() -> None:
    assert video_callback._callback_state({"data": {"state": "fail"}}) == "failed"
    assert video_callback._callback_state({"data": {"successFlag": 3}}) == "failed"
    assert video_callback._callback_state({"data": {"successFlag": 1}}) == "completed"
    assert video_callback._callback_state({}) == "completed"
    assert (
        video_callback._callback_error({"data": {"failMsg": "boom"}}) == "boom"
    )
    assert "render failure" in video_callback._callback_error({"data": {}})


async def test_store_render_result_downloads_and_stores(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """_store_render_result downloads the clip + puts it in the b-roll pool."""
    monkeypatch.setenv("FAKE_RENDER", "true")  # download_video returns b"" in fake mode
    from src.config import get_settings

    get_settings.cache_clear()

    stored = await video_callback._store_render_result(
        task_id="veo-store", theme="remodeling", urls=["https://kie/veo-store.mp4"]
    )
    assert stored["clip_id"]
    assert stored["source_url"] == "https://kie/veo-store.mp4"
    get_settings.cache_clear()


async def test_store_render_result_no_urls_raises() -> None:
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as ei:
        await video_callback._store_render_result(task_id="t", theme=None, urls=[])
    assert ei.value.status_code == 422
