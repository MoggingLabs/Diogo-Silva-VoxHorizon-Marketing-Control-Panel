"""Worker-side service for the operator-controlled approval mode toggle.

The dashboard Settings tab lets the operator flip the plugin's behavior
between three modes:

  * ``ASK``          — long-poll the dashboard for an operator decision
  * ``AUTO_APPROVE`` — allow without asking (TTL-bounded, 60s .. 1h)
  * ``HALT``         — block all approval-needing tools

State lives in the singleton ``approval_mode`` row in Supabase. Every
transition writes an audit row to ``approval_mode_audit``.

This service is plumbing only: no HTTP, no auth, no bearer. The route
layer in :mod:`..routes.hermes_approval_mode` owns the auth gate and the
HTTP shape; we expose three async functions:

  * :func:`get_mode`        — read the singleton row
  * :func:`set_mode`        — update the singleton + write audit row
  * :func:`get_audit_rows`  — read recent transitions

TTL semantics
-------------
Only ``AUTO_APPROVE`` carries an ``expires_at`` — the migration enforces
this via a CHECK constraint. The plugin's mode-check branch is
responsible for "expired AUTO_APPROVE drops back to ASK" — the worker
just returns the row as-is; if ``expires_at`` is in the past the plugin
falls back to ASK on its own. We do NOT clear the row on read because
the row's continued presence is a useful audit signal ("auto-approve
was enabled but expired without being explicitly cleared").
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog

from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


#: Valid mode values. Mirrors the CHECK constraint in migration 0009.
VALID_MODES: frozenset[str] = frozenset({"ASK", "AUTO_APPROVE", "HALT"})

#: Min/max TTL the operator can pick for AUTO_APPROVE, in seconds. The
#: lower bound (60s) prevents accidental no-op toggles; the upper bound
#: (1h) is enforced in lockstep with the DB CHECK in migration 0044 and the
#: approvals plugin's read-time clamp (E6.5). A longer auto-allow window is an
#: unbounded spend / launch surface, so anything beyond an hour is a config
#: change, not a runtime toggle. Requesting a larger TTL is rejected here
#: rather than failing later on the 0044 constraint.
MIN_TTL_SECONDS = 60
MAX_TTL_SECONDS = 3_600

#: Singleton row id; the table CHECK constraint rejects any other value.
SINGLETON_ID = "singleton"

#: Default audit-page page size. The route accepts ``?limit=N`` but
#: clamps to this when unset.
DEFAULT_AUDIT_LIMIT = 50

#: Hard cap on audit limit so a misbehaving client can't pull the whole
#: table.
MAX_AUDIT_LIMIT = 500


# ---------------------------------------------------------------------------
# Result + error types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ApprovalModeRow:
    """Singleton row shape returned to the plugin / dashboard."""

    mode: str
    expires_at: str | None
    set_by: str | None
    set_at: str
    note: str | None


@dataclass(frozen=True)
class ApprovalModeAuditRow:
    """One audit log row."""

    id: str
    from_mode: str
    to_mode: str
    ttl_seconds: int | None
    changed_at: str
    changed_by: str
    note: str | None


class ApprovalModeError(RuntimeError):
    """Raised when Supabase plumbing fails.

    The route translates this to 502 so the dashboard / plugin can
    retry rather than treat the missing state as a hard reject.
    """


class InvalidModeError(ValueError):
    """Raised when the caller asks for an invalid mode / TTL combo.

    The route translates this to 422 — this is operator input that
    didn't validate, not a backend failure.
    """


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_utc() -> datetime:
    """Indirection so tests can monkey-patch the clock."""
    return datetime.now(timezone.utc)


def _row_to_mode(row: dict[str, Any]) -> ApprovalModeRow:
    """Convert a raw Supabase row into the public dataclass shape."""
    return ApprovalModeRow(
        mode=str(row.get("mode") or "ASK"),
        expires_at=row.get("expires_at"),
        set_by=row.get("set_by"),
        set_at=str(row.get("set_at") or ""),
        note=row.get("note"),
    )


def _row_to_audit(row: dict[str, Any]) -> ApprovalModeAuditRow:
    """Convert a raw audit row into the public dataclass shape."""
    return ApprovalModeAuditRow(
        id=str(row.get("id") or ""),
        from_mode=str(row.get("from_mode") or ""),
        to_mode=str(row.get("to_mode") or ""),
        ttl_seconds=row.get("ttl_seconds"),
        changed_at=str(row.get("changed_at") or ""),
        changed_by=str(row.get("changed_by") or ""),
        note=row.get("note"),
    )


def _supabase() -> Any:
    """Resolve the Supabase admin client or raise :class:`ApprovalModeError`."""
    try:
        return get_supabase_admin()
    except Exception as exc:  # noqa: BLE001 — surface as ApprovalModeError
        log.warning("approval_mode_no_supabase", error=str(exc))
        raise ApprovalModeError(
            f"Supabase client unavailable: {exc}"
        ) from exc


def _select_singleton(supabase: Any) -> dict[str, Any] | None:
    """SELECT the singleton row or return ``None`` if missing."""
    result = (
        supabase.table("approval_mode")
        .select("*")
        .eq("id", SINGLETON_ID)
        .execute()
    )
    rows = getattr(result, "data", None) or []
    if not rows:
        return None
    return rows[0]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def validate_mode_payload(
    mode: str, ttl_seconds: int | None
) -> tuple[str, int | None]:
    """Normalize + validate the mode/ttl pair.

    Returns:
        ``(mode, ttl_seconds_or_none)`` where the TTL is non-None ONLY
        for ``AUTO_APPROVE``. Other modes always get ``None``.

    Raises:
        :class:`InvalidModeError` when the mode is unknown, when
        AUTO_APPROVE is missing TTL, or when AUTO_APPROVE's TTL is
        outside ``[MIN_TTL_SECONDS, MAX_TTL_SECONDS]``. Also when
        a non-AUTO_APPROVE mode carries a TTL (operator confusion —
        reject loudly rather than silently drop the TTL).
    """
    if mode not in VALID_MODES:
        raise InvalidModeError(
            f"invalid mode '{mode}' — must be one of "
            f"{sorted(VALID_MODES)}"
        )
    if mode == "AUTO_APPROVE":
        if ttl_seconds is None:
            raise InvalidModeError(
                "AUTO_APPROVE requires ttl_seconds"
            )
        if not isinstance(ttl_seconds, int):
            raise InvalidModeError(
                "ttl_seconds must be an integer"
            )
        if ttl_seconds < MIN_TTL_SECONDS:
            raise InvalidModeError(
                f"ttl_seconds {ttl_seconds} below minimum "
                f"{MIN_TTL_SECONDS}"
            )
        if ttl_seconds > MAX_TTL_SECONDS:
            raise InvalidModeError(
                f"ttl_seconds {ttl_seconds} above maximum "
                f"{MAX_TTL_SECONDS}"
            )
        return mode, ttl_seconds
    # ASK / HALT — TTL must not be set
    if ttl_seconds is not None:
        raise InvalidModeError(
            f"ttl_seconds only valid for AUTO_APPROVE, got {mode}"
        )
    return mode, None


async def get_mode() -> ApprovalModeRow:
    """Read the singleton ``approval_mode`` row.

    If the row is missing (shouldn't happen — the migration seeds it),
    returns the canonical ASK default with empty metadata so the plugin
    has something safe to act on.

    Raises:
        :class:`ApprovalModeError` on a Supabase failure.
    """
    supabase = _supabase()
    try:
        row = _select_singleton(supabase)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "approval_mode_select_failed", error=str(exc)
        )
        raise ApprovalModeError(
            f"approval_mode select failed: {exc}"
        ) from exc

    if row is None:
        # Defensive: the seed row should always exist. Return a safe
        # ASK default so callers don't crash on a missing row.
        log.warning("approval_mode_singleton_missing")
        return ApprovalModeRow(
            mode="ASK",
            expires_at=None,
            set_by=None,
            set_at="",
            note=None,
        )
    return _row_to_mode(row)


async def set_mode(
    *,
    mode: str,
    ttl_seconds: int | None = None,
    changed_by: str = "dashboard",
    note: str | None = None,
) -> ApprovalModeRow:
    """Transition the singleton to ``mode`` and write an audit row.

    The two writes (UPDATE singleton, INSERT audit) are intentionally
    NOT wrapped in a transaction — the Supabase Python client doesn't
    expose a clean way to do that without dropping into raw SQL, and
    the worst case is a row in ``approval_mode_audit`` with no
    corresponding state update (which we'd diagnose from logs).

    Args:
        mode: One of ``ASK`` / ``AUTO_APPROVE`` / ``HALT``.
        ttl_seconds: REQUIRED for ``AUTO_APPROVE``; must be None for
            the other modes. Bounds are enforced by
            :func:`validate_mode_payload`.
        changed_by: Audit identifier — ``"dashboard"`` for now; once
            SSO lands this becomes the operator's ``auth.user.id``.
        note: Optional operator note ("paused for nightly deploy", …).

    Returns:
        The freshly-written row.

    Raises:
        :class:`InvalidModeError` when validation fails.
        :class:`ApprovalModeError` on Supabase failures.
    """
    mode, ttl_seconds = validate_mode_payload(mode, ttl_seconds)
    supabase = _supabase()

    # Read the current row so we can record from_mode in the audit.
    try:
        current = _select_singleton(supabase)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "approval_mode_pre_update_select_failed",
            error=str(exc),
        )
        raise ApprovalModeError(
            f"approval_mode pre-update select failed: {exc}"
        ) from exc
    from_mode = (current or {}).get("mode") or "ASK"

    now = _now_utc()
    expires_at: str | None = None
    if mode == "AUTO_APPROVE":
        # ttl_seconds is guaranteed non-None by validation above.
        assert ttl_seconds is not None
        expires_at = (now + timedelta(seconds=ttl_seconds)).isoformat()

    update_payload: dict[str, Any] = {
        "id": SINGLETON_ID,
        "mode": mode,
        "expires_at": expires_at,
        "set_by": changed_by,
        "set_at": now.isoformat(),
        "note": note,
    }
    try:
        (
            supabase.table("approval_mode")
            .upsert(update_payload, on_conflict="id")
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "approval_mode_upsert_failed", error=str(exc)
        )
        raise ApprovalModeError(
            f"approval_mode upsert failed: {exc}"
        ) from exc

    audit_payload: dict[str, Any] = {
        "from_mode": from_mode,
        "to_mode": mode,
        "ttl_seconds": ttl_seconds,
        "changed_at": now.isoformat(),
        "changed_by": changed_by,
        "note": note,
    }
    try:
        (
            supabase.table("approval_mode_audit")
            .insert(audit_payload)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001 — best-effort: state already
        # changed, so don't unwind. Log loudly so the gap is diagnosable.
        log.warning(
            "approval_mode_audit_insert_failed",
            from_mode=from_mode,
            to_mode=mode,
            error=str(exc),
        )

    log.info(
        "approval_mode_set",
        from_mode=from_mode,
        to_mode=mode,
        ttl_seconds=ttl_seconds,
        changed_by=changed_by,
    )

    return ApprovalModeRow(
        mode=mode,
        expires_at=expires_at,
        set_by=changed_by,
        set_at=now.isoformat(),
        note=note,
    )


async def get_audit_rows(
    limit: int = DEFAULT_AUDIT_LIMIT,
) -> list[ApprovalModeAuditRow]:
    """Return recent audit rows, newest first.

    Args:
        limit: Number of rows to fetch. Clamped to
            ``[1, MAX_AUDIT_LIMIT]``.

    Raises:
        :class:`ApprovalModeError` on Supabase failures.
    """
    # Clamp at the service so an unauthenticated caller can't OOM us
    # with ``?limit=99999999``.
    if limit < 1:
        limit = 1
    if limit > MAX_AUDIT_LIMIT:
        limit = MAX_AUDIT_LIMIT

    supabase = _supabase()
    try:
        result = (
            supabase.table("approval_mode_audit")
            .select("*")
            .order("changed_at", desc=True)
            .limit(limit)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "approval_mode_audit_select_failed", error=str(exc)
        )
        raise ApprovalModeError(
            f"approval_mode_audit select failed: {exc}"
        ) from exc
    rows = getattr(result, "data", None) or []
    return [_row_to_audit(r) for r in rows]


def get_approval_token() -> str | None:
    """Return the shared bearer for ``/work/hermes/approval-mode``.

    Re-uses ``VOXHORIZON_APPROVAL_TOKEN`` so the Hermes plugin's single
    bearer covers both the long-poll route and the mode endpoints.
    """
    import os

    raw = os.environ.get("VOXHORIZON_APPROVAL_TOKEN")
    if raw is None:
        return None
    stripped = raw.strip()
    return stripped or None


__all__ = [
    "ApprovalModeAuditRow",
    "ApprovalModeError",
    "ApprovalModeRow",
    "DEFAULT_AUDIT_LIMIT",
    "InvalidModeError",
    "MAX_AUDIT_LIMIT",
    "MAX_TTL_SECONDS",
    "MIN_TTL_SECONDS",
    "SINGLETON_ID",
    "VALID_MODES",
    "get_approval_token",
    "get_audit_rows",
    "get_mode",
    "set_mode",
    "validate_mode_payload",
]
