"""Tests for the wave-5 video pipeline routes (/work/video/*).

All external services are mocked: Supabase reads/writes via a MagicMock,
ElevenLabs / Submagic / yt-dlp / Hyperframes via their service modules,
ffmpeg via ``asyncio.create_subprocess_exec``.

The tests focus on the route layer's contract: auth + per-stage 200/4xx
shape + that the right service entry point gets called with the right
inputs. Service-internal behaviour is covered by the per-service test
files.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient


SHARED_SECRET = "test-secret-for-video-routes"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path / "broll"))
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "el-key")
    monkeypatch.setenv("SUBMAGIC_API_KEY", "sm-key")
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "worker-test")

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


# ---------------------------------------------------------------------------
# Supabase mocks
# ---------------------------------------------------------------------------


def _example_script() -> dict[str, Any]:
    return {
        "hook": "Stop scrolling.",
        "hook_duration_s": 3,
        "segments": [
            {
                "idx": 0,
                "topic": "establish",
                "duration_s": 4.0,
                "voiceover_text": "first beat",
                "voiceover_direction": "energetic",
                "broll_query": "texas roof drone",
                "broll_intent": "vertical drone",
                "broll_theme": "rooftops",
                "captions_emphasis": [],
            }
        ],
        "outro": {
            "voiceover_text": "tap below",
            "cta_overlay": "Claim",
            "duration_s": 3.0,
        },
        "total_duration_s": 10,
    }


def _build_supabase_mock() -> MagicMock:
    """Generic ``sb`` mock that resolves any chain ``.table().X().Y()...``.

    Tests then call ``_set_select`` / ``_set_insert`` / ``_set_update`` to
    pin specific return values for the chain endpoints.
    """
    sb = MagicMock(name="supabase_client")
    table = MagicMock(name="table")
    sb.table.return_value = table

    # Both chains we use return ``table`` so they're fluent.
    for meth in ("select", "eq", "maybe_single", "insert", "update", "from_"):
        getattr(table, meth).return_value = table

    table.execute.return_value = MagicMock(data={})

    # Storage paths
    bucket = MagicMock(name="bucket")
    bucket.upload.return_value = None
    bucket.create_signed_url.return_value = {"signedURL": "https://x/signed"}
    bucket.download.return_value = b""
    sb.storage.from_.return_value = bucket
    return sb


def _set_select(sb: MagicMock, data: dict | None) -> None:
    """Pin the .execute() return for the next select chain."""
    sb.table.return_value.execute.return_value = MagicMock(data=data)


def _patch_route_supabase(monkeypatch: pytest.MonkeyPatch, sb: MagicMock) -> None:
    """Patch every supabase lookup used by the routes module."""
    from src.routes import video

    monkeypatch.setattr(video, "get_supabase_admin", lambda: sb)


# ---------------------------------------------------------------------------
# Auth gates
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "endpoint,payload",
    [
        ("/work/video/script", {"brief_id": "b1"}),
        ("/work/video/voiceover", {"creative_id": "v1"}),
        ("/work/video/broll-search", {"creative_id": "v1"}),
        ("/work/video/broll-select", {"creative_id": "v1"}),
        ("/work/video/compose", {"creative_id": "v1"}),
        ("/work/video/caption", {"creative_id": "v1"}),
    ],
)
def test_endpoints_require_auth(
    client: TestClient, endpoint: str, payload: dict
) -> None:
    resp = client.post(endpoint, json=payload)
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# /work/video/script
# ---------------------------------------------------------------------------


def test_script_404_when_brief_missing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    sb = _build_supabase_mock()
    _set_select(sb, None)
    _patch_route_supabase(monkeypatch, sb)

    resp = client.post(
        "/work/video/script",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"brief_id": "missing"},
    )
    assert resp.status_code == 404


def test_script_returns_501_when_claude_runner_not_ready(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The runner stub raises NotImplementedError until Agent CG merges."""
    from src.routes import video

    sb = _build_supabase_mock()
    _set_select(
        sb,
        {"id": "b1", "payload": {"hook_style": "curiosity"}, "clients": {}},
    )
    _patch_route_supabase(monkeypatch, sb)

    resp = client.post(
        "/work/video/script",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"brief_id": "b1"},
    )
    assert resp.status_code == 501
    assert "claude" in resp.json()["detail"].lower() or "lands in M2" in resp.json()["detail"]


def test_script_happy_path_persists_and_records_stage(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.routes import video as video_routes
    from src.services import claude_runner
    from src.services.atomic_inserts_video import VideoStageResult

    sb = _build_supabase_mock()
    _set_select(
        sb, {"id": "b1", "payload": {"hook_style": "curiosity"}, "clients": {}}
    )
    _patch_route_supabase(monkeypatch, sb)

    valid_output = (
        '{"hook":"Stop","segments":['
        '{"idx":0,"topic":"a","duration_s":4,"voiceover_text":"hi",'
        '"voiceover_direction":"e","broll_query":"q","broll_intent":"i",'
        '"captions_emphasis":[]}],'
        '"outro":{"voiceover_text":"o","cta_overlay":"c","duration_s":3},'
        '"total_duration_s":10}'
    )

    monkeypatch.setattr(
        claude_runner.ClaudeRunner,
        "run_subprocess",
        AsyncMock(return_value=valid_output),
    )

    async def fake_record(**_kw):
        return VideoStageResult(
            creative_id="vc-1",
            iteration_id="vi-1",
            event_id="ev-1",
            status="script_ready",
            new_creative=True,
        )

    monkeypatch.setattr(video_routes, "record_video_stage", fake_record)

    resp = client.post(
        "/work/video/script",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"brief_id": "b1"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["creative_id"] == "vc-1"
    assert body["script_outline"]["segments"][0]["idx"] == 0


def test_script_rejects_invalid_json_with_502(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.services import claude_runner

    sb = _build_supabase_mock()
    _set_select(sb, {"id": "b1", "payload": {}, "clients": {}})
    _patch_route_supabase(monkeypatch, sb)

    monkeypatch.setattr(
        claude_runner.ClaudeRunner,
        "run_subprocess",
        AsyncMock(return_value="not json at all"),
    )

    resp = client.post(
        "/work/video/script",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"brief_id": "b1"},
    )
    assert resp.status_code == 502


def test_script_rejects_missing_top_level_keys_with_502(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.services import claude_runner

    sb = _build_supabase_mock()
    _set_select(sb, {"id": "b1", "payload": {}, "clients": {}})
    _patch_route_supabase(monkeypatch, sb)

    monkeypatch.setattr(
        claude_runner.ClaudeRunner,
        "run_subprocess",
        AsyncMock(return_value='{"hook":"x"}'),
    )

    resp = client.post(
        "/work/video/script",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"brief_id": "b1"},
    )
    assert resp.status_code == 502
    assert "missing" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# /work/video/voiceover
# ---------------------------------------------------------------------------


def test_voiceover_404_when_creative_missing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    sb = _build_supabase_mock()
    _set_select(sb, None)
    _patch_route_supabase(monkeypatch, sb)

    resp = client.post(
        "/work/video/voiceover",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "x"},
    )
    assert resp.status_code == 404


def test_voiceover_409_when_no_script(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "script_outline": None,
            "voice_id": "rachel",
            "video_briefs": {"payload": {}},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    resp = client.post(
        "/work/video/voiceover",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 409


def test_voiceover_409_when_no_voice_id(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "script_outline": _example_script(),
            "video_briefs": {"payload": {}},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    resp = client.post(
        "/work/video/voiceover",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 409
    assert "voice_id" in resp.json()["detail"]


def test_voiceover_happy_path(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from src.routes import video as video_routes
    from src.services import elevenlabs
    from src.services.atomic_inserts_video import VideoStageResult
    from src.services.elevenlabs import VoiceoverSegment

    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "voiceover_path": None,
            "script_outline": _example_script(),
            "voice_id": "rachel",
            "video_briefs": {"payload": {}, "voice_id": "rachel"},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    # Mock segment synthesis + concat so we don't touch ElevenLabs / ffmpeg.
    seg_file = tmp_path / "seg.mp3"
    seg_file.write_bytes(b"AAA")

    async def fake_synth(**_kw):
        return [
            VoiceoverSegment(
                idx=0, voiceover_text="t", local_path=seg_file, bytes_size=3
            )
        ]

    monkeypatch.setattr(video_routes, "synthesize_segments", fake_synth)

    async def fake_concat(paths, out, **_kw):
        out.write_bytes(b"CONCAT")
        return out

    monkeypatch.setattr(video_routes, "ffmpeg_concat_mp3", fake_concat)

    async def fake_record(**kw):
        return VideoStageResult(
            creative_id="vc1",
            iteration_id="vi",
            event_id="ev",
            status="voiceover_ready",
            new_creative=False,
        )

    monkeypatch.setattr(video_routes, "record_video_stage", fake_record)

    # Stub the ElevenLabsClient ctor so we don't open a real httpx client.
    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

    monkeypatch.setattr(video_routes, "ElevenLabsClient", FakeClient)

    resp = client.post(
        "/work/video/voiceover",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["voiceover_path"].endswith(".mp3")
    assert body["segments"][0]["idx"] == 0


# ---------------------------------------------------------------------------
# /work/video/broll-search
# ---------------------------------------------------------------------------


def test_broll_search_404_when_creative_missing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    sb = _build_supabase_mock()
    _set_select(sb, None)
    _patch_route_supabase(monkeypatch, sb)

    resp = client.post(
        "/work/video/broll-search",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "x"},
    )
    assert resp.status_code == 404


def test_broll_search_409_when_no_script(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "script_outline": None,
            "video_briefs": {"payload": {}},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    resp = client.post(
        "/work/video/broll-search",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 409


def test_broll_search_503_when_yt_dlp_missing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.routes import video as video_routes

    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "script_outline": _example_script(),
            "video_briefs": {"payload": {}},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    async def fake_scrape(*_a, **_kw):
        raise RuntimeError("yt-dlp not found on PATH")

    monkeypatch.setattr(video_routes, "scrape_yt_shorts", fake_scrape)

    resp = client.post(
        "/work/video/broll-search",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 503
    assert "yt-dlp" in resp.json()["detail"]


def test_broll_search_happy_path(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from src.routes import video as video_routes
    from src.services.atomic_inserts_video import VideoStageResult
    from src.services.broll_search import BrollCandidate
    from src.services.broll_store import StoredClip

    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "script_outline": _example_script(),
            "video_briefs": {"payload": {}},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    # Stage one fake clip on disk and one in-memory candidate that points at it.
    clip_file = tmp_path / "clip.mp4"
    clip_file.write_bytes(b"XX")

    async def fake_scrape(*_a, **_kw):
        return [
            BrollCandidate(
                source_url="https://youtube/x",
                local_path=clip_file,
                info={"id": "x", "width": 1, "height": 2, "duration": 5},
            )
        ]

    monkeypatch.setattr(video_routes, "scrape_yt_shorts", fake_scrape)

    # Stub the BrollStore so we don't touch the filesystem-backed store
    # (which would copy bytes around).
    store = MagicMock(name="store")

    async def fake_put(source_url, local_path, **kwargs):
        return StoredClip(
            clip_id="clip-1",
            source_url=source_url,
            duration_s=kwargs.get("duration_s"),
            dimensions=kwargs.get("dimensions"),
            store_backend="local",
            theme=kwargs.get("theme"),
            local_path=str(local_path),
        )

    store.put = AsyncMock(side_effect=fake_put)
    monkeypatch.setattr(video_routes, "get_broll_store", lambda: store)

    async def fake_record(**kw):
        return VideoStageResult(
            creative_id="vc1",
            iteration_id="vi",
            event_id="ev",
            status="broll_ready",
            new_creative=False,
        )

    monkeypatch.setattr(video_routes, "record_video_stage", fake_record)

    resp = client.post(
        "/work/video/broll-search",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert "0" in body["candidates"]
    assert body["candidates"]["0"][0]["clip_id"] == "clip-1"


# ---------------------------------------------------------------------------
# /work/video/broll-select
# ---------------------------------------------------------------------------


def test_broll_select_409_when_no_candidates(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "script_outline": _example_script(),
            "broll_clips": None,
            "video_briefs": {"payload": {}, "broll_selection_mode": "auto"},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    resp = client.post(
        "/work/video/broll-select",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 409


def test_broll_select_auto_resolves(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.routes import video as video_routes
    from src.services.atomic_inserts_video import VideoStageResult

    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "script_outline": _example_script(),
            "broll_clips": {
                "candidates": {
                    "0": [
                        {
                            "clip_id": "c-strong",
                            "source_url": "u1",
                            "title": "texas roof drone",
                        },
                        {
                            "clip_id": "c-weak",
                            "source_url": "u2",
                            "title": "cooking",
                        },
                    ]
                }
            },
            "video_briefs": {
                "payload": {},
                "broll_selection_mode": "auto",
            },
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    async def fake_record(**kw):
        return VideoStageResult(
            creative_id="vc1",
            iteration_id="vi",
            event_id="ev",
            status="broll_ready",
            new_creative=False,
        )

    monkeypatch.setattr(video_routes, "record_video_stage", fake_record)

    resp = client.post(
        "/work/video/broll-select",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mode"] == "auto"
    assert body["resolved"]["0"]["clip_id"] == "c-strong"


def test_broll_select_review_each_returns_needs_review(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.routes import video as video_routes
    from src.services.atomic_inserts_video import VideoStageResult

    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "script_outline": _example_script(),
            "broll_clips": {
                "candidates": {
                    "0": [
                        {"clip_id": "c-a", "source_url": "u1", "title": "texas roof"},
                        {"clip_id": "c-b", "source_url": "u2", "title": "cooking"},
                    ]
                }
            },
            "video_briefs": {"payload": {}, "broll_selection_mode": "review_each"},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    async def fake_record(**kw):
        return VideoStageResult(
            creative_id="vc1",
            iteration_id="vi",
            event_id="ev",
            status="broll_ready",
            new_creative=False,
        )

    monkeypatch.setattr(video_routes, "record_video_stage", fake_record)

    resp = client.post(
        "/work/video/broll-select",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "review_each"
    assert body["resolved"] == {}
    assert len(body["needs_review"]["0"]) == 2


def test_broll_select_low_confidence_returns_501_by_default(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "script_outline": _example_script(),
            "broll_clips": {
                "candidates": {
                    "0": [{"clip_id": "c", "source_url": "u", "title": "x"}]
                }
            },
            "video_briefs": {
                "payload": {},
                "broll_selection_mode": "review_low_confidence",
            },
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    resp = client.post(
        "/work/video/broll-select",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 501


def test_broll_select_invalid_mode_returns_400(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "script_outline": _example_script(),
            "broll_clips": {"candidates": {"0": []}},
            "video_briefs": {"payload": {}, "broll_selection_mode": "bogus"},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    resp = client.post(
        "/work/video/broll-select",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# /work/video/compose
# ---------------------------------------------------------------------------


def test_compose_409_when_voiceover_missing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "script_outline": _example_script(),
            "voiceover_path": None,
            "broll_clips": {"selected": {"0": {"clip_id": "c"}}},
            "video_briefs": {"payload": {}, "dimensions": "9x16"},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    resp = client.post(
        "/work/video/compose",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 409
    assert "voiceover" in resp.json()["detail"]


def test_compose_409_when_no_selected_clips(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "script_outline": _example_script(),
            "voiceover_path": "vo.mp3",
            "broll_clips": {},
            "video_briefs": {"payload": {}, "dimensions": "9x16"},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    resp = client.post(
        "/work/video/compose",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 409
    assert "broll" in resp.json()["detail"]


def test_compose_503_when_hyperframes_missing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from src.routes import video as video_routes

    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "script_outline": _example_script(),
            "voiceover_path": "vo.mp3",
            "broll_clips": {"selected": {"0": {"clip_id": "c-1"}}},
            "video_briefs": {
                "payload": {},
                "dimensions": "9x16",
                "captions_style": "bold_yellow",
            },
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    # Stub the broll store signed URL.
    store = MagicMock()
    store.get_signed_url = AsyncMock(return_value="https://x/clip")
    monkeypatch.setattr(video_routes, "get_broll_store", lambda: store)

    async def boom(**_kw):
        raise RuntimeError("hyperframes CLI not found on PATH")

    monkeypatch.setattr(video_routes, "author_and_render", boom)

    resp = client.post(
        "/work/video/compose",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 503
    assert "hyperframes" in resp.json()["detail"].lower()


def test_compose_happy_path(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from src.routes import video as video_routes
    from src.services.atomic_inserts_video import VideoStageResult
    from src.services.hyperframes import HyperframesRenderResult

    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "composed_path": None,
            "script_outline": _example_script(),
            "voiceover_path": "vo.mp3",
            "broll_clips": {"selected": {"0": {"clip_id": "c-1"}}},
            "video_briefs": {
                "payload": {},
                "dimensions": "9x16",
                "captions_style": "bold_yellow",
            },
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    store = MagicMock()
    store.get_signed_url = AsyncMock(return_value="https://x/clip")
    monkeypatch.setattr(video_routes, "get_broll_store", lambda: store)

    # The author_and_render fake writes the mp4 byte-for-byte so the
    # upload step can read it.
    mp4_path = tmp_path / "composed.mp4"
    mp4_path.write_bytes(b"MP4")

    async def fake_render(**_kw):
        return HyperframesRenderResult(
            scenes_html_path=tmp_path / "scenes.html",
            output_mp4_path=mp4_path,
            stdout="",
            stderr="",
        )

    monkeypatch.setattr(video_routes, "author_and_render", fake_render)

    async def fake_record(**kw):
        return VideoStageResult(
            creative_id="vc1",
            iteration_id="vi",
            event_id="ev",
            status="composed",
            new_creative=False,
        )

    monkeypatch.setattr(video_routes, "record_video_stage", fake_record)

    resp = client.post(
        "/work/video/compose",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["composed_path"].endswith(".mp4")


# ---------------------------------------------------------------------------
# /work/video/caption
# ---------------------------------------------------------------------------


def test_caption_409_when_no_composed_path(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "composed_path": None,
            "video_briefs": {"payload": {}, "captions_style": "bold_yellow"},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    resp = client.post(
        "/work/video/caption",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 409
    assert "composed_path" in resp.json()["detail"]


def test_caption_happy_path(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.routes import video as video_routes
    from src.services.atomic_inserts_video import VideoStageResult
    from src.services.submagic import SubmagicJobResult

    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "composed_path": "composed.mp4",
            "captioned_path": None,
            "video_briefs": {"payload": {}, "captions_style": "bold_yellow"},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def caption(self, *_a, **_kw):
            return SubmagicJobResult(
                project_id="proj-1",
                video_url="https://cdn/x.mp4",
                captioned_bytes=b"OUT",
            )

    monkeypatch.setattr(video_routes, "SubmagicClient", FakeClient)

    async def fake_record(**kw):
        return VideoStageResult(
            creative_id="vc1",
            iteration_id="vi",
            event_id="ev",
            status="captioned",
            new_creative=False,
        )

    monkeypatch.setattr(video_routes, "record_video_stage", fake_record)

    resp = client.post(
        "/work/video/caption",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["captioned_path"].endswith(".mp4")
    assert body["submagic_project_id"] == "proj-1"


def test_caption_503_when_submagic_unavailable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.routes import video as video_routes

    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "b1",
            "composed_path": "composed.mp4",
            "video_briefs": {"payload": {}, "captions_style": "bold_yellow"},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def caption(self, *_a, **_kw):
            raise RuntimeError("Submagic submit failed (401): unauthorized")

    monkeypatch.setattr(video_routes, "SubmagicClient", FakeClient)

    resp = client.post(
        "/work/video/caption",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 503
    assert "Submagic" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# V2-16 — every video route acquires the per-brief queue.
# ---------------------------------------------------------------------------


def test_voiceover_acquires_brief_queue(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """One request through /work/video/voiceover must increment the per-brief
    queue depth at the moment the service-side work runs.

    Two requests against the same brief would serialize in production; the
    plain queue test in ``test_queue.py`` already covers concurrent
    contention. This test ensures the route LAYER actually wraps the work
    in ``get_queue().acquire(brief_id)`` so the V2-16 serialization works
    end to end.
    """
    from src.routes import video as video_routes
    from src.services.atomic_inserts_video import VideoStageResult
    from src.services.elevenlabs import VoiceoverSegment
    from src.services.queue import get_queue, reset_queue

    reset_queue()
    queue = get_queue()
    depth_witness: list[int] = []

    sb = _build_supabase_mock()
    _set_select(
        sb,
        {
            "id": "vc1",
            "brief_id": "queued-brief",
            "voiceover_path": None,
            "script_outline": _example_script(),
            "voice_id": "rachel",
            "video_briefs": {"payload": {}, "voice_id": "rachel"},
        },
    )
    _patch_route_supabase(monkeypatch, sb)

    async def fake_synth(**_kw):
        # Inside the critical section: depth must be 1.
        depth_witness.append(queue.depth("queued-brief"))
        seg_file = tmp_path / "seg.mp3"
        seg_file.write_bytes(b"X")
        return [VoiceoverSegment(idx=0, voiceover_text="t", local_path=seg_file, bytes_size=1)]

    monkeypatch.setattr(video_routes, "synthesize_segments", fake_synth)

    async def fake_concat(paths, out, **_kw):
        out.write_bytes(b"CC")
        return out

    monkeypatch.setattr(video_routes, "ffmpeg_concat_mp3", fake_concat)

    async def fake_record(**kw):
        return VideoStageResult(
            creative_id="vc1",
            iteration_id="vi",
            event_id="ev",
            status="voiceover_ready",
            new_creative=False,
        )

    monkeypatch.setattr(video_routes, "record_video_stage", fake_record)

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

    monkeypatch.setattr(video_routes, "ElevenLabsClient", FakeClient)

    resp = client.post(
        "/work/video/voiceover",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "vc1"},
    )
    assert resp.status_code == 200, resp.text
    assert depth_witness == [1]
    # And once the route returns, the queue cleared.
    assert queue.depth("queued-brief") == 0
