"""Tests for /work/launch/validate and the scripts_runner adapter."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient


SHARED_SECRET = "test-secret-for-launch-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")

    from src.config import get_settings
    from src.services.queue import reset_queue

    get_settings.cache_clear()
    reset_queue()
    yield
    get_settings.cache_clear()
    reset_queue()


@pytest.fixture
def client() -> TestClient:
    from src.main import create_app

    return TestClient(create_app())


def _mock_subprocess(returncode: int, stdout: bytes, stderr: bytes = b"") -> AsyncMock:
    proc = MagicMock()
    proc.returncode = returncode
    proc.communicate = AsyncMock(return_value=(stdout, stderr))
    return AsyncMock(return_value=proc)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def test_validate_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/launch/validate", json={"brief_id": "x", "format": "image"})
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Happy + sad paths against the adapter
# ---------------------------------------------------------------------------


def test_validate_returns_503_when_script_missing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from src.services import scripts_runner

    # Point the resolver at a non-existent root so the script can't be found.
    monkeypatch.setattr(scripts_runner, "DEFAULT_SCRIPTS_ROOT", tmp_path / "no-such-scripts")

    resp = client.post(
        "/work/launch/validate",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"brief_id": "b1", "format": "image"},
    )
    assert resp.status_code == 503
    assert "launch_package.py not found" in resp.json()["detail"]


def test_validate_returns_ok_true_on_clean_run(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from src.services import scripts_runner

    # Drop a stub script on disk so `_resolve_launch_package_script` finds it.
    scripts_dir = tmp_path / "campaign-ops"
    scripts_dir.mkdir(parents=True)
    (scripts_dir / "launch_package.py").write_text("# stub\n")
    monkeypatch.setattr(scripts_runner, "DEFAULT_SCRIPTS_ROOT", tmp_path)

    fake_exec = _mock_subprocess(
        0,
        b'{"ok": true, "issues": []}\n',
    )
    monkeypatch.setattr(scripts_runner.asyncio, "create_subprocess_exec", fake_exec)

    resp = client.post(
        "/work/launch/validate",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"brief_id": "b1", "format": "image", "payload": {"a": 1}},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["issues"] == []


def test_validate_surfaces_issues_from_stdout(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from src.services import scripts_runner

    scripts_dir = tmp_path / "campaign-ops"
    scripts_dir.mkdir(parents=True)
    (scripts_dir / "launch_package.py").write_text("# stub\n")
    monkeypatch.setattr(scripts_runner, "DEFAULT_SCRIPTS_ROOT", tmp_path)

    fake_exec = _mock_subprocess(
        2,
        b'{"ok": false, "issues": ["missing copy for creative c1", "no drive path on c2"]}\n',
    )
    monkeypatch.setattr(scripts_runner.asyncio, "create_subprocess_exec", fake_exec)

    resp = client.post(
        "/work/launch/validate",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"brief_id": "b1", "format": "video"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert body["issues"] == [
        "missing copy for creative c1",
        "no drive path on c2",
    ]


def test_validate_falls_back_to_stderr_when_no_json(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """If the upstream script can't speak JSON, surface stderr verbatim."""
    from src.services import scripts_runner

    scripts_dir = tmp_path / "campaign-ops"
    scripts_dir.mkdir(parents=True)
    (scripts_dir / "launch_package.py").write_text("# stub\n")
    monkeypatch.setattr(scripts_runner, "DEFAULT_SCRIPTS_ROOT", tmp_path)

    fake_exec = _mock_subprocess(1, b"", b"FATAL: bad config\n")
    monkeypatch.setattr(scripts_runner.asyncio, "create_subprocess_exec", fake_exec)

    resp = client.post(
        "/work/launch/validate",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"brief_id": "b1", "format": "image"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert body["issues"] == ["FATAL: bad config"]


def test_adapter_direct_returns_dataclass(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from src.services import scripts_runner

    scripts_dir = tmp_path / "campaign-ops"
    scripts_dir.mkdir(parents=True)
    (scripts_dir / "launch_package.py").write_text("# stub\n")
    monkeypatch.setattr(scripts_runner, "DEFAULT_SCRIPTS_ROOT", tmp_path)

    fake_exec = _mock_subprocess(0, b'{"ok": true, "issues": []}\n')
    monkeypatch.setattr(scripts_runner.asyncio, "create_subprocess_exec", fake_exec)

    result = asyncio.run(
        scripts_runner.run_launch_package_validate(
            brief_id="b1",
            format="image",
            payload={"x": 1},
            scripts_root=tmp_path,
        )
    )
    assert result.ok is True
    assert result.issues == []
    assert "ok" in result.raw_stdout
