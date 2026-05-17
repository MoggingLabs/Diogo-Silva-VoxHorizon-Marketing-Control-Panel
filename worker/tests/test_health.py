"""Tests for /work/health auth + JSON shape."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


SHARED_SECRET = "test-secret-for-health-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Provision env + reset cached settings before each test."""
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")

    # Reset the cached settings + app so env changes are picked up.
    from src.config import get_settings
    from src.services.queue import reset_queue

    get_settings.cache_clear()
    reset_queue()
    yield
    get_settings.cache_clear()
    reset_queue()


@pytest.fixture
def client() -> TestClient:
    """Fresh TestClient built against a fresh app instance."""
    from src.main import create_app

    return TestClient(create_app())


def test_health_without_auth_returns_401(client: TestClient) -> None:
    resp = client.get("/work/health")
    assert resp.status_code == 401


def test_health_with_wrong_token_returns_401(client: TestClient) -> None:
    resp = client.get("/work/health", headers={"Authorization": "Bearer wrong"})
    assert resp.status_code == 401


def test_health_with_valid_token_returns_expected_shape(client: TestClient) -> None:
    resp = client.get(
        "/work/health",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
    )
    assert resp.status_code == 200
    body = resp.json()

    assert body["ok"] is True
    assert isinstance(body["version"], str)
    assert isinstance(body["uptime_seconds"], int)
    assert body["uptime_seconds"] >= 0
    assert body["tailscale_hostname"] == "voxhorizon-worker-test"
    assert isinstance(body["claude_code_available"], bool)
    assert body["skills_loaded"] == []
    qd = body["queue_depth"]
    assert qd["image"] == 0
    assert qd["video"] == 0
    assert qd["broll"] == 0
    # New per-brief queue infra (M2-12): idle worker has no contention.
    assert qd["briefs"] == {}
    assert qd["total"] == 0


def test_git_sha_falls_back_to_env_when_git_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Lines 41-43: when ``git`` is unavailable (or fails), use WORKER_VERSION."""
    import subprocess

    from src.routes import health as health_mod

    def _raise_filenotfound(*_args, **_kwargs):
        raise FileNotFoundError("no git binary")

    monkeypatch.setattr(subprocess, "run", _raise_filenotfound)
    monkeypatch.setenv("WORKER_VERSION", "abc123-test")
    assert health_mod._git_sha() == "abc123-test"


def test_git_sha_falls_back_to_dev_when_env_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fallback all the way to the literal 'dev' when there's no env hint."""
    import subprocess

    from src.routes import health as health_mod

    def _raise_subprocess_error(*_args, **_kwargs):
        raise subprocess.SubprocessError("nope")

    monkeypatch.setattr(subprocess, "run", _raise_subprocess_error)
    monkeypatch.delenv("WORKER_VERSION", raising=False)
    assert health_mod._git_sha() == "dev"


def test_git_sha_returns_sha_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    """Happy path: subprocess returned a SHA on stdout."""
    from unittest.mock import MagicMock

    import subprocess

    from src.routes import health as health_mod

    completed = MagicMock()
    completed.returncode = 0
    completed.stdout = "deadbeef\n"
    monkeypatch.setattr(subprocess, "run", MagicMock(return_value=completed))
    assert health_mod._git_sha() == "deadbeef"


def test_git_sha_skips_empty_sha(monkeypatch: pytest.MonkeyPatch) -> None:
    """Empty stdout (git rev-parse returning no SHA) falls through to env."""
    from unittest.mock import MagicMock

    import subprocess

    from src.routes import health as health_mod

    completed = MagicMock()
    completed.returncode = 0
    completed.stdout = "  \n"
    monkeypatch.setattr(subprocess, "run", MagicMock(return_value=completed))
    monkeypatch.setenv("WORKER_VERSION", "fallback-v")
    assert health_mod._git_sha() == "fallback-v"


def test_git_sha_handles_nonzero_returncode(monkeypatch: pytest.MonkeyPatch) -> None:
    """git rev-parse exit non-zero → fall back."""
    from unittest.mock import MagicMock

    import subprocess

    from src.routes import health as health_mod

    completed = MagicMock()
    completed.returncode = 128
    completed.stdout = "not a git repo\n"
    monkeypatch.setattr(subprocess, "run", MagicMock(return_value=completed))
    monkeypatch.setenv("WORKER_VERSION", "ci-build")
    assert health_mod._git_sha() == "ci-build"
