"""Supabase publish helper for the VoxHorizon dashboard.

This module is invoked by Hermes skills (campaign-brief, image-ad-prompting,
campaign-audit, etc.) to push artifact rows into the dashboard's Supabase
tables so the dashboard UI renders them in Realtime.

Each public function performs a single INSERT against Supabase's REST API
(``/rest/v1/<table>``) using the service-role key (bypasses RLS). The
returned ``dict`` is the inserted row (``Prefer: return=representation``).

Configuration is read from the environment on every call so the module is
safe to import without ``SUPABASE_URL`` / ``SUPABASE_SERVICE_ROLE_KEY`` set
(e.g. inside the test suite).
"""

from __future__ import annotations

import os
from typing import Any, Optional

import httpx


class DashboardPublishError(Exception):
    """Raised when a publish call fails (network, HTTP error, or config)."""


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

# campaign_perf_image / campaign_perf_video share these typed columns. Any
# other keys passed in ``metrics`` are silently dropped so callers can pass
# pass-through dicts straight from upstream skills without filtering.
_AUDIT_COMMON_COLS = (
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "leads_meta",
    "leads_ghl",
    "cpl_real",
    "freq",
)
_AUDIT_VIDEO_EXTRA_COLS = (
    "hook_rate",
    "drop_off_3s",
    "view_rate_avg",
    "watch_time_p50",
)


def _client() -> httpx.Client:
    """Build an httpx client pointed at the Supabase REST endpoint.

    Reads ``SUPABASE_URL`` and ``SUPABASE_SERVICE_ROLE_KEY`` from the
    environment. Both must be set; an empty string counts as unset so
    misconfigured ``.env`` files fail loudly rather than silently
    authenticating as anon.
    """
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise DashboardPublishError(
            "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set"
        )
    return httpx.Client(
        base_url=f"{url}/rest/v1",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
        timeout=10.0,
    )


def _post(table: str, body: dict[str, Any]) -> dict[str, Any]:
    """POST a single-row insert and return the inserted row.

    Supabase returns the inserted rows as a JSON array; with a single-row
    body the array always has one element. Any HTTP error (4xx or 5xx) is
    re-raised as ``DashboardPublishError`` with the response body so the
    caller can decide whether to retry.
    """
    try:
        with _client() as c:
            resp = c.post(f"/{table}", json=body)
    except httpx.HTTPError as exc:
        raise DashboardPublishError(
            f"network error posting to {table}: {exc}"
        ) from exc

    if resp.status_code >= 300:
        raise DashboardPublishError(
            f"{table} insert failed: {resp.status_code} {resp.text}"
        )

    try:
        rows = resp.json()
    except ValueError as exc:
        raise DashboardPublishError(
            f"{table} insert returned non-JSON body: {resp.text}"
        ) from exc

    if not isinstance(rows, list) or not rows:
        raise DashboardPublishError(
            f"{table} insert returned empty body: {resp.text}"
        )
    return rows[0]


# ---------------------------------------------------------------------------
# Public functions
# ---------------------------------------------------------------------------


def publish_brief(
    *,
    client_slug: str,
    payload: dict[str, Any],
    status: str = "draft",
    brief_id: Optional[str] = None,
    brief_id_human: Optional[str] = None,
) -> dict[str, Any]:
    """Insert a row into ``public.briefs``.

    ``payload`` must contain at least ``service`` and ``budget`` to satisfy
    the table's CHECK constraint. ``client_slug`` is the human slug from the
    ``clients`` table; we pass it through to the payload (the briefs table
    stores ``client_id``, not slug, but callers identify clients by slug —
    so we include the slug in the payload for downstream consumers and let
    the caller resolve ``client_id`` separately when needed).
    """
    if not isinstance(payload, dict):
        raise DashboardPublishError("payload must be a dict")
    if "service" not in payload or "budget" not in payload:
        raise DashboardPublishError(
            "payload must include 'service' and 'budget' keys"
        )

    # Mirror the slug onto the payload so consumers reading raw briefs can
    # see which client it belongs to without a join.
    body_payload = {**payload, "client_slug": client_slug}

    body: dict[str, Any] = {
        "payload": body_payload,
        "status": status,
    }
    if brief_id:
        body["id"] = brief_id
    if brief_id_human:
        body["brief_id_human"] = brief_id_human

    return _post("briefs", body)


def publish_creative(
    *,
    brief_id: str,
    concept: str,
    ratio: str,
    file_path_supabase: str,
    prompt_used: dict[str, Any],
    version: str = "v1.0",
    status: str = "draft",
    offer_text: Optional[str] = None,
) -> dict[str, Any]:
    """Insert a row into ``public.creatives`` (image side).

    ``ratio`` is one of ``1x1 | 9x16 | 16x9``. ``status`` is one of the
    ``image_creative_status`` enum values.
    """
    body: dict[str, Any] = {
        "brief_id": brief_id,
        "concept": concept,
        "ratio": ratio,
        "file_path_supabase": file_path_supabase,
        "prompt_used": prompt_used,
        "version": version,
        "status": status,
    }
    if offer_text is not None:
        body["offer_text"] = offer_text
    return _post("creatives", body)


def publish_audit_row(
    *,
    client_id: str,
    campaign_id: str,
    window_days: int,
    metrics: dict[str, Any],
    verdict: str,
    verdict_reason: Optional[str] = None,
    format: str = "image",
) -> dict[str, Any]:
    """Insert into ``campaign_perf_image`` or ``campaign_perf_video``.

    ``metrics`` is filtered to the typed columns supported by the chosen
    table; unknown keys are dropped (callers may pass-through dicts that
    include extra fields).
    """
    if format == "image":
        table = "campaign_perf_image"
        allowed = _AUDIT_COMMON_COLS
    elif format == "video":
        table = "campaign_perf_video"
        allowed = _AUDIT_COMMON_COLS + _AUDIT_VIDEO_EXTRA_COLS
    else:
        raise DashboardPublishError(
            f"format must be 'image' or 'video', got {format!r}"
        )

    filtered_metrics = {k: v for k, v in metrics.items() if k in allowed}

    body: dict[str, Any] = {
        "client_id": client_id,
        "campaign_id": campaign_id,
        "window_days": window_days,
        "verdict": verdict,
        **filtered_metrics,
    }
    if verdict_reason is not None:
        body["verdict_reason"] = verdict_reason

    return _post(table, body)


def publish_pipeline_event(
    *,
    pipeline_id: str,
    kind: str,
    stage: Optional[str] = None,
    payload: Optional[dict[str, Any]] = None,
    source: str = "hermes-task",
) -> dict[str, Any]:
    """Insert a row into ``public.pipeline_events``.

    ``source`` defaults to ``hermes-task`` (per ``pipeline_event_source_enum``);
    use ``hermes-hook`` for pre-tool-call hook events or ``manual`` for
    operator-emitted entries.
    """
    body: dict[str, Any] = {
        "pipeline_id": pipeline_id,
        "kind": kind,
        "source": source,
    }
    if stage is not None:
        body["stage"] = stage
    if payload is not None:
        body["payload"] = payload

    return _post("pipeline_events", body)
