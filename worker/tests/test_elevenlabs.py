"""Tests for the ElevenLabs TTS client + segment synthesizer.

External HTTP calls and ffmpeg are mocked so this runs on CI without an
ElevenLabs API key or ffmpeg installed.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest


SHARED_SECRET = "test-secret-for-elevenlabs"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("ELEVENLABS_API_KEY", "el-test-key")

    from src.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _mock_httpx_client(status_code: int = 200, content: bytes = b"MP3DATA") -> MagicMock:
    """An ``httpx.AsyncClient`` mock with a ``post`` returning the content."""
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.content = content
    resp.text = content.decode("utf-8", errors="replace")

    client = MagicMock(spec=httpx.AsyncClient)
    client.post = AsyncMock(return_value=resp)
    client.get = AsyncMock(return_value=resp)
    client.aclose = AsyncMock()
    return client


# ---------------------------------------------------------------------------
# ElevenLabsClient.synthesize — request shape + auth header
# ---------------------------------------------------------------------------


def test_client_requires_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    from src.config import get_settings
    from src.services.elevenlabs import ElevenLabsClient

    get_settings.cache_clear()
    with pytest.raises(RuntimeError) as exc:
        ElevenLabsClient()
    assert "ELEVENLABS_API_KEY" in str(exc.value)
    get_settings.cache_clear()


def test_synthesize_sends_expected_headers_and_body() -> None:
    from src.services.elevenlabs import ElevenLabsClient

    fake = _mock_httpx_client()
    client = ElevenLabsClient(client=fake)
    out = asyncio.run(client.synthesize("hello world", "rachel"))
    assert out == b"MP3DATA"

    # Single POST to /text-to-speech/<voice_id>
    fake.post.assert_awaited_once()
    url = fake.post.call_args.args[0]
    assert url.endswith("/text-to-speech/rachel")

    headers = fake.post.call_args.kwargs["headers"]
    assert headers["xi-api-key"] == "el-test-key"
    assert headers["accept"] == "audio/mpeg"

    body = fake.post.call_args.kwargs["json"]
    assert body["text"] == "hello world"
    assert body["model_id"].startswith("eleven_")
    assert body["output_format"].startswith("mp3_")
    assert "voice_settings" in body
    assert body["voice_settings"]["speed"] == 1.0


def test_synthesize_raises_on_non_2xx() -> None:
    from src.services.elevenlabs import ElevenLabsClient

    resp = MagicMock(spec=httpx.Response)
    resp.status_code = 401
    resp.text = '{"detail":"bad key"}'
    resp.content = resp.text.encode()
    fake = MagicMock(spec=httpx.AsyncClient)
    fake.post = AsyncMock(return_value=resp)
    fake.aclose = AsyncMock()

    client = ElevenLabsClient(client=fake)
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(client.synthesize("x", "voice"))
    assert "401" in str(exc.value)


def test_synthesize_passes_speed_param_to_voice_settings() -> None:
    from src.services.elevenlabs import ElevenLabsClient

    fake = _mock_httpx_client()
    client = ElevenLabsClient(client=fake)
    asyncio.run(client.synthesize("x", "voice", speed=1.2))
    body = fake.post.call_args.kwargs["json"]
    assert body["voice_settings"]["speed"] == 1.2


# ---------------------------------------------------------------------------
# synthesize_segments — per-segment files written under tmp_root
# ---------------------------------------------------------------------------


def test_synthesize_segments_writes_one_mp3_per_segment(tmp_path: Path) -> None:
    from src.services.elevenlabs import ElevenLabsClient, synthesize_segments

    fake = _mock_httpx_client(content=b"FAKE-MP3")
    client = ElevenLabsClient(client=fake)
    out = asyncio.run(
        synthesize_segments(
            client=client,
            segments=[
                {"idx": 0, "voiceover_text": "hook"},
                {"idx": 1, "voiceover_text": "body"},
            ],
            voice_id="voice-a",
            tmp_root=tmp_path / "vo",
        )
    )

    assert [s.idx for s in out] == [0, 1]
    for seg in out:
        assert seg.local_path.exists()
        assert seg.local_path.read_bytes() == b"FAKE-MP3"
        assert seg.bytes_size == len(b"FAKE-MP3")

    # Two synthesize calls, in order, with the right text + voice id.
    assert fake.post.await_count == 2
    first = fake.post.call_args_list[0]
    second = fake.post.call_args_list[1]
    assert first.kwargs["json"]["text"] == "hook"
    assert second.kwargs["json"]["text"] == "body"
    assert first.args[0].endswith("/text-to-speech/voice-a")


def test_synthesize_segments_rejects_empty_text(tmp_path: Path) -> None:
    from src.services.elevenlabs import ElevenLabsClient, synthesize_segments

    fake = _mock_httpx_client()
    client = ElevenLabsClient(client=fake)
    with pytest.raises(ValueError) as exc:
        asyncio.run(
            synthesize_segments(
                client=client,
                segments=[{"idx": 0, "voiceover_text": "   "}],
                voice_id="voice-a",
                tmp_root=tmp_path,
            )
        )
    assert "empty voiceover_text" in str(exc.value)


# ---------------------------------------------------------------------------
# ffmpeg_concat_mp3 — builds concat list + invokes ffmpeg
# ---------------------------------------------------------------------------


def test_ffmpeg_concat_mp3_invokes_ffmpeg_with_concat_demuxer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.services import elevenlabs

    # Stage two MP3 segment files.
    seg_a = tmp_path / "a.mp3"
    seg_b = tmp_path / "b.mp3"
    seg_a.write_bytes(b"AAA")
    seg_b.write_bytes(b"BBB")

    captured: dict[str, list[str]] = {}

    async def fake_exec(*args, **kwargs):
        captured["cmd"] = list(args)
        proc = MagicMock()
        proc.returncode = 0
        proc.communicate = AsyncMock(return_value=(b"", b""))
        return proc

    monkeypatch.setattr(elevenlabs.asyncio, "create_subprocess_exec", fake_exec)
    # Force a deterministic ffmpeg binary path.
    monkeypatch.setattr(elevenlabs.shutil, "which", lambda _name: "/usr/bin/ffmpeg")

    out_path = tmp_path / "concat.mp3"
    result = asyncio.run(elevenlabs.ffmpeg_concat_mp3([seg_a, seg_b], out_path))
    assert result == out_path.resolve()

    cmd = captured["cmd"]
    assert cmd[0] == "/usr/bin/ffmpeg"
    assert "-f" in cmd and "concat" in cmd
    assert "-safe" in cmd and "0" in cmd
    assert "-c" in cmd and "copy" in cmd
    # The concat list file is written and referenced.
    concat_file = out_path.with_suffix(".mp3.concat.txt")
    assert concat_file.exists()
    body = concat_file.read_text()
    assert str(seg_a.resolve()) in body
    assert str(seg_b.resolve()) in body


def test_ffmpeg_concat_mp3_raises_on_nonzero_exit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from src.services import elevenlabs

    seg = tmp_path / "x.mp3"
    seg.write_bytes(b"DATA")

    async def fake_exec(*_args, **_kwargs):
        proc = MagicMock()
        proc.returncode = 1
        proc.communicate = AsyncMock(return_value=(b"", b"ffmpeg boom"))
        return proc

    monkeypatch.setattr(elevenlabs.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(elevenlabs.shutil, "which", lambda _name: "/usr/bin/ffmpeg")

    with pytest.raises(RuntimeError) as exc:
        asyncio.run(elevenlabs.ffmpeg_concat_mp3([seg], tmp_path / "out.mp3"))
    assert "ffmpeg boom" in str(exc.value)


def test_ffmpeg_concat_mp3_rejects_empty_input(tmp_path: Path) -> None:
    from src.services.elevenlabs import ffmpeg_concat_mp3

    with pytest.raises(ValueError):
        asyncio.run(ffmpeg_concat_mp3([], tmp_path / "out.mp3"))
