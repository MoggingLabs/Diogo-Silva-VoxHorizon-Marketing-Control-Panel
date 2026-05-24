"""Contract tests for the P3 operator stage-persist routes.

Covers the five endpoints on the operator-stage-tools router with the full
matrix the rebuild requires (happy / 401 / 422 / idempotency / error):

  * POST /work/pipeline/tools/copy            — upsert copy_variants + arm gate.
  * POST /work/pipeline/tools/spec_result     — write spec_check + roll gate.
  * POST /work/pipeline/tools/finalize_result — record creatives finalize cols.
  * POST /work/pipeline/tools/monitor_result  — campaign_perf_image + cpl_real.
  * POST /work/pipeline/tools/signal          — operator_dispatches lifecycle.

Uses the shared harness (``client`` + ``fake_supabase``) from conftest.py. The
fake is additionally installed on the ``operator_stage_tools`` module here
(conftest patches the pipeline_tools/runner modules; this route is new).
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from .conftest import FakeSupabase, SHARED_SECRET


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {SHARED_SECRET}"}


def _pipeline_row(**overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": "p-1",
        "status": "copy",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib-1",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {"image": ["cr-1"], "video": []},
        "advanced_at": {},
        "created_at": "2026-05-22T00:00:00Z",
    }
    row.update(overrides)
    return row


@pytest.fixture
def stage_sb(fake_supabase: FakeSupabase, monkeypatch: pytest.MonkeyPatch) -> FakeSupabase:
    """The shared fake, also installed on the new operator_stage_tools module."""
    from src.routes import operator_stage_tools

    monkeypatch.setattr(operator_stage_tools, "get_supabase_admin", lambda: fake_supabase)
    return fake_supabase


# ===========================================================================
# POST /work/pipeline/tools/copy
# ===========================================================================


def test_copy_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/pipeline/tools/copy", json={})
    assert resp.status_code == 401


def test_copy_422_on_empty_variants(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    resp = client.post(
        "/work/pipeline/tools/copy",
        headers=_auth(),
        json={"pipeline_id": "p-1", "variants": []},
    )
    assert resp.status_code == 422


def test_copy_404_when_pipeline_missing(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", None)
    resp = client.post(
        "/work/pipeline/tools/copy",
        headers=_auth(),
        json={
            "pipeline_id": "ghost",
            "variants": [{"creative_id": "cr-1", "headline": "h"}],
        },
    )
    assert resp.status_code == 404


def test_copy_happy_inserts_variants_and_arms_gate(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    resp = client.post(
        "/work/pipeline/tools/copy",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "variants": [
                {
                    "creative_id": "cr-1",
                    "platform": "meta",
                    "variant_index": 1,
                    "headline": "New roof, no surprises",
                    "primary_text": "Storm damage? We handle the claim.",
                    "cta": "Get a free inspection",
                    "validation": {"headline_chars": 23},
                },
                {
                    "creative_id": "cr-1",
                    "platform": "meta",
                    "variant_index": 2,
                    "headline": "Roof leak? Act fast",
                },
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert len(body["variants"]) == 2
    # One creative, two variants -> one rollup entry armed to in_progress.
    assert len(body["rollup"]) == 1
    assert body["rollup"][0]["stage_state"] == "in_progress"
    assert body["rollup"][0]["variant_count"] == 2

    inserted_tables = [t for t, _ in stage_sb.inserts]
    assert inserted_tables.count("copy_variants") == 2
    assert "creative_stage_state" in inserted_tables
    # Primary text maps onto the back-compat `body` column.
    copy_rows = [r for t, r in stage_sb.inserts if t == "copy_variants"]
    assert copy_rows[0]["body"] == "Storm damage? We handle the claim."
    assert copy_rows[0]["status"] == "draft"


def test_copy_idempotent_updates_existing_variant(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    # Pre-seed an existing variant + gate row for the unique key.
    stage_sb.seed(
        "copy_variants",
        [{"id": "cv-existing", "creative_id": "cr-1", "platform": "meta", "variant_index": 1}],
    )
    stage_sb.seed(
        "creative_stage_state",
        [{"id": "css-existing", "creative_id": "cr-1", "stage": "copy", "status": "in_progress"}],
    )
    resp = client.post(
        "/work/pipeline/tools/copy",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "variants": [{"creative_id": "cr-1", "variant_index": 1, "headline": "rev"}],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["variants"][0]["copy_variant_id"] == "cv-existing"
    # No new copy_variants insert — it was an update of the existing row.
    assert all(t != "copy_variants" for t, _ in stage_sb.inserts)
    updated = [(t, r) for t, r in stage_sb.updates if t == "copy_variants"]
    assert updated and updated[0][1]["headline"] == "rev"


def test_copy_routes_video_creative_to_video_table(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    """A video creative's copy is written to video_copy_variants, not copy_variants."""
    stage_sb.set_single("pipelines", _pipeline_row())
    stage_sb.seed("video_creatives", [{"id": "vc-1", "brief_id": "vb-1"}])
    resp = client.post(
        "/work/pipeline/tools/copy",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "variants": [
                {
                    "creative_id": "vc-1",
                    "headline": "One storm from a leak",
                    "primary_text": "Book your $99 inspection.",
                    "cta": "Book now",
                    "validation": {"humanized": True},
                }
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    inserted = [t for t, _ in stage_sb.inserts]
    assert "video_copy_variants" in inserted
    assert "copy_variants" not in inserted
    vrows = [r for t, r in stage_sb.inserts if t == "video_copy_variants"]
    assert vrows[0]["body"] == "Book your $99 inspection."
    assert vrows[0]["humanized"] is True
    assert vrows[0]["status"] == "draft"
    # The per-creative gate still arms (format-agnostic).
    assert any(t == "creative_stage_state" for t, _ in stage_sb.inserts)
    assert resp.json()["rollup"][0]["stage_state"] == "in_progress"


def test_copy_video_resume_by_skip(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    """A re-dispatch skips a video creative that already has copy (no dup insert)."""
    stage_sb.set_single("pipelines", _pipeline_row())
    stage_sb.seed("video_creatives", [{"id": "vc-1", "brief_id": "vb-1"}])
    stage_sb.seed("video_copy_variants", [{"id": "vcv-1", "creative_id": "vc-1"}])
    resp = client.post(
        "/work/pipeline/tools/copy",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "variants": [{"creative_id": "vc-1", "headline": "rev", "primary_text": "x"}],
        },
    )
    assert resp.status_code == 200, resp.text
    # Resume-by-skip: no NEW video_copy_variants insert.
    assert all(t != "video_copy_variants" for t, _ in stage_sb.inserts)


# ===========================================================================
# POST /work/pipeline/tools/spec_result
# ===========================================================================


def test_spec_happy_passes_when_all_placements_pass(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    resp = client.post(
        "/work/pipeline/tools/spec_result",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "results": [
                {"creative_id": "cr-1", "placement": "feed", "ratio": "1x1", "status": "pass"},
                {"creative_id": "cr-1", "placement": "stories", "ratio": "9x16", "status": "pass"},
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["results"]) == 2
    assert body["rollup"][0]["stage_state"] == "passed"
    assert [t for t, _ in stage_sb.inserts].count("spec_check") == 2


def test_spec_failing_placement_holds_gate_failed(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    resp = client.post(
        "/work/pipeline/tools/spec_result",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "results": [
                {"creative_id": "cr-1", "placement": "feed", "status": "pass"},
                {"creative_id": "cr-1", "placement": "stories", "status": "fail"},
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    # A failing placement must NOT auto-pass the gate — it holds it failed.
    assert resp.json()["rollup"][0]["stage_state"] == "failed"


def test_spec_warn_holds_gate_in_progress(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    resp = client.post(
        "/work/pipeline/tools/spec_result",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "results": [{"creative_id": "cr-1", "placement": "feed", "status": "warn"}],
        },
    )
    assert resp.json()["rollup"][0]["stage_state"] == "in_progress"


def test_spec_422_on_bad_status(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    resp = client.post(
        "/work/pipeline/tools/spec_result",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "results": [{"creative_id": "cr-1", "placement": "feed", "status": "bogus"}],
        },
    )
    assert resp.status_code == 422


def test_spec_idempotent_updates_existing_check(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    stage_sb.seed(
        "spec_check",
        [{"id": "sc-1", "creative_id": "cr-1", "platform": "meta", "placement": "feed"}],
    )
    resp = client.post(
        "/work/pipeline/tools/spec_result",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "results": [{"creative_id": "cr-1", "placement": "feed", "status": "pass"}],
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["results"][0]["spec_check_id"] == "sc-1"
    assert all(t != "spec_check" for t, _ in stage_sb.inserts)


# ===========================================================================
# POST /work/pipeline/tools/finalize_result
# ===========================================================================


def test_finalize_happy_records_creative_cols(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    stage_sb.seed("creatives", [{"id": "cr-1", "finalize_verified": False}])
    resp = client.post(
        "/work/pipeline/tools/finalize_result",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "results": [
                {
                    "creative_id": "cr-1",
                    "asset_name": "2026-05-22 | Roof Trust v1 | $99",
                    "drive_folder_id": "drv-folder-1",
                    "file_path_drive": "drive://acme/roof-trust-v1.png",
                    "verified": True,
                }
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recorded"][0]["creative_id"] == "cr-1"
    assert body["skipped"] == []
    updates = [r for t, r in stage_sb.updates if t == "creatives"]
    assert updates and updates[0]["finalize_verified"] is True
    assert updates[0]["drive_folder_id"] == "drv-folder-1"
    assert "finalized_at" in updates[0]


def test_finalize_skips_already_verified(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    stage_sb.seed("creatives", [{"id": "cr-1", "finalize_verified": True}])
    resp = client.post(
        "/work/pipeline/tools/finalize_result",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "results": [{"creative_id": "cr-1", "asset_name": "x", "verified": True}],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recorded"] == []
    assert body["skipped"] == ["cr-1"]
    assert all(t != "creatives" for t, _ in stage_sb.updates)


def test_finalize_404_on_missing_creative(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    # No creatives seeded -> maybe_single returns None -> 404.
    resp = client.post(
        "/work/pipeline/tools/finalize_result",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "results": [{"creative_id": "ghost", "asset_name": "x", "verified": True}],
        },
    )
    assert resp.status_code == 404


def test_finalize_422_on_missing_asset_name(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    resp = client.post(
        "/work/pipeline/tools/finalize_result",
        headers=_auth(),
        json={"pipeline_id": "p-1", "results": [{"creative_id": "cr-1"}]},
    )
    assert resp.status_code == 422


# ===========================================================================
# POST /work/pipeline/tools/monitor_result
# ===========================================================================


def test_monitor_happy_computes_cpl_real(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row(status="monitor"))
    resp = client.post(
        "/work/pipeline/tools/monitor_result",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "results": [
                {
                    "campaign_id": "camp-1",
                    "ad_entity_id": "ae-1",
                    "window_days": 30,
                    "spend": 300.0,
                    "ghl_leads": 12,
                    "ctr": 0.018,
                    "verdict": "keep",
                    "verdict_reason": "CPL under target",
                }
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Real CPL = spend / GHL leads = 300 / 12 = 25.0 (GHL is lead truth).
    assert body["recorded"][0]["cpl_real"] == 25.0
    assert body["tally"] == {"kill": 0, "watch": 0, "keep": 1}
    perf = [r for t, r in stage_sb.inserts if t == "campaign_perf_image"]
    assert perf and perf[0]["cpl_real"] == 25.0
    assert perf[0]["leads_ghl"] == 12
    assert perf[0]["pipeline_id"] == "p-1"


def test_monitor_zero_ghl_leads_cpl_is_none(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row(status="monitor"))
    resp = client.post(
        "/work/pipeline/tools/monitor_result",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "results": [
                {"campaign_id": "camp-1", "window_days": 7, "spend": 80.0, "ghl_leads": 0, "verdict": "kill"}
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    # No leads -> undefined CPL (None), never a divide-by-zero.
    assert resp.json()["recorded"][0]["cpl_real"] is None


def test_monitor_idempotent_skips_today(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    from datetime import datetime, timezone

    stage_sb.set_single("pipelines", _pipeline_row(status="monitor"))
    today = datetime.now(timezone.utc).date().isoformat()
    stage_sb.seed(
        "campaign_perf_image",
        [
            {
                "id": "perf-old",
                "client_id": "c-1",
                "campaign_id": "camp-1",
                "window_days": 30,
                "pulled_at": f"{today}T01:00:00+00:00",
            }
        ],
    )
    resp = client.post(
        "/work/pipeline/tools/monitor_result",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "client_id": "c-1",
            "results": [
                {"campaign_id": "camp-1", "window_days": 30, "spend": 300.0, "ghl_leads": 10, "verdict": "keep"}
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["skipped"] == ["camp-1"]
    assert body["recorded"] == []


def test_monitor_422_on_bad_verdict(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row(status="monitor"))
    resp = client.post(
        "/work/pipeline/tools/monitor_result",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "results": [{"campaign_id": "c", "window_days": 7, "verdict": "explode"}],
        },
    )
    assert resp.status_code == 422


# ===========================================================================
# POST /work/pipeline/tools/signal
# ===========================================================================


def test_signal_opens_dispatch_row(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    resp = client.post(
        "/work/pipeline/tools/signal",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "dispatch_id": "d-1",
            "stage": "copy",
            "status": "running",
            "expected_status": "copy",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "running"
    assert body["terminal"] is False
    inserted = [r for t, r in stage_sb.inserts if t == "operator_dispatches"]
    assert inserted and inserted[0]["status"] == "running"
    assert inserted[0]["stage"] == "copy"
    assert "last_heartbeat_at" in inserted[0]


def test_signal_terminal_close_stamps_completed_at(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    resp = client.post(
        "/work/pipeline/tools/signal",
        headers=_auth(),
        json={"pipeline_id": "p-1", "dispatch_id": "d-2", "status": "completed", "stage": "copy"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "completed"
    assert body["terminal"] is True
    inserted = [r for t, r in stage_sb.inserts if t == "operator_dispatches"]
    assert "completed_at" in inserted[0]


def test_signal_stale_maps_to_completed(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    resp = client.post(
        "/work/pipeline/tools/signal",
        headers=_auth(),
        json={"pipeline_id": "p-1", "dispatch_id": "d-3", "status": "stale", "stage": "copy"},
    )
    # A stale/duplicate dispatch is a no-op that is "done".
    assert resp.json()["status"] == "completed"


def test_signal_error_maps_to_failed(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    resp = client.post(
        "/work/pipeline/tools/signal",
        headers=_auth(),
        json={"pipeline_id": "p-1", "dispatch_id": "d-4", "status": "error", "error": "read failed"},
    )
    body = resp.json()
    assert body["status"] == "failed"
    assert body["terminal"] is True


def test_signal_idempotent_updates_existing_row(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    stage_sb.seed(
        "operator_dispatches",
        [{"id": "od-1", "pipeline_id": "p-1", "dispatch_id": "d-5", "status": "dispatched"}],
    )
    resp = client.post(
        "/work/pipeline/tools/signal",
        headers=_auth(),
        json={"pipeline_id": "p-1", "dispatch_id": "d-5", "status": "completed", "stage": "copy"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["dispatch_row_id"] == "od-1"
    # Updated in place, not a duplicate insert.
    assert all(t != "operator_dispatches" for t, _ in stage_sb.inserts)
    updated = [r for t, r in stage_sb.updates if t == "operator_dispatches"]
    assert updated and updated[0]["status"] == "completed"


def test_signal_422_on_bad_status(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    stage_sb.set_single("pipelines", _pipeline_row())
    resp = client.post(
        "/work/pipeline/tools/signal",
        headers=_auth(),
        json={"pipeline_id": "p-1", "dispatch_id": "d-6", "status": "made-up"},
    )
    assert resp.status_code == 422


def test_signal_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/pipeline/tools/signal", json={})
    assert resp.status_code == 401


# ===========================================================================
# GET /work/pipeline/tools/{id} — the extended per-creative stage_state rollup
# ===========================================================================


def test_read_returns_per_creative_stage_rollup(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    """The read tool now carries a per-creative gate rollup so the operator
    resumes the per-creative stages by skip-done."""
    # No brief/client to keep the read narrow; the rollup is the assertion.
    stage_sb.set_single(
        "pipelines",
        _pipeline_row(status="creative_qa", image_brief_id=None, client_id=None),
    )
    stage_sb.seed(
        "creative_stage_state",
        [
            # _fetch_creative_rollup filters by pipeline_id (= the path id "p-1"),
            # so the seeded rows must carry it or the rollup comes back empty.
            {"pipeline_id": "p-1", "creative_id": "cr-1", "stage": "creative_qa", "status": "passed"},
            {"pipeline_id": "p-1", "creative_id": "cr-1", "stage": "copy", "status": "pending"},
            {"pipeline_id": "p-1", "creative_id": "cr-2", "stage": "creative_qa", "status": "failed"},
        ],
    )
    stage_sb.seed(
        "creatives",
        [
            {"id": "cr-1", "status": "draft"},
            {"id": "cr-2", "status": "draft"},
        ],
    )
    resp = client.get("/work/pipeline/tools/p-1", headers=_auth())
    assert resp.status_code == 200, resp.text
    rollup = {c["creative_id"]: c for c in resp.json()["creatives"]}
    assert rollup["cr-1"]["stage_state"]["creative_qa"] == "passed"
    assert rollup["cr-1"]["stage_state"]["copy"] == "pending"
    assert rollup["cr-2"]["stage_state"]["creative_qa"] == "failed"
    assert rollup["cr-1"]["status"] == "draft"


def test_read_rollup_empty_when_no_stage_state(
    client: TestClient, stage_sb: FakeSupabase
) -> None:
    """A pre-QA pipeline has no per-creative state -> the rollup degrades to []."""
    stage_sb.set_single(
        "pipelines",
        _pipeline_row(status="ideation", image_brief_id=None, client_id=None),
    )
    resp = client.get("/work/pipeline/tools/p-1", headers=_auth())
    assert resp.status_code == 200, resp.text
    assert resp.json()["creatives"] == []
