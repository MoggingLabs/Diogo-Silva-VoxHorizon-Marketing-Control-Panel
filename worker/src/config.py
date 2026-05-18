"""Centralized environment-backed settings.

Mirrors the JS `lib/env.ts` clean_env pattern: whitespace is stripped from
every value, empty strings collapse to None, and access is via a cached
singleton so import order doesn't matter.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


BrollBackend = Literal["local", "supabase"]


def clean_env(value: str | None) -> str | None:
    """Strip whitespace and collapse empty values to None."""
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


class Settings(BaseSettings):
    """All env vars the worker reads. Required values raise on first access."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Worker auth + URLs
    worker_shared_secret: str = Field(..., min_length=1)
    worker_public_base_url: str = "http://localhost:8000"
    worker_cors_origin: str = "http://localhost:3000"

    # Supabase
    supabase_url: str | None = None
    supabase_secret_key: str | None = None

    # External services (optional at boot; routes that need them fail loudly)
    kie_ai_api_key: str | None = None
    elevenlabs_api_key: str | None = None
    submagic_api_key: str | None = None
    meta_ads_api_key: str | None = None

    # B-roll storage
    broll_store_backend: BrollBackend = "local"
    broll_local_root: str = "~/voxhorizon-worker/storage/broll-pool"

    # Observability
    tailscale_hostname: str = "voxhorizon-worker"

    # Internal Next.js API (HI-17): the worker calls /api/internal/approval-email
    # to render + ship Resend emails for high-urgency approvals. Both values
    # are optional — when either is missing the fan-out helper logs and
    # gracefully skips the email step (push still fires).
    internal_api_base_url: str | None = None
    internal_api_token: str | None = None

    @field_validator("*", mode="before")
    @classmethod
    def _strip_strings(cls, v: object) -> object:
        if isinstance(v, str):
            stripped = v.strip()
            return stripped if stripped else None
        return v

    @property
    def broll_local_root_path(self) -> Path:
        """Expanded absolute path for the local b-roll pool."""
        return Path(self.broll_local_root).expanduser().resolve()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached singleton accessor."""
    return Settings()  # type: ignore[call-arg]
