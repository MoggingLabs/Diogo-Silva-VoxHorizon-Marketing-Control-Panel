"""Tests for src.config — env-backed settings + helpers."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _env_baseline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Provide the minimal env so Settings() doesn't blow up at import time."""
    monkeypatch.setenv("WORKER_SHARED_SECRET", "tests")
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    # Force a path that doesn't actually exist on disk so we know the
    # expanduser logic actually runs.
    monkeypatch.setenv("BROLL_LOCAL_ROOT", "~/broll-pool-config-tests")
    from src.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_clean_env_strips_whitespace() -> None:
    from src.config import clean_env

    assert clean_env("  abc  ") == "abc"


def test_clean_env_collapses_empty_to_none() -> None:
    """Lines 23-26: clean_env on None / empty / whitespace returns None."""
    from src.config import clean_env

    assert clean_env(None) is None
    assert clean_env("") is None
    assert clean_env("    ") is None


def test_get_settings_returns_singleton() -> None:
    from src.config import get_settings

    s1 = get_settings()
    s2 = get_settings()
    assert s1 is s2


def test_settings_strips_string_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify the ``_strip_strings`` field validator strips whitespace."""
    monkeypatch.setenv("WORKER_SHARED_SECRET", "  with-pad  ")
    from src.config import get_settings

    get_settings.cache_clear()
    s = get_settings()
    assert s.worker_shared_secret == "with-pad"


def test_settings_collapses_empty_string_to_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """Validator collapses pure-whitespace optional fields to None."""
    monkeypatch.setenv("SUPABASE_URL", "   ")
    from src.config import get_settings

    get_settings.cache_clear()
    s = get_settings()
    assert s.supabase_url is None


def test_broll_local_root_path_expands_tilde() -> None:
    """The property expands ``~`` and resolves to an absolute path."""
    from src.config import get_settings

    s = get_settings()
    p = s.broll_local_root_path
    assert p.is_absolute()
    # Tilde must be expanded — not present in the resolved path.
    assert "~" not in str(p)


def test_settings_defaults_when_optional_envs_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Optional API keys default to None and BROLL_STORE_BACKEND defaults to 'local'."""
    monkeypatch.delenv("KIE_AI_API_KEY", raising=False)
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("SUBMAGIC_API_KEY", raising=False)
    monkeypatch.delenv("META_ADS_API_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    monkeypatch.delenv("BROLL_STORE_BACKEND", raising=False)
    from src.config import get_settings

    get_settings.cache_clear()
    s = get_settings()
    assert s.kie_ai_api_key is None
    assert s.elevenlabs_api_key is None
    assert s.submagic_api_key is None
    assert s.meta_ads_api_key is None
    assert s.supabase_url is None
    assert s.supabase_secret_key is None
    assert s.broll_store_backend == "local"


def test_pipeline_budget_cap_default_and_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The E4.4 per-pipeline hard cap default is set and env-overridable."""
    from src.config import get_settings

    get_settings.cache_clear()
    assert get_settings().pipeline_budget_cap_usd == 50.0

    monkeypatch.setenv("PIPELINE_BUDGET_CAP_USD", "12.5")
    get_settings.cache_clear()
    assert get_settings().pipeline_budget_cap_usd == 12.5
