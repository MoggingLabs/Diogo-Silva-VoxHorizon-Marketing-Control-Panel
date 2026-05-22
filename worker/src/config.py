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

    # Fake-integration mode (T.4 / #317). When a FAKE_* flag is on, the
    # corresponding external integration is stubbed in-process with a
    # deterministic response and makes ZERO outbound network calls — so the
    # whole pipeline can run locally / in CI with no real Meta, GHL, Drive,
    # or image-render credentials. Off by default so production behaviour is
    # never accidentally faked; tests and local runs opt in via env.
    #
    #   FAKE_META    — Meta Ads recorder/launch saga returns canned ad ids.
    #   FAKE_GHL     — GoHighLevel lead pull / webhook returns canned leads.
    #   FAKE_DRIVE   — Google Drive upload returns a deterministic fake url.
    #   FAKE_RENDER  — Kie.ai / codex image render returns a deterministic
    #                  1x1 PNG (see services.kie.KieClient) instead of polling
    #                  the real API.
    #
    # Meta/GHL/Drive are not built yet (see PIPELINE-REBUILD-ARCHITECTURE.md
    # Layer 6); the flags + this convention land now so those services wire
    # to them by construction when they arrive. FAKE_RENDER is live today.
    fake_meta: bool = False
    fake_ghl: bool = False
    fake_drive: bool = False
    fake_render: bool = False

    # B-roll storage
    broll_store_backend: BrollBackend = "local"
    broll_local_root: str = "~/voxhorizon-worker/storage/broll-pool"

    # Observability
    tailscale_hostname: str = "voxhorizon-worker"

    # Slack approval fan-out (HI-17, post-Slack-pivot 2026-05-18). The worker
    # posts high-urgency approval notifications to a single Slack channel via
    # chat.postMessage. The bot token is sourced at deploy time from
    # /docker/hermes-shared/config/secrets.json (key EKKO_SLACK_BOT_TOKEN) and
    # surfaced into the container as SLACK_BOT_TOKEN. The channel ID is the
    # static Slack ID for #mkt-dept-updates. Both values are optional at boot —
    # when either is missing the fan-out helper logs and gracefully skips
    # the Slack step (push still fires).
    slack_bot_token: str | None = None
    slack_approval_channel_id: str | None = None
    # Base URL the Slack "Open in dashboard" CTA links to. The worker never
    # serves this URL itself; the link resolves on the operator's browser.
    dashboard_base_url: str = "https://dashboard.voxhorizon.com"

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
