"""Notification event emitter with dedupe.

The Wave 4 spec calls for surfacing key operator-attention moments — creative
fatigue, kill-threshold hits, briefs awaiting approval, etc. — through both
web-push (M4-11) and email (M4-10).

Those delivery channels are *future* work that needs live Resend keys and a
browser subscription flow. This module ships the upstream half of the pipeline
right now: an idempotent recorder that writes intent into the ``events`` table.
A future delivery worker can subscribe to those rows and ship the actual push
or email.

The dedupe key is composed by the caller (typically
``f"{kind}:{ref_id}"``); within ``dedupe_window_minutes`` of an existing event
with the same key, :func:`emit` returns ``False`` instead of inserting a new
row. This stops a campaign that hits ``freq > 3`` from spamming the operator
every audit cycle.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from ..supabase_client import get_supabase_admin


#: Default dedupe window. The Wave 4 spec says "don't ping me twice in a hour".
DEFAULT_DEDUPE_WINDOW_MINUTES = 60


@dataclass(frozen=True)
class NotificationEvent:
    """A single notification intent.

    ``kind`` should be a short stable identifier we'll filter on later — the
    domain dictates the vocabulary (e.g. ``"creative_fatigue"``,
    ``"kill_threshold"``, ``"brief_awaits_approval"``). ``ref_table`` /
    ``ref_id`` point at the row that triggered the event so a delivery worker
    can deep-link from a push / email.

    ``dedupe_key`` is a free-form string the caller picks. The standard form
    is ``f"{kind}:{ref_id}"`` but callers can scope tighter (e.g. include the
    window) when needed.
    """

    kind: str
    ref_table: str
    ref_id: str
    payload: dict[str, Any] = field(default_factory=dict)
    dedupe_key: str = ""
    dedupe_window_minutes: int = DEFAULT_DEDUPE_WINDOW_MINUTES


def _dedupe_key_for(event: NotificationEvent) -> str:
    """Return the dedupe key the caller passed, or fall back to ``kind:ref_id``."""
    if event.dedupe_key:
        return event.dedupe_key
    return f"{event.kind}:{event.ref_id}"


def _utc_now() -> datetime:
    """Return current UTC time. Wrapped so tests can monkeypatch."""
    return datetime.now(timezone.utc)


async def emit(event: NotificationEvent) -> bool:
    """Record a notification intent unless one already exists in-window.

    Returns ``True`` if a new row was inserted, ``False`` if it was deduped.

    Implementation: query ``events`` for matching ``kind`` rows whose
    ``payload->>'dedupe_key'`` equals our key and whose ``created_at`` is
    within the window. If anything comes back, dedupe and bail. Otherwise
    insert a fresh row with the dedupe key embedded into the payload so we
    can re-find it next call.
    """
    sb = get_supabase_admin()
    dedupe_key = _dedupe_key_for(event)
    window_start = _utc_now() - timedelta(minutes=event.dedupe_window_minutes)

    # Look for an existing event with the same dedupe key inside the window.
    existing = (
        sb.table("events")
        .select("id, created_at, payload")
        .eq("kind", event.kind)
        .gte("created_at", window_start.isoformat())
        .execute()
    )
    rows: list[dict[str, Any]] = getattr(existing, "data", None) or []
    for row in rows:
        payload = row.get("payload") or {}
        if isinstance(payload, dict) and payload.get("dedupe_key") == dedupe_key:
            return False

    # No prior event — insert a new one. We always stamp the dedupe key into
    # the payload so the next call can find us; merge with the caller's
    # payload so we don't lose context.
    payload: dict[str, Any] = {**event.payload, "dedupe_key": dedupe_key}
    sb.table("events").insert(
        {
            "kind": event.kind,
            "ref_table": event.ref_table,
            "ref_id": event.ref_id,
            "payload": payload,
        }
    ).execute()
    return True


__all__ = [
    "DEFAULT_DEDUPE_WINDOW_MINUTES",
    "NotificationEvent",
    "emit",
]
