"""Cost-ledger helpers (P5.4 / #367).

The ``cost_ledger`` table (migration 0023) is the normalized, queryable spend
record across the two cost sources the pipeline incurs:

  * **Generation** — Kie.ai renders (paid) and codex/ChatGPT renders ($0, on
    the operator's subscription). One row per render unit.
  * **Meta spend** — pulled from the operator's Meta insights and recorded here
    so a campaign's real CPL (Meta spend ÷ GHL leads, see :mod:`services.ghl`)
    and the budget gauge read from one place.

This module owns the *write* + *sum* + *budget-check* surface; it never reaches
out to Kie/Meta itself (those are recorded by their callers — the render route
and the reconciliation job). Every function takes the supabase handle implicitly
via :func:`~src.supabase_client.get_supabase_admin` so it threads through the
in-memory test double exactly like the rest of the worker.

``cost_kind_enum`` (migration 0017) constrains ``kind``; the four the pipeline
uses are exposed as constants here so callers don't hard-code strings.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import structlog

from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


# cost_ledger.kind values (subset of cost_kind_enum, migration 0017). Generation
# covers both Kie + codex renders (the ``api`` column disambiguates the source);
# ``meta_spend`` is the ad spend pulled from insights.
KIND_GENERATION = "generation"
KIND_META_SPEND = "meta_spend"

# cost_ledger.api labels — the concrete provider behind a row. Mirrors the
# render route's ``_CODEX_COST_API`` so a codex render recorded here lines up
# with the pipeline_events cost line.
API_KIE = "kie.ai"
API_CODEX = "openai-codex"
API_META = "meta"


@dataclass(frozen=True)
class CostTotals:
    """Rolled-up cost figures for a pipeline.

    ``total_usd`` is every ledger row; ``generation_usd`` / ``meta_spend_usd``
    split by kind so the budget gauge can show "X on renders, Y on ad spend".
    """

    total_usd: float
    generation_usd: float
    meta_spend_usd: float
    row_count: int


def record_cost(
    *,
    pipeline_id: str,
    kind: str,
    api: str | None,
    amount_usd: float,
    units: float = 0.0,
    creative_id: str | None = None,
    meta: dict[str, Any] | None = None,
) -> str | None:
    """Insert one ``cost_ledger`` row and return its id (or ``None`` on failure).

    Mirrors :func:`services.pipeline_runner.emit_pipeline_event`'s contract: a
    write failure is logged but never raised — the ledger is an accounting
    rollup, not a control-flow gate, so a transient Supabase hiccup must not
    abort a render or a reconciliation pass. ``amount_usd`` < 0 is rejected as a
    programming error (a refund would be modelled as its own typed kind, not a
    negative spend row).
    """
    if amount_usd < 0:
        raise ValueError(f"record_cost amount_usd must be >= 0 (got {amount_usd!r})")
    sb = get_supabase_admin()
    row: dict[str, Any] = {
        "pipeline_id": pipeline_id,
        "kind": kind,
        "api": api,
        "units": units,
        "amount_usd": amount_usd,
        "meta": meta or {},
    }
    if creative_id is not None:
        row["creative_id"] = creative_id
    try:
        resp = sb.table("cost_ledger").insert(row).execute()
        created = (resp.data or [None])[0] if resp is not None else None
        if isinstance(created, dict):
            return str(created.get("id") or "") or None
    except Exception as e:  # noqa: BLE001 — accounting write never aborts work
        log.warning(
            "cost_ledger_write_failed",
            pipeline_id=pipeline_id,
            kind=kind,
            api=api,
            error=str(e),
        )
    return None


def record_generation_cost(
    *,
    pipeline_id: str,
    api: str,
    amount_usd: float,
    units: float = 1.0,
    creative_id: str | None = None,
    meta: dict[str, Any] | None = None,
) -> str | None:
    """Record a generation (Kie/codex render) cost line. Thin :func:`record_cost`."""
    return record_cost(
        pipeline_id=pipeline_id,
        kind=KIND_GENERATION,
        api=api,
        amount_usd=amount_usd,
        units=units,
        creative_id=creative_id,
        meta=meta,
    )


def record_meta_spend(
    *,
    pipeline_id: str,
    amount_usd: float,
    meta: dict[str, Any] | None = None,
) -> str | None:
    """Record a Meta ad-spend line (from operator-pulled insights)."""
    return record_cost(
        pipeline_id=pipeline_id,
        kind=KIND_META_SPEND,
        api=API_META,
        amount_usd=amount_usd,
        units=0.0,
        meta=meta,
    )


def _as_float(value: Any) -> float:
    """Coerce a Supabase numeric (Decimal/str/int) to float (None/junk → 0)."""
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def sum_costs(pipeline_id: str) -> CostTotals:
    """Sum a pipeline's ledger rows into a :class:`CostTotals`.

    Reads every ``cost_ledger`` row for the pipeline and folds them client-side
    (timelines are bounded — a handful of renders + a daily spend line, well
    under a page). A read failure degrades to all-zero totals (logged) so the
    budget gauge never crashes the caller.
    """
    sb = get_supabase_admin()
    try:
        resp = (
            sb.table("cost_ledger")
            .select("kind, amount_usd")
            .eq("pipeline_id", pipeline_id)
            .execute()
        )
        rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
    except Exception as e:  # noqa: BLE001 — budget read degrades to zero
        log.warning("cost_ledger_sum_failed", pipeline_id=pipeline_id, error=str(e))
        rows = []

    total = 0.0
    generation = 0.0
    meta_spend = 0.0
    for row in rows:
        if not isinstance(row, dict):
            continue
        amount = _as_float(row.get("amount_usd"))
        total += amount
        kind = row.get("kind")
        if kind == KIND_GENERATION:
            generation += amount
        elif kind == KIND_META_SPEND:
            meta_spend += amount
    return CostTotals(
        total_usd=round(total, 6),
        generation_usd=round(generation, 6),
        meta_spend_usd=round(meta_spend, 6),
        row_count=len(rows),
    )


@dataclass(frozen=True)
class BudgetStatus:
    """Result of a budget check for a pipeline."""

    pipeline_id: str
    total_usd: float
    cap_usd: float | None
    over_cap: bool
    remaining_usd: float | None


def check_budget(pipeline_id: str, cap_usd: float | None) -> BudgetStatus:
    """Compare a pipeline's spend to ``cap_usd``.

    ``cap_usd is None`` means "no cap configured" — ``over_cap`` is then always
    ``False`` and ``remaining_usd`` is ``None`` (the architecture notes the
    accepted residual: no hard server-side cap; the approval gate is the real
    guardrail, this is the *gauge*). Otherwise ``over_cap`` is ``total > cap``.
    """
    totals = sum_costs(pipeline_id)
    if cap_usd is None:
        return BudgetStatus(
            pipeline_id=pipeline_id,
            total_usd=totals.total_usd,
            cap_usd=None,
            over_cap=False,
            remaining_usd=None,
        )
    return BudgetStatus(
        pipeline_id=pipeline_id,
        total_usd=totals.total_usd,
        cap_usd=cap_usd,
        over_cap=totals.total_usd > cap_usd,
        remaining_usd=round(cap_usd - totals.total_usd, 6),
    )
