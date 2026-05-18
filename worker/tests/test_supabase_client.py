"""Tests for the cached service-role Supabase client accessor."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _env_baseline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", "tests")
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))

    from src.config import get_settings
    from src.supabase_client import get_supabase_admin

    get_settings.cache_clear()
    get_supabase_admin.cache_clear()
    yield
    get_settings.cache_clear()
    get_supabase_admin.cache_clear()


def test_get_supabase_admin_raises_when_url_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Lines 25-30: RuntimeError when Supabase URL is missing."""
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "anything")

    from src.config import get_settings
    from src.supabase_client import get_supabase_admin

    get_settings.cache_clear()
    get_supabase_admin.cache_clear()

    with pytest.raises(RuntimeError) as exc:
        get_supabase_admin()
    assert "SUPABASE_URL" in str(exc.value)


def test_get_supabase_admin_raises_when_key_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    from src.config import get_settings
    from src.supabase_client import get_supabase_admin

    get_settings.cache_clear()
    get_supabase_admin.cache_clear()

    with pytest.raises(RuntimeError) as exc:
        get_supabase_admin()
    assert "SUPABASE_SECRET_KEY" in str(exc.value)


def test_get_supabase_admin_creates_client_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Happy path: a Client is returned when both envs are set."""
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "service-role-test")

    from src.config import get_settings
    from src.supabase_client import get_supabase_admin

    get_settings.cache_clear()
    get_supabase_admin.cache_clear()

    sb = get_supabase_admin()
    # The exact class is supabase.Client; verify we got something with the
    # expected ``storage`` / ``table`` surface.
    assert hasattr(sb, "storage")
    assert hasattr(sb, "table")


def test_get_supabase_admin_is_singleton(monkeypatch: pytest.MonkeyPatch) -> None:
    """Same client returned across calls (the lru_cache wraps the factory)."""
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "service-role-test")

    from src.config import get_settings
    from src.supabase_client import get_supabase_admin

    get_settings.cache_clear()
    get_supabase_admin.cache_clear()

    a = get_supabase_admin()
    b = get_supabase_admin()
    assert a is b
