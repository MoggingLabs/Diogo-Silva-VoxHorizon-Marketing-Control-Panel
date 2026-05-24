"""Tests for the Kie.ai video client wrapper (kie_video)."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

from src.services import kie_video as vid_mod
from src.services.kie import KieError
from src.services.kie_video import KieVideoClient, KieVideoError


SHARED_SECRET = "test-secret-for-kie-video-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie-key")
    monkeypatch.delenv("FAKE_RENDER", raising=False)

    from src.config import get_settings

    get_settings.cache_clear()

    # Skip the real-time sleeps + cap the poll loop for fast tests.
    monkeypatch.setattr(vid_mod, "POLL_INTERVAL_S", 0.0)
    monkeypatch.setattr(vid_mod, "MAX_VIDEO_POLL_ATTEMPTS", 5)

    yield
    get_settings.cache_clear()


def _transport(handler):
    return httpx.MockTransport(handler)


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def test_init_raises_when_api_key_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KIE_AI_API_KEY", raising=False)
    from src.config import get_settings

    get_settings.cache_clear()
    with pytest.raises(RuntimeError, match="KIE_AI_API_KEY"):
        KieVideoClient()


def test_init_picks_up_explicit_api_key() -> None:
    assert KieVideoClient(api_key="explicit").api_key == "explicit"


def test_unsupported_ratio_raises() -> None:
    client = KieVideoClient(api_key="k")
    with pytest.raises(KieVideoError, match="Unsupported aspect_ratio"):
        asyncio.run(client.generate_video("p", aspect_ratio="4x5"))  # type: ignore[arg-type]


def test_video_error_is_kie_error() -> None:
    assert issubclass(KieVideoError, KieError)


# ---------------------------------------------------------------------------
# Veo (dedicated endpoints)
# ---------------------------------------------------------------------------


def test_generate_video_veo_happy_path() -> None:
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        calls.append(
            {
                "method": request.method,
                "url": url,
                "body": json.loads(request.content) if request.content else None,
            }
        )
        if "/veo/generate" in url:
            return httpx.Response(200, json={"code": 200, "data": {"taskId": "veo-1"}})
        if "/veo/record-info" in url:
            return httpx.Response(
                200,
                json={
                    "code": 200,
                    "data": {
                        "successFlag": 1,
                        "response": {"resultUrls": ["https://kie/v.mp4"]},
                    },
                },
            )
        return httpx.Response(404)

    client = KieVideoClient(api_key="k", transport=_transport(handler))
    result = asyncio.run(client.generate_video("a roof drone shot", aspect_ratio="9x16"))

    assert result.video_url == "https://kie/v.mp4"
    assert result.task_id == "veo-1"
    assert result.is_veo is True
    assert result.aspect_ratio == "9:16"
    assert result.model == "veo3_fast"
    # submit, then one poll. generate_video does NOT download.
    assert [c["method"] for c in calls] == ["POST", "GET"]
    submit_body = calls[0]["body"]
    assert submit_body["model"] == "veo3_fast"
    assert submit_body["aspect_ratio"] == "9:16"
    assert submit_body["prompt"] == "a roof drone shot"


def test_generate_video_veo_polls_until_success() -> None:
    n = {"v": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/veo/generate" in url:
            return httpx.Response(200, json={"code": 200, "data": {"taskId": "veo-x"}})
        n["v"] += 1
        if n["v"] < 3:
            return httpx.Response(200, json={"code": 200, "data": {"successFlag": 0}})
        return httpx.Response(
            200,
            json={
                "code": 200,
                "data": {
                    "successFlag": 1,
                    "response": {"resultUrls": ["https://kie/done.mp4"]},
                },
            },
        )

    client = KieVideoClient(api_key="k", transport=_transport(handler))
    result = asyncio.run(client.generate_video("p"))
    assert result.video_url == "https://kie/done.mp4"
    assert n["v"] == 3


def test_generate_video_veo_failed_flag_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/veo/generate" in url:
            return httpx.Response(200, json={"code": 200, "data": {"taskId": "veo-f"}})
        return httpx.Response(
            200,
            json={
                "code": 200,
                "data": {"successFlag": 2, "errorMessage": "unsafe content"},
            },
        )

    client = KieVideoClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieVideoError, match="unsafe content"):
        asyncio.run(client.generate_video("p"))


def test_generate_video_veo_falls_back_to_origin_urls() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/veo/generate" in url:
            return httpx.Response(200, json={"code": 200, "data": {"taskId": "veo-o"}})
        return httpx.Response(
            200,
            json={
                "code": 200,
                "data": {
                    "successFlag": 1,
                    "response": {"resultUrls": [], "originUrls": ["https://kie/o.mp4"]},
                },
            },
        )

    client = KieVideoClient(api_key="k", transport=_transport(handler))
    result = asyncio.run(client.generate_video("p"))
    assert result.video_url == "https://kie/o.mp4"


def test_veo_image_to_video_fields() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/veo/generate" in url:
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, json={"code": 200, "data": {"taskId": "veo-i"}})
        return httpx.Response(
            200,
            json={
                "code": 200,
                "data": {"successFlag": 1, "response": {"resultUrls": ["https://k/v.mp4"]}},
            },
        )

    client = KieVideoClient(api_key="k", transport=_transport(handler))
    asyncio.run(client.generate_video("p", image_url="https://k/ref.png"))
    assert captured["body"]["imageUrls"] == ["https://k/ref.png"]
    assert captured["body"]["generationType"] == "REFERENCE_2_VIDEO"


# ---------------------------------------------------------------------------
# Unified Jobs API (Kling / Seedance)
# ---------------------------------------------------------------------------


def test_generate_video_unified_kling() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/jobs/createTask" in url:
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, json={"code": 200, "data": {"taskId": "kl-1"}})
        if "/jobs/recordInfo" in url:
            return httpx.Response(
                200,
                json={
                    "code": 200,
                    "data": {
                        "state": "success",
                        "resultJson": json.dumps({"resultUrls": ["https://k/kling.mp4"]}),
                    },
                },
            )
        return httpx.Response(404)

    client = KieVideoClient(api_key="k", transport=_transport(handler))
    result = asyncio.run(
        client.generate_video(
            "p", model="kling-2.6/text-to-video", aspect_ratio="9x16", duration=5
        )
    )
    assert result.video_url == "https://k/kling.mp4"
    assert result.is_veo is False
    assert result.model == "kling-2.6/text-to-video"
    assert captured["body"]["input"]["aspect_ratio"] == "9:16"
    assert captured["body"]["input"]["duration"] == "5"
    # Kling submit should NOT carry a resolution field (only Seedance does).
    assert "resolution" not in captured["body"]["input"]


def test_unified_success_tolerates_non_200_code() -> None:
    """The unified record-info can return a non-200 ``code`` on success
    (documented quirk); gate on ``state``, not ``code``."""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/jobs/createTask" in url:
            return httpx.Response(200, json={"code": 200, "data": {"taskId": "kl-2"}})
        return httpx.Response(
            200,
            json={
                "code": 505,
                "data": {
                    "state": "success",
                    "resultJson": json.dumps({"resultUrls": ["https://k/ok.mp4"]}),
                },
            },
        )

    client = KieVideoClient(api_key="k", transport=_transport(handler))
    result = asyncio.run(client.generate_video("p", model="kling-2.6/text-to-video"))
    assert result.video_url == "https://k/ok.mp4"


def test_seedance_uses_input_urls_and_resolution() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/jobs/createTask" in url:
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, json={"code": 200, "data": {"taskId": "sd-1"}})
        return httpx.Response(
            200,
            json={
                "code": 200,
                "data": {
                    "state": "success",
                    "resultJson": json.dumps({"resultUrls": ["https://k/sd.mp4"]}),
                },
            },
        )

    client = KieVideoClient(api_key="k", transport=_transport(handler))
    asyncio.run(
        client.generate_video(
            "p",
            model="bytedance/seedance-1.5-pro",
            image_url="https://k/start.png",
            resolution="1080p",
        )
    )
    inp = captured["body"]["input"]
    assert inp["input_urls"] == ["https://k/start.png"]
    assert "imageUrls" not in inp
    assert inp["resolution"] == "1080p"


def test_unified_fail_state_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/jobs/createTask" in url:
            return httpx.Response(200, json={"code": 200, "data": {"taskId": "kl-f"}})
        return httpx.Response(
            200,
            json={"code": 200, "data": {"state": "fail", "failMsg": "quota exceeded"}},
        )

    client = KieVideoClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieVideoError, match="quota exceeded"):
        asyncio.run(client.generate_video("p", model="kling-2.6/text-to-video"))


# ---------------------------------------------------------------------------
# submit_video (callback path) + errors + fake + signature
# ---------------------------------------------------------------------------


def test_submit_video_returns_task_and_sets_callback() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"code": 200, "data": {"taskId": "veo-cb"}})

    client = KieVideoClient(api_key="k", transport=_transport(handler))
    task_id, is_veo = asyncio.run(
        client.submit_video("p", callback_url="https://w/cb")
    )
    assert task_id == "veo-cb"
    assert is_veo is True
    assert captured["body"]["callBackUrl"] == "https://w/cb"


def test_submit_http_error_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    client = KieVideoClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieVideoError, match="submit responded 500"):
        asyncio.run(client.generate_video("p"))


def test_submit_missing_task_id_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"code": 200, "data": {}})

    client = KieVideoClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieVideoError, match="missing taskId"):
        asyncio.run(client.generate_video("p"))


def test_poll_timeout_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/veo/generate" in url:
            return httpx.Response(200, json={"code": 200, "data": {"taskId": "veo-t"}})
        return httpx.Response(200, json={"code": 200, "data": {"successFlag": 0}})

    client = KieVideoClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieVideoError, match="timed out"):
        asyncio.run(client.generate_video("p"))


def test_fake_render_mode_is_deterministic(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_RENDER", "true")
    from src.config import get_settings

    get_settings.cache_clear()
    client = KieVideoClient()  # no key needed in fake mode
    a = asyncio.run(client.generate_video("same prompt", aspect_ratio="9x16"))
    b = asyncio.run(client.generate_video("same prompt", aspect_ratio="9x16"))
    assert a.task_id == b.task_id
    assert a.task_id.startswith("fake-vid-")
    assert a.video_url.endswith(".mp4")
    assert a.is_veo is True


def test_verify_webhook_signature() -> None:
    secret = "whk-secret"
    task_id = "task-123"
    ts = "1748000000"
    good = base64.b64encode(
        hmac.new(secret.encode(), f"{task_id}.{ts}".encode(), hashlib.sha256).digest()
    ).decode()

    assert KieVideoClient.verify_webhook_signature(task_id, ts, good, secret) is True
    assert KieVideoClient.verify_webhook_signature(task_id, ts, "wrong", secret) is False
    assert KieVideoClient.verify_webhook_signature("", ts, good, secret) is False
    assert KieVideoClient.verify_webhook_signature(task_id, ts, good, "") is False
