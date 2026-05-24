"""Tests for the self-hosted caption service.

The cue packer, ASS renderer, and ffmpeg argv builder are pure and asserted
directly. transcribe is driven with a fake WhisperModel (so faster-whisper is
never loaded); the ffmpeg runners use a mocked subprocess + shutil.which.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from src.services import captions as cap_mod
from src.services.captions import (
    CaptionError,
    CaptionResult,
    Cue,
    Word,
    build_ass,
    build_burn_argv,
    burn_captions,
    caption_video,
    group_words_into_cues,
    transcribe,
)
from src.services.captions import _ass_escape, _escape_filter_path, _fmt_ass_ts


def _w(text: str, start: float, end: float) -> Word:
    return Word(text=text, start=start, end=end)


# ---------------------------------------------------------------------------
# group_words_into_cues (pure)
# ---------------------------------------------------------------------------


def test_group_empty_returns_empty() -> None:
    assert group_words_into_cues([]) == []


def test_group_skips_blank_words() -> None:
    cues = group_words_into_cues([_w("  ", 0.0, 0.1), _w("hi", 0.1, 0.4)])
    assert len(cues) == 1
    assert cues[0].text == "hi"


def test_group_packs_until_max_chars() -> None:
    words = [_w(f"w{i}", float(i), float(i) + 0.2) for i in range(10)]
    cues = group_words_into_cues(words, max_chars=8, max_gap=99, max_cue_dur=999)
    # "w0 w1" = 5 chars; adding " w2" -> 8 ok; " w3" -> 11 > 8 -> split.
    assert all(len(c.text) <= 8 for c in cues)
    assert len(cues) > 1
    # Cue boundaries carry the right timings.
    assert cues[0].start == 0.0
    assert cues[0].end == words[len(cues[0].text.split()) - 1].end


def test_group_splits_on_gap() -> None:
    words = [_w("a", 0.0, 0.4), _w("b", 2.0, 2.4)]  # 1.6s gap
    cues = group_words_into_cues(words, max_gap=0.6, max_chars=99, max_cue_dur=999)
    assert [c.text for c in cues] == ["a", "b"]


def test_group_splits_on_duration() -> None:
    words = [_w("a", 0.0, 0.4), _w("b", 0.5, 5.0)]  # cue would span 5s
    cues = group_words_into_cues(words, max_cue_dur=3.0, max_gap=99, max_chars=99)
    assert [c.text for c in cues] == ["a", "b"]


# ---------------------------------------------------------------------------
# timestamp + escaping helpers (pure)
# ---------------------------------------------------------------------------


def test_fmt_ass_ts() -> None:
    assert _fmt_ass_ts(0) == "0:00:00.00"
    assert _fmt_ass_ts(1.5) == "0:00:01.50"
    assert _fmt_ass_ts(75.25) == "0:01:15.25"
    assert _fmt_ass_ts(3661.0) == "1:01:01.00"


def test_fmt_ass_ts_clamps_negative() -> None:
    assert _fmt_ass_ts(-3.0) == "0:00:00.00"


def test_ass_escape_neutralizes_braces_and_newlines() -> None:
    assert _ass_escape("a{b}c") == "a(b)c"
    assert _ass_escape("line1\nline2") == "line1\\Nline2"
    assert _ass_escape("  trim  ") == "trim"


# ---------------------------------------------------------------------------
# build_ass (pure)
# ---------------------------------------------------------------------------


def test_build_ass_structure_and_dialogue() -> None:
    cues = [Cue("hello world", 0.0, 0.9), Cue("buy now", 1.0, 1.8)]
    ass = build_ass(cues, width=1080, height=1920)
    assert "[Script Info]" in ass
    assert "PlayResX: 1080" in ass
    assert "PlayResY: 1920" in ass
    assert "[V4+ Styles]" in ass
    assert "Style: Default,Arial,84," in ass
    assert "[Events]" in ass
    dialogues = [ln for ln in ass.splitlines() if ln.startswith("Dialogue:")]
    assert len(dialogues) == 2
    assert dialogues[0] == "Dialogue: 0,0:00:00.00,0:00:00.90,Default,,0,0,0,,hello world"


def test_build_ass_empty_has_no_dialogue() -> None:
    ass = build_ass([])
    assert "[Events]" in ass
    assert "Dialogue:" not in ass


def test_build_ass_applies_escaping_and_overrides() -> None:
    ass = build_ass([Cue("a{x}b", 0.0, 1.0)], font_size=120, bold=False)
    assert "a(x)b" in ass
    assert ",120," in ass
    # bold=False -> the Bold field is 0 (vs -1 when bold).
    assert "Style: Default,Arial,120,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0," in ass


# ---------------------------------------------------------------------------
# build_burn_argv / _escape_filter_path (pure)
# ---------------------------------------------------------------------------


def test_escape_filter_path() -> None:
    assert _escape_filter_path("/tmp/a.ass") == "/tmp/a.ass"
    assert _escape_filter_path("C:\\x\\a.ass") == "C\\:\\\\x\\\\a.ass"


def test_build_burn_argv() -> None:
    argv = build_burn_argv(video="in.mp4", ass_path="/tmp/c.ass", output="out.mp4")
    assert argv[0] == "ffmpeg"
    assert "-y" in argv
    assert argv[argv.index("-i") + 1] == "in.mp4"
    assert argv[argv.index("-vf") + 1] == "ass=/tmp/c.ass"
    assert "libx264" in argv
    assert "+faststart" in argv
    # audio is stream-copied, never re-encoded.
    assert argv[argv.index("-c:a") + 1] == "copy"
    assert argv[-1] == "out.mp4"


def test_build_burn_argv_threads_ffmpeg_bin() -> None:
    argv = build_burn_argv(
        video="i.mp4", ass_path="c.ass", output="o.mp4", ffmpeg_bin="/usr/bin/ffmpeg"
    )
    assert argv[0] == "/usr/bin/ffmpeg"


# ---------------------------------------------------------------------------
# transcribe (fake WhisperModel)
# ---------------------------------------------------------------------------


class _FakeWWord:
    def __init__(self, word: str, start: float, end: float) -> None:
        self.word = word
        self.start = start
        self.end = end


class _FakeSegment:
    def __init__(self, words: list[_FakeWWord]) -> None:
        self.words = words


class _FakeModel:
    def __init__(self, segments: list[_FakeSegment]) -> None:
        self._segments = segments
        self.calls: list[dict] = []

    def transcribe(self, path: str, language=None, word_timestamps=False):  # noqa: ANN001, ANN201
        self.calls.append(
            {"path": path, "language": language, "word_timestamps": word_timestamps}
        )
        return (iter(self._segments), {"language": "en"})


def test_transcribe_flattens_words(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio = tmp_path / "vo.m4a"
    audio.write_bytes(b"x")
    fake = _FakeModel(
        [
            _FakeSegment([_FakeWWord(" Hello", 0.0, 0.4), _FakeWWord(" world", 0.4, 0.9)]),
            _FakeSegment([_FakeWWord(" now", 1.0, 1.3)]),
        ]
    )
    monkeypatch.setattr(cap_mod, "_load_model", lambda *a, **k: fake)

    words = asyncio.run(transcribe(audio, language="en"))
    assert [w.text for w in words] == [" Hello", " world", " now"]
    assert words[0].start == 0.0 and words[-1].end == 1.3
    # word_timestamps must be requested for word-level cues.
    assert fake.calls[0]["word_timestamps"] is True
    assert fake.calls[0]["language"] == "en"


def test_transcribe_missing_audio_raises(tmp_path: Path) -> None:
    with pytest.raises(CaptionError, match="does not exist"):
        asyncio.run(transcribe(tmp_path / "nope.m4a"))


def test_transcribe_handles_segment_without_words(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio = tmp_path / "vo.m4a"
    audio.write_bytes(b"x")
    seg = _FakeSegment([])
    seg.words = None  # faster-whisper yields None when word_timestamps is off
    monkeypatch.setattr(cap_mod, "_load_model", lambda *a, **k: _FakeModel([seg]))
    assert asyncio.run(transcribe(audio)) == []


# ---------------------------------------------------------------------------
# burn_captions (async runner, mocked subprocess)
# ---------------------------------------------------------------------------


class _FakeProc:
    def __init__(self, returncode: int, stderr: bytes) -> None:
        self.returncode = returncode
        self._stderr = stderr

    async def communicate(self) -> tuple[bytes, bytes]:
        return (b"", self._stderr)


def _seed_inputs(tmp_path: Path) -> tuple[Path, Path]:
    video = tmp_path / "in.mp4"
    video.write_bytes(b"v")
    ass = tmp_path / "c.ass"
    ass.write_text("[Events]\n", encoding="utf-8")
    return video, ass


def test_burn_runs_and_returns_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    video, ass = _seed_inputs(tmp_path)
    out = tmp_path / "out.mp4"
    monkeypatch.setattr(cap_mod.shutil, "which", lambda name: "/usr/bin/ffmpeg")

    captured: dict = {}

    async def fake_exec(*argv, **kwargs):  # noqa: ANN002, ANN003
        captured["argv"] = list(argv)
        out.write_bytes(b"VIDEO")
        return _FakeProc(0, b"")

    monkeypatch.setattr(cap_mod.asyncio, "create_subprocess_exec", fake_exec)
    res = asyncio.run(burn_captions(video=video, ass_path=ass, output=out))
    assert res == out
    assert captured["argv"][0] == "/usr/bin/ffmpeg"
    assert "ass=" + _escape_filter_path(str(ass)) in captured["argv"]


def test_burn_missing_ffmpeg_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    video, ass = _seed_inputs(tmp_path)
    monkeypatch.setattr(cap_mod.shutil, "which", lambda name: None)
    with pytest.raises(RuntimeError, match="ffmpeg not found"):
        asyncio.run(burn_captions(video=video, ass_path=ass, output=tmp_path / "o.mp4"))


def test_burn_missing_input_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(cap_mod.shutil, "which", lambda name: "/usr/bin/ffmpeg")
    with pytest.raises(CaptionError, match="does not exist"):
        asyncio.run(
            burn_captions(
                video=tmp_path / "missing.mp4",
                ass_path=tmp_path / "missing.ass",
                output=tmp_path / "o.mp4",
            )
        )


def test_burn_nonzero_exit_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    video, ass = _seed_inputs(tmp_path)
    monkeypatch.setattr(cap_mod.shutil, "which", lambda name: "/usr/bin/ffmpeg")

    async def fake_exec(*argv, **kwargs):  # noqa: ANN002, ANN003
        return _FakeProc(1, b"boom")

    monkeypatch.setattr(cap_mod.asyncio, "create_subprocess_exec", fake_exec)
    with pytest.raises(CaptionError, match="exited 1"):
        asyncio.run(burn_captions(video=video, ass_path=ass, output=tmp_path / "o.mp4"))


def test_burn_success_but_no_output_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    video, ass = _seed_inputs(tmp_path)
    monkeypatch.setattr(cap_mod.shutil, "which", lambda name: "/usr/bin/ffmpeg")

    async def fake_exec(*argv, **kwargs):  # noqa: ANN002, ANN003
        return _FakeProc(0, b"")  # exits 0 but writes nothing

    monkeypatch.setattr(cap_mod.asyncio, "create_subprocess_exec", fake_exec)
    with pytest.raises(CaptionError, match="not written"):
        asyncio.run(burn_captions(video=video, ass_path=ass, output=tmp_path / "o.mp4"))


# ---------------------------------------------------------------------------
# caption_video (orchestrator, transcribe + burn mocked)
# ---------------------------------------------------------------------------


def test_caption_video_writes_ass_and_burns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    video = tmp_path / "in.mp4"
    video.write_bytes(b"v")
    audio = tmp_path / "vo.m4a"
    audio.write_bytes(b"a")
    out = tmp_path / "out.mp4"

    async def fake_transcribe(_audio, **kwargs):  # noqa: ANN001, ANN003
        return [_w("hello", 0.0, 0.4), _w("world", 0.4, 0.9)]

    async def fake_burn(*, video, ass_path, output, ffmpeg_bin=None):  # noqa: ANN001
        Path(output).write_bytes(b"VIDEO")
        return Path(output)

    monkeypatch.setattr(cap_mod, "transcribe", fake_transcribe)
    monkeypatch.setattr(cap_mod, "burn_captions", fake_burn)

    res = asyncio.run(caption_video(video=video, audio=audio, output=out))
    assert isinstance(res, CaptionResult)
    assert res.cue_count == 1
    assert res.output_path == out
    assert res.ass_path == out.with_suffix(".ass")
    ass_text = res.ass_path.read_text(encoding="utf-8")
    assert "Dialogue:" in ass_text
    assert "hello world" in ass_text


def test_load_model_lazy_imports_and_caches(monkeypatch: pytest.MonkeyPatch) -> None:
    import sys
    import types

    constructed: list[tuple] = []

    class _FakeWhisperModel:
        def __init__(self, size, device, compute_type) -> None:  # noqa: ANN001
            constructed.append((size, device, compute_type))

    fake_mod = types.ModuleType("faster_whisper")
    fake_mod.WhisperModel = _FakeWhisperModel  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_mod)

    cap_mod._MODEL_CACHE.clear()
    try:
        m1 = cap_mod._load_model("base", "cpu", "int8")
        m2 = cap_mod._load_model("base", "cpu", "int8")  # cache hit
        assert m1 is m2
        assert constructed == [("base", "cpu", "int8")]  # constructed once
    finally:
        cap_mod._MODEL_CACHE.clear()


def test_caption_video_honors_explicit_ass_path_and_style(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    video = tmp_path / "in.mp4"
    video.write_bytes(b"v")
    audio = tmp_path / "vo.m4a"
    audio.write_bytes(b"a")
    out = tmp_path / "out.mp4"
    ass = tmp_path / "custom.ass"

    async def fake_transcribe(_audio, **kwargs):  # noqa: ANN001, ANN003
        return [_w("buy", 0.0, 0.3)]

    async def fake_burn(*, video, ass_path, output, ffmpeg_bin=None):  # noqa: ANN001
        Path(output).write_bytes(b"V")
        return Path(output)

    monkeypatch.setattr(cap_mod, "transcribe", fake_transcribe)
    monkeypatch.setattr(cap_mod, "burn_captions", fake_burn)

    res = asyncio.run(
        caption_video(video=video, audio=audio, output=out, ass_path=ass, font_size=120)
    )
    assert res.ass_path == ass
    assert ",120," in ass.read_text(encoding="utf-8")
