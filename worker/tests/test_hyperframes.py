"""Tests for the Hyperframes scene authoring + render adapter.

Template rendering is exercised against the real Jinja file so a missing
field or typo lights up immediately. The CLI render is mocked via
``asyncio.create_subprocess_exec``.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", "x")
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    from src.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Template rendering
# ---------------------------------------------------------------------------


def _example_script() -> dict:
    return {
        "hook": "Stop scrolling if you live in Texas.",
        "hook_duration_s": 3,
        "segments": [
            {
                "idx": 0,
                "topic": "establish problem",
                "duration_s": 4.5,
                "voiceover_text": "Most homeowners don't realize their roof is failing.",
                "voiceover_direction": "energetic",
                "broll_query": "texas roof drone shot",
                "broll_intent": "establish home, vertical drone",
                "captions_emphasis": ["failing"],
            },
            {
                "idx": 1,
                "topic": "show the cost",
                "duration_s": 5.0,
                "voiceover_text": "By the time you spot a leak, you're at 12 grand.",
                "voiceover_direction": "deadpan",
                "broll_query": "water damage ceiling",
                "broll_intent": "consequence frame",
                "captions_emphasis": ["12 grand"],
            },
        ],
        "outro": {
            "voiceover_text": "Tap below to claim a free quote.",
            "cta_overlay": "Claim Free Quote",
            "duration_s": 3.5,
        },
        "total_duration_s": 16,
    }


def test_build_timeline_pairs_each_segment_with_selected_clip() -> None:
    from src.services.hyperframes import build_timeline_from_script

    timeline = build_timeline_from_script(
        script_outline=_example_script(),
        selected_clips={0: "https://x/a", 1: "https://x/b"},
    )
    assert len(timeline) == 2
    # Hook duration of 3s pushes segment 0 to start at 3.
    assert timeline[0].start_s == 3.0
    assert timeline[0].end_s == pytest.approx(7.5)
    assert timeline[1].start_s == pytest.approx(7.5)
    assert timeline[1].end_s == pytest.approx(12.5)
    assert timeline[0].broll_url == "https://x/a"
    assert timeline[1].broll_url == "https://x/b"
    assert timeline[0].captions_emphasis == ("failing",)


def test_build_timeline_raises_when_clip_is_missing_for_segment() -> None:
    from src.services.hyperframes import build_timeline_from_script

    with pytest.raises(ValueError) as exc:
        build_timeline_from_script(
            script_outline=_example_script(),
            selected_clips={0: "u"},  # missing idx=1
        )
    assert "idx=1" in str(exc.value)


def test_build_timeline_raises_on_non_contiguous_idx() -> None:
    from src.services.hyperframes import build_timeline_from_script

    script = _example_script()
    script["segments"][0]["idx"] = 5  # break contiguity
    with pytest.raises(ValueError) as exc:
        build_timeline_from_script(
            script_outline=script,
            selected_clips={5: "a", 1: "b"},
        )
    assert "0-contiguous" in str(exc.value)


def test_render_scene_html_emits_expected_tags() -> None:
    from src.services.hyperframes import render_scene_html, scene_from_script

    scene = scene_from_script(
        script_outline=_example_script(),
        selected_clips={0: "https://x/a", 1: "https://x/b"},
        voiceover_url="https://x/vo.mp3",
        dimensions="9x16",
        captions_style="bold_yellow",
    )
    html = render_scene_html(scene)
    assert "<hf-scene" in html
    assert "dimensions=\"9x16\"" in html
    assert "<hf-audio" in html
    assert "https://x/vo.mp3" in html
    # Both segments rendered.
    assert "https://x/a" in html
    assert "https://x/b" in html
    # Captions rendered with style.
    assert "style=\"bold_yellow\"" in html
    # Hook overlay present.
    assert "Stop scrolling if you live in Texas." in html
    # CTA overlay rendered.
    assert "Claim Free Quote" in html


def test_render_scene_html_omits_captions_when_style_is_none() -> None:
    from src.services.hyperframes import render_scene_html, scene_from_script

    scene = scene_from_script(
        script_outline=_example_script(),
        selected_clips={0: "u", 1: "u"},
        voiceover_url="vo",
        dimensions="9x16",
        captions_style="none",
    )
    html = render_scene_html(scene)
    assert "<hf-captions" not in html


def test_scene_from_script_computes_total_when_missing() -> None:
    from src.services.hyperframes import scene_from_script

    script = _example_script()
    script["total_duration_s"] = 0
    scene = scene_from_script(
        script_outline=script,
        selected_clips={0: "a", 1: "b"},
        voiceover_url="vo",
        dimensions="9x16",
        captions_style="bold_yellow",
    )
    # hook 3 + 4.5 + 5.0 (segments) + outro 3.5 = 16.0 — computed when the
    # script omits total_duration_s.
    assert scene.total_duration_s == pytest.approx(16.0)


# ---------------------------------------------------------------------------
# render_to_mp4
# ---------------------------------------------------------------------------


def test_render_to_mp4_raises_when_binary_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.services import hyperframes

    monkeypatch.setattr(hyperframes.shutil, "which", lambda _n: None)
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(
            hyperframes.render_to_mp4(
                tmp_path / "scenes.html", tmp_path / "out.mp4"
            )
        )
    assert "hyperframes" in str(exc.value).lower()


def test_render_to_mp4_invokes_cli_when_present(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.services import hyperframes

    captured: dict = {}

    async def fake_exec(*args, **kwargs):
        captured["cmd"] = list(args)
        proc = MagicMock()
        proc.returncode = 0
        proc.communicate = AsyncMock(return_value=(b"ok", b""))
        return proc

    monkeypatch.setattr(hyperframes.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(
        hyperframes.shutil, "which", lambda _n: "/usr/bin/hyperframes"
    )

    scenes_html = tmp_path / "scenes.html"
    out_mp4 = tmp_path / "out.mp4"
    scenes_html.write_text("<html/>")

    result = asyncio.run(hyperframes.render_to_mp4(scenes_html, out_mp4))
    assert result.output_mp4_path == out_mp4.resolve()
    assert result.scenes_html_path == scenes_html
    assert captured["cmd"][0] == "/usr/bin/hyperframes"
    assert captured["cmd"][1] == "render"
    assert str(scenes_html) in captured["cmd"]


def test_render_to_mp4_raises_on_non_zero_exit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.services import hyperframes

    async def fake_exec(*_args, **_kwargs):
        proc = MagicMock()
        proc.returncode = 2
        proc.communicate = AsyncMock(return_value=(b"", b"render failed"))
        return proc

    monkeypatch.setattr(hyperframes.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(
        hyperframes.shutil, "which", lambda _n: "/usr/bin/hyperframes"
    )

    with pytest.raises(RuntimeError) as exc:
        asyncio.run(
            hyperframes.render_to_mp4(tmp_path / "s.html", tmp_path / "out.mp4")
        )
    assert "render failed" in str(exc.value)


def test_author_and_render_writes_html_then_runs_cli(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.services import hyperframes
    from src.services.hyperframes import scene_from_script

    async def fake_exec(*_args, **_kwargs):
        proc = MagicMock()
        proc.returncode = 0
        proc.communicate = AsyncMock(return_value=(b"", b""))
        return proc

    monkeypatch.setattr(hyperframes.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(
        hyperframes.shutil, "which", lambda _n: "/usr/bin/hyperframes"
    )

    scene = scene_from_script(
        script_outline=_example_script(),
        selected_clips={0: "a", 1: "b"},
        voiceover_url="vo",
        dimensions="9x16",
        captions_style="bold_yellow",
    )

    work_dir = tmp_path / "work"
    result = asyncio.run(hyperframes.author_and_render(scene=scene, work_dir=work_dir))
    assert (work_dir / "scenes.html").exists()
    assert result.scenes_html_path == (work_dir / "scenes.html").resolve()
    # HTML body looks like our template output.
    body = (work_dir / "scenes.html").read_text()
    assert "<hf-scene" in body


def test_build_timeline_raises_when_segments_empty() -> None:
    """Line 145: empty segments list raises a structured ValueError."""
    from src.services.hyperframes import build_timeline_from_script

    with pytest.raises(ValueError) as exc:
        build_timeline_from_script(
            script_outline={"hook": "x", "segments": []},
            selected_clips={},
        )
    assert "non-empty list" in str(exc.value)


def test_build_timeline_raises_when_segments_not_list() -> None:
    from src.services.hyperframes import build_timeline_from_script

    with pytest.raises(ValueError) as exc:
        build_timeline_from_script(
            script_outline={"hook": "x", "segments": "not-a-list"},
            selected_clips={},
        )
    assert "non-empty list" in str(exc.value)


def test_build_timeline_raises_when_segment_not_dict() -> None:
    """Line 156: per-segment object guard fires when a segment is a string."""
    from src.services.hyperframes import build_timeline_from_script

    with pytest.raises(ValueError) as exc:
        build_timeline_from_script(
            script_outline={"hook": "x", "segments": ["not-a-dict"]},
            selected_clips={},
        )
    assert "not an object" in str(exc.value)
