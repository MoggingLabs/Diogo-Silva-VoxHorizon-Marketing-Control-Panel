"""Contract + unit tests for the P5 integrations routes (#364 #365 #367 #368 #369).

Drives the new endpoints via the shared ``client`` / ``asgi_client`` +
``fake_supabase`` harness:

  * POST /work/pipeline/tools/launch       — recorder + HARD gate
        (happy / 401 / 422 schema / 422 gate-blocked / 404 / idempotency).
  * POST /work/pipeline/tools/finalize_drive — md5-verified Drive recorder
        (happy / 422 mismatch / 404 / 401).
  * POST /work/ghl/webhook                 — lead ingest, inbox dedupe
        (happy / dedupe / 422 malformed / 401).
  * GET  /work/metrics                     — observability snapshot (happy / 401).

Plus the launch-precondition re-check unit (the server-side gate core) and the
``check_launch_preconditions`` matrix.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from src.routes import integrations

from .conftest import FakeSupabase


# ---------------------------------------------------------------------------
# Seeding helpers
# ---------------------------------------------------------------------------


def _pipeline_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": "p-1",
        "status": "launch_handoff",
        "format_choice": "image",
        "client_id": "client-1",
        "image_brief_id": "ib-1",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {"image": [], "video": []},
        "advanced_at": {},
        "created_at": "2026-05-22T00:00:00Z",
    }
    row.update(overrides)
    return row


def _seed_clearing_state(sb: FakeSupabase) -> None:
    """Seed creative_stage_state + copy_variants so all preconditions pass."""
    sb.seed(
        "creative_stage_state",
        [
            {"pipeline_id": "p-1", "stage": "spec_validation", "status": "passed"},
            {"pipeline_id": "p-1", "stage": "compliance_review", "status": "passed"},
            {"pipeline_id": "p-1", "stage": "compliance_review", "status": "overridden"},
        ],
    )
    sb.seed(
        "copy_variants",
        [
            {"id": "cv-1", "pipeline_id": "p-1", "status": "approved"},
            {"id": "cv-2", "pipeline_id": "p-1", "status": "approved"},
            {"id": "cv-3", "pipeline_id": "p-1", "status": "approved"},
            {"id": "cv-4", "pipeline_id": "p-1", "status": "draft"},
        ],
    )


def _launch_body(**overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "pipeline_id": "p-1",
        "approved_by": "manager@vox",
        "launch_package_id": "lp-1",
        "entities": [
            {"kind": "campaign", "meta_id": "camp-100"},
            {"kind": "adset", "meta_id": "adset-200", "parent_meta_id": "camp-100"},
            {"kind": "ad", "meta_id": "ad-300", "parent_meta_id": "adset-200"},
        ],
    }
    body.update(overrides)
    return body


# ===========================================================================
# check_launch_preconditions (the server-side gate core)
# ===========================================================================


def test_preconditions_ok_when_all_clear(fake_supabase: FakeSupabase) -> None:
    _seed_clearing_state(fake_supabase)
    pc = integrations.check_launch_preconditions("p-1")
    assert pc.spec_pass is True
    assert pc.compliance_clear is True
    assert pc.approved_copy_count == 3
    assert pc.copy_ge_3 is True
    assert pc.ok is True


def test_preconditions_fail_when_spec_missing(fake_supabase: FakeSupabase) -> None:
    # Only compliance + copy seeded; no spec_validation rows ⇒ spec not cleared.
    fake_supabase.seed(
        "creative_stage_state",
        [{"pipeline_id": "p-1", "stage": "compliance_review", "status": "passed"}],
    )
    fake_supabase.seed(
        "copy_variants",
        [{"id": f"cv-{i}", "pipeline_id": "p-1", "status": "approved"} for i in range(3)],
    )
    pc = integrations.check_launch_preconditions("p-1")
    assert pc.spec_pass is False
    assert pc.ok is False


def test_preconditions_fail_when_a_creative_failed(fake_supabase: FakeSupabase) -> None:
    fake_supabase.seed(
        "creative_stage_state",
        [
            {"pipeline_id": "p-1", "stage": "spec_validation", "status": "passed"},
            {"pipeline_id": "p-1", "stage": "compliance_review", "status": "passed"},
            # A still-failed compliance unit must hold the gate.
            {"pipeline_id": "p-1", "stage": "compliance_review", "status": "failed"},
        ],
    )
    fake_supabase.seed(
        "copy_variants",
        [{"id": f"cv-{i}", "pipeline_id": "p-1", "status": "approved"} for i in range(3)],
    )
    pc = integrations.check_launch_preconditions("p-1")
    assert pc.compliance_clear is False
    assert pc.ok is False


def test_preconditions_fail_when_too_few_copy(fake_supabase: FakeSupabase) -> None:
    fake_supabase.seed(
        "creative_stage_state",
        [
            {"pipeline_id": "p-1", "stage": "spec_validation", "status": "passed"},
            {"pipeline_id": "p-1", "stage": "compliance_review", "status": "passed"},
        ],
    )
    fake_supabase.seed(
        "copy_variants",
        [{"id": "cv-1", "pipeline_id": "p-1", "status": "approved"}],
    )
    pc = integrations.check_launch_preconditions("p-1")
    assert pc.approved_copy_count == 1
    assert pc.copy_ge_3 is False
    assert pc.ok is False


# ===========================================================================
# POST /work/pipeline/tools/launch
# ===========================================================================


def test_launch_happy_records_entities_paused_first(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", _pipeline_row())
    _seed_clearing_state(fake_supabase)

    resp = client.post(
        "/work/pipeline/tools/launch", headers=auth_headers, json=_launch_body()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["preconditions"]["ok"] is True
    assert len(body["entities"]) == 3

    ad_inserts = [row for name, row in fake_supabase.inserts if name == "ad_entity"]
    assert len(ad_inserts) == 3
    # PAUSED-first: every recorded entity is paused regardless of input.
    assert all(row["state"] == "paused" for row in ad_inserts)
    # launch_packages gate columns stamped.
    lp_updates = [row for name, row in fake_supabase.updates if name == "launch_packages"]
    assert lp_updates and lp_updates[0]["approved_by"] == "manager@vox"
    assert lp_updates[0]["meta_campaign_id"] == "camp-100"


def test_launch_422_when_gate_blocked(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", _pipeline_row())
    # No clearing state seeded ⇒ preconditions fail ⇒ HARD gate blocks.
    resp = client.post(
        "/work/pipeline/tools/launch", headers=auth_headers, json=_launch_body()
    )
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == "launch preconditions not met"
    assert detail["preconditions"]["ok"] is False
    # NOTHING recorded — the gate blocked before any write.
    assert not any(name == "ad_entity" for name, _ in fake_supabase.inserts)


def test_launch_404_when_pipeline_missing(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", None)
    resp = client.post(
        "/work/pipeline/tools/launch", headers=auth_headers, json=_launch_body()
    )
    assert resp.status_code == 404


def test_launch_422_on_invalid_entity_kind(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", _pipeline_row())
    _seed_clearing_state(fake_supabase)
    body = _launch_body(entities=[{"kind": "bogus", "meta_id": "x-1"}])
    resp = client.post(
        "/work/pipeline/tools/launch", headers=auth_headers, json=body
    )
    assert resp.status_code == 422
    assert "invalid ad_entity kind" in str(resp.json()["detail"])
    assert not any(name == "ad_entity" for name, _ in fake_supabase.inserts)


def test_launch_422_on_missing_approver(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", _pipeline_row())
    body = _launch_body()
    del body["approved_by"]
    resp = client.post(
        "/work/pipeline/tools/launch", headers=auth_headers, json=body
    )
    # Pydantic rejects the missing required field before the handler runs.
    assert resp.status_code == 422


def test_launch_401_without_auth(
    client: TestClient, fake_supabase: FakeSupabase
) -> None:
    resp = client.post("/work/pipeline/tools/launch", json=_launch_body())
    assert resp.status_code == 401


def test_launch_idempotent_rerecord_updates_in_place(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", _pipeline_row())
    _seed_clearing_state(fake_supabase)

    first = client.post(
        "/work/pipeline/tools/launch", headers=auth_headers, json=_launch_body()
    )
    assert first.status_code == 200
    inserts_after_first = len(
        [r for n, r in fake_supabase.inserts if n == "ad_entity"]
    )
    assert inserts_after_first == 3

    # Re-record the SAME (kind, meta_id) graph: should UPDATE, not re-INSERT.
    second = client.post(
        "/work/pipeline/tools/launch", headers=auth_headers, json=_launch_body()
    )
    assert second.status_code == 200, second.text
    j2 = second.json()
    assert all(e["recorded"] == "updated" for e in j2["entities"])
    inserts_after_second = len(
        [r for n, r in fake_supabase.inserts if n == "ad_entity"]
    )
    # No new inserts on the second call — idempotent recorder.
    assert inserts_after_second == 3


def test_launch_without_package_id_skips_stamp(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", _pipeline_row())
    _seed_clearing_state(fake_supabase)
    body = _launch_body(launch_package_id=None)
    resp = client.post(
        "/work/pipeline/tools/launch", headers=auth_headers, json=body
    )
    assert resp.status_code == 200
    # Entities still recorded; no launch_packages update attempted.
    assert any(name == "ad_entity" for name, _ in fake_supabase.inserts)
    assert not any(name == "launch_packages" for name, _ in fake_supabase.updates)


# ---------------------------------------------------------------------------
# Video launch routing (VID-12): count video copy + stamp video_launch_packages
# ---------------------------------------------------------------------------


def _seed_video_clearing_state(sb: FakeSupabase) -> None:
    """Clear all preconditions for a VIDEO pipeline (approved copy in video table)."""
    sb.seed(
        "creative_stage_state",
        [
            {"pipeline_id": "p-1", "stage": "spec_validation", "status": "passed"},
            {"pipeline_id": "p-1", "stage": "compliance_review", "status": "passed"},
        ],
    )
    sb.seed(
        "video_copy_variants",
        [{"id": f"vcv-{i}", "pipeline_id": "p-1", "status": "approved"} for i in range(3)],
    )


def test_preconditions_count_video_copy_for_video_pipeline(
    fake_supabase: FakeSupabase,
) -> None:
    """A video pipeline's approved-copy gate counts video_copy_variants, not copy_variants."""
    fake_supabase.set_single("pipelines", _pipeline_row(format_choice="video"))
    _seed_video_clearing_state(fake_supabase)
    # An image copy_variants row must NOT count toward a video pipeline's gate.
    fake_supabase.seed(
        "copy_variants", [{"id": "cv-x", "pipeline_id": "p-1", "status": "approved"}]
    )
    pc = integrations.check_launch_preconditions("p-1")
    assert pc.approved_copy_count == 3
    assert pc.copy_ge_3 is True
    assert pc.ok is True


def test_launch_stamps_video_launch_packages_for_video_pipeline(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    """A video pipeline's launch stamps video_launch_packages, not launch_packages."""
    fake_supabase.set_single(
        "pipelines", _pipeline_row(format_choice="video", video_brief_id="vb-1")
    )
    _seed_video_clearing_state(fake_supabase)
    resp = client.post(
        "/work/pipeline/tools/launch", headers=auth_headers, json=_launch_body()
    )
    assert resp.status_code == 200, resp.text
    vupd = [r for t, r in fake_supabase.updates if t == "video_launch_packages"]
    assert vupd, "expected a video_launch_packages stamp"
    assert vupd[0]["approved_by"] == "manager@vox"
    assert vupd[0]["meta_campaign_id"] == "camp-100"
    assert all(t != "launch_packages" for t, _ in fake_supabase.updates)


# ===========================================================================
# POST /work/pipeline/tools/finalize_drive
# ===========================================================================


def _drive_body(**overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "pipeline_id": "p-1",
        "assets": [
            {
                "creative_id": "cr-1",
                "drive_url": "https://drive.google.com/file/cr-1",
                "drive_folder_id": "folder-1",
                "asset_name": "ad-1x1.png",
                "expected_md5": "ABCDEF",
                "drive_md5": "abcdef",  # case-insensitive match
            }
        ],
    }
    body.update(overrides)
    return body


def test_finalize_drive_happy_verifies_md5(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", _pipeline_row())
    resp = client.post(
        "/work/pipeline/tools/finalize_drive", headers=auth_headers, json=_drive_body()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["assets"][0]["finalize_verified"] is True
    cr_updates = [row for name, row in fake_supabase.updates if name == "creatives"]
    assert cr_updates and cr_updates[0]["finalize_verified"] is True
    assert cr_updates[0]["drive_folder_id"] == "folder-1"
    assert cr_updates[0]["asset_name"] == "ad-1x1.png"


def test_finalize_drive_422_on_md5_mismatch(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", _pipeline_row())
    body = _drive_body(
        assets=[
            {
                "creative_id": "cr-1",
                "drive_url": "https://drive/cr-1",
                "expected_md5": "aaaa",
                "drive_md5": "bbbb",
            }
        ]
    )
    resp = client.post(
        "/work/pipeline/tools/finalize_drive", headers=auth_headers, json=body
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "drive md5 mismatch"
    # Nothing written on a mismatch (all-or-nothing).
    assert not any(name == "creatives" for name, _ in fake_supabase.updates)


def test_finalize_drive_404_when_pipeline_missing(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", None)
    resp = client.post(
        "/work/pipeline/tools/finalize_drive", headers=auth_headers, json=_drive_body()
    )
    assert resp.status_code == 404


def test_finalize_drive_401(client: TestClient, fake_supabase: FakeSupabase) -> None:
    resp = client.post("/work/pipeline/tools/finalize_drive", json=_drive_body())
    assert resp.status_code == 401


def test_md5_hex_helper() -> None:
    assert integrations.md5_hex(b"hello") == "5d41402abc4b2a76b9719d911017c592"


# ===========================================================================
# POST /work/ghl/webhook
# ===========================================================================


def _webhook_body() -> dict[str, object]:
    return {
        "type": "ContactCreate",
        "webhookId": "evt-123",
        "contactId": "c-1",
        "locationId": "loc-1",
        "dateAdded": "2026-05-22T10:00:00Z",
    }


def test_ghl_webhook_happy_ingests_lead(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    resp = client.post(
        "/work/ghl/webhook", headers=auth_headers, json=_webhook_body()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deduped"] is False
    assert body["is_lead"] is True
    assert body["dedupe_key"] == "ghl:evt-123"
    inbox = [row for name, row in fake_supabase.inserts if name == "integration_event_inbox"]
    assert inbox and inbox[0]["event_id"] == "ghl:evt-123"


def test_ghl_webhook_dedupes_replay(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    # First delivery ingests.
    first = client.post("/work/ghl/webhook", headers=auth_headers, json=_webhook_body())
    assert first.status_code == 200
    assert first.json()["deduped"] is False

    # Replay (same webhookId → same dedupe_key) is dropped.
    second = client.post("/work/ghl/webhook", headers=auth_headers, json=_webhook_body())
    assert second.status_code == 200, second.text
    assert second.json()["deduped"] is True
    # Only ONE inbox row exists despite two deliveries.
    inbox = [r for n, r in fake_supabase.inserts if n == "integration_event_inbox"]
    assert len(inbox) == 1


def test_ghl_webhook_422_on_malformed(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    # Missing the required 'type' discriminator → parse_webhook_event raises.
    resp = client.post(
        "/work/ghl/webhook", headers=auth_headers, json={"contactId": "c-1"}
    )
    assert resp.status_code == 422
    assert "malformed GHL webhook" in str(resp.json()["detail"])


def test_ghl_webhook_non_lead_event(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    body = {"type": "ContactDelete", "webhookId": "evt-del", "contactId": "c-9"}
    resp = client.post("/work/ghl/webhook", headers=auth_headers, json=body)
    assert resp.status_code == 200
    assert resp.json()["is_lead"] is False


def test_ghl_webhook_401(client: TestClient, fake_supabase: FakeSupabase) -> None:
    resp = client.post("/work/ghl/webhook", json=_webhook_body())
    assert resp.status_code == 401


# ===========================================================================
# GET /work/metrics
# ===========================================================================


def test_metrics_happy(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.seed(
        "integration_outbox",
        [{"status": "pending"}, {"status": "inflight"}],
    )
    fake_supabase.seed("operator_dispatches", [{"status": "running"}])
    resp = client.get("/work/metrics", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["outbox"]["depth"] == 2
    assert body["dispatches"]["in_flight"] == 1
    assert "breakers" in body
    assert "cost" in body


def test_metrics_401(client: TestClient, fake_supabase: FakeSupabase) -> None:
    resp = client.get("/work/metrics")
    assert resp.status_code == 401


# ===========================================================================
# Transactional outbox enqueue (E5.1 / #510)
# ===========================================================================
#
# The Meta launch + Drive finalize recorders enqueue an integration_outbox row
# IN THE SAME HANDLER as the state change, so the durable side effect is
# exactly-once + retryable. We assert the row is written on the happy path,
# carries the right (integration, op) + a deterministic idempotency_key, and is
# NOT written when the state change itself is rejected (gate-blocked / md5
# mismatch) -- a side effect must never outlive a refused state change.


def _outbox_inserts(sb: FakeSupabase) -> list[dict[str, object]]:
    return [row for name, row in sb.inserts if name == "integration_outbox"]


def test_launch_enqueues_meta_outbox_row_in_handler(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", _pipeline_row())
    _seed_clearing_state(fake_supabase)

    resp = client.post(
        "/work/pipeline/tools/launch", headers=auth_headers, json=_launch_body()
    )
    assert resp.status_code == 200, resp.text
    ob = _outbox_inserts(fake_supabase)
    assert len(ob) == 1
    row = ob[0]
    assert row["integration"] == "meta"
    assert row["op"] == "record_launch"
    assert row["status"] == "pending"
    assert row["pipeline_id"] == "p-1"
    assert row["idempotency_key"].startswith("meta:record_launch:p-1:")
    # The durable request payload carries the recorded entity graph.
    assert row["request"]["pipeline_id"] == "p-1"
    assert len(row["request"]["entities"]) == 3


def test_launch_gate_block_enqueues_nothing(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", _pipeline_row())
    # No clearing state -> gate 422s before any write, INCLUDING the outbox.
    resp = client.post(
        "/work/pipeline/tools/launch", headers=auth_headers, json=_launch_body()
    )
    assert resp.status_code == 422
    assert _outbox_inserts(fake_supabase) == []


def test_launch_enqueue_is_idempotent_on_rerecord(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    """Re-recording the same launch enqueues the side effect exactly once."""
    fake_supabase.set_single("pipelines", _pipeline_row())
    _seed_clearing_state(fake_supabase)

    first = client.post(
        "/work/pipeline/tools/launch", headers=auth_headers, json=_launch_body()
    )
    assert first.status_code == 200
    # The enqueued row now lives in the store; the second call's probe finds it.
    second = client.post(
        "/work/pipeline/tools/launch", headers=auth_headers, json=_launch_body()
    )
    assert second.status_code == 200, second.text
    # Exactly one outbox row despite two recorder runs (same idempotency_key).
    assert len(_outbox_inserts(fake_supabase)) == 1


def test_finalize_drive_enqueues_drive_outbox_row(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", _pipeline_row())
    resp = client.post(
        "/work/pipeline/tools/finalize_drive", headers=auth_headers, json=_drive_body()
    )
    assert resp.status_code == 200, resp.text
    ob = _outbox_inserts(fake_supabase)
    assert len(ob) == 1
    row = ob[0]
    assert row["integration"] == "drive"
    assert row["op"] == "finalize_verified"
    assert row["status"] == "pending"
    assert row["idempotency_key"].startswith("drive:finalize_verified:p-1:")
    assert len(row["request"]["assets"]) == 1


def test_finalize_drive_md5_mismatch_enqueues_nothing(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", _pipeline_row())
    body = _drive_body(
        assets=[
            {
                "creative_id": "cr-1",
                "drive_url": "https://drive/cr-1",
                "expected_md5": "aaaa",
                "drive_md5": "bbbb",
            }
        ]
    )
    resp = client.post(
        "/work/pipeline/tools/finalize_drive", headers=auth_headers, json=body
    )
    assert resp.status_code == 422
    # A refused finalize must not leave a durable side effect behind.
    assert _outbox_inserts(fake_supabase) == []


def test_ghl_webhook_dedupes_on_insert_conflict(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    """A PK conflict on the inbox insert is treated as already-ingested (deduped).

    The probe-then-insert has a race window; the inbox PK (provider, event_id) is
    the real backstop. We force the insert to raise (a unique violation) and
    assert the route still returns deduped=true, not a 500.
    """
    from src.routes import integrations as integrations_mod

    real_table = fake_supabase.table

    def _conflicting_insert(name: str):  # noqa: ANN202
        q = real_table(name)
        if name == "integration_event_inbox":
            orig_execute = q.execute

            def _boom():  # noqa: ANN202
                # Reads (select/maybe_single) pass through; the insert raises.
                if q._insert_data is not None:
                    raise RuntimeError("duplicate key value violates unique constraint")
                return orig_execute()

            q.execute = _boom  # type: ignore[method-assign]
        return q

    integrations_mod.get_supabase_admin = lambda: type(  # type: ignore[assignment]
        "SB", (), {"table": staticmethod(_conflicting_insert)}
    )()

    resp = client.post("/work/ghl/webhook", headers=auth_headers, json=_webhook_body())
    assert resp.status_code == 200, resp.text
    assert resp.json()["deduped"] is True
