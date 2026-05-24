"""Contract tests for the P2 compliance + QA adjudication routes (#341 / #342).

Drives ``/work/pipeline/tools/compliance_run`` and ``/qa_run`` through the
shared ``asgi_client`` + ``fake_supabase`` harness (``conftest.py``). Covers
the DoD contract matrix — happy / 401 / 422 / idempotency / error — plus the
load-bearing hard-gate invariant: the operator submits CANDIDATES only and the
WORKER writes the verdict, so an operator "clear" candidate can never produce a
``passed`` gate when the engine's deterministic backstop fails.

The worker can't run on the dev Windows host (pyiceberg/MSVC); these are written
to be correct and are validated in CI.
"""

from __future__ import annotations

import base64
import io

import httpx
import pytest
from PIL import Image

from src.routes import qa_compliance


PIPELINE_ID = "11111111-1111-4111-8111-111111111111"
CREATIVE_ID = "22222222-2222-4222-8222-222222222222"
CREATIVE_ID_2 = "33333333-3333-4333-8333-333333333333"
COPY_VARIANT_ID = "44444444-4444-4444-8444-444444444444"
CLIENT_ID = "55555555-5555-4555-8555-555555555555"
# VIDEO_CREATIVE_ID + the QA-flavoured _seed_video_creative live in the
# "qa_run VIDEO branch" section below (they predate this M3 work). The
# compliance video tests use _seed_video_compliance_creative (script_outline).


# ===========================================================================
# Fixtures / builders
# ===========================================================================


def _png_bytes(width: int = 1080, height: int = 1080) -> bytes:
    """A real PNG of the given dims (passes det.resolution for 1:1)."""
    buf = io.BytesIO()
    Image.new("RGB", (width, height), (120, 120, 120)).save(buf, format="PNG")
    return buf.getvalue()


def _png_b64(width: int = 1080, height: int = 1080) -> str:
    return base64.b64encode(_png_bytes(width, height)).decode("ascii")


def _seed_creative(fake, creative_id: str = CREATIVE_ID, **overrides) -> None:
    row = {
        "id": creative_id,
        "brief_id": "brief-1",
        "concept": "fresh-roof",
        "ratio": "1x1",
        "version": "v1.0",
        "type": "image",
        "file_path_supabase": f"brief-1/{creative_id}-1x1-v1.0.png",
        "has_overlay_text": False,
    }
    row.update(overrides)
    fake.seed("creatives", [row])


def _seed_video_compliance_creative(
    fake, *, script_outline: dict, creative_id: str = "66666666-6666-4666-8666-666666666666"
) -> None:
    """Seed a ``video_creatives`` row carrying a spoken ``script_outline``.

    No matching ``creatives`` row: the compliance route's image fetch misses and
    falls back to ``_fetch_video_compliance_creative``, resolving the spoken
    surface the voiceover-claim rules scan.
    """
    fake.seed(
        "video_creatives",
        [{"id": creative_id, "brief_id": "vbrief-1", "script_outline": script_outline}],
    )


def _seed_pipeline_client(fake, *, with_client: bool = True, constraints=None) -> None:
    fake.seed(
        "pipelines",
        [{"id": PIPELINE_ID, "client_id": CLIENT_ID if with_client else None}],
    )
    if with_client:
        fake.seed("clients", [{"id": CLIENT_ID, "service_type": "roofing"}])
        for i, text in enumerate(constraints or []):
            fake.seed(
                "client_offer_constraints",
                [{"client_id": CLIENT_ID, "constraint_text": text, "sort_order": i}],
            )


# ===========================================================================
# compliance_run
# ===========================================================================


@pytest.mark.asyncio
async def test_compliance_run_happy_clean_passes(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """A clean creative with no candidates -> passed gate, no findings written."""
    _seed_pipeline_client(fake_supabase, with_client=False)
    _seed_creative(fake_supabase)

    res = await asgi_client.post(
        "/work/pipeline/tools/compliance_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [
                {
                    "creative_id": CREATIVE_ID,
                    "copy_variant_id": None,
                    "surface": "copy",
                    "vertical": "roofing",
                    "llm_candidates": [],
                }
            ],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["stage"] == "compliance_review"
    assert body["rollup"] == "passed"
    assert body["results"][0]["verdict"] == "pass"
    assert body["results"][0]["status"] == "passed"

    # The gate row was upserted to 'passed' and decided_by the worker.
    states = fake_supabase.rows("creative_stage_state")
    state_inserts = [r for (t, r) in fake_supabase.inserts if t == "creative_stage_state"]
    assert state_inserts and state_inserts[0]["status"] == "passed"
    assert state_inserts[0]["decided_by"] == "worker"
    assert state_inserts[0]["stage"] == "compliance_review"
    assert states  # stored


@pytest.mark.asyncio
async def test_compliance_run_client_do_not_say_blocks(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """A client do-not-say phrase in copy fails the gate + writes a finding."""
    _seed_pipeline_client(fake_supabase, with_client=True, constraints=["free roof"])
    _seed_creative(fake_supabase)
    fake_supabase.seed(
        "copy_variants",
        [
            {
                "id": COPY_VARIANT_ID,
                "headline": "Get a free roof today",
                "body": "Limited offer",
                "description": "",
                "cta": "Call now",
            }
        ],
    )

    res = await asgi_client.post(
        "/work/pipeline/tools/compliance_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [
                {
                    "creative_id": CREATIVE_ID,
                    "copy_variant_id": COPY_VARIANT_ID,
                    "surface": "copy",
                    "llm_candidates": [],
                }
            ],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["rollup"] == "failed"
    assert body["results"][0]["verdict"] == "fail"
    assert body["results"][0]["status"] == "failed"
    assert body["results"][0]["block_count"] >= 1

    findings = [r for (t, r) in fake_supabase.inserts if t == "compliance_finding"]
    assert findings, "a blocking finding must be persisted as evidence"
    assert findings[0]["verdict"] == "fail"
    assert findings[0]["severity"] == "critical"
    assert findings[0]["checked_by"] == "worker"
    assert findings[0]["pass"] == 1


@pytest.mark.asyncio
async def test_compliance_run_operator_cannot_self_clear(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """HARD-GATE INVARIANT: an operator 'clear' candidate cannot pass the gate.

    The worker runs its own deterministic do-not-say backstop. Even when the
    operator submits a confident ``clear`` candidate for that exact rule, the
    deterministic match still fires and the verdict is ``failed`` — the operator
    has no path to write a pass.
    """
    _seed_pipeline_client(fake_supabase, with_client=True, constraints=["free roof"])
    _seed_creative(fake_supabase)
    fake_supabase.seed(
        "copy_variants",
        [
            {
                "id": COPY_VARIANT_ID,
                "headline": "Get a free roof today",
                "body": "",
                "description": "",
                "cta": "",
            }
        ],
    )

    res = await asgi_client.post(
        "/work/pipeline/tools/compliance_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [
                {
                    "creative_id": CREATIVE_ID,
                    "copy_variant_id": COPY_VARIANT_ID,
                    "surface": "copy",
                    # The operator tries to self-clear the do-not-say rule.
                    "llm_candidates": [
                        {
                            "rule_id": "client.do_not_say.0",
                            "label": "clear",
                            "confidence": 1.0,
                            "evidence_span": "looks fine to me",
                        }
                    ],
                }
            ],
        },
    )
    assert res.status_code == 200
    body = res.json()
    # Worker-owned verdict wins: still failed despite the operator's "clear".
    assert body["rollup"] == "failed"
    assert body["results"][0]["status"] == "failed"
    state_inserts = [r for (t, r) in fake_supabase.inserts if t == "creative_stage_state"]
    assert state_inserts[0]["status"] == "failed"


@pytest.mark.asyncio
async def test_compliance_run_video_spoken_claim_blocks(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """M3: a personal-attribute claim SPOKEN in the voiceover fails the gate.

    The creative lives in ``video_creatives`` and carries no copy/image
    violation — only the voiceover says it. The video spoken-claim rule fires on
    ``script_outline`` (hook + segments + outro) and blocks, proving the gate
    sees the audio surface the image/copy checks never do.
    """
    _seed_pipeline_client(fake_supabase, with_client=False)
    _seed_video_compliance_creative(
        fake_supabase,
        script_outline={
            "hook": "Are you embarrassed by your smile?",
            "segments": [
                {"idx": 0, "voiceover_text": "We can fix that fast."},
            ],
            "outro": "Book a visit today.",
            "total_duration_s": 20,
        },
    )

    res = await asgi_client.post(
        "/work/pipeline/tools/compliance_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [
                {
                    "creative_id": VIDEO_CREATIVE_ID,
                    "copy_variant_id": None,
                    "surface": "video",
                    "llm_candidates": [],
                }
            ],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["rollup"] == "failed"
    assert body["results"][0]["verdict"] == "fail"
    assert body["results"][0]["block_count"] >= 1

    findings = [r for (t, r) in fake_supabase.inserts if t == "compliance_finding"]
    spoken = [f for f in findings if f["rule_id"] == "meta.spoken_personal_attributes"]
    assert spoken, "the spoken personal-attribute rule must fire + be recorded"
    assert spoken[0]["verdict"] == "fail"
    assert spoken[0]["severity"] == "critical"
    assert spoken[0]["citation_url"].startswith("http")


@pytest.mark.asyncio
async def test_compliance_run_video_clean_voiceover_passes(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """A video whose voiceover makes no banned claim passes the gate cleanly."""
    _seed_pipeline_client(fake_supabase, with_client=False)
    _seed_video_compliance_creative(
        fake_supabase,
        script_outline={
            "hook": "Ready for a smile you'll love?",
            "segments": [{"idx": 0, "voiceover_text": "Our team is here to help."}],
            "outro": "Book a visit today.",
            "total_duration_s": 20,
        },
    )

    res = await asgi_client.post(
        "/work/pipeline/tools/compliance_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [
                {
                    "creative_id": VIDEO_CREATIVE_ID,
                    "copy_variant_id": None,
                    "surface": "video",
                    "llm_candidates": [],
                }
            ],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["rollup"] == "passed"
    assert body["results"][0]["verdict"] == "pass"


@pytest.mark.asyncio
async def test_compliance_run_missing_creative_is_per_item_error(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """An unknown creative is reported in errors without aborting the batch."""
    _seed_pipeline_client(fake_supabase, with_client=False)
    _seed_creative(fake_supabase, creative_id=CREATIVE_ID)

    res = await asgi_client.post(
        "/work/pipeline/tools/compliance_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [
                {"creative_id": CREATIVE_ID, "surface": "copy", "llm_candidates": []},
                {"creative_id": "does-not-exist", "surface": "copy", "llm_candidates": []},
            ],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert len(body["results"]) == 1
    assert len(body["errors"]) == 1
    assert body["errors"][0]["creative_id"] == "does-not-exist"


@pytest.mark.asyncio
async def test_compliance_run_unknown_pipeline_degrades_to_no_client(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """No pipeline row at all -> client resolution returns None, run still works.

    The compliance gate doesn't require a client (an unconstrained vertical is
    valid); a missing pipeline row simply means no synthesized do-not-say rules.
    """
    _seed_creative(fake_supabase)  # pipelines table left empty
    res = await asgi_client.post(
        "/work/pipeline/tools/compliance_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [{"creative_id": CREATIVE_ID, "surface": "copy", "llm_candidates": []}],
        },
    )
    assert res.status_code == 200
    assert res.json()["rollup"] == "passed"


@pytest.mark.asyncio
async def test_compliance_run_401_without_auth(
    asgi_client: httpx.AsyncClient, fake_supabase
) -> None:
    res = await asgi_client.post(
        "/work/pipeline/tools/compliance_run",
        json={"pipeline_id": PIPELINE_ID, "items": [{"creative_id": CREATIVE_ID}]},
    )
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_compliance_run_422_empty_items(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """An empty items list fails pydantic validation (min_length=1) -> 422."""
    res = await asgi_client.post(
        "/work/pipeline/tools/compliance_run",
        headers=auth_headers,
        json={"pipeline_id": PIPELINE_ID, "items": []},
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_compliance_run_422_missing_pipeline_id(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    res = await asgi_client.post(
        "/work/pipeline/tools/compliance_run",
        headers=auth_headers,
        json={"items": [{"creative_id": CREATIVE_ID}]},
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_compliance_run_idempotent_reruns_update_same_gate(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """A second run updates the existing gate row rather than inserting a dup.

    compliance_finding is append-only (a re-run adds evidence), but the gate
    state is a single row per (creative, stage): the second call must take the
    update branch, not insert a second creative_stage_state row.
    """
    _seed_pipeline_client(fake_supabase, with_client=False)
    _seed_creative(fake_supabase)
    payload = {
        "pipeline_id": PIPELINE_ID,
        "items": [{"creative_id": CREATIVE_ID, "surface": "copy", "llm_candidates": []}],
    }
    r1 = await asgi_client.post(
        "/work/pipeline/tools/compliance_run", headers=auth_headers, json=payload
    )
    r2 = await asgi_client.post(
        "/work/pipeline/tools/compliance_run", headers=auth_headers, json=payload
    )
    assert r1.status_code == 200 and r2.status_code == 200

    state_inserts = [r for (t, r) in fake_supabase.inserts if t == "creative_stage_state"]
    state_updates = [r for (t, r) in fake_supabase.updates if t == "creative_stage_state"]
    assert len(state_inserts) == 1, "only the first run inserts the gate row"
    assert len(state_updates) >= 1, "the second run updates the existing gate row"


# ===========================================================================
# qa_run
# ===========================================================================


@pytest.mark.asyncio
async def test_qa_run_happy_with_inline_bytes(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """A clean 1080x1080 PNG with passing vision candidates -> passed gate."""
    _seed_creative(fake_supabase)

    vision = [
        {"check_id": "vision.hands", "score": 0.95},
        {"check_id": "vision.text_glyphs", "score": 0.95},
        {"check_id": "vision.anatomy", "score": 0.95},
        {"check_id": "vision.surface_artifact", "score": 0.95},
    ]
    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [
                {
                    "creative_id": CREATIVE_ID,
                    "ratio": "1x1",
                    "vertical": None,
                    "image_b64": _png_b64(),
                    "vision_candidates": vision,
                }
            ],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["stage"] == "creative_qa"
    assert body["rollup"] == "passed"
    assert body["results"][0]["verdict"] == "pass"
    assert body["results"][0]["status"] == "passed"
    assert body["results"][0]["attempt"] == 1

    qa_rows = [r for (t, r) in fake_supabase.inserts if t == "qa_result"]
    assert qa_rows and qa_rows[0]["status"] == "pass"
    assert qa_rows[0]["checked_by"] == "worker"
    assert qa_rows[0]["attempt"] == 1


@pytest.mark.asyncio
async def test_qa_run_low_resolution_fails_and_flags_rerender(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """A too-small image fails the deterministic resolution check -> re-render."""
    _seed_creative(fake_supabase)
    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [
                {
                    "creative_id": CREATIVE_ID,
                    "ratio": "1x1",
                    "image_b64": _png_b64(200, 200),
                    "vision_candidates": [],
                }
            ],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["rollup"] == "failed"
    assert body["results"][0]["verdict"] == "fail"
    assert body["results"][0]["rerender_recommended"] is True


@pytest.mark.asyncio
async def test_qa_run_operator_cannot_self_clear_bad_image(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """HARD-GATE INVARIANT: a 'pass' vision candidate can't override a det fail.

    The worker computes resolution itself. A confident operator ``pass``
    candidate on a 200x200 render does not let the creative through — the
    deterministic backstop fails it.
    """
    _seed_creative(fake_supabase)
    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [
                {
                    "creative_id": CREATIVE_ID,
                    "ratio": "1x1",
                    "image_b64": _png_b64(200, 200),
                    "vision_candidates": [
                        {"check_id": "vision.hands", "score": 1.0},
                        {"check_id": "vision.text_glyphs", "score": 1.0},
                        {"check_id": "vision.anatomy", "score": 1.0},
                        {"check_id": "vision.surface_artifact", "score": 1.0},
                    ],
                }
            ],
        },
    )
    assert res.status_code == 200
    assert res.json()["rollup"] == "failed"


@pytest.mark.asyncio
async def test_qa_run_downloads_bytes_from_storage(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """No image_b64 -> the worker downloads file_path_supabase from Storage."""
    path = "brief-1/stored-1x1-v1.0.png"
    _seed_creative(fake_supabase, file_path_supabase=path)
    fake_supabase.set_storage_object(path, _png_bytes())

    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [
                {
                    "creative_id": CREATIVE_ID,
                    "ratio": "1x1",
                    "vision_candidates": [
                        {"check_id": "vision.hands", "score": 0.95},
                        {"check_id": "vision.text_glyphs", "score": 0.95},
                        {"check_id": "vision.anatomy", "score": 0.95},
                        {"check_id": "vision.surface_artifact", "score": 0.95},
                    ],
                }
            ],
        },
    )
    assert res.status_code == 200
    assert res.json()["results"][0]["status"] == "passed"


@pytest.mark.asyncio
async def test_qa_run_422_bad_base64(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    _seed_creative(fake_supabase)
    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [{"creative_id": CREATIVE_ID, "image_b64": "!!!not-base64!!!"}],
        },
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_qa_run_502_on_storage_download_failure(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """Missing object (no seeded bytes, no image_b64) -> 502 download failure."""
    _seed_creative(fake_supabase, file_path_supabase="brief-1/missing.png")
    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [{"creative_id": CREATIVE_ID}],
        },
    )
    assert res.status_code == 502


@pytest.mark.asyncio
async def test_qa_run_422_no_bytes_no_path(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    _seed_creative(fake_supabase, file_path_supabase=None)
    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [{"creative_id": CREATIVE_ID}],
        },
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_qa_run_401_without_auth(
    asgi_client: httpx.AsyncClient, fake_supabase
) -> None:
    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        json={"pipeline_id": PIPELINE_ID, "items": [{"creative_id": CREATIVE_ID}]},
    )
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_qa_run_missing_creative_is_per_item_error(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [{"creative_id": "does-not-exist", "image_b64": _png_b64()}],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["results"] == []
    assert body["errors"][0]["creative_id"] == "does-not-exist"
    assert body["rollup"] == "pending"


@pytest.mark.asyncio
async def test_qa_run_idempotent_attempts_increment(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """Re-running QA appends a fresh attempt (append-only) and re-uses the gate."""
    _seed_creative(fake_supabase)
    payload = {
        "pipeline_id": PIPELINE_ID,
        "items": [{"creative_id": CREATIVE_ID, "ratio": "1x1", "image_b64": _png_b64()}],
    }
    r1 = await asgi_client.post("/work/pipeline/tools/qa_run", headers=auth_headers, json=payload)
    r2 = await asgi_client.post("/work/pipeline/tools/qa_run", headers=auth_headers, json=payload)
    assert r1.json()["results"][0]["attempt"] == 1
    assert r2.json()["results"][0]["attempt"] == 2

    qa_rows = [r for (t, r) in fake_supabase.inserts if t == "qa_result"]
    assert len(qa_rows) == 2
    state_inserts = [r for (t, r) in fake_supabase.inserts if t == "creative_stage_state"]
    assert len(state_inserts) == 1  # gate row reused on the second run


@pytest.mark.asyncio
async def test_qa_run_overlay_region_is_passed_through(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase
) -> None:
    """A supplied overlay region triggers the legibility check (a flat fill fails)."""
    _seed_creative(fake_supabase)
    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [
                {
                    "creative_id": CREATIVE_ID,
                    "ratio": "1x1",
                    "image_b64": _png_b64(),
                    "overlay_region": {"x": 0, "y": 0, "width": 200, "height": 80},
                    "vision_candidates": [
                        {"check_id": "vision.hands", "score": 0.95},
                        {"check_id": "vision.text_glyphs", "score": 0.95},
                        {"check_id": "vision.anatomy", "score": 0.95},
                        {"check_id": "vision.surface_artifact", "score": 0.95},
                    ],
                }
            ],
        },
    )
    assert res.status_code == 200
    # A uniform-grey fill has ~0 contrast -> overlay legibility fails -> failed.
    assert res.json()["rollup"] == "failed"


# ===========================================================================
# Unit-level helpers
# ===========================================================================


def test_rollup_verdict_semantics() -> None:
    assert qa_compliance._rollup_verdict([]) == "pending"
    assert qa_compliance._rollup_verdict(["passed"]) == "passed"
    assert qa_compliance._rollup_verdict(["passed", "failed"]) == "failed"
    assert qa_compliance._rollup_verdict(["passed", "pending"]) == "pending"
    assert qa_compliance._rollup_verdict(["overridden", "skipped"]) == "passed"


# ===========================================================================
# qa_run VIDEO branch (E3.2 #489)
# ===========================================================================


VIDEO_CREATIVE_ID = "66666666-6666-4666-8666-666666666666"


def _seed_video_creative(
    fake,
    creative_id: str = VIDEO_CREATIVE_ID,
    *,
    dimensions: str = "9x16",
    captioned_path: str | None = "vb-1/captioned-v1.mp4",
    composed_path: str | None = "vb-1/composed-v1.mp4",
) -> None:
    row = {
        "id": creative_id,
        "brief_id": "vb-1",
        "version": 1,
        "composed_path": composed_path,
        "captioned_path": captioned_path,
        "duration_actual_s": 18,
        "status": "draft",
        "video_briefs": {"dimensions": dimensions},
    }
    fake.seed("video_creatives", [row])


def _install_probe(monkeypatch, probe) -> list[str]:
    """Patch ``video_probe.probe_video`` to return ``probe``; record the path."""
    seen: list[str] = []

    async def _fake_probe(path, *, ffprobe_bin=None):  # noqa: ANN001
        seen.append(str(path))
        return probe

    monkeypatch.setattr(qa_compliance.video_probe, "probe_video", _fake_probe)
    return seen


def _good_video_probe():
    from src.services import video_probe as vp

    return vp.parse_probe(
        {
            "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "18.5"},
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1080,
                    "height": 1920,
                    "avg_frame_rate": "30/1",
                },
                {"codec_type": "audio", "codec_name": "aac"},
            ],
        }
    )


@pytest.mark.asyncio
async def test_qa_run_video_clean_passes(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase, monkeypatch
) -> None:
    """A conformant 9:16 H.264 video creative passes the worker-owned QA verdict."""
    _seed_video_creative(fake_supabase)
    fake_supabase.set_storage_object("vb-1/captioned-v1.mp4", b"\x00fakebytes")
    _install_probe(monkeypatch, _good_video_probe())

    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [{"creative_id": VIDEO_CREATIVE_ID, "surface": "video"}],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rollup"] == "passed"
    assert body["results"][0]["surface"] == "video"
    assert body["results"][0]["verdict"] == "pass"
    assert body["results"][0]["rerender_recommended"] is False

    qa_rows = [r for (t, r) in fake_supabase.inserts if t == "qa_result"]
    assert qa_rows and qa_rows[0]["status"] == "pass"
    assert qa_rows[0]["checked_by"] == "worker"
    # The probe facts ride on the persisted checks (append-only evidence).
    assert any(c["check_id"] == "video.has_audio" for c in qa_rows[0]["checks"])


@pytest.mark.asyncio
async def test_qa_run_video_no_audio_fails_rerender(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase, monkeypatch
) -> None:
    """A video with no audio stream fails QA and flags a re-render."""
    from src.services import video_probe as vp

    _seed_video_creative(fake_supabase)
    fake_supabase.set_storage_object("vb-1/captioned-v1.mp4", b"\x00fakebytes")
    no_audio = vp.parse_probe(
        {
            "format": {"format_name": "mov,mp4", "duration": "18.5"},
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1080,
                    "height": 1920,
                }
            ],
        }
    )
    _install_probe(monkeypatch, no_audio)

    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [{"creative_id": VIDEO_CREATIVE_ID, "surface": "video"}],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rollup"] == "failed"
    assert body["results"][0]["verdict"] == "fail"
    assert body["results"][0]["rerender_recommended"] is True


@pytest.mark.asyncio
async def test_qa_run_video_detected_even_without_surface_flag(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase, monkeypatch
) -> None:
    """A creative that lives only in video_creatives is QA'd as video.

    The operator omitted ``surface='video'``; the image fetch returns nothing,
    the worker falls back to the video store and probes the asset. The worker
    never trusts the operator's (absent) surface claim.
    """
    _seed_video_creative(fake_supabase)
    fake_supabase.set_single("creatives", None)  # not an image creative
    fake_supabase.set_storage_object("vb-1/captioned-v1.mp4", b"\x00fakebytes")
    _install_probe(monkeypatch, _good_video_probe())

    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [{"creative_id": VIDEO_CREATIVE_ID}],
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["results"][0]["surface"] == "video"


@pytest.mark.asyncio
async def test_qa_run_video_uses_brief_ratio(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase, monkeypatch
) -> None:
    """The declared brief ratio (1x1) fails a 9:16 asset -- worker uses brief truth."""
    _seed_video_creative(fake_supabase, dimensions="1x1")
    fake_supabase.set_storage_object("vb-1/captioned-v1.mp4", b"\x00fakebytes")
    _install_probe(monkeypatch, _good_video_probe())  # 1080x1920 (9:16)

    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            # Operator claims 9x16 in the item, but the brief says 1x1.
            "items": [
                {"creative_id": VIDEO_CREATIVE_ID, "surface": "video", "ratio": "9x16"}
            ],
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["results"][0]["verdict"] == "fail"


@pytest.mark.asyncio
async def test_qa_run_video_no_asset_returns_409(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase, monkeypatch
) -> None:
    """A video creative that reached QA with no rendered asset is a 409."""
    _seed_video_creative(fake_supabase, captioned_path=None, composed_path=None)
    _install_probe(monkeypatch, _good_video_probe())

    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [{"creative_id": VIDEO_CREATIVE_ID, "surface": "video"}],
        },
    )
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_qa_run_video_prefers_captioned_over_composed(
    asgi_client: httpx.AsyncClient, auth_headers, fake_supabase, monkeypatch
) -> None:
    """When both paths exist the worker probes the captioned (final) asset."""
    _seed_video_creative(fake_supabase)
    fake_supabase.set_storage_object("vb-1/captioned-v1.mp4", b"\x00fakebytes")
    fake_supabase.set_storage_object("vb-1/composed-v1.mp4", b"\x00other")
    seen = _install_probe(monkeypatch, _good_video_probe())

    res = await asgi_client.post(
        "/work/pipeline/tools/qa_run",
        headers=auth_headers,
        json={
            "pipeline_id": PIPELINE_ID,
            "items": [{"creative_id": VIDEO_CREATIVE_ID, "surface": "video"}],
        },
    )
    assert res.status_code == 200, res.text
    # The temp file was written from the captioned bytes (the final asset).
    assert seen, "probe_video was called"
