"""Web Push delivery wrapper.

Reads subscriptions from ``push_subscriptions`` and ships each payload via
``pywebpush``. Subscriptions that return ``404`` or ``410`` from the push
service are considered expired and are deleted on the fly — that's the only
way the table stays clean over the lifetime of the operator's browsers.

This module deliberately ignores the *content* of the notification payload —
the caller is responsible for shaping ``{title, body, url, ...}`` and any
notification-kind-specific fields. We just envelope-deliver.

VAPID keys are read from the environment:

* ``VAPID_PUBLIC_KEY`` — the same key the browser used to subscribe (only
  needed when the WebPush spec requires it; pywebpush surfaces it back to
  the push service).
* ``VAPID_PRIVATE_KEY`` — the private half used to sign the JWT.

Both are PEM-encoded EC keys (P-256). Generate via
``npx web-push generate-vapid-keys``.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

import structlog

from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


#: VAPID subscriber claim — mailto: identifying who's sending the push.
#: GHL / Meta don't see this; the push service uses it for abuse complaints.
VAPID_SUBJECT = "mailto:notifications@voxhorizon.com"


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PushPayload:
    """Notification payload shape consumed by ``public/sw.js``."""

    title: str
    body: str
    url: str = "/"
    kind: str = "generic"

    def to_dict(self) -> dict[str, Any]:
        return {"title": self.title, "body": self.body, "url": self.url, "kind": self.kind}


# ---------------------------------------------------------------------------
# Subscription helpers
# ---------------------------------------------------------------------------


def _subscription_info(row: dict[str, Any]) -> dict[str, Any]:
    """Translate a Supabase ``push_subscriptions`` row into ``pywebpush`` input."""
    return {"endpoint": row["endpoint"], "keys": row.get("keys") or {}}


async def _delete_subscription_by_endpoint(endpoint: str) -> None:
    """Drop a single subscription. Used when the push service signals 404/410."""
    sb = get_supabase_admin()
    try:
        sb.table("push_subscriptions").delete().eq("endpoint", endpoint).execute()
    except Exception as e:  # noqa: BLE001 — best-effort cleanup
        log.warning("push_subscription_delete_failed", endpoint=endpoint, error=str(e))


# ---------------------------------------------------------------------------
# Sending
# ---------------------------------------------------------------------------


async def send_push_notification(
    subscription: dict[str, Any],
    payload: PushPayload | dict[str, Any],
    *,
    vapid_private_key: str | None = None,
    vapid_subject: str = VAPID_SUBJECT,
) -> bool:
    """Send a single push notification.

    Args:
        subscription: ``{ endpoint, keys: {p256dh, auth} }`` dict as stored in
            ``push_subscriptions``.
        payload: A :class:`PushPayload` or pre-formed dict the Service Worker
            will receive via ``event.data.json()``.
        vapid_private_key: PEM-encoded private key. Falls back to
            ``VAPID_PRIVATE_KEY`` from the environment.
        vapid_subject: ``mailto:`` URI registered as the subscriber.

    Returns:
        ``True`` if the push service accepted the request. ``False`` if the
        subscription was reported gone (404/410) — the row is deleted from
        Supabase as a side effect.
    """
    key = (vapid_private_key or os.environ.get("VAPID_PRIVATE_KEY") or "").strip()
    if not key:
        raise RuntimeError("VAPID_PRIVATE_KEY must be set to send web push.")

    # Imported lazily so the module can be imported without pywebpush
    # installed (tests monkey-patch the entire ``send_push_notification`` /
    # ``fanout_push`` surface anyway).
    from pywebpush import WebPushException, webpush  # type: ignore[import-untyped]

    data = payload.to_dict() if isinstance(payload, PushPayload) else payload
    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps(data),
            vapid_private_key=key,
            vapid_claims={"sub": vapid_subject},
        )
        return True
    except WebPushException as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        if status in (404, 410):
            endpoint = subscription.get("endpoint", "")
            log.info("push_subscription_expired", endpoint=endpoint, status=status)
            if endpoint:
                await _delete_subscription_by_endpoint(endpoint)
            return False
        # Other errors are non-fatal at the per-message level (e.g. 5xx from
        # the push service). Log and return False so the caller can tally a
        # failure but the loop keeps going.
        log.warning("push_send_failed", error=str(e), status=status)
        return False


async def fanout_push(payload: PushPayload | dict[str, Any]) -> tuple[int, int]:
    """Deliver one payload to every active subscription.

    Returns ``(sent, failed)``. ``sent`` counts only fully-accepted pushes;
    ``failed`` counts both transient failures and 404/410 expirations (the
    rows are deleted in either case, so the next run starts with a clean
    pool).
    """
    sb = get_supabase_admin()
    try:
        result = sb.table("push_subscriptions").select("endpoint, keys").execute()
    except Exception as e:  # noqa: BLE001
        log.warning("push_subscriptions_query_failed", error=str(e))
        return 0, 0
    rows = getattr(result, "data", None) or []
    if not rows:
        return 0, 0

    sent = failed = 0
    for row in rows:
        if not isinstance(row, dict) or not row.get("endpoint"):
            continue
        ok = await send_push_notification(_subscription_info(row), payload)
        if ok:
            sent += 1
        else:
            failed += 1
    log.info("push_fanout_done", sent=sent, failed=failed, total=len(rows))
    return sent, failed


__all__ = [
    "PushPayload",
    "VAPID_SUBJECT",
    "fanout_push",
    "send_push_notification",
]
