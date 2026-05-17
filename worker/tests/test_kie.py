"""Tests for the Kie.ai REST client wrapper."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

from src.services import kie as kie_mod
from src.services.kie import (
    CREATE_TASK_URL,
    KieClient,
    KieError,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


SHARED_SECRET = "test-secret-for-kie-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie-key")

    from src.config import get_settings

    get_settings.cache_clear()

    # Skip the real-time sleeps used by the polling loop.
    monkeypatch.setattr(kie_mod, "POLL_INTERVAL_S", 0.0)
    monkeypatch.setattr(kie_mod, "MAX_POLL_ATTEMPTS", 5)

    yield
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_transport(handler):
    """Build a MockTransport from a sync handler so we can drive the client."""
    return httpx.MockTransport(handler)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_init_raises_when_api_key_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KIE_AI_API_KEY", raising=False)
    from src.config import get_settings

    get_settings.cache_clear()
    with pytest.raises(RuntimeError, match="KIE_AI_API_KEY"):
        KieClient()


def test_init_picks_up_explicit_api_key() -> None:
    client = KieClient(api_key="explicit-key")
    assert client.api_key == "explicit-key"


def test_unsupported_ratio_raises_kie_error() -> None:
    client = KieClient(api_key="k")
    with pytest.raises(KieError, match="Unsupported ratio"):
        asyncio.run(client.generate_image("p", "16x9"))  # type: ignore[arg-type]


def test_generate_image_happy_path() -> None:
    call_log: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        call_log.append(
            {
                "method": request.method,
                "url": str(request.url),
                "body": json.loads(request.content) if request.content else None,
            }
        )
        if str(request.url) == CREATE_TASK_URL:
            return httpx.Response(
                200,
                json={"code": 200, "data": {"taskId": "tk-1"}},
            )
        if "recordInfo" in str(request.url):
            return httpx.Response(
                200,
                json={
                    "code": 200,
                    "data": {
                        "state": "success",
                        "resultJson": json.dumps(
                            {"resultUrls": ["https://kie/img-1.png"]}
                        ),
                    },
                },
            )
        if str(request.url).startswith("https://kie/img-1.png"):
            return httpx.Response(200, content=b"PNGBYTES")
        return httpx.Response(404)

    client = KieClient(api_key="k", transport=_make_transport(handler))
    result = asyncio.run(client.generate_image_full("a sunny roof", "1x1"))

    assert result.image_bytes == b"PNGBYTES"
    assert result.task_id == "tk-1"
    assert result.source_url == "https://kie/img-1.png"
    assert result.aspect_ratio == "1:1"

    # 3 requests total: createTask, recordInfo, image download.
    assert [c["method"] for c in call_log] == ["POST", "GET", "GET"]
    # And the createTask body had our prompt + ratio mapped to "1:1".
    create_body = call_log[0]["body"]
    assert create_body["input"]["aspect_ratio"] == "1:1"
    assert create_body["input"]["prompt"] == "a sunny roof"


def test_polls_until_success() -> None:
    state_calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == CREATE_TASK_URL:
            return httpx.Response(
                200, json={"code": 200, "data": {"taskId": "tk-x"}}
            )
        if "recordInfo" in str(request.url):
            state_calls["n"] += 1
            if state_calls["n"] < 3:
                return httpx.Response(
                    200,
                    json={"code": 200, "data": {"state": "processing"}},
                )
            return httpx.Response(
                200,
                json={
                    "code": 200,
                    "data": {
                        "state": "success",
                        "resultJson": json.dumps(
                            {"resultUrls": ["https://kie/u.png"]}
                        ),
                    },
                },
            )
        return httpx.Response(200, content=b"DATA")

    client = KieClient(api_key="k", transport=_make_transport(handler))
    result = asyncio.run(client.generate_image("p", "9x16"))
    assert result == b"DATA"
    assert state_calls["n"] == 3


def test_failed_state_raises_kie_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == CREATE_TASK_URL:
            return httpx.Response(
                200, json={"code": 200, "data": {"taskId": "tk-fail"}}
            )
        return httpx.Response(
            200,
            json={
                "code": 200,
                "data": {"state": "failed", "failMsg": "rate limit"},
            },
        )

    client = KieClient(api_key="k", transport=_make_transport(handler))
    with pytest.raises(KieError, match="rate limit"):
        asyncio.run(client.generate_image("p", "1x1"))


def test_create_task_http_error_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    client = KieClient(api_key="k", transport=_make_transport(handler))
    with pytest.raises(KieError, match="responded 500"):
        asyncio.run(client.generate_image("p", "1x1"))


def test_poll_timeout_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == CREATE_TASK_URL:
            return httpx.Response(
                200, json={"code": 200, "data": {"taskId": "tk-stuck"}}
            )
        return httpx.Response(
            200, json={"code": 200, "data": {"state": "processing"}}
        )

    client = KieClient(api_key="k", transport=_make_transport(handler))
    with pytest.raises(KieError, match="timed out"):
        asyncio.run(client.generate_image("p", "1x1"))


def test_missing_task_id_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"code": 200, "data": {}})

    client = KieClient(api_key="k", transport=_make_transport(handler))
    with pytest.raises(KieError, match="missing taskId"):
        asyncio.run(client.generate_image("p", "1x1"))


def test_app_code_non_200_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"code": 500, "msg": "bad"})

    client = KieClient(api_key="k", transport=_make_transport(handler))
    with pytest.raises(KieError, match="non-200 application code"):
        asyncio.run(client.generate_image("p", "1x1"))
