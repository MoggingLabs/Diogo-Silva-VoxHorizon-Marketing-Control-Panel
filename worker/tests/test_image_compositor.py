"""Tests for the image_compositor.py subprocess wrapper."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.services import image_compositor as ic
from src.services.image_compositor import (
    CompositorError,
    CompositorResult,
    composite,
)


SHARED_SECRET = "test-secret-for-compositor-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")

    from src.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _make_subprocess(
    returncode: int = 0,
    stdout: bytes = b"",
    stderr: bytes = b"",
) -> AsyncMock:
    proc = MagicMock()
    proc.returncode = returncode
    proc.communicate = AsyncMock(return_value=(stdout, stderr))
    return AsyncMock(return_value=proc)


def _stub_scripts(tmp_path: Path) -> Path:
    """Drop a placeholder image_compositor.py under tmp_path."""
    scripts_dir = tmp_path / "creative-tools"
    scripts_dir.mkdir(parents=True)
    (scripts_dir / "image_compositor.py").write_text("# stub\n")
    return tmp_path


def _stub_input(tmp_path: Path) -> Path:
    p = tmp_path / "input.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n")
    return p


def test_raises_runtime_error_when_script_missing(tmp_path: Path) -> None:
    in_path = _stub_input(tmp_path)
    out_path = tmp_path / "out.png"
    with pytest.raises(RuntimeError, match="image_compositor.py not found"):
        asyncio.run(
            composite(
                in_path,
                out_path,
                headline="X",
                scripts_root=tmp_path / "missing",
            )
        )


def test_raises_compositor_error_when_input_missing(tmp_path: Path) -> None:
    _stub_scripts(tmp_path)
    out_path = tmp_path / "out.png"
    with pytest.raises(CompositorError, match="input_path does not exist"):
        asyncio.run(
            composite(
                tmp_path / "no-such.png",
                out_path,
                headline="X",
                scripts_root=tmp_path,
            )
        )


def test_raises_compositor_error_when_headline_missing(tmp_path: Path) -> None:
    _stub_scripts(tmp_path)
    in_path = _stub_input(tmp_path)
    with pytest.raises(CompositorError, match="headline is required"):
        asyncio.run(
            composite(
                in_path,
                tmp_path / "out.png",
                headline=None,
                scripts_root=tmp_path,
            )
        )


def test_returns_output_path_on_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _stub_scripts(tmp_path)
    in_path = _stub_input(tmp_path)
    out_path = tmp_path / "composed.png"

    # The fake subprocess "writes" the output before returning.
    def fake_subprocess(*args, **kwargs):
        out_path.write_bytes(b"OUTPUT")
        proc = MagicMock()
        proc.returncode = 0
        proc.communicate = AsyncMock(return_value=(b"", b""))
        return proc

    monkeypatch.setattr(ic.asyncio, "create_subprocess_exec", AsyncMock(side_effect=fake_subprocess))

    result = asyncio.run(
        composite(
            in_path,
            out_path,
            headline="Best Estimate",
            cta="Get Quote",
            style="bold-bottom",
            output_format="1x1",
            scripts_root=root,
        )
    )
    assert isinstance(result, CompositorResult)
    assert result.output_path == out_path
    assert out_path.exists()


def test_propagates_subprocess_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _stub_scripts(tmp_path)
    in_path = _stub_input(tmp_path)
    out_path = tmp_path / "composed.png"

    fake_exec = _make_subprocess(returncode=1, stderr=b"missing font")
    monkeypatch.setattr(ic.asyncio, "create_subprocess_exec", fake_exec)

    with pytest.raises(CompositorError, match="missing font"):
        asyncio.run(
            composite(
                in_path,
                out_path,
                headline="X",
                scripts_root=root,
            )
        )


def test_args_include_optional_flags(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the caller provides extras, they show up on the CLI."""
    root = _stub_scripts(tmp_path)
    in_path = _stub_input(tmp_path)
    out_path = tmp_path / "composed.png"

    captured: dict = {}

    async def fake_exec(*args, **kwargs):
        captured["args"] = list(args)
        out_path.write_bytes(b"OK")
        proc = MagicMock()
        proc.returncode = 0
        proc.communicate = AsyncMock(return_value=(b"", b""))
        return proc

    monkeypatch.setattr(ic.asyncio, "create_subprocess_exec", fake_exec)

    asyncio.run(
        composite(
            in_path,
            out_path,
            headline="H",
            subtext="S",
            cta="C",
            offer_bar="O",
            city="Austin",
            color="#1a1a2e",
            accent_color="#e94560",
            style="offer-banner",
            output_format="9x16",
            scripts_root=root,
        )
    )
    args = captured["args"]
    # Must include every flag we supplied.
    assert "--headline" in args and "H" in args
    assert "--subtext" in args and "S" in args
    assert "--cta" in args and "C" in args
    assert "--offer-bar" in args and "O" in args
    assert "--city" in args and "Austin" in args
    assert "--color" in args and "#1a1a2e" in args
    assert "--accent-color" in args and "#e94560" in args
    assert "--style" in args and "offer-banner" in args
    assert "--format" in args and "9x16" in args


def test_logo_flag_is_propagated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When `logo_path` is provided, the script gets `--logo <path>`."""
    root = _stub_scripts(tmp_path)
    in_path = _stub_input(tmp_path)
    out_path = tmp_path / "composed.png"
    logo = tmp_path / "logo.png"
    logo.write_bytes(b"L")

    captured: dict = {}

    async def fake_exec(*args, **kwargs):
        captured["args"] = list(args)
        out_path.write_bytes(b"OK")
        proc = MagicMock()
        proc.returncode = 0
        proc.communicate = AsyncMock(return_value=(b"", b""))
        return proc

    monkeypatch.setattr(ic.asyncio, "create_subprocess_exec", fake_exec)

    asyncio.run(
        composite(
            in_path,
            out_path,
            headline="H",
            logo_path=logo,
            scripts_root=root,
        )
    )
    args = captured["args"]
    assert "--logo" in args
    assert str(logo) in args


def test_format_both_resolves_to_1x1_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`format=both` → resolver prefers the `_1x1.png` sibling when present."""
    root = _stub_scripts(tmp_path)
    in_path = _stub_input(tmp_path)
    out_stem = tmp_path / "composed.png"

    cand_1 = out_stem.parent / f"{out_stem.stem}_1x1.png"
    cand_2 = out_stem.parent / f"{out_stem.stem}_9x16.png"

    async def fake_exec(*args, **kwargs):
        cand_1.write_bytes(b"ONE")
        cand_2.write_bytes(b"TWO")
        proc = MagicMock()
        proc.returncode = 0
        proc.communicate = AsyncMock(return_value=(b"", b""))
        return proc

    monkeypatch.setattr(ic.asyncio, "create_subprocess_exec", fake_exec)

    result = asyncio.run(
        composite(
            in_path,
            out_stem,
            headline="H",
            output_format="both",
            scripts_root=root,
        )
    )
    assert result.output_path == cand_1


def test_format_both_falls_back_to_9x16_when_only_that_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When only the 9x16 sibling exists, the resolver picks it."""
    root = _stub_scripts(tmp_path)
    in_path = _stub_input(tmp_path)
    out_stem = tmp_path / "composed.png"
    cand_2 = out_stem.parent / f"{out_stem.stem}_9x16.png"

    async def fake_exec(*args, **kwargs):
        cand_2.write_bytes(b"TWO")
        proc = MagicMock()
        proc.returncode = 0
        proc.communicate = AsyncMock(return_value=(b"", b""))
        return proc

    monkeypatch.setattr(ic.asyncio, "create_subprocess_exec", fake_exec)

    result = asyncio.run(
        composite(
            in_path,
            out_stem,
            headline="H",
            output_format="both",
            scripts_root=root,
        )
    )
    assert result.output_path == cand_2


def test_raises_compositor_error_when_output_not_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Zero exit but no file → CompositorError."""
    root = _stub_scripts(tmp_path)
    in_path = _stub_input(tmp_path)
    out_path = tmp_path / "never-written.png"

    async def fake_exec(*args, **kwargs):
        proc = MagicMock()
        proc.returncode = 0
        proc.communicate = AsyncMock(return_value=(b"hi", b""))
        return proc

    monkeypatch.setattr(ic.asyncio, "create_subprocess_exec", fake_exec)

    with pytest.raises(CompositorError, match="reported success but"):
        asyncio.run(
            composite(
                in_path,
                out_path,
                headline="H",
                scripts_root=root,
            )
        )
