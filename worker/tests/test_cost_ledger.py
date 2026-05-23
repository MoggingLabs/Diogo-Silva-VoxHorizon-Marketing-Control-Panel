"""Unit tests for the cost-ledger helpers (P5.4 / #367).

Exercises the write / sum / budget-check surface against the in-memory Supabase
double from ``conftest.py`` — ledger sums are correct, the kind split is right,
budget queries work (capped + uncapped + over), and write failures degrade
without raising (the accounting-never-aborts-work contract).
"""

from __future__ import annotations

import pytest

from src.services import cost_ledger
from src.services.cost_ledger import (
    API_CODEX,
    API_KIE,
    API_META,
    KIND_GENERATION,
    KIND_META_SPEND,
)

from .conftest import FakeSupabase


# ---------------------------------------------------------------------------
# record_cost / record_generation_cost / record_meta_spend
# ---------------------------------------------------------------------------


def test_record_generation_cost_inserts_row(fake_supabase: FakeSupabase) -> None:
    rid = cost_ledger.record_generation_cost(
        pipeline_id="p-1", api=API_KIE, amount_usd=0.05, units=1.0, creative_id="cr-1"
    )
    assert rid is not None
    name, row = fake_supabase.inserts[0]
    assert name == "cost_ledger"
    assert row["pipeline_id"] == "p-1"
    assert row["kind"] == KIND_GENERATION
    assert row["api"] == API_KIE
    assert row["amount_usd"] == 0.05
    assert row["creative_id"] == "cr-1"


def test_record_codex_generation_is_zero_cost(fake_supabase: FakeSupabase) -> None:
    cost_ledger.record_generation_cost(
        pipeline_id="p-1", api=API_CODEX, amount_usd=0.0
    )
    _, row = fake_supabase.inserts[0]
    assert row["api"] == API_CODEX
    assert row["amount_usd"] == 0.0


def test_record_meta_spend_inserts_meta_kind(fake_supabase: FakeSupabase) -> None:
    cost_ledger.record_meta_spend(
        pipeline_id="p-1", amount_usd=42.5, meta={"date": "2026-05-22"}
    )
    _, row = fake_supabase.inserts[0]
    assert row["kind"] == KIND_META_SPEND
    assert row["api"] == API_META
    assert row["amount_usd"] == 42.5
    assert row["meta"] == {"date": "2026-05-22"}


def test_record_cost_rejects_negative_amount(fake_supabase: FakeSupabase) -> None:
    with pytest.raises(ValueError):
        cost_ledger.record_cost(
            pipeline_id="p-1", kind=KIND_GENERATION, api=API_KIE, amount_usd=-1.0
        )
    assert fake_supabase.inserts == []


def test_record_cost_without_creative_omits_column(fake_supabase: FakeSupabase) -> None:
    cost_ledger.record_cost(
        pipeline_id="p-1", kind=KIND_META_SPEND, api=API_META, amount_usd=1.0
    )
    _, row = fake_supabase.inserts[0]
    assert "creative_id" not in row


def test_record_cost_write_failure_returns_none(
    monkeypatch: pytest.MonkeyPatch, fake_supabase: FakeSupabase
) -> None:
    class _Boom:
        def table(self, _name: str):  # noqa: ANN001
            raise RuntimeError("supabase down")

    monkeypatch.setattr(cost_ledger, "get_supabase_admin", lambda: _Boom())
    # Never raises — accounting write must not abort the caller's work.
    assert (
        cost_ledger.record_cost(
            pipeline_id="p-1", kind=KIND_GENERATION, api=API_KIE, amount_usd=0.05
        )
        is None
    )


# ---------------------------------------------------------------------------
# sum_costs
# ---------------------------------------------------------------------------


def test_sum_costs_splits_by_kind(fake_supabase: FakeSupabase) -> None:
    fake_supabase.seed(
        "cost_ledger",
        [
            {"pipeline_id": "p-1", "kind": KIND_GENERATION, "amount_usd": 0.05},
            {"pipeline_id": "p-1", "kind": KIND_GENERATION, "amount_usd": 0.05},
            {"pipeline_id": "p-1", "kind": KIND_META_SPEND, "amount_usd": 100.0},
            # A different pipeline's rows must NOT bleed in.
            {"pipeline_id": "p-2", "kind": KIND_META_SPEND, "amount_usd": 999.0},
        ],
    )
    totals = cost_ledger.sum_costs("p-1")
    assert totals.generation_usd == 0.1
    assert totals.meta_spend_usd == 100.0
    assert totals.total_usd == 100.1
    assert totals.row_count == 3


def test_sum_costs_empty_is_zero(fake_supabase: FakeSupabase) -> None:
    totals = cost_ledger.sum_costs("p-empty")
    assert totals.total_usd == 0.0
    assert totals.generation_usd == 0.0
    assert totals.meta_spend_usd == 0.0
    assert totals.row_count == 0


def test_sum_costs_coerces_string_and_null_amounts(fake_supabase: FakeSupabase) -> None:
    fake_supabase.seed(
        "cost_ledger",
        [
            {"pipeline_id": "p-1", "kind": KIND_META_SPEND, "amount_usd": "12.50"},
            {"pipeline_id": "p-1", "kind": KIND_GENERATION, "amount_usd": None},
            {"pipeline_id": "p-1", "kind": "other", "amount_usd": 1.0},
        ],
    )
    totals = cost_ledger.sum_costs("p-1")
    assert totals.meta_spend_usd == 12.5
    assert totals.generation_usd == 0.0
    # 'other' kind counts toward total but neither split.
    assert totals.total_usd == 13.5


def test_sum_costs_ignores_junk_amount_and_non_dict_rows(
    fake_supabase: FakeSupabase,
) -> None:
    fake_supabase.seed(
        "cost_ledger",
        [
            {"pipeline_id": "p-1", "kind": KIND_META_SPEND, "amount_usd": "not-a-number"},
            {"pipeline_id": "p-1", "kind": KIND_GENERATION, "amount_usd": 0.05},
        ],
    )
    totals = cost_ledger.sum_costs("p-1")
    # The junk amount coerces to 0; the valid generation row still counts.
    assert totals.generation_usd == 0.05
    assert totals.total_usd == 0.05


def test_sum_costs_read_failure_degrades_to_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Boom:
        def table(self, _name: str):  # noqa: ANN001
            raise RuntimeError("read failed")

    monkeypatch.setattr(cost_ledger, "get_supabase_admin", lambda: _Boom())
    totals = cost_ledger.sum_costs("p-1")
    assert totals.total_usd == 0.0
    assert totals.row_count == 0


# ---------------------------------------------------------------------------
# check_budget
# ---------------------------------------------------------------------------


def test_check_budget_under_cap(fake_supabase: FakeSupabase) -> None:
    fake_supabase.seed(
        "cost_ledger",
        [{"pipeline_id": "p-1", "kind": KIND_META_SPEND, "amount_usd": 50.0}],
    )
    status = cost_ledger.check_budget("p-1", cap_usd=100.0)
    assert status.over_cap is False
    assert status.total_usd == 50.0
    assert status.remaining_usd == 50.0


def test_check_budget_over_cap(fake_supabase: FakeSupabase) -> None:
    fake_supabase.seed(
        "cost_ledger",
        [{"pipeline_id": "p-1", "kind": KIND_META_SPEND, "amount_usd": 150.0}],
    )
    status = cost_ledger.check_budget("p-1", cap_usd=100.0)
    assert status.over_cap is True
    assert status.remaining_usd == -50.0


def test_check_budget_no_cap_is_gauge_only(fake_supabase: FakeSupabase) -> None:
    fake_supabase.seed(
        "cost_ledger",
        [{"pipeline_id": "p-1", "kind": KIND_META_SPEND, "amount_usd": 9999.0}],
    )
    status = cost_ledger.check_budget("p-1", cap_usd=None)
    assert status.over_cap is False
    assert status.cap_usd is None
    assert status.remaining_usd is None
    assert status.total_usd == 9999.0
