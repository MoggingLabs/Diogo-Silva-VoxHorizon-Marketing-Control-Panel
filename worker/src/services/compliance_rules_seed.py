"""Seed the ``compliance_rule`` lookup from the in-memory ruleset (#394).

The compliance engine adjudicates from the IN-MEMORY ruleset
(:mod:`services.compliance_rules` via :func:`get_starter_rules`) — that module
is the single source of truth. The ``compliance_rule`` DB table (migration
``0021``, ``version`` reconciled int -> text in ``0029``) is a *display / lookup*
surface only: the UI (ReviewDrawer / ComplianceOverrideGate) reads a finding's
``(rule_id, rule_version)`` and joins it to this table for the rule's title,
authority and frozen citation. It must therefore be populated in every
environment, but WITHOUT a second hand-maintained copy of the ruleset — a
hardcoded SQL seed would silently drift from the Python source.

This module bridges the two: it projects each ``get_starter_rules()`` row onto
the table's columns and UPSERTs it on the ``(rule_id, version)`` primary key, so

  * the table mirrors the engine ruleset exactly (one source of truth);
  * a re-run is a no-op (idempotent UPSERT — re-seeding never duplicates);
  * a rule edit in the Python module flows to the table on the next boot.

:func:`seed_compliance_rules` does the work and raises on a real DB error.
:func:`seed_compliance_rules_safe` wraps it so app startup can call it as a
best-effort side-effect: it NEVER raises (a missing/unreachable DB just logs and
skips), mirroring how the worker boots without Supabase configured (the admin
client raises lazily; health + local b-roll still work).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import structlog

from .compliance_rules import get_starter_rules


log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Engine -> DB projection
# ---------------------------------------------------------------------------
#
# The engine speaks ``info`` / ``warn`` / ``block``; the DB
# ``verdict_severity_enum`` is ``info | low | medium | high | critical`` (0017).
# This MUST match routes.qa_compliance._COMPLIANCE_SEVERITY_TO_DB so a seeded
# rule's severity and a finding's severity pin the same enum value.
_SEVERITY_TO_DB: dict[str, str] = {
    "info": "info",
    "warn": "medium",
    "block": "critical",
}

# The ``compliance_rule.authority`` column is ``not null`` and is documented as
# ``'meta' | 'ftc' | 'google' | 'client'`` (0021). The in-memory rules carry no
# explicit authority, so derive it from the namespaced ``rule_id`` prefix. The
# ``vertical.*`` rules (e.g. ``vertical.before_after``) are Meta policy substance
# (their citation is a Meta business-help page), so they map to ``meta``.
_PREFIX_TO_AUTHORITY: dict[str, str] = {
    "meta": "meta",
    "ftc": "ftc",
    "google": "google",
    "client": "client",
    "vertical": "meta",
}


def _authority_for(rule_id: str) -> str:
    """Derive the regulatory authority from a namespaced ``rule_id``."""
    prefix = rule_id.split(".", 1)[0].lower()
    return _PREFIX_TO_AUTHORITY.get(prefix, "meta")


def _row_for(rule: dict[str, Any]) -> dict[str, Any]:
    """Project one engine rule onto the ``compliance_rule`` table columns."""
    severity = str(rule.get("severity", "warn"))
    return {
        "rule_id": rule["rule_id"],
        "version": str(rule.get("version", "")),
        "title": rule.get("title", ""),
        "authority": _authority_for(rule["rule_id"]),
        "applies_to_vertical": list(rule.get("applies_to_vertical") or ["*"]),
        "surface": rule.get("surface", "copy"),
        "severity": _SEVERITY_TO_DB.get(severity, "medium"),
        "engine": rule.get("engine", "both"),
        "check_spec": rule.get("check_spec") or {},
        "required_edit": rule.get("required_edit"),
        # The lookup column is ``not null``; the in-memory rule always carries a
        # citation_url (possibly empty for synthesized rules, but starter rules
        # all have one).
        "citation_url": rule.get("citation_url") or "",
        "active": True,
    }


# ---------------------------------------------------------------------------
# Seeder
# ---------------------------------------------------------------------------


def seed_compliance_rules() -> int:
    """UPSERT every starter rule into ``compliance_rule``; return rows touched.

    Idempotent on the ``(rule_id, version)`` primary key: we look the row up by
    its PK and UPDATE in place when present, else INSERT. This two-step emulation
    works against both a live Postgres and the in-memory test double (neither the
    double nor every supabase-py path exposes ``on_conflict`` here) — the same
    pattern :func:`routes.integrations._record_ad_entities` uses.

    Raises whatever the Supabase admin client raises when the DB / table is
    unreachable; :func:`seed_compliance_rules_safe` is the startup-safe wrapper.
    """
    # Imported lazily so importing this module never forces a Supabase client
    # (mirrors the engine importing the rules module on demand).
    from ..supabase_client import get_supabase_admin

    sb = get_supabase_admin()
    now = datetime.now(timezone.utc).isoformat()
    touched = 0
    for rule in get_starter_rules():
        row = _row_for(rule)
        existing = (
            sb.table("compliance_rule")
            .select("rule_id, version")
            .eq("rule_id", row["rule_id"])
            .eq("version", row["version"])
            .maybe_single()
            .execute()
        )
        found = existing.data if (existing is not None) else None
        if isinstance(found, dict) and found.get("rule_id"):
            (
                sb.table("compliance_rule")
                .update({**row, "updated_at": now})
                .eq("rule_id", row["rule_id"])
                .eq("version", row["version"])
                .execute()
            )
        else:
            sb.table("compliance_rule").insert(row).execute()
        touched += 1

    log.info("compliance_rules_seeded", rules=touched)
    return touched


def seed_compliance_rules_safe() -> int:
    """Best-effort :func:`seed_compliance_rules` for app startup.

    NEVER raises — a missing / unreachable DB (e.g. the worker booting without
    Supabase configured, or before migrations are applied) logs and returns 0
    instead of crashing ``create_app()``. Returns the number of rows seeded.
    """
    try:
        return seed_compliance_rules()
    except Exception as exc:  # noqa: BLE001 — startup must never crash on seed
        log.warning("compliance_rules_seed_skipped", error=str(exc))
        return 0
