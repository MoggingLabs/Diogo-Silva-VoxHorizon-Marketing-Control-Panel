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

    # kie.ai video completion-callback HMAC secret (E5.2 / #514). kie signs
    # ``f"{taskId}.{timestamp}"`` with this key and sends the Base64 digest in
    # ``X-Webhook-Signature`` on the completion POST to /work/video/kie-callback.
    # The callback receiver verifies it via
    # ``KieVideoClient.verify_webhook_signature`` before recording the result.
    # Optional at boot: when unset the callback route 503s (it cannot verify a
    # signature without the key) and the durable reconciliation sweep is the
    # safety net that still recovers the render.
    kie_ai_webhook_secret: str | None = None

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

    # === Periodic background scheduler (#354) ===
    # The worker runs three cron cores in supervised asyncio loops (see
    # services.scheduler): the stuck-dispatch watchdog, the GHL daily
    # reconciliation, and the observability watchdogs. All knobs are env-backed
    # with conservative defaults. Set SCHEDULER_ENABLED=false to disable every
    # loop; the scheduler also auto-skips when Supabase is unconfigured, so
    # local boots / tests need set nothing.
    scheduler_enabled: bool = True
    scheduler_watchdog_interval_s: float = 60.0
    scheduler_watchdog_timeout_s: float = 900.0
    scheduler_watchdog_max_redispatch: int = 5
    scheduler_observability_interval_s: float = 300.0
    scheduler_observability_dispatch_timeout_s: float = 900.0
    scheduler_observability_outbox_timeout_s: float = 300.0
    # GHL daily reconciliation: no-op until the client_integrations table exists.
    scheduler_reconcile_interval_s: float = 86_400.0
    scheduler_reconcile_window_days: int = 1
    # kie video render reconciliation (E5.2 / #514): a periodic sweep that finds
    # renders persisted as ``submitted`` (in video_render_tasks) that the
    # callback never resolved (a restart mid-poll, or a dropped callback), polls
    # kie for each, and records the result. Bounded per pass like the dispatch
    # watchdog so a backlog can't fan out an unbounded burst of record-info GETs.
    scheduler_kie_reconcile_interval_s: float = 120.0
    scheduler_kie_reconcile_max_per_pass: int = 10

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
