"""Unit tests for the daily reconciliation core (P5.3/P5.4 / #366 #367).

``reconcile_pipeline`` pulls GHL leads via :class:`GhlClient` (driven through an
``httpx.MockTransport`` — zero live HTTP), reads Meta spend from the cost ledger
(the in-memory supabase double), computes ``real_cpl = spend / leads``, and
writes a ``campaign_perf_image`` row. We assert: correct lead count, correct
CPL, the perf row is written + linked, and the zero-leads divide-by-zero guard
(real_cpl → None).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx
import pytest

from src.routes import integrations
from src.services._http import ResilientHttpClient
from src.services.cost_ledger import KIND_META_SPEND
from src.services.ghl import GHL_API_VERSION, GhlClient

from .conftest import FakeSupabase


SINCE = datetime(2026, 5, 1, tzinfo=timezone.utc)
UNTIL = datetime(2026, 5, 8, tzinfo=timezone.utc)
IN_WINDOW = "2026-05-04T12:00:00.000Z"


def _client_with(handler) -> GhlClient:  # noqa: ANN001
    async def _no_sleep(_d: float) -> None:
        return None

    http = ResilientHttpClient(
        headers={"Authorization": "Bearer t", "Version": GHL_API_VERSION},
        transport=httpx.MockTransport(handler),
        sleep=_no_sleep,
        rng=lambda: 0.0,
    )
    # Pass an explicit key so construction doesn't require the GHL_API_KEY env
    # (the shared harness env doesn't set it); the injected http_client makes
    # the key unused on the wire anyway.
    return GhlClient(api_key="test-ghl-token", http_client=http)


def _contacts_response(contacts: list[dict]) -> httpx.Response:
    # GHL contacts/search returns < PAGE_SIZE rows ⇒ the connector stops paging.
    return httpx.Response(200, json={"contacts": contacts})


async def test_reconcile_computes_cpl_and_writes_perf_row(
    fake_supabase: FakeSupabase,
) -> None:
    # 4 in-window leads tagged with the campaign ref.
    def handler(_req: httpx.Request) -> httpx.Response:
        return _contacts_response(
            [
                {"id": f"c-{i}", "dateAdded": IN_WINDOW, "source": "camp-100"}
                for i in range(4)
            ]
        )

    fake_supabase.seed(
        "cost_ledger",
        [{"pipeline_id": "p-1", "kind": KIND_META_SPEND, "amount_usd": 200.0}],
    )

    ghl = _client_with(handler)
    result = await integrations.reconcile_pipeline(
        pipeline_id="p-1",
        location_id="loc-1",
        campaign_ref="camp-100",
        window=(SINCE, UNTIL),
        ghl_client=ghl,
        ad_entity_id="ae-1",
    )
    await ghl.aclose()

    assert result.ghl_leads == 4
    assert result.meta_spend_usd == 200.0
    assert result.real_cpl == 50.0  # 200 / 4
    assert result.perf_row_written is True

    perf = [row for name, row in fake_supabase.inserts if name == "campaign_perf_image"]
    assert len(perf) == 1
    assert perf[0]["pipeline_id"] == "p-1"
    assert perf[0]["ad_entity_id"] == "ae-1"
    assert perf[0]["leads"] == 4
    assert perf[0]["real_cpl"] == 50.0


async def test_reconcile_records_meta_spend_yields_nonzero_cpl(
    fake_supabase: FakeSupabase,
) -> None:
    """E4.3 #503 regression: the structural real_cpl == 0 bug.

    With NO pre-seeded ledger spend (the prod reality — nothing recorded
    meta_spend), reconcile is handed the pulled Meta insights spend and RECORDS
    it, so summing the ledger back yields a non-zero real_cpl. Before the fix the
    ledger was always empty -> real_cpl always 0/None -> the monitor ran on
    garbage.
    """

    def handler(_req: httpx.Request) -> httpx.Response:
        return _contacts_response(
            [
                {"id": f"c-{i}", "dateAdded": IN_WINDOW, "source": "camp-100"}
                for i in range(5)
            ]
        )

    # NOTE: cost_ledger is NOT seeded — the bug was that prod never populated it.
    ghl = _client_with(handler)
    result = await integrations.reconcile_pipeline(
        pipeline_id="p-1",
        location_id="loc-1",
        campaign_ref="camp-100",
        window=(SINCE, UNTIL),
        ghl_client=ghl,
        ad_entity_id="ae-1",
        meta_spend_usd=250.0,  # pulled from Meta insights this pass
    )
    await ghl.aclose()

    assert result.ghl_leads == 5
    assert result.meta_spend_usd == 250.0
    assert result.real_cpl == 50.0  # 250 / 5 — NON-ZERO
    assert result.real_cpl is not None

    # The pulled spend was RECORDED to the ledger (a meta_spend row landed).
    spend_rows = [
        row
        for name, row in fake_supabase.inserts
        if name == "cost_ledger" and row.get("kind") == KIND_META_SPEND
    ]
    assert len(spend_rows) == 1
    assert spend_rows[0]["amount_usd"] == 250.0
    assert spend_rows[0]["dedupe_key"].startswith("meta_spend:p-1:")


async def test_reconcile_rerun_is_idempotent_no_double_spend(
    fake_supabase: FakeSupabase,
) -> None:
    """Re-running a day's reconciliation does not double-count the spend.

    The recorded meta_spend is keyed on (pipeline, campaign, window), so the
    second pass dedupes and real_cpl stays correct instead of halving.
    """

    def handler(_req: httpx.Request) -> httpx.Response:
        return _contacts_response(
            [{"id": "c-1", "dateAdded": IN_WINDOW, "source": "camp-100"}]
        )

    async def _run() -> Any:  # noqa: ANN401
        ghl = _client_with(handler)
        res = await integrations.reconcile_pipeline(
            pipeline_id="p-1",
            location_id="loc-1",
            campaign_ref="camp-100",
            window=(SINCE, UNTIL),
            ghl_client=ghl,
            meta_spend_usd=100.0,
        )
        await ghl.aclose()
        return res

    first = await _run()
    second = await _run()

    assert first.meta_spend_usd == 100.0
    assert second.meta_spend_usd == 100.0  # NOT 200 — deduped, not doubled
    assert second.real_cpl == 100.0  # 100 / 1

    spend_rows = [
        row
        for name, row in fake_supabase.inserts
        if name == "cost_ledger" and row.get("kind") == KIND_META_SPEND
    ]
    assert len(spend_rows) == 1  # exactly one recorded spend row across both runs


async def test_reconcile_zero_leads_cpl_none(fake_supabase: FakeSupabase) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return _contacts_response([])  # no leads in window

    fake_supabase.seed(
        "cost_ledger",
        [{"pipeline_id": "p-1", "kind": KIND_META_SPEND, "amount_usd": 80.0}],
    )

    ghl = _client_with(handler)
    result = await integrations.reconcile_pipeline(
        pipeline_id="p-1",
        location_id="loc-1",
        campaign_ref="camp-100",
        window=(SINCE, UNTIL),
        ghl_client=ghl,
    )
    await ghl.aclose()

    assert result.ghl_leads == 0
    assert result.real_cpl is None  # divide-by-zero guard
    perf = [row for name, row in fake_supabase.inserts if name == "campaign_perf_image"]
    assert perf[0]["real_cpl"] is None


async def test_reconcile_fake_ghl_mode(
    monkeypatch: pytest.MonkeyPatch, fake_supabase: FakeSupabase
) -> None:
    """FAKE_GHL: deterministic 2 leads, zero network — the local/CI path."""
    monkeypatch.setenv("FAKE_GHL", "true")
    from src.config import get_settings

    get_settings.cache_clear()

    fake_supabase.seed(
        "cost_ledger",
        [{"pipeline_id": "p-1", "kind": KIND_META_SPEND, "amount_usd": 30.0}],
    )

    ghl = GhlClient()  # no transport — FAKE_GHL short-circuits the HTTP path
    result = await integrations.reconcile_pipeline(
        pipeline_id="p-1",
        location_id="loc-1",
        campaign_ref="camp-100",
        window=(SINCE, UNTIL),
        ghl_client=ghl,
    )
    await ghl.aclose()
    get_settings.cache_clear()

    assert result.ghl_leads == 2  # _fake_leads returns two in-window leads
    assert result.real_cpl == 15.0  # 30 / 2


async def test_reconcile_perf_write_failure_degrades(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A perf-row write failure is logged, not raised (job never aborts)."""

    class _PartialBoom:
        """Reads work (empty cost ledger); the perf insert raises."""

        def table(self, name: str):  # noqa: ANN001
            return _PartialTable(name)

    class _PartialTable:
        def __init__(self, name: str) -> None:
            self.name = name

        def select(self, *_a, **_k):  # noqa: ANN002, ANN003
            return self

        def eq(self, *_a, **_k):  # noqa: ANN002, ANN003
            return self

        def insert(self, *_a, **_k):  # noqa: ANN002, ANN003
            if self.name == "campaign_perf_image":
                raise RuntimeError("perf insert failed")
            return self

        def execute(self):
            from types import SimpleNamespace

            return SimpleNamespace(data=[])

    monkeypatch.setattr(integrations, "get_supabase_admin", lambda: _PartialBoom())
    from src.services import cost_ledger as cl

    monkeypatch.setattr(cl, "get_supabase_admin", lambda: _PartialBoom())

    def handler(_req: httpx.Request) -> httpx.Response:
        return _contacts_response([{"id": "c-1", "dateAdded": IN_WINDOW, "source": "camp-100"}])

    ghl = _client_with(handler)
    result = await integrations.reconcile_pipeline(
        pipeline_id="p-1",
        location_id="loc-1",
        campaign_ref="camp-100",
        window=(SINCE, UNTIL),
        ghl_client=ghl,
    )
    await ghl.aclose()
    assert result.perf_row_written is False
    assert result.ghl_leads == 1
