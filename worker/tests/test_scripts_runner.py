"""Tests for `src/services/scripts_runner.py`.

Covers:

* The placeholder `ScriptsRunner` (default ctor + NotImplementedError).
* `run_launch_package_validate` happy path / missing-script / non-JSON
  stdout / non-zero exit.
* `run_kie_generate` and `run_image_composite` re-export shims.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.services import scripts_runner as sr


SHARED_SECRET = "test-secret-for-scripts-runner-tests"


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
    yield
    get_settings.cache_clear()


def _stub_launch_package(tmp_path: Path) -> Path:
    """Drop a placeholder launch_package.py under tmp_path."""
    scripts_dir = tmp_path / "campaign-ops"
    scripts_dir.mkdir(parents=True)
    (scripts_dir / "launch_package.py").write_text("# stub\n")
    return tmp_path


# ---------------------------------------------------------------------------
# ScriptsRunner placeholder
# ---------------------------------------------------------------------------


def test_scripts_runner_default_init_uses_default_root() -> None:
    """The placeholder accepts the default scripts root."""
    runner = sr.ScriptsRunner()
    assert runner.scripts_root == sr.DEFAULT_SCRIPTS_ROOT


def test_scripts_runner_run_raises_not_implemented() -> None:
    runner = sr.ScriptsRunner(scripts_root=Path("/tmp"))
    with pytest.raises(NotImplementedError):
        asyncio.run(runner.run("any-script"))


# ---------------------------------------------------------------------------
# _resolve_launch_package_script
# ---------------------------------------------------------------------------


def test_resolve_launch_package_returns_none_when_missing(tmp_path: Path) -> None:
    """Missing checkout → None so the route can return a clean 503."""
    assert sr._resolve_launch_package_script(tmp_path / "missing") is None


def test_resolve_launch_package_returns_path_when_present(tmp_path: Path) -> None:
    _stub_launch_package(tmp_path)
    resolved = sr._resolve_launch_package_script(tmp_path)
    assert resolved is not None
    assert resolved.name == "launch_package.py"


# ---------------------------------------------------------------------------
# run_launch_package_validate
# ---------------------------------------------------------------------------


def test_run_launch_package_validate_raises_when_missing(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="launch_package.py not found"):
        asyncio.run(
            sr.run_launch_package_validate(
                brief_id="b",
                format="image",
                scripts_root=tmp_path / "nowhere",
            )
        )


def test_run_launch_package_validate_parses_json_stdout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the script emits `{ok, issues}` JSON, surface it directly."""
    _stub_launch_package(tmp_path)

    payload_out = json.dumps({"ok": True, "issues": []}).encode("utf-8")

    async def fake_exec(*args, **kwargs):
        proc = MagicMock()
        proc.returncode = 0
        proc.communicate = AsyncMock(return_value=(payload_out, b""))
        return proc

    monkeypatch.setattr(sr.asyncio, "create_subprocess_exec", fake_exec)

    result = asyncio.run(
        sr.run_launch_package_validate(
            brief_id="b-1",
            format="image",
            payload={"some": "thing"},
            scripts_root=tmp_path,
        )
    )
    assert result.ok is True
    assert result.issues == []


def test_run_launch_package_validate_reads_issues_list(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A `{ok: false, issues: [...]}` payload should populate `issues`."""
    _stub_launch_package(tmp_path)

    payload_out = json.dumps(
        {"ok": False, "issues": ["missing drive folder", "no copy"]}
    ).encode("utf-8")

    async def fake_exec(*args, **kwargs):
        proc = MagicMock()
        proc.returncode = 1
        proc.communicate = AsyncMock(return_value=(payload_out, b""))
        return proc

    monkeypatch.setattr(sr.asyncio, "create_subprocess_exec", fake_exec)

    result = asyncio.run(
        sr.run_launch_package_validate(
            brief_id="b-1",
            format="image",
            scripts_root=tmp_path,
        )
    )
    assert result.ok is False
    assert "missing drive folder" in result.issues


def test_run_launch_package_validate_falls_back_to_stderr(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Non-JSON stdout + non-zero exit → stderr becomes the single issue."""
    _stub_launch_package(tmp_path)

    async def fake_exec(*args, **kwargs):
        proc = MagicMock()
        proc.returncode = 2
        proc.communicate = AsyncMock(return_value=(b"not json output", b"BOOM"))
        return proc

    monkeypatch.setattr(sr.asyncio, "create_subprocess_exec", fake_exec)

    result = asyncio.run(
        sr.run_launch_package_validate(
            brief_id="b-1",
            format="image",
            scripts_root=tmp_path,
        )
    )
    assert result.ok is False
    assert result.issues == ["BOOM"]


def test_run_launch_package_validate_empty_stdout_falls_back(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Empty stdout + non-zero exit → exit code message used."""
    _stub_launch_package(tmp_path)

    async def fake_exec(*args, **kwargs):
        proc = MagicMock()
        proc.returncode = 3
        proc.communicate = AsyncMock(return_value=(b"", b""))
        return proc

    monkeypatch.setattr(sr.asyncio, "create_subprocess_exec", fake_exec)

    result = asyncio.run(
        sr.run_launch_package_validate(
            brief_id="b-2",
            format="video",
            scripts_root=tmp_path,
        )
    )
    assert result.ok is False
    assert result.issues == ["launch_package.py exited 3"]


def test_run_launch_package_validate_zero_exit_no_json_keeps_ok(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Zero exit + non-JSON stdout → ok=True with no issues; nothing to fall
    back to because the exit code already says success."""
    _stub_launch_package(tmp_path)

    async def fake_exec(*args, **kwargs):
        proc = MagicMock()
        proc.returncode = 0
        proc.communicate = AsyncMock(return_value=(b"plain text", b""))
        return proc

    monkeypatch.setattr(sr.asyncio, "create_subprocess_exec", fake_exec)

    result = asyncio.run(
        sr.run_launch_package_validate(
            brief_id="b-2",
            format="image",
            scripts_root=tmp_path,
        )
    )
    assert result.ok is True
    assert result.issues == []


# ---------------------------------------------------------------------------
# run_kie_generate — shim around KieClient.generate_image
# ---------------------------------------------------------------------------


def test_run_kie_generate_delegates_to_kie_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Shim invokes KieClient with our args and returns its bytes."""
    from src.services import kie as kie_mod

    captured = {}

    class FakeClient:
        def __init__(self, api_key: str | None = None) -> None:
            captured["api_key"] = api_key

        async def generate_image(self, prompt, ratio, *, resolution="2K"):
            captured["prompt"] = prompt
            captured["ratio"] = ratio
            captured["resolution"] = resolution
            return b"KIE_BYTES"

    monkeypatch.setattr(kie_mod, "KieClient", FakeClient)

    out = asyncio.run(
        sr.run_kie_generate(
            prompt="hello world",
            ratio="9x16",
            resolution="4K",
            api_key="my-key",
        )
    )
    assert out == b"KIE_BYTES"
    assert captured["api_key"] == "my-key"
    assert captured["prompt"] == "hello world"
    assert captured["ratio"] == "9x16"
    assert captured["resolution"] == "4K"


# ---------------------------------------------------------------------------
# run_image_composite — shim around image_compositor.composite
# ---------------------------------------------------------------------------


def test_run_image_composite_returns_output_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The shim forwards every kwarg and yields the inner output_path."""
    from src.services import image_compositor as ic

    expected_out = tmp_path / "out.png"
    captured: dict = {}

    async def fake_composite(input_path, output_path, **kwargs):
        captured["in"] = input_path
        captured["out"] = output_path
        captured.update(kwargs)
        return ic.CompositorResult(
            output_path=expected_out,
            raw_stdout="",
            raw_stderr="",
        )

    monkeypatch.setattr(ic, "composite", fake_composite)

    in_path = tmp_path / "in.png"
    in_path.write_bytes(b"P")

    result = asyncio.run(
        sr.run_image_composite(
            in_path,
            tmp_path / "x.png",
            style="offer-banner",
            headline="H",
            subtext="S",
            cta="C",
            offer_bar="O",
            city="Austin",
            logo_path=tmp_path / "logo.png",
            color="#000",
            accent_color="#fff",
            output_format="9x16",
            scripts_root=tmp_path,
        )
    )
    assert result == expected_out
    assert captured["headline"] == "H"
    assert captured["style"] == "offer-banner"
    assert captured["output_format"] == "9x16"
    assert captured["logo_path"] == tmp_path / "logo.png"
