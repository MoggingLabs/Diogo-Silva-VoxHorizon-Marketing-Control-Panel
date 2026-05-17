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


# ---------------------------------------------------------------------------
# Lifecycle / context manager + edge body shapes
# ---------------------------------------------------------------------------


def test_client_context_manager_closes_owned_client() -> None:
    """Lines 110-111 + 113-114 + 116-117: ``async with`` closes the
    httpx.AsyncClient we own."""
    from src.services.submagic import SubmagicClient

    fake = _mock_client(get_responses=[], post_responses=[])

    async def _go() -> SubmagicClient:
        c = SubmagicClient()
        c._client = fake
        async with c as ctx_client:
            assert ctx_client is c
        return c

    asyncio.run(_go())
    fake.aclose.assert_awaited_once()


def test_client_close_noop_when_client_is_injected() -> None:
    """Injected httpx client → caller owns lifecycle."""
    from src.services.submagic import SubmagicClient

    fake = _mock_client(get_responses=[], post_responses=[])
    client = SubmagicClient(client=fake)
    asyncio.run(client.close())
    fake.aclose.assert_not_called()


def test_submit_merges_extra_kwargs_into_body() -> None:
    """Line 145: ``extra`` field merges into the submit body."""
    from src.services.submagic import SubmagicClient

    post = _mock_response(json_data={"id": "p"})
    fake = _mock_client(get_responses=[], post_responses=[post])
    client = SubmagicClient(client=fake)
    asyncio.run(
        client.submit(
            "u", style="bold_yellow", extra={"speaker_label": "Ekko"}
        )
    )
    body = fake.post.call_args.kwargs["json"]
    assert body["speaker_label"] == "Ekko"


def test_poll_raises_on_non_2xx() -> None:
    """Line 169: GET status returns 5xx → RuntimeError."""
    from src.services.submagic import SubmagicClient

    err_resp = _mock_response(status_code=500, json_data={})
    err_resp.text = "internal"
    fake = _mock_client(get_responses=[err_resp], post_responses=[])
    client = SubmagicClient(client=fake)
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(client.poll("p1"))
    assert "500" in str(exc.value)


def test_poll_raises_when_payload_not_dict() -> None:
    """Line 174: poll payload must be a dict."""
    from src.services.submagic import SubmagicClient

    resp = _mock_response(json_data=["not a dict"])
    fake = _mock_client(get_responses=[resp], post_responses=[])
    client = SubmagicClient(client=fake)
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(client.poll("p1"))
    assert "non-object" in str(exc.value)


def test_download_raises_on_non_2xx() -> None:
    """Line 181: download URL returning 5xx → RuntimeError."""
    from src.services.submagic import SubmagicClient

    err_resp = _mock_response(status_code=503)
    fake = _mock_client(get_responses=[err_resp], post_responses=[])
    client = SubmagicClient(client=fake)
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(client.download("https://cdn/x.mp4"))
    assert "503" in str(exc.value)


def test_caption_completed_with_output_url_field() -> None:
    """Submagic occasionally returns ``output_url`` instead of ``video_url``."""
    from src.services import submagic
    from src.services.submagic import SubmagicClient

    submit_resp = _mock_response(json_data={"id": "p1"})
    done_resp = _mock_response(
        json_data={"status": "succeeded", "output_url": "https://cdn/x.mp4"}
    )
    download_resp = _mock_response(content=b"MP4")
    fake = _mock_client(
        get_responses=[done_resp, download_resp], post_responses=[submit_resp]
    )
    import unittest.mock as _mock

    fake_sleep = _mock.AsyncMock()
    monkeypatch_sleep = _mock.patch.object(submagic.asyncio, "sleep", fake_sleep)
    monkeypatch_sleep.start()
    try:
        client = SubmagicClient(client=fake)
        result = asyncio.run(
            client.caption("u", style="brand", poll_interval_s=0.0)
        )
    finally:
        monkeypatch_sleep.stop()

    assert result.video_url == "https://cdn/x.mp4"
    assert result.captioned_bytes == b"MP4"


def test_caption_raises_when_completed_with_non_string_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``video_url`` value isn't a string → fail loudly."""
    from src.services import submagic
    from src.services.submagic import SubmagicClient

    submit_resp = _mock_response(json_data={"id": "p1"})
    done_resp = _mock_response(json_data={"status": "completed", "video_url": 42})
    fake = _mock_client(
        get_responses=[done_resp], post_responses=[submit_resp]
    )
    monkeypatch.setattr(submagic.asyncio, "sleep", AsyncMock())

    client = SubmagicClient(client=fake)
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(client.caption("u", style="brand", poll_interval_s=0.0))
    assert "video_url" in str(exc.value)


def test_submit_uses_project_id_key_when_id_missing() -> None:
    """Submagic also returns ``project_id`` instead of ``id`` historically."""
    from src.services.submagic import SubmagicClient

    post = _mock_response(json_data={"project_id": "p-legacy"})
    fake = _mock_client(get_responses=[], post_responses=[post])
    client = SubmagicClient(client=fake)
    project_id = asyncio.run(client.submit("u", style="bold_yellow"))
    assert project_id == "p-legacy"
