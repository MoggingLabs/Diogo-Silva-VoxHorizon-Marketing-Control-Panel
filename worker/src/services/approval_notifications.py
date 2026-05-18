"""Fan-out helper for Hermes approval notifications (HI-17).

After a fresh ``approvals`` row is inserted by :mod:`hermes_approval`, this
module is called fire-and-forget to notify the operator across two channels:

* **Always**: VAPID web push to every subscribed browser. The push surfaces
  a clickable notification that deep-links to ``/approvals/{id}``. Delivered
  via :func:`services.push_delivery.fanout_push` so we never reinvent the
  pywebpush envelope, the 404/410 cleanup, or the subscription iteration.

* **High-urgency only**: a Resend transactional email to the operator's
  inbox. The email template lives Next.js-side (``lib/emails``) — this
  module triggers it via a small internal HTTP call so we don't drag the
  Resend SDK into the Python worker.

Why split it that way? Two reasons:

1. ``react-email`` + Tailwind already lives in the Next.js bundle. Building
   the HTML there means designers can preview templates with the existing
   dev tooling without standing up a Python renderer.
2. Resend's Node SDK has first-class support for ``react`` props →
   prerendered HTML. Replicating that against the raw Resend HTTP API from
   Python would be lossy.

High-urgency classification
---------------------------
Either signal flips the row to "high":

* ``risk_class == "external-write"`` — any tool that writes to a third
  party (Meta Ads, GHL, Drive, etc.). Spend may be zero but the blast
  radius is.
* ``context.estimated_cost > 50.0`` — the agent itself reports a cost
  estimate via the plugin. We pick $50 as the operator-attention floor
  per the HI-17 issue body.

Failure semantics
-----------------
This whole module is best-effort. The caller (``hermes_approval``) wraps
:func:`fan_out` in a ``try`` so a notification failure never breaks the
long-poll — the badge still updates via Supabase Realtime regardless,
which is the actual source of truth for the dashboard's "approval pending"
state. We log warnings rather than raise.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
import structlog

from .push_delivery import PushPayload, fanout_push


log = structlog.get_logger(__name__)


#: Cost threshold above which an approval is treated as high-urgency. The
#: HI-17 spec calls for "spend > $50 estimated" — we use strict greater-than
#: so $50.00 itself does NOT trigger an email (operator-defined floor).
HIGH_URGENCY_COST_THRESHOLD = 50.0

#: Risk classes considered high-urgency regardless of cost.
HIGH_URGENCY_RISK_CLASSES = frozenset({"external-write"})

#: Notification kind dispatched to the Service Worker. ``public/sw.js``
#: doesn't switch on kind — it just shows the title/body/url — but we
#: still tag it so the in-app notification feed can group these correctly.
APPROVAL_PUSH_KIND = "approval_pending"

#: Timeout for the internal Next.js call. Email is best-effort; if Next is
#: down or slow we'd rather move on than block the worker's fan-out task.
INTERNAL_API_TIMEOUT_S = 8.0


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


def is_high_urgency(row: dict[str, Any]) -> bool:
    """Decide whether an approval should also trigger an email.

    Args:
        row: The ``approvals`` row dict — at minimum ``risk_class`` and
            ``context`` are inspected. Missing / null values default to
            "not high urgency".

    Returns:
        ``True`` if the row should fire an email, ``False`` otherwise.

    Examples:
        >>> is_high_urgency({"risk_class": "external-write"})
        True
        >>> is_high_urgency({"context": {"estimated_cost": 51.0}})
        True
        >>> is_high_urgency({"context": {"estimated_cost": 50.0}})
        False
        >>> is_high_urgency({"risk_class": "filesystem"})
        False
    """
    risk = row.get("risk_class")
    if isinstance(risk, str) and risk in HIGH_URGENCY_RISK_CLASSES:
        return True

    ctx = row.get("context") or {}
    if not isinstance(ctx, dict):
        return False

    cost_raw = ctx.get("estimated_cost")
    if cost_raw is None:
        return False
    try:
        cost = float(cost_raw)
    except (TypeError, ValueError):
        return False
    return cost > HIGH_URGENCY_COST_THRESHOLD


# ---------------------------------------------------------------------------
# Push payload construction
# ---------------------------------------------------------------------------


def _build_push_payload(row: dict[str, Any]) -> PushPayload:
    """Shape a :class:`PushPayload` from an approvals row.

    Matches the ``WebPushBody`` shape consumed by ``public/sw.js`` — title
    + body + url + kind. We keep the body short because the push service
    caps payloads at ~4KB after encryption.
    """
    tool_name = str(row.get("tool_name") or "tool")
    ctx = row.get("context") or {}
    skill_name = ""
    if isinstance(ctx, dict):
        raw_skill = ctx.get("skill_name")
        if isinstance(raw_skill, str):
            skill_name = raw_skill

    risk = row.get("risk_class") or "review"
    body_pieces = [str(risk)]
    if skill_name:
        body_pieces.append(skill_name)
    body = " • ".join(p for p in body_pieces if p).strip()

    approval_id = str(row.get("id") or "")
    url = f"/approvals/{approval_id}" if approval_id else "/approvals"

    return PushPayload(
        title=f"Approval needed: {tool_name}",
        body=body,
        url=url,
        kind=APPROVAL_PUSH_KIND,
    )


# ---------------------------------------------------------------------------
# Email payload construction
# ---------------------------------------------------------------------------


_MAX_ARGS_PREVIEW_CHARS = 500


def _build_email_payload(row: dict[str, Any]) -> dict[str, Any]:
    """Shape the JSON payload the Next.js internal endpoint expects.

    The Next side validates with zod — keep keys snake_case to mirror the
    DB row directly. The renderer is responsible for trimming / formatting
    for display.
    """
    import json

    approval_id = str(row.get("id") or "")
    tool_name = str(row.get("tool_name") or "tool")
    tool_args = row.get("tool_args") or {}
    try:
        args_preview = json.dumps(tool_args, indent=2, default=str)
    except (TypeError, ValueError):
        args_preview = repr(tool_args)
    if len(args_preview) > _MAX_ARGS_PREVIEW_CHARS:
        args_preview = args_preview[:_MAX_ARGS_PREVIEW_CHARS] + "..."

    ctx = row.get("context") or {}
    if not isinstance(ctx, dict):
        ctx = {}
    estimated_cost = ctx.get("estimated_cost")
    try:
        estimated_cost_num: float | None = (
            float(estimated_cost) if estimated_cost is not None else None
        )
    except (TypeError, ValueError):
        estimated_cost_num = None

    context_summary = {
        "pipeline_name": ctx.get("pipeline_name"),
        "brief_id": ctx.get("brief_id"),
        "brief_id_human": ctx.get("brief_id_human"),
        "skill_name": ctx.get("skill_name"),
        "session_id": row.get("ekko_session_id"),
    }
    # Drop blanks so the template can use truthy checks.
    context_summary = {k: v for k, v in context_summary.items() if v}

    return {
        "approval_id": approval_id,
        "tool_name": tool_name,
        "tool_args_preview": args_preview,
        "context_summary": context_summary,
        "risk_class": row.get("risk_class"),
        "estimated_cost": estimated_cost_num,
    }


# ---------------------------------------------------------------------------
# Internal HTTP call to Next.js renderer
# ---------------------------------------------------------------------------


async def _send_email_via_nextjs(
    payload: dict[str, Any],
    *,
    base_url: str,
    token: str,
    timeout_s: float = INTERNAL_API_TIMEOUT_S,
) -> bool:
    """POST to the internal Next.js endpoint that renders + sends the email.

    Returns ``True`` when the endpoint responds 2xx, ``False`` otherwise.
    Network errors are caught and logged — never raised — because the
    caller wraps us in a fire-and-forget task.
    """
    url = f"{base_url.rstrip('/')}/api/internal/approval-email"
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
    except httpx.HTTPError as exc:
        log.warning(
            "approval_email_http_failed",
            approval_id=payload.get("approval_id"),
            error=str(exc),
        )
        return False
    except Exception as exc:  # noqa: BLE001 — best-effort fan-out
        log.warning(
            "approval_email_unexpected_error",
            approval_id=payload.get("approval_id"),
            error=str(exc),
        )
        return False

    if resp.status_code >= 400:
        log.warning(
            "approval_email_non_2xx",
            approval_id=payload.get("approval_id"),
            status=resp.status_code,
            body=resp.text[:500],
        )
        return False
    log.info(
        "approval_email_sent",
        approval_id=payload.get("approval_id"),
        status=resp.status_code,
    )
    return True


def _internal_api_config() -> tuple[str | None, str | None]:
    """Read the Next.js internal-API URL + token from env.

    Returns ``(base_url, token)``. Either side being None means the email
    fan-out is disabled — the worker logs and moves on rather than raising.
    """
    base = os.environ.get("INTERNAL_API_BASE_URL")
    token = os.environ.get("INTERNAL_API_TOKEN")
    base = base.strip() if base else None
    token = token.strip() if token else None
    return (base or None), (token or None)


# ---------------------------------------------------------------------------
# Public entrypoint
# ---------------------------------------------------------------------------


async def fan_out(row: dict[str, Any]) -> None:
    """Fan out notifications for a freshly-inserted approval row.

    Always fires a VAPID push (best-effort). For high-urgency rows,
    additionally POSTs to the Next.js internal renderer so an email goes
    out via Resend.

    Args:
        row: The approvals row dict returned by Supabase. Should have at
            least ``id``, ``tool_name``, ``risk_class``, ``context``.

    Notes:
        * Never raises. Any exception is logged and swallowed — the caller
          (long-poll service) must not be blocked.
        * If push fan-out fails, email is still attempted.
        * If the email config (``INTERNAL_API_BASE_URL`` /
          ``INTERNAL_API_TOKEN``) is missing, the email step is skipped
          with a warning. Push still runs.
    """
    approval_id = row.get("id")

    # 1. Push — always. Wrapped so a push failure doesn't skip email.
    try:
        payload = _build_push_payload(row)
        sent, failed = await fanout_push(payload)
        log.info(
            "approval_push_fanout",
            approval_id=approval_id,
            sent=sent,
            failed=failed,
        )
    except Exception as exc:  # noqa: BLE001 — best-effort
        log.warning(
            "approval_push_fanout_failed",
            approval_id=approval_id,
            error=str(exc),
        )

    # 2. Email — only for high-urgency rows.
    if not is_high_urgency(row):
        log.info(
            "approval_email_skipped_low_urgency",
            approval_id=approval_id,
            risk_class=row.get("risk_class"),
        )
        return

    base_url, token = _internal_api_config()
    if not base_url or not token:
        log.warning(
            "approval_email_not_configured",
            approval_id=approval_id,
            has_base_url=bool(base_url),
            has_token=bool(token),
        )
        return

    email_payload = _build_email_payload(row)
    await _send_email_via_nextjs(
        email_payload,
        base_url=base_url,
        token=token,
    )


__all__ = [
    "APPROVAL_PUSH_KIND",
    "HIGH_URGENCY_COST_THRESHOLD",
    "HIGH_URGENCY_RISK_CLASSES",
    "fan_out",
    "is_high_urgency",
]
