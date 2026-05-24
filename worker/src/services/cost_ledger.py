"""Cost-ledger helpers (P5.4 / #367, M4 E4.1 #498 / E4.3 #503).

The ``cost_ledger`` table (migration 0023) is the normalized, queryable spend
record across the cost sources the pipeline incurs:

  * **Image generation** — Kie.ai renders (paid) and codex/ChatGPT renders ($0,
    on the operator's subscription). One row per render unit.
  * **Video generation** — Kie video clips (the only paid video step).
  * **TTS** — Kie ElevenLabs voiceover synthesis.
  * **Meta spend** — pulled from the operator's Meta insights and recorded here
    so a campaign's real CPL (Meta spend ÷ GHL leads, see :mod:`services.ghl`)
    and the budget gauge read from one place.

This is now the **single ledger write path** (E4.1): the prod cost call site
``services.pipeline_runner.emit_cost`` writes a typed row HERE (in addition to
the ``pipeline_events`` timeline line) so the two formerly-disconnected cost
systems are consolidated — ``reconcile_pipeline`` reads back real meta_spend and
the budget gauge reads real generation spend, instead of an always-zero table.

This module owns the *write* + *sum* + *budget-check* surface; it never reaches
out to Kie/Meta itself (those are recorded by their callers — the render route
and the reconciliation job). Every function takes the supabase handle implicitly
via :func:`~src.supabase_client.get_supabase_admin` so it threads through the
in-memory test double exactly like the rest of the worker.

``cost_kind_enum`` (migrations 0017 + 0036) constrains ``kind``; the values the
pipeline uses are exposed as constants here so callers don't hard-code strings.
The legacy ``KIND_GENERATION`` string ("generation") was NOT a member of the
enum (a latent break) and is replaced by the real ``image_gen`` / ``video_gen``
/ ``tts`` values; :func:`kind_for_api` maps a cost ``api`` label to the right
enum value so the single write path stays declarative.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import structlog

from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


# cost_ledger.kind values — the real ``cost_kind_enum`` members (migration 0017
# adds image_gen/video_gen/vision_qa/copy_llm/meta_spend/other; 0036 adds tts).
KIND_IMAGE_GEN = "image_gen"
KIND_VIDEO_GEN = "video_gen"
KIND_TTS = "tts"
KIND_VISION_QA = "vision_qa"
KIND_COPY_LLM = "copy_llm"
KIND_META_SPEND = "meta_spend"
KIND_OTHER = "other"

# The full set of valid enum values, so a write can be validated against the
# schema before it hits Postgres (a bad string would otherwise 22P02 the insert
# and lose the cost line). Mirrors cost_kind_enum (0017 + 0036).
COST_KINDS: frozenset[str] = frozenset(
    {
        KIND_IMAGE_GEN,
        KIND_VIDEO_GEN,
        KIND_TTS,
        KIND_VISION_QA,
        KIND_COPY_LLM,
        KIND_META_SPEND,
        KIND_OTHER,
    }
)

# Back-compat: the old constant name some callers/tests referenced. Now points
# at the real image-generation enum value rather than the invalid "generation".
KIND_GENERATION = KIND_IMAGE_GEN

# Kinds that count toward the "generation" (produced-asset) spend split, as
# opposed to ``meta_spend`` (ad spend) and ``other`` (uncategorised).
_GENERATION_KINDS: frozenset[str] = frozenset(
    {KIND_IMAGE_GEN, KIND_VIDEO_GEN, KIND_TTS, KIND_VISION_QA, KIND_COPY_LLM}
)

# cost_ledger.api labels — the concrete provider behind a row. Mirrors the
# render route's ``_CODEX_COST_API`` so a codex render recorded here lines up
# with the pipeline_events cost line.
API_KIE = "kie.ai"
API_KIE_VIDEO = "kie-video"
API_KIE_TTS = "kie-tts"
API_CODEX = "openai-codex"
API_META = "meta"

# Map a cost ``api`` label (the upstream the spend was paid to) to its
# ``cost_kind_enum`` value. The single write path (emit_cost) passes the api it
# already records on the pipeline_events line; this keeps the ledger kind in
# lockstep without the call sites hard-coding the enum. An unknown api degrades
# to ``image_gen`` for the legacy image-render default (the historical behaviour
# of the old "generation" kind), so a new provider never silently 22P02s.
_API_TO_KIND: dict[str, str] = {
    API_KIE: KIND_IMAGE_GEN,
    API_CODEX: KIND_IMAGE_GEN,
    "gpt-image-2": KIND_IMAGE_GEN,
    API_KIE_VIDEO: KIND_VIDEO_GEN,
    "kie-video-gen": KIND_VIDEO_GEN,
    API_KIE_TTS: KIND_TTS,
    "elevenlabs": KIND_TTS,
    API_META: KIND_META_SPEND,
    "meta": KIND_META_SPEND,
}


def kind_for_api(api: str | None) -> str:
    """Resolve a cost ``api`` label to its ``cost_kind_enum`` value.

    Used by the single write path so callers pass only the api they already
    record on the timeline. Free/local steps (ffmpeg, whisper, yt-dlp) and any
    unrecognised api fall back to ``image_gen`` only when they look like a render
    api; otherwise ``other`` — so a $0 local-op cost line is categorised cleanly
    and never trips the enum constraint.
    """
    if api is None:
        return KIND_OTHER
    mapped = _API_TO_KIND.get(api.strip().lower()) or _API_TO_KIND.get(api)
    if mapped is not None:
        return mapped
    # Local / free ops and unknown providers: keep them as 'other' so the budget
    # gauge's generation split stays meaningful (real paid renders only).
    return KIND_OTHER


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
    dedupe_key: str | None = None,
) -> str | None:
    """Insert one ``cost_ledger`` row and return its id (or ``None`` on failure).

    Mirrors :func:`services.pipeline_runner.emit_pipeline_event`'s contract: a
    write failure is logged but never raised — the ledger is an accounting
    rollup, not a control-flow gate, so a transient Supabase hiccup must not
    abort a render or a reconciliation pass. ``amount_usd`` < 0 is rejected as a
    programming error (a refund would be modelled as its own typed kind, not a
    negative spend row). ``kind`` must be a ``cost_kind_enum`` member — an
    invalid value is rejected before the write rather than 22P02-ing on Postgres.

    ``dedupe_key`` (E4.1 idempotency, migration 0036): when supplied, the unique
    partial index makes the write exactly-once — a retried render or a re-run
    reconciliation that passes the same key collapses to a single ledger row
    instead of double-counting spend. A duplicate-key insert is caught + treated
    as already-recorded (returns ``None``, logged at info).
    """
    if amount_usd < 0:
        raise ValueError(f"record_cost amount_usd must be >= 0 (got {amount_usd!r})")
    if kind not in COST_KINDS:
        raise ValueError(
            f"record_cost kind must be a cost_kind_enum value "
            f"(got {kind!r}; valid: {sorted(COST_KINDS)})"
        )
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
    # Everything that touches Supabase (resolving the admin client, the dedupe
    # probe, the insert) runs under one guard — the ledger is an accounting
    # rollup, not a control-flow gate, so ANY failure (a transient hiccup, a
    # missing-config RuntimeError when the worker runs without Supabase) is
    # logged and swallowed, never raised, so it can't abort a render or a
    # reconciliation pass.
    try:
        sb = get_supabase_admin()
        if dedupe_key is not None:
            # Probe-then-insert so a replayed key is a clean no-op even on the
            # in-memory double (which has no unique-index enforcement). The
            # unique partial index (0036) is the real backstop for a race.
            existing = (
                sb.table("cost_ledger")
                .select("id")
                .eq("dedupe_key", dedupe_key)
                .maybe_single()
                .execute()
            )
            if existing is not None and isinstance(existing.data, dict):
                log.info(
                    "cost_ledger_write_deduped",
                    pipeline_id=pipeline_id,
                    kind=kind,
                    dedupe_key=dedupe_key,
                )
                return None
            row["dedupe_key"] = dedupe_key
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
    dedupe_key: str | None = None,
    kind: str | None = None,
) -> str | None:
    """Record a generation cost line, kind derived from ``api``.

    Thin :func:`record_cost` whose ``kind`` is resolved from the ``api`` label
    via :func:`kind_for_api` (Kie/codex image → ``image_gen``, kie-video →
    ``video_gen``, kie-tts → ``tts``), unless an explicit ``kind`` overrides it.
    This is the helper the single write path (emit_cost) delegates to for every
    non-meta cost line.
    """
    resolved_kind = kind or kind_for_api(api)
    return record_cost(
        pipeline_id=pipeline_id,
        kind=resolved_kind,
        api=api,
        amount_usd=amount_usd,
        units=units,
        creative_id=creative_id,
        meta=meta,
        dedupe_key=dedupe_key,
    )


def record_meta_spend(
    *,
    pipeline_id: str,
    amount_usd: float,
    meta: dict[str, Any] | None = None,
    dedupe_key: str | None = None,
) -> str | None:
    """Record a Meta ad-spend line (from operator-pulled insights).

    ``dedupe_key`` lets the daily reconciliation key a spend line on
    (campaign, window) so re-running a day's reconciliation does not double the
    recorded spend (and so real_cpl stays correct).
    """
    return record_cost(
        pipeline_id=pipeline_id,
        kind=KIND_META_SPEND,
        api=API_META,
        amount_usd=amount_usd,
        units=0.0,
        meta=meta,
        dedupe_key=dedupe_key,
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
        # "generation" rolls up every produced-asset cost: image, video and TTS
        # (the budget gauge shows "X on renders, Y on ad spend").
        if kind in _GENERATION_KINDS:
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
