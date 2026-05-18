"""Hermes shell-hook event receiver.

Hermes (the Claude Code harness running on the worker host) emits lifecycle
events via shell hooks configured in ``/opt/data/config.yaml``. Each event
fires a non-blocking ``curl`` into the worker; this module turns those
payloads into ``pipeline_events`` rows so the dashboard can render a live
timeline of hook activity.

Design goals
------------
* **Never raise.** The route MUST always return success to Ekko's hook
  caller — if we 5xx, the next ``curl`` may block the agent loop. Every
  sub-step here is wrapped in try/except + structured log; the worst case
  is a silent miss, never a stack trace propagating to the route layer.
* **Best-effort fan-out.** A ``tool_completed`` event with
  ``risk_class == "spend"`` is high-priority enough to wake the operator,
  so we trigger a VAPID push via the existing
  :func:`push_delivery.send_push_notification` fan-out. Failures there are
  logged and ignored.
* **Forward-compatible insert.** ``pipeline_events`` is the existing
  Realtime-published timeline. We write rows with ``source="hermes-hook"``
  embedded in the JSON payload so dashboards can filter / colour-code
  hook-driven events distinctly from pipeline-driven ones.

Event taxonomy
--------------
The kinds we recognize today (free-form text; new kinds get
``hermes-hook`` source + a custom ``kind`` value):

* ``tool_completed`` — Hermes post_tool_call hook. Payload may include
  ``risk_class`` (``"spend"`` / ``"network"`` / ``"fs"`` / ``"low"``).
* ``session_started`` — Hermes session_start hook.
* ``session_ended`` — Hermes session_end hook.
* ``skill_invoked`` — Hermes pre_skill hook.

Unknown kinds are still written to the timeline so we never silently drop
operator-facing signal; the dashboard renders them as ``custom``.
"""

from __future__ import annotations

import os
from typing import Any

import structlog

from ..supabase_client import get_supabase_admin
from . import push_delivery


log = structlog.get_logger(__name__)


#: Sentinel value written to ``pipeline_events.payload.source`` so dashboards
#: can distinguish hook-emitted rows from pipeline-emitted rows.
HOOK_SOURCE = "hermes-hook"

#: Recognized event kinds. Anything else is classified ``custom`` for the
#: timeline but still persisted.
KNOWN_KINDS: frozenset[str] = frozenset(
    {"tool_completed", "session_started", "session_ended", "skill_invoked"}
)

#: ``tool_completed`` with this ``risk_class`` triggers a VAPID push to the
#: operator. ``spend`` covers any tool call that moves money (Meta budget
#: updates, ad spend launches, …).
SPEND_RISK_CLASS = "spend"


def _classify(kind: str | None) -> str:
    """Return the kind string we'll persist (known kinds unchanged, else ``custom``).

    A missing / non-string ``kind`` is treated as ``custom`` so we still
    record the event rather than dropping it on the floor.
    """
    if isinstance(kind, str) and kind in KNOWN_KINDS:
        return kind
    return "custom"


def _safe_payload(event: dict[str, Any], classified_kind: str) -> dict[str, Any]:
    """Build the JSON payload to write to ``pipeline_events.payload``.

    The original event is preserved under ``event`` so dashboards can pull
    arbitrary hook-specific fields (session_id, tool_name, risk_class, etc.)
    without us having to enumerate them here.
    """
    return {
        "source": HOOK_SOURCE,
        "classified_kind": classified_kind,
        "event": event,
    }


async def _write_pipeline_event(*, kind: str, payload: dict[str, Any]) -> None:
    """Insert one row into ``pipeline_events``.

    Failures are logged and swallowed — the timeline is best-effort
    audit, not transactional state. ``pipeline_id`` is left ``None``
    because hook-emitted events are not scoped to a pipeline; the
    ``source`` field in ``payload`` is what the dashboard filters on.
    """
    try:
        sb = get_supabase_admin()
        sb.table("pipeline_events").insert(
            {
                "pipeline_id": None,
                "kind": kind,
                "stage": None,
                "payload": payload,
            }
        ).execute()
    except Exception as e:  # noqa: BLE001 — must never raise to the route
        log.warning("hermes_event_persist_failed", kind=kind, error=str(e))


async def _maybe_push_spend_alert(event: dict[str, Any]) -> None:
    """Fan out a VAPID push to every subscribed operator on a spend event.

    Only fires when:
      * the original event ``kind == "tool_completed"``; AND
      * the payload's ``risk_class == "spend"``.

    Failures are logged and ignored.
    """
    if event.get("kind") != "tool_completed":
        return
    if event.get("risk_class") != SPEND_RISK_CLASS:
        return

    title = "Hermes: spend action completed"
    tool_name = event.get("tool_name") or event.get("tool") or "unknown tool"
    body = f"{tool_name} ran with risk_class=spend. Review the timeline."

    payload = push_delivery.PushPayload(
        title=title,
        body=body,
        url="/timeline",
        kind="hermes_spend",
    )

    try:
        sb = get_supabase_admin()
        result = sb.table("push_subscriptions").select("endpoint, keys").execute()
        rows = getattr(result, "data", None) or []
    except Exception as e:  # noqa: BLE001
        log.warning("hermes_push_subs_query_failed", error=str(e))
        return

    for row in rows:
        if not isinstance(row, dict):
            continue
        endpoint = row.get("endpoint")
        if not endpoint:
            continue
        sub = {"endpoint": endpoint, "keys": row.get("keys") or {}}
        try:
            await push_delivery.send_push_notification(sub, payload)
        except Exception as e:  # noqa: BLE001 — every leg is best-effort
            log.warning(
                "hermes_push_send_failed", endpoint=endpoint, error=str(e)
            )


async def handle_event(event: dict[str, Any]) -> None:
    """Persist + fan out one Hermes shell-hook event.

    Args:
        event: The decoded JSON body from the ``POST /work/hermes/webhook``
            request. Must be a ``dict``; non-dict values are rejected with a
            warning log so the route can still return success.

    The function is intentionally generous about what it accepts: any dict
    with a string ``kind`` is persisted, even if the kind is unknown. Only
    fully malformed input (non-dict, missing ``kind`` entirely) is dropped
    with a warning.
    """
    if not isinstance(event, dict):
        log.warning("hermes_event_invalid_type", got=type(event).__name__)
        return

    raw_kind = event.get("kind")
    if not isinstance(raw_kind, str) or not raw_kind:
        log.warning("hermes_event_missing_kind", event_keys=list(event.keys()))
        return

    classified = _classify(raw_kind)
    payload = _safe_payload(event, classified)

    await _write_pipeline_event(kind=raw_kind, payload=payload)
    await _maybe_push_spend_alert(event)


def get_dashboard_webhook_token() -> str | None:
    """Return the shared webhook token Ekko's shell hooks present.

    This is a SEPARATE secret from ``WORKER_SHARED_SECRET`` — Ekko's hooks
    run as a low-privilege subprocess on the same host, so they get their
    own narrowly-scoped token that only authorizes the webhook receiver.
    Returns ``None`` when the env var is unset; the route surfaces that as
    a 401 on every request (fail closed).
    """
    raw = os.environ.get("DASHBOARD_WEBHOOK_TOKEN")
    if raw is None:
        return None
    stripped = raw.strip()
    return stripped or None


__all__ = [
    "HOOK_SOURCE",
    "KNOWN_KINDS",
    "SPEND_RISK_CLASS",
    "get_dashboard_webhook_token",
    "handle_event",
]
