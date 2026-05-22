"""Self-test for the shared worker-route harness (T.2 / #315).

Proves the ``conftest.py`` fixtures (env, bearer ``auth_headers``, ``client`` /
``asgi_client``, ``fake_supabase``) on EXISTING routes with the full contract
matrix the rebuild requires:

  * happy        — authed request returns 200 + expected shape;
  * 401          — missing / malformed / wrong bearer is rejected;
  * 422          — a schema-invalid payload is rejected;
  * idempotency  — a duplicate render call renders the REMAINDER only (no
                   double effect), using FAKE_RENDER so there's zero network.

The matrix runs against ``/work/health`` (auth), ``/work/pipeline/tools/{id}``
(read + 404), and ``/work/pipeline/tools/render`` (validation + idempotency).
New endpoint tests should lean on these fixtures rather than re-rolling a
Supabase double + env block.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from .conftest import FakeSupabase


def _pipeline_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": "p-1",
        "status": "ideation",
        "format_choice": "image",
        "client_id": None,
        "image_brief_id": "ib-1",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {"image": [], "video": []},
        "advanced_at": {},
        "created_at": "2026-05-22T00:00:00Z",
    }
    row.update(overrides)
    return row


# ===========================================================================
# Bearer-auth helper + 401 matrix (verify_secret dependency)
# ===========================================================================


def test_health_happy_with_auth_headers(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    resp = client.get("/work/health", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


def test_health_401_without_auth(client: TestClient) -> None:
    resp = client.get("/work/health")
    assert resp.status_code == 401


def test_health_401_with_wrong_bearer(client: TestClient) -> None:
    resp = client.get("/work/health", headers={"Authorization": "Bearer nope"})
    assert resp.status_code == 401


def test_health_401_with_malformed_header(client: TestClient) -> None:
    resp = client.get("/work/health", headers={"Authorization": "Token abc"})
    assert resp.status_code == 401


# ===========================================================================
# httpx ASGITransport client surface
# ===========================================================================


async def test_asgi_client_happy(
    asgi_client: httpx.AsyncClient, auth_headers: dict[str, str]
) -> None:
    resp = await asgi_client.get("/work/health", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


async def test_asgi_client_401(asgi_client: httpx.AsyncClient) -> None:
    resp = await asgi_client.get("/work/health")
    assert resp.status_code == 401


# ===========================================================================
# fake_supabase: read happy + 404
# ===========================================================================


def test_read_happy(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", _pipeline_row())
    fake_supabase.set_single("briefs", {"id": "ib-1", "payload": {"market": "Austin"}})
    fake_supabase.seed(
        "creatives",
        [
            {
                "id": "cr-1",
                "brief_id": "ib-1",
                "concept": "trust",
                "ratio": "1x1",
                "version": "v0.ideation",
                "file_path_supabase": "ib-1/trust.png",
            }
        ],
    )

    resp = client.get("/work/pipeline/tools/p-1", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["pipeline_id"] == "p-1"
    assert body["status"] == "ideation"
    assert [c["creative_id"] for c in body["concepts"]] == ["cr-1"]


def test_read_404_when_pipeline_absent(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", None)
    resp = client.get("/work/pipeline/tools/missing", headers=auth_headers)
    assert resp.status_code == 404


def test_read_401(client: TestClient, fake_supabase: FakeSupabase) -> None:
    resp = client.get("/work/pipeline/tools/p-1")
    assert resp.status_code == 401


# ===========================================================================
# 422: schema-invalid payload rejected before any side effect
# ===========================================================================


def test_render_422_on_bad_payload(
    client: TestClient, auth_headers: dict[str, str], fake_supabase: FakeSupabase
) -> None:
    fake_supabase.set_single("pipelines", _pipeline_row())
    # `kind` must be concept_preview | final; "bogus" fails Pydantic validation.
    resp = client.post(
        "/work/pipeline/tools/render",
        headers=auth_headers,
        json={"pipeline_id": "p-1", "kind": "bogus"},
    )
    assert resp.status_code == 422
    # Nothing rendered.
    assert not any(name == "creatives" for name, _ in fake_supabase.inserts)


# ===========================================================================
# Idempotency: duplicate deterministic render = no double effect
# (FAKE_RENDER => zero network calls; the harness proves the no-double-effect
# contract the rebuild's exactly-once design depends on.)
# ===========================================================================


@pytest.fixture
def _fake_render(monkeypatch: pytest.MonkeyPatch) -> None:
    """Turn on FAKE_RENDER for the deterministic render idempotency test."""
    monkeypatch.setenv("FAKE_RENDER", "true")
    from src.config import get_settings

    get_settings.cache_clear()


def test_render_idempotent_skips_already_rendered(
    client: TestClient,
    auth_headers: dict[str, str],
    fake_supabase: FakeSupabase,
    _fake_render: None,
) -> None:
    """First render stores 2 concepts; the duplicate call renders 0 more."""
    fake_supabase.set_single(
        "pipelines",
        _pipeline_row(
            config_draft={
                "concepts": [
                    {"concept": "before_after__a", "prompt": "pa"},
                    {"concept": "savings__b", "prompt": "pb"},
                ]
            },
        ),
    )

    body1 = {"pipeline_id": "p-1", "kind": "concept_preview"}  # no items → fan out

    first = client.post("/work/pipeline/tools/render", headers=auth_headers, json=body1)
    assert first.status_code == 200, first.text
    j1 = first.json()
    assert len(j1["renders"]) == 2
    assert j1["skipped"] == []
    creatives_after_first = [n for n, _ in fake_supabase.inserts if n == "creatives"]
    assert len(creatives_after_first) == 2

    # Duplicate call: the route reads back the stored creatives and skips them.
    second = client.post("/work/pipeline/tools/render", headers=auth_headers, json=body1)
    assert second.status_code == 200, second.text
    j2 = second.json()
    assert j2["renders"] == []
    assert sorted(j2["skipped"]) == ["before_after__a", "savings__b"]
    # No new creatives inserted by the second call — the no-double-effect proof.
    creatives_after_second = [n for n, _ in fake_supabase.inserts if n == "creatives"]
    assert len(creatives_after_second) == 2
