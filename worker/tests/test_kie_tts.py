"""Tests for the Kie.ai ElevenLabs TTS client wrapper (kie_tts)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

from src.services import kie_tts as tts_mod
from src.services.kie import KieError
from src.services.kie_tts import (
    DEFAULT_TTS_MODEL,
    KieTtsClient,
    KieTtsError,
    fake_tts_result,
)


SHARED_SECRET = "test-secret-for-kie-tts-tests"


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
    monkeypatch.setattr(tts_mod, "POLL_INTERVAL_S", 0.0)
    monkeypatch.setattr(tts_mod, "MAX_TTS_POLL_ATTEMPTS", 5)

    yield
    get_settings.cache_clear()


def _transport(handler) -> httpx.MockTransport:  # noqa: ANN001
    return httpx.MockTransport(handler)


def _ok_create(task_id: str = "tts-task-1") -> httpx.Response:
    return httpx.Response(200, json={"code": 200, "data": {"taskId": task_id}})


def _ok_record(urls: list[str]) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "code": 200,
            "data": {"state": "success", "resultJson": json.dumps({"resultUrls": urls})},
        },
    )


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def test_init_raises_when_api_key_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KIE_AI_API_KEY", raising=False)
    from src.config import get_settings

    get_settings.cache_clear()
    with pytest.raises(RuntimeError, match="KIE_AI_API_KEY"):
        KieTtsClient()


def test_init_picks_up_explicit_api_key() -> None:
    assert KieTtsClient(api_key="explicit").api_key == "explicit"


def test_tts_error_is_kie_error() -> None:
    assert issubclass(KieTtsError, KieError)


def test_default_model() -> None:
    assert KieTtsClient(api_key="k").model == DEFAULT_TTS_MODEL


# ---------------------------------------------------------------------------
# Local validation (no network)
# ---------------------------------------------------------------------------


def test_empty_text_raises() -> None:
    client = KieTtsClient(api_key="k")
    with pytest.raises(KieTtsError, match="empty"):
        asyncio.run(client.synthesize("   ", voice="v1"))


def test_too_long_text_raises() -> None:
    client = KieTtsClient(api_key="k")
    with pytest.raises(KieTtsError, match="max 5000"):
        asyncio.run(client.synthesize("x" * 5001, voice="v1"))


def test_missing_voice_raises() -> None:
    client = KieTtsClient(api_key="k")
    with pytest.raises(KieTtsError, match="voice id is required"):
        asyncio.run(client.synthesize("hello", voice=""))


def test_speed_out_of_range_raises() -> None:
    client = KieTtsClient(api_key="k")
    with pytest.raises(KieTtsError, match="speed"):
        asyncio.run(client.synthesize("hello", voice="v1", speed=2.0))


# ---------------------------------------------------------------------------
# FAKE_RENDER mode
# ---------------------------------------------------------------------------


def test_synthesize_fake_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_RENDER", "true")
    from src.config import get_settings

    get_settings.cache_clear()

    client = KieTtsClient()
    res = asyncio.run(client.synthesize("buy now", voice="v1"))
    assert res.audio_url.endswith(".mp3")
    assert res.task_id.startswith("fake-tts-")
    # Deterministic: same inputs -> same result.
    again = asyncio.run(client.synthesize("buy now", voice="v1"))
    assert again == res
    assert fake_tts_result("buy now", "v1", client.model) == res


def test_download_audio_fake_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_RENDER", "true")
    from src.config import get_settings

    get_settings.cache_clear()
    assert asyncio.run(KieTtsClient().download_audio("https://x/a.mp3")) == b""


# ---------------------------------------------------------------------------
# Happy path (submit + poll, mocked transport)
# ---------------------------------------------------------------------------


def test_synthesize_happy_path_and_body() -> None:
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/jobs/createTask"):
            calls.append(json.loads(request.content))
            return _ok_create()
        if "/jobs/recordInfo" in url:
            return _ok_record(["https://cdn.kie/a.mp3"])
        raise AssertionError(f"unexpected url {url}")

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    res = asyncio.run(
        client.synthesize(
            "Hello there",
            voice="voice-xyz",
            speed=1.1,
            language_code="en",
            stability=0.4,
        )
    )
    assert res.audio_url == "https://cdn.kie/a.mp3"
    assert res.task_id == "tts-task-1"
    body = calls[0]
    assert body["model"] == DEFAULT_TTS_MODEL
    assert body["input"]["text"] == "Hello there"
    assert body["input"]["voice"] == "voice-xyz"
    assert body["input"]["speed"] == 1.1
    assert body["input"]["language_code"] == "en"
    assert body["input"]["stability"] == 0.4
    # Unset optional fields are omitted, not sent as null.
    assert "similarity_boost" not in body["input"]
    assert "callBackUrl" not in body


def test_synthesize_forwards_callback_url() -> None:
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/jobs/createTask"):
            calls.append(json.loads(request.content))
            return _ok_create()
        return _ok_record(["https://cdn.kie/a.mp3"])

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    asyncio.run(
        client.synthesize("hi", voice="v1", callback_url="https://hook/cb")
    )
    assert calls[0]["callBackUrl"] == "https://hook/cb"


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


def test_submit_http_error_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"msg": "boom"})

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieTtsError, match="submit responded 500"):
        asyncio.run(client.synthesize("hi", voice="v1"))


def test_submit_non_200_app_code_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"code": 422, "msg": "bad"})

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieTtsError, match="non-200 application code"):
        asyncio.run(client.synthesize("hi", voice="v1"))


def test_submit_missing_task_id_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"code": 200, "data": {}})

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieTtsError, match="missing taskId"):
        asyncio.run(client.synthesize("hi", voice="v1"))


def test_poll_fail_state_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/jobs/createTask"):
            return _ok_create()
        return httpx.Response(
            200, json={"code": 200, "data": {"state": "fail", "failMsg": "nope"}}
        )

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieTtsError, match="failed: nope"):
        asyncio.run(client.synthesize("hi", voice="v1"))


def test_poll_success_no_urls_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/jobs/createTask"):
            return _ok_create()
        return _ok_record([])  # success but empty

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieTtsError, match="no audio URLs"):
        asyncio.run(client.synthesize("hi", voice="v1"))


def test_poll_unparseable_result_json_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/jobs/createTask"):
            return _ok_create()
        return httpx.Response(
            200,
            json={"code": 200, "data": {"state": "success", "resultJson": "{not json"}},
        )

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieTtsError, match="resultJson not parseable"):
        asyncio.run(client.synthesize("hi", voice="v1"))


def test_poll_times_out() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/jobs/createTask"):
            return _ok_create()
        return httpx.Response(200, json={"code": 200, "data": {"state": "running"}})

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieTtsError, match="timed out"):
        asyncio.run(client.synthesize("hi", voice="v1"))


# ---------------------------------------------------------------------------
# download_audio
# ---------------------------------------------------------------------------


def test_download_audio_happy() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"ID3-audio-bytes")

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    assert asyncio.run(client.download_audio("https://cdn.kie/a.mp3")) == b"ID3-audio-bytes"


def test_download_audio_error_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieTtsError, match="download responded 404"):
        asyncio.run(client.download_audio("https://cdn.kie/missing.mp3"))


# ---------------------------------------------------------------------------
# Network-error + remaining branch coverage
# ---------------------------------------------------------------------------


def test_submit_network_error_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieTtsError, match="submit network error"):
        asyncio.run(client.synthesize("hi", voice="v1"))


def test_poll_network_error_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/jobs/createTask"):
            return _ok_create()
        raise httpx.ConnectError("down")

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieTtsError, match="record-info network error"):
        asyncio.run(client.synthesize("hi", voice="v1"))


def test_poll_http_error_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/jobs/createTask"):
            return _ok_create()
        return httpx.Response(503, json={"msg": "unavailable"})

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieTtsError, match="record-info responded 503"):
        asyncio.run(client.synthesize("hi", voice="v1"))


def test_poll_non_list_urls_yields_no_audio() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/jobs/createTask"):
            return _ok_create()
        return httpx.Response(
            200,
            json={
                "code": 200,
                "data": {
                    "state": "success",
                    "resultJson": json.dumps({"resultUrls": "not-a-list"}),
                },
            },
        )

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieTtsError, match="no audio URLs"):
        asyncio.run(client.synthesize("hi", voice="v1"))


def test_download_audio_network_error_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    client = KieTtsClient(api_key="k", transport=_transport(handler))
    with pytest.raises(KieTtsError, match="download network error"):
        asyncio.run(client.download_audio("https://cdn.kie/a.mp3"))
