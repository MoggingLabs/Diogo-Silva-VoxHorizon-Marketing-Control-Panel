"""Tests for the Submagic captioning client.

Mocks the httpx.AsyncClient so the submit + poll + download flow runs
without hitting Submagic. ``asyncio.sleep`` is short-circuited so the
test suite stays fast.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest


SHARED_SECRET = "test-secret-for-submagic"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("SUBMAGIC_API_KEY", "sm-test-key")

    from src.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _mock_response(
    status_code: int = 200, json_data=None, content: bytes = b""
) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.content = content
    resp.text = "ok"
    resp.json = MagicMock(return_value=json_data)
    return resp


def _mock_client(get_responses, post_responses) -> MagicMock:
    """Build an ``httpx.AsyncClient`` mock that returns the configured
    responses in order across ``get`` / ``post`` calls."""
    client = MagicMock(spec=httpx.AsyncClient)
    client.aclose = AsyncMock()
    client.post = AsyncMock(side_effect=list(post_responses))
    client.get = AsyncMock(side_effect=list(get_responses))
    return client


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def test_requires_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SUBMAGIC_API_KEY", raising=False)
    from src.config import get_settings
    from src.services.submagic import SubmagicClient

    get_settings.cache_clear()
    with pytest.raises(RuntimeError) as exc:
        SubmagicClient()
    assert "SUBMAGIC_API_KEY" in str(exc.value)
    get_settings.cache_clear()


def test_style_map_has_known_keys() -> None:
    from src.services.submagic import STYLE_TEMPLATE_IDS

    for key in ("bold_yellow", "minimal_white", "brand"):
        assert key in STYLE_TEMPLATE_IDS


# ---------------------------------------------------------------------------
# submit + poll cycle
# ---------------------------------------------------------------------------


def test_submit_posts_to_projects_with_auth_header() -> None:
    from src.services.submagic import SubmagicClient

    post = _mock_response(json_data={"id": "proj-1"})
    fake = _mock_client(get_responses=[], post_responses=[post])
    client = SubmagicClient(client=fake)
    project_id = asyncio.run(
        client.submit("https://cdn.example.com/in.mp4", style="bold_yellow")
    )
    assert project_id == "proj-1"

    fake.post.assert_awaited_once()
    args, kwargs = fake.post.call_args
    assert args[0].endswith("/projects")
    assert kwargs["headers"]["x-api-key"] == "sm-test-key"
    body = kwargs["json"]
    assert body["video_url"] == "https://cdn.example.com/in.mp4"
    assert body["template_id"]  # mapped from style
    assert body["language"] == "en"


def test_submit_falls_back_to_default_template_on_unknown_style() -> None:
    from src.services.submagic import STYLE_TEMPLATE_IDS, SubmagicClient

    post = _mock_response(json_data={"id": "proj-1"})
    fake = _mock_client(get_responses=[], post_responses=[post])
    client = SubmagicClient(client=fake)
    asyncio.run(client.submit("u", style="unknown_style"))
    body = fake.post.call_args.kwargs["json"]
    assert body["template_id"] == STYLE_TEMPLATE_IDS["bold_yellow"]


def test_submit_raises_on_non_2xx() -> None:
    from src.services.submagic import SubmagicClient

    err_resp = _mock_response(status_code=401, json_data={})
    err_resp.text = "unauthorized"
    fake = _mock_client(get_responses=[], post_responses=[err_resp])
    client = SubmagicClient(client=fake)
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(client.submit("u", style="bold_yellow"))
    assert "401" in str(exc.value)


def test_submit_raises_when_no_id_returned() -> None:
    from src.services.submagic import SubmagicClient

    bad = _mock_response(json_data={"weird": "payload"})
    fake = _mock_client(get_responses=[], post_responses=[bad])
    client = SubmagicClient(client=fake)
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(client.submit("u", style="bold_yellow"))
    assert "no id" in str(exc.value)


def test_poll_returns_status_payload() -> None:
    from src.services.submagic import SubmagicClient

    status_resp = _mock_response(json_data={"status": "processing"})
    fake = _mock_client(get_responses=[status_resp], post_responses=[])
    client = SubmagicClient(client=fake)
    out = asyncio.run(client.poll("proj-1"))
    assert out == {"status": "processing"}
    assert fake.get.call_args.args[0].endswith("/projects/proj-1")


# ---------------------------------------------------------------------------
# caption — full lifecycle
# ---------------------------------------------------------------------------


def test_caption_submits_polls_then_downloads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.services import submagic
    from src.services.submagic import SubmagicClient, SubmagicJobResult

    # 1) submit → 2) poll(processing) → 3) poll(completed) → 4) download
    submit_resp = _mock_response(json_data={"id": "proj-1"})
    poll_processing = _mock_response(json_data={"status": "processing"})
    poll_done = _mock_response(
        json_data={"status": "completed", "video_url": "https://cdn/x.mp4"}
    )
    download_resp = _mock_response(content=b"FINAL-MP4")

    fake = _mock_client(
        get_responses=[poll_processing, poll_done, download_resp],
        post_responses=[submit_resp],
    )

    # Short-circuit sleeps so the test runs in milliseconds.
    monkeypatch.setattr(submagic.asyncio, "sleep", AsyncMock())

    client = SubmagicClient(client=fake)
    result: SubmagicJobResult = asyncio.run(
        client.caption(
            "https://cdn.example.com/in.mp4",
            style="bold_yellow",
            poll_interval_s=0.0,
            poll_timeout_s=30.0,
        )
    )
    assert result.project_id == "proj-1"
    assert result.video_url == "https://cdn/x.mp4"
    assert result.captioned_bytes == b"FINAL-MP4"

    assert fake.post.await_count == 1
    # Two polls + one download.
    assert fake.get.await_count == 3


def test_caption_raises_when_submagic_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.services import submagic
    from src.services.submagic import SubmagicClient

    submit_resp = _mock_response(json_data={"id": "p"})
    poll_failed = _mock_response(
        json_data={"status": "failed", "error": "bad input"}
    )
    fake = _mock_client(
        get_responses=[poll_failed], post_responses=[submit_resp]
    )
    monkeypatch.setattr(submagic.asyncio, "sleep", AsyncMock())

    client = SubmagicClient(client=fake)
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(
            client.caption("u", style="bold_yellow", poll_interval_s=0.0)
        )
    assert "failed" in str(exc.value)


def test_caption_times_out_when_status_never_completes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.services import submagic
    from src.services.submagic import SubmagicClient

    submit_resp = _mock_response(json_data={"id": "p"})
    # Always "processing" — we'll set the timeout to one poll cycle.
    poll_resp = _mock_response(json_data={"status": "processing"})
    fake = _mock_client(
        get_responses=[poll_resp, poll_resp, poll_resp],
        post_responses=[submit_resp],
    )
    monkeypatch.setattr(submagic.asyncio, "sleep", AsyncMock())

    client = SubmagicClient(client=fake)
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(
            client.caption(
                "u",
                style="bold_yellow",
                poll_interval_s=1.0,
                poll_timeout_s=1.0,  # one iteration before timing out
            )
        )
    assert "timed out" in str(exc.value)


def test_caption_raises_when_completed_without_video_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.services import submagic
    from src.services.submagic import SubmagicClient

    submit_resp = _mock_response(json_data={"id": "p"})
    completed_no_url = _mock_response(json_data={"status": "completed"})
    fake = _mock_client(
        get_responses=[completed_no_url], post_responses=[submit_resp]
    )
    monkeypatch.setattr(submagic.asyncio, "sleep", AsyncMock())

    client = SubmagicClient(client=fake)
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(
            client.caption("u", style="bold_yellow", poll_interval_s=0.0)
        )
    assert "video_url" in str(exc.value)
