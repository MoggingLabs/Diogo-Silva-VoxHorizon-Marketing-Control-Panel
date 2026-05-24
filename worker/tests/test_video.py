"""Tests for the rebuilt video pipeline route handlers (VID-5).

The handlers are thick "fetch + dispatch + record" wrappers, so the boundaries
(the fetch helpers, the kie/ffmpeg/whisper service clients, record_video_stage,
storage, the per-brief queue) are mocked at the module level and we assert on the
control flow: the return shapes the pipeline dispatcher reads, the record_video_stage
calls, the budget cap, and the validation error branches. The pure validators are
asserted directly.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from src.routes import video as vid
from src.routes.video import (
    BrollSearchRequest,
    BrollSelectRequest,
    CaptionRequest,
    ComposeRequest,
    ScriptRequest,
    VoiceoverRequest,
    _coerce_candidates_for_selection,
    _estimate_generation_cost,
    _local_clip_for,
    _parse_script_output,
    _per_ad_budget,
    _segments_from_script,
)
from src.services.atomic_inserts_video import VideoStageResult
from src.services.broll_store import StoredClip


# ---------------------------------------------------------------------------
# Fixtures: mock the handler boundaries
# ---------------------------------------------------------------------------


def _seg(idx: int, **over: Any) -> dict[str, Any]:
    base = {
        "idx": idx,
        "topic": "roof",
        "duration_s": 6,
        "voiceover_text": "We checked the roof and found loose shingles.",
        "voiceover_direction": "calm",
        "broll_query": "roofer inspecting shingles",
        "broll_intent": "demonstrate",
        "captions_emphasis": ["loose"],
    }
    base.update(over)
    return base


def _script(n: int = 2) -> dict[str, Any]:
    return {
        "hook": "Is your roof leaking?",
        "segments": [_seg(i) for i in range(n)],
        "outro": "Book today.",
        "total_duration_s": 6 * n,
    }


class _FakeQueue:
    def acquire(self, _key: str) -> Any:
        return contextlib.nullcontext()


@pytest.fixture
def boundaries(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Patch the shared side-effect boundaries; return a capture dict."""
    cap: dict[str, Any] = {"records": [], "uploads": []}

    monkeypatch.setattr(vid, "get_queue", lambda: _FakeQueue())

    async def fake_record(**kwargs: Any) -> VideoStageResult:
        cap["records"].append(kwargs)
        return VideoStageResult(
            creative_id=kwargs.get("creative_id") or "cr-new",
            iteration_id="it-1",
            event_id="ev-1",
            status="ok",
            new_creative=kwargs.get("creative_id") is None,
        )

    monkeypatch.setattr(vid, "record_video_stage", fake_record)
    monkeypatch.setattr(
        vid,
        "_upload_to_storage",
        lambda *, local_path, storage_path, content_type, bucket="creatives": (
            cap["uploads"].append(storage_path) or storage_path
        ),
    )
    monkeypatch.setattr(vid, "_sign_storage_url", lambda p, *a, **k: f"https://signed/{p}")

    async def fake_download(url: str, dest: Path) -> Path:
        dest.write_bytes(b"x")
        return dest

    monkeypatch.setattr(vid, "_download_to_file", fake_download)
    return cap


def _set_creative(monkeypatch: pytest.MonkeyPatch, creative: dict[str, Any]) -> None:
    monkeypatch.setattr(vid, "_fetch_video_creative", lambda cid: creative)


# ---------------------------------------------------------------------------
# Pure validators
# ---------------------------------------------------------------------------


def test_parse_script_valid() -> None:
    out = _parse_script_output(json.dumps(_script(2)))
    assert len(out["segments"]) == 2


def test_parse_script_strips_fence() -> None:
    out = _parse_script_output("```json\n" + json.dumps(_script(1)) + "\n```")
    assert out["hook"]


def test_parse_script_invalid_json() -> None:
    with pytest.raises(HTTPException) as e:
        _parse_script_output("{not json")
    assert e.value.status_code == 502


def test_parse_script_not_object() -> None:
    with pytest.raises(HTTPException):
        _parse_script_output("[1,2,3]")


def test_parse_script_missing_keys() -> None:
    with pytest.raises(HTTPException, match="missing required keys"):
        _parse_script_output(json.dumps({"hook": "h"}))


def test_parse_script_bad_segment_count() -> None:
    bad = _script(2)
    bad["segments"] = []
    with pytest.raises(HTTPException, match="1-4"):
        _parse_script_output(json.dumps(bad))


def test_parse_script_missing_segment_key() -> None:
    bad = _script(1)
    del bad["segments"][0]["broll_intent"]
    with pytest.raises(HTTPException, match="missing required key"):
        _parse_script_output(json.dumps(bad))


def test_parse_script_noncontiguous_idx() -> None:
    bad = _script(2)
    bad["segments"][1]["idx"] = 5
    with pytest.raises(HTTPException, match="0-contiguous"):
        _parse_script_output(json.dumps(bad))


def test_estimate_and_budget() -> None:
    assert _estimate_generation_cost(3) == pytest.approx(1.2)
    assert _per_ad_budget({}) == vid.DEFAULT_PER_AD_BUDGET_USD
    assert _per_ad_budget({"payload": {"budget_usd": 2.5}}) == 2.5
    assert _per_ad_budget({"payload": {"budget_usd": 0}}) == vid.DEFAULT_PER_AD_BUDGET_USD


def test_coerce_candidates_bad_key() -> None:
    with pytest.raises(HTTPException, match="non-int"):
        _coerce_candidates_for_selection({"x": []})


def test_coerce_and_segments() -> None:
    cands = _coerce_candidates_for_selection(
        {"0": [{"clip_id": "c1", "source_url": "u", "theme": "roof"}]}
    )
    assert cands[0][0].clip_id == "c1"
    segs = _segments_from_script(_script(2))
    assert set(segs) == {0, 1}
    assert segs[0].query == "roofer inspecting shingles"


def test_local_clip_for() -> None:
    cands = {"0": [{"clip_id": "c1", "local_path": "/tmp/c1.mp4"}, {"clip_id": "c2"}]}
    assert _local_clip_for(cands, 0, "c1") == "/tmp/c1.mp4"
    assert _local_clip_for(cands, 0, "c2") is None  # no local_path
    assert _local_clip_for(cands, 0, "zzz") is None  # not found


# ---------------------------------------------------------------------------
# Budget cap (D1)
# ---------------------------------------------------------------------------


def test_search_broll_over_budget_402(
    monkeypatch: pytest.MonkeyPatch, boundaries: dict[str, Any]
) -> None:
    creative = {
        "id": "cr-1",
        "brief_id": "b-1",
        "script_outline": _script(2),
        "video_briefs": {"payload": {"budget_usd": 0.10}},  # tiny budget
    }
    _set_creative(monkeypatch, creative)
    with pytest.raises(HTTPException) as e:
        asyncio.run(search_broll_call())
    assert e.value.status_code == 402
    assert "exceeds per-ad budget" in e.value.detail


async def search_broll_call() -> Any:
    return await vid.search_broll(BrollSearchRequest(creative_id="cr-1"))


# ---------------------------------------------------------------------------
# Validation 409s
# ---------------------------------------------------------------------------


def test_voiceover_no_voice_id_409(
    monkeypatch: pytest.MonkeyPatch, boundaries: dict[str, Any]
) -> None:
    _set_creative(
        monkeypatch,
        {"id": "cr-1", "brief_id": "b-1", "script_outline": _script(1), "video_briefs": {}},
    )
    with pytest.raises(HTTPException) as e:
        asyncio.run(vid.synthesize_voiceover(VoiceoverRequest(creative_id="cr-1")))
    assert e.value.status_code == 409
    assert "voice_id" in e.value.detail


def test_compose_no_voiceover_409(
    monkeypatch: pytest.MonkeyPatch, boundaries: dict[str, Any]
) -> None:
    _set_creative(monkeypatch, {"id": "cr-1", "brief_id": "b-1"})
    with pytest.raises(HTTPException) as e:
        asyncio.run(vid.compose_video(ComposeRequest(creative_id="cr-1")))
    assert e.value.status_code == 409


def test_compose_no_selected_409(
    monkeypatch: pytest.MonkeyPatch, boundaries: dict[str, Any]
) -> None:
    _set_creative(
        monkeypatch,
        {"id": "cr-1", "brief_id": "b-1", "voiceover_path": "vo.mp3", "broll_clips": {}},
    )
    with pytest.raises(HTTPException) as e:
        asyncio.run(vid.compose_video(ComposeRequest(creative_id="cr-1")))
    assert e.value.status_code == 409


def test_caption_no_composed_409(
    monkeypatch: pytest.MonkeyPatch, boundaries: dict[str, Any]
) -> None:
    _set_creative(monkeypatch, {"id": "cr-1", "brief_id": "b-1"})
    with pytest.raises(HTTPException) as e:
        asyncio.run(vid.caption_video(CaptionRequest(creative_id="cr-1")))
    assert e.value.status_code == 409


def test_select_no_candidates_409(
    monkeypatch: pytest.MonkeyPatch, boundaries: dict[str, Any]
) -> None:
    _set_creative(
        monkeypatch,
        {"id": "cr-1", "brief_id": "b-1", "script_outline": _script(1), "broll_clips": {}},
    )
    with pytest.raises(HTTPException) as e:
        asyncio.run(vid.select_broll(BrollSelectRequest(creative_id="cr-1")))
    assert e.value.status_code == 409


# ---------------------------------------------------------------------------
# Happy paths (mocked services)
# ---------------------------------------------------------------------------


def test_generate_script_happy(
    monkeypatch: pytest.MonkeyPatch, boundaries: dict[str, Any]
) -> None:
    monkeypatch.setattr(vid, "_fetch_video_brief", lambda bid: {"id": "b-1", "payload": {}})

    class _Runner:
        async def run_subprocess(self, prompt: str, cwd: str | None = None) -> str:
            return json.dumps(_script(2))

    monkeypatch.setattr(vid, "ClaudeRunner", _Runner)
    out = asyncio.run(vid.generate_script(ScriptRequest(brief_id="b-1")))
    assert out["ok"] is True
    assert out["script_path"].startswith("b-1/script-")
    assert len(out["script_outline"]["segments"]) == 2
    assert boundaries["records"][0]["stage"] == "script"


def test_generate_script_runner_not_ready_501(
    monkeypatch: pytest.MonkeyPatch, boundaries: dict[str, Any]
) -> None:
    monkeypatch.setattr(vid, "_fetch_video_brief", lambda bid: {"id": "b-1", "payload": {}})

    class _Runner:
        async def run_subprocess(self, prompt: str, cwd: str | None = None) -> str:
            raise NotImplementedError("runner not merged")

    monkeypatch.setattr(vid, "ClaudeRunner", _Runner)
    with pytest.raises(HTTPException) as e:
        asyncio.run(vid.generate_script(ScriptRequest(brief_id="b-1")))
    assert e.value.status_code == 501


def test_voiceover_happy(
    monkeypatch: pytest.MonkeyPatch, boundaries: dict[str, Any]
) -> None:
    _set_creative(
        monkeypatch,
        {
            "id": "cr-1",
            "brief_id": "b-1",
            "voice_id": "v1",
            "script_outline": _script(2),
            "video_briefs": {},
        },
    )

    class _Tts:
        async def synthesize(self, text: str, *, voice: str, speed: float = 1.0) -> Any:
            return SimpleNamespace(audio_url=f"https://kie/{voice}.mp3")

        async def download_audio(self, url: str) -> bytes:
            return b"ID3audio"

    monkeypatch.setattr(vid, "KieTtsClient", _Tts)

    async def fake_concat(parts: list[Path], output: Path) -> Path:
        output.write_bytes(b"concat")
        return output

    monkeypatch.setattr(vid, "_ffmpeg_concat_audio", fake_concat)

    out = asyncio.run(vid.synthesize_voiceover(VoiceoverRequest(creative_id="cr-1")))
    assert out["ok"] is True
    assert out["voiceover_path"].startswith("b-1/voiceover-")
    assert boundaries["records"][0]["stage"] == "voiceover"


def test_broll_search_happy(
    monkeypatch: pytest.MonkeyPatch, boundaries: dict[str, Any]
) -> None:
    _set_creative(
        monkeypatch,
        {"id": "cr-1", "brief_id": "b-1", "script_outline": _script(2), "video_briefs": {}},
    )

    class _Vid:
        async def generate_video(self, prompt: str, **kw: Any) -> Any:
            return SimpleNamespace(video_url="https://kie/gen.mp4")

        async def download_video(self, url: str) -> bytes:
            return b"VIDEO"

    class _Store:
        async def put(self, source_url: str, local_file: Path, **kw: Any) -> StoredClip:
            return StoredClip(
                clip_id="gen-c", source_url=source_url, duration_s=None,
                dimensions=None, store_backend="local", local_path=str(local_file),
            )

    async def fake_scrape(query: str, *, count: int = 5) -> list[Any]:
        return []  # generation supplies the clip; stock empty

    monkeypatch.setattr(vid, "KieVideoClient", _Vid)
    monkeypatch.setattr(vid, "get_broll_store", lambda: _Store())
    monkeypatch.setattr(vid, "scrape_yt_shorts", fake_scrape)

    out = asyncio.run(vid.search_broll(BrollSearchRequest(creative_id="cr-1")))
    assert out["ok"] is True
    assert set(out["candidates"]) == {"0", "1"}
    assert out["candidates"]["0"][0]["clip_id"] == "gen-c"
    assert boundaries["records"][0]["stage"] == "broll_search"


def test_broll_search_all_sources_fail_503(
    monkeypatch: pytest.MonkeyPatch, boundaries: dict[str, Any]
) -> None:
    _set_creative(
        monkeypatch,
        {"id": "cr-1", "brief_id": "b-1", "script_outline": _script(1), "video_briefs": {}},
    )

    class _Vid:
        async def generate_video(self, prompt: str, **kw: Any) -> Any:
            raise RuntimeError("kie down")

        async def download_video(self, url: str) -> bytes:  # pragma: no cover
            return b""

    async def fake_scrape(query: str, *, count: int = 5) -> list[Any]:
        raise RuntimeError("yt-dlp missing")

    monkeypatch.setattr(vid, "KieVideoClient", _Vid)
    monkeypatch.setattr(vid, "get_broll_store", lambda: SimpleNamespace())
    monkeypatch.setattr(vid, "scrape_yt_shorts", fake_scrape)

    with pytest.raises(HTTPException) as e:
        asyncio.run(vid.search_broll(BrollSearchRequest(creative_id="cr-1")))
    assert e.value.status_code == 503


def test_select_broll_auto_happy(
    monkeypatch: pytest.MonkeyPatch, boundaries: dict[str, Any]
) -> None:
    creative = {
        "id": "cr-1",
        "brief_id": "b-1",
        "script_outline": _script(1),
        "broll_clips": {
            "candidates": {
                "0": [
                    {"clip_id": "c1", "source_url": "u1", "theme": "roof"},
                    {"clip_id": "c2", "source_url": "u2", "theme": "other"},
                ]
            }
        },
        "video_briefs": {"broll_selection_mode": "auto"},
    }
    _set_creative(monkeypatch, creative)
    out = asyncio.run(vid.select_broll(BrollSelectRequest(creative_id="cr-1")))
    assert out["ok"] is True
    assert "0" in out["resolved"]  # auto resolved the segment
    assert boundaries["records"][0]["stage"] == "broll_pick"


def test_compose_happy(
    monkeypatch: pytest.MonkeyPatch, boundaries: dict[str, Any], tmp_path: Path
) -> None:
    clip = tmp_path / "c1.mp4"
    clip.write_bytes(b"clip")
    creative = {
        "id": "cr-1",
        "brief_id": "b-1",
        "voiceover_path": "b-1/vo.mp3",
        "broll_clips": {
            "selected": {"0": {"clip_id": "c1", "source_url": "u1"}},
            "candidates": {"0": [{"clip_id": "c1", "local_path": str(clip)}]},
        },
    }
    _set_creative(monkeypatch, creative)

    async def fake_compose(*, clips: list[Path], output: Path, voiceover: Path) -> Any:
        return SimpleNamespace(output_path=output, raw_stderr="")

    monkeypatch.setattr(vid, "ffmpeg_compose", fake_compose)
    out = asyncio.run(vid.compose_video(ComposeRequest(creative_id="cr-1")))
    assert out["ok"] is True
    assert out["composed_path"].startswith("b-1/composed-")
    assert boundaries["records"][0]["stage"] == "composed"


def test_caption_happy(
    monkeypatch: pytest.MonkeyPatch, boundaries: dict[str, Any]
) -> None:
    _set_creative(
        monkeypatch,
        {
            "id": "cr-1",
            "brief_id": "b-1",
            "composed_path": "b-1/composed.mp4",
            "voiceover_path": "b-1/vo.mp3",
        },
    )

    async def fake_burn(*, video: Path, audio: Path, output: Path) -> Any:
        return SimpleNamespace(output_path=output, ass_path=output, cue_count=4)

    monkeypatch.setattr(vid, "burn_captions_into_video", fake_burn)
    out = asyncio.run(vid.caption_video(CaptionRequest(creative_id="cr-1")))
    assert out["ok"] is True
    assert out["captioned_path"].startswith("b-1/captioned-")
    assert boundaries["records"][0]["stage"] == "captioned"


# ---------------------------------------------------------------------------
# Helper plumbing (real bodies via the conftest FakeSupabase + mocked ffmpeg)
# ---------------------------------------------------------------------------


def test_fetch_brief_and_creative_404(
    monkeypatch: pytest.MonkeyPatch, fake_supabase: Any
) -> None:
    monkeypatch.setattr(vid, "get_supabase_admin", lambda: fake_supabase)
    fake_supabase.set_single("video_briefs", None)
    fake_supabase.set_single("video_creatives", None)
    with pytest.raises(HTTPException) as e1:
        vid._fetch_video_brief("missing")
    assert e1.value.status_code == 404
    with pytest.raises(HTTPException) as e2:
        vid._fetch_video_creative("missing")
    assert e2.value.status_code == 404


def test_fetch_brief_and_creative_happy(
    monkeypatch: pytest.MonkeyPatch, fake_supabase: Any
) -> None:
    monkeypatch.setattr(vid, "get_supabase_admin", lambda: fake_supabase)
    fake_supabase.set_single("video_briefs", {"id": "b-1", "voice_id": "v"})
    fake_supabase.set_single("video_creatives", {"id": "cr-1", "brief_id": "b-1"})
    assert vid._fetch_video_brief("b-1")["id"] == "b-1"
    assert vid._fetch_video_creative("cr-1")["brief_id"] == "b-1"


def test_brief_id_from_creative_409() -> None:
    with pytest.raises(HTTPException) as e:
        vid._brief_id_from_creative({"id": "cr-1"})
    assert e.value.status_code == 409


def test_script_of_fallback_and_missing() -> None:
    # Falls back to the brief payload when the creative has no script_outline.
    brief = {"payload": {"script_outline": _script(1)}}
    assert vid._script_of({"id": "cr"}, brief)["hook"]
    with pytest.raises(HTTPException) as e:
        vid._script_of({"id": "cr"}, {})
    assert e.value.status_code == 409


def test_upload_to_storage(
    monkeypatch: pytest.MonkeyPatch, fake_supabase: Any, tmp_path: Path
) -> None:
    monkeypatch.setattr(vid, "get_supabase_admin", lambda: fake_supabase)
    f = tmp_path / "a.mp4"
    f.write_bytes(b"data")
    out = vid._upload_to_storage(local_path=f, storage_path="b/a.mp4", content_type="video/mp4")
    assert out == "b/a.mp4"
    assert fake_supabase.storage_uploads and fake_supabase.storage_uploads[0][0] == "b/a.mp4"
    with pytest.raises(FileNotFoundError):
        vid._upload_to_storage(
            local_path=tmp_path / "nope.mp4", storage_path="x", content_type="video/mp4"
        )


def test_ffmpeg_concat_audio(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(vid.shutil, "which", lambda name: "/usr/bin/ffmpeg")
    out = tmp_path / "out.mp3"

    captured: dict[str, Any] = {}

    async def fake_exec(*argv: Any, **kw: Any) -> Any:
        captured["argv"] = list(argv)
        out.write_bytes(b"concat")

        class _P:
            returncode = 0

            async def communicate(self) -> tuple[bytes, bytes]:
                return (b"", b"")

        return _P()

    monkeypatch.setattr(vid.asyncio, "create_subprocess_exec", fake_exec)
    res = asyncio.run(
        vid._ffmpeg_concat_audio([tmp_path / "a.mp3", tmp_path / "b.mp3"], out)
    )
    assert res == out
    assert any("concat=n=2:v=0:a=1[aout]" in a for a in captured["argv"])


def test_ffmpeg_concat_audio_missing_ffmpeg(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(vid.shutil, "which", lambda name: None)
    with pytest.raises(HTTPException) as e:
        asyncio.run(vid._ffmpeg_concat_audio([tmp_path / "a.mp3"], tmp_path / "o.mp3"))
    assert e.value.status_code == 503


def test_ffmpeg_concat_audio_nonzero(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(vid.shutil, "which", lambda name: "/usr/bin/ffmpeg")

    async def fake_exec(*argv: Any, **kw: Any) -> Any:
        class _P:
            returncode = 1

            async def communicate(self) -> tuple[bytes, bytes]:
                return (b"", b"boom")

        return _P()

    monkeypatch.setattr(vid.asyncio, "create_subprocess_exec", fake_exec)
    with pytest.raises(HTTPException) as e:
        asyncio.run(
            vid._ffmpeg_concat_audio([tmp_path / "a.mp3", tmp_path / "b.mp3"], tmp_path / "o.mp3")
        )
    assert e.value.status_code == 502
