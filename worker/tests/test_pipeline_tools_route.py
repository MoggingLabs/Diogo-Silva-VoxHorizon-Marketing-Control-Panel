"""Tests for the Wave A operator-tool routes.

Covers the four endpoints on the pipeline-tools router:

  * GET  /work/pipeline/tools/{pipeline_id} — read shape.
  * POST /work/pipeline/tools/brief         — validate + upsert + event.
  * POST /work/pipeline/tools/render        — events + cost + creatives,
                                              per-item error handling.
  * POST /work/pipeline/tools/dispatch      — builds the right argv (the
                                              operator bridge is mocked).

Mirrors the test conventions in ``test_pipeline_route.py`` (a narrow
Supabase + Kie double, background tasks run synchronously by the
TestClient) and ``test_hermes_bridge.py`` (a MagicMock docker client).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient


SHARED_SECRET = "test-secret-for-pipeline-tools"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Provision env + reset cached settings, queue, and operator bridge."""
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-api-key")

    from src.config import get_settings
    from src.services.operator_bridge import reset_operator_bridge
    from src.services.queue import reset_queue

    get_settings.cache_clear()
    reset_queue()
    reset_operator_bridge()
    yield
    get_settings.cache_clear()
    reset_queue()
    reset_operator_bridge()


# ---------------------------------------------------------------------------
# Supabase + Kie test doubles (modelled on test_pipeline_route.py)
# ---------------------------------------------------------------------------


class _ToolsSupabase:
    """Stand-in for the supabase-py client used by the operator tools.

    ``pipeline_row`` / ``brief_row`` set the rows returned on
    ``maybe_single`` selects; ``creatives_rows`` / ``events_rows`` back the
    multi-row selects the read path issues; ``rpc_return`` is what
    ``rpc('gen_brief_id_human')`` yields. Inserts / updates / uploads are
    captured for assertions.
    """

    def __init__(self) -> None:
        self.pipeline_row: dict | None = None
        self.brief_row: dict | None = None
        self.client_row: dict | None = None
        self.creatives_rows: list[dict] = []
        self.events_rows: list[dict] = []
        self.rpc_return: Any = "acme-2026-05-20-001"

        self.inserts: list[tuple[str, dict]] = []
        self.updates: list[tuple[str, dict]] = []
        self.storage_uploads: list[tuple[str, bytes]] = []
        self.rpc_calls: list[tuple[str, dict]] = []

    def table(self, name: str) -> "_ToolsTable":
        return _ToolsTable(self, name)

    def rpc(self, fn: str, params: dict) -> "_ToolsRpc":
        self.rpc_calls.append((fn, params))
        return _ToolsRpc(self.rpc_return)

    @property
    def storage(self) -> "_ToolsStorage":
        return _ToolsStorage(self)


class _ToolsRpc:
    def __init__(self, value: Any) -> None:
        self._value = value

    def execute(self) -> SimpleNamespace:
        return SimpleNamespace(data=self._value)


class _ToolsTable:
    def __init__(self, sb: _ToolsSupabase, name: str) -> None:
        self.sb = sb
        self.name = name
        self._filters: list[tuple[str, str]] = []
        self._select: str | None = None
        self._insert_data: dict | None = None
        self._update_data: dict | None = None
        self._maybe_single = False
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None

    def select(self, columns: str) -> "_ToolsTable":
        self._select = columns
        return self

    def eq(self, col: str, val: str) -> "_ToolsTable":
        self._filters.append((col, val))
        return self

    def order(self, col: str, *, desc: bool = False) -> "_ToolsTable":
        self._order = (col, desc)
        return self

    def limit(self, n: int) -> "_ToolsTable":
        self._limit = n
        return self

    def maybe_single(self) -> "_ToolsTable":
        self._maybe_single = True
        return self

    def insert(self, data: dict) -> "_ToolsTable":
        self._insert_data = data
        return self

    def update(self, data: dict) -> "_ToolsTable":
        self._update_data = data
        return self

    def execute(self) -> SimpleNamespace:
        if self._insert_data is not None:
            self.sb.inserts.append((self.name, self._insert_data))
            row = {
                **self._insert_data,
                "id": f"{self.name}-id-{len(self.sb.inserts)}",
            }
            return SimpleNamespace(data=[row])
        if self._update_data is not None:
            self.sb.updates.append((self.name, self._update_data))
            return SimpleNamespace(data=[{**self._update_data, "id": "u-id"}])

        # maybe_single selects:
        if self._maybe_single:
            if self.name == "pipelines":
                return SimpleNamespace(data=self.sb.pipeline_row)
            if self.name == "briefs":
                return SimpleNamespace(data=self.sb.brief_row)
            if self.name == "clients":
                return SimpleNamespace(data=self.sb.client_row)
            return SimpleNamespace(data=None)

        # multi-row selects:
        if self.name == "creatives":
            rows = [
                r
                for r in self.sb.creatives_rows
                if all(r.get(c) == v for c, v in self._filters)
            ]
            return SimpleNamespace(data=rows)
        if self.name == "pipeline_events":
            rows = [
                r
                for r in self.sb.events_rows
                if all(r.get(c) == v for c, v in self._filters)
            ]
            if self._order:
                col, desc = self._order
                rows = sorted(rows, key=lambda r: r.get(col, ""), reverse=desc)
            if self._limit:
                rows = rows[: self._limit]
            return SimpleNamespace(data=rows)

        return SimpleNamespace(data=None)


class _ToolsStorage:
    def __init__(self, sb: _ToolsSupabase) -> None:
        self.sb = sb

    def from_(self, bucket: str) -> "_ToolsBucket":
        return _ToolsBucket(self.sb)


class _ToolsBucket:
    def __init__(self, sb: _ToolsSupabase) -> None:
        self.sb = sb

    def upload(self, *, path: str, file: bytes, file_options: dict) -> None:
        self.sb.storage_uploads.append((path, bytes(file)))


class _StubKieClient:
    """Drop-in for KieClient returning canned bytes + metadata."""

    def __init__(self, *_a: Any, **_kw: Any) -> None:
        pass

    async def generate_image_full(
        self, prompt: str, ratio: str, *, resolution: str = "2K"
    ) -> Any:
        from src.services.kie import KieGenerationResult

        return KieGenerationResult(
            image_bytes=b"PNGBYTES",
            task_id=f"task-{ratio}",
            source_url=f"https://kie/{ratio}.png",
            aspect_ratio=ratio,
            resolution=resolution,
        )


class _FailKieClient(_StubKieClient):
    """Kie double that fails on the 9x16 ratio to exercise per-item errors."""

    async def generate_image_full(
        self, prompt: str, ratio: str, *, resolution: str = "2K"
    ) -> Any:
        from src.services.kie import KieError

        if ratio == "9x16":
            raise KieError("simulated kie failure")
        return await super().generate_image_full(
            prompt, ratio, resolution=resolution
        )


@pytest.fixture
def tools_sb(monkeypatch: pytest.MonkeyPatch) -> _ToolsSupabase:
    """Install the tools Supabase stub everywhere the routes read it."""
    sb = _ToolsSupabase()

    from src.routes import pipeline_tools
    from src.services import atomic_inserts, pipeline_runner

    monkeypatch.setattr(pipeline_tools, "get_supabase_admin", lambda: sb)
    monkeypatch.setattr(pipeline_runner, "get_supabase_admin", lambda: sb)
    monkeypatch.setattr(atomic_inserts, "get_supabase_admin", lambda: sb)
    return sb


@pytest.fixture
def client() -> TestClient:
    from src.main import create_app

    return TestClient(create_app())


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {SHARED_SECRET}"}


def _pipeline_row(**overrides: Any) -> dict[str, Any]:
    row = {
        "id": "p-1",
        "status": "ideation",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib-1",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {"image": [], "video": []},
        "advanced_at": {},
        "created_at": "2026-05-20T00:00:00Z",
    }
    row.update(overrides)
    return row


# ===========================================================================
# GET /work/pipeline/tools/{pipeline_id}
# ===========================================================================


def test_read_requires_auth(client: TestClient) -> None:
    resp = client.get("/work/pipeline/tools/p-1")
    assert resp.status_code == 401


def test_read_404_when_missing(
    client: TestClient, tools_sb: _ToolsSupabase
) -> None:
    tools_sb.pipeline_row = None
    resp = client.get("/work/pipeline/tools/p-nope", headers=_auth())
    assert resp.status_code == 404


def test_read_returns_full_shape(
    client: TestClient, tools_sb: _ToolsSupabase
) -> None:
    tools_sb.pipeline_row = _pipeline_row(
        config_draft={"image_payload": {"market": "Austin"}},
        picks={"image": ["cr-final-1"], "video": []},
    )
    tools_sb.brief_row = {
        "id": "ib-1",
        "payload": {"market": "Austin, TX", "offer_text": "$99 inspection"},
    }
    tools_sb.creatives_rows = [
        {
            "id": "cr-c1",
            "brief_id": "ib-1",
            "concept": "trust",
            "ratio": "1x1",
            "version": "v0.ideation",
            "file_path_supabase": "ib-1/trust-1x1-v0.ideation.png",
        },
        {
            "id": "cr-final-1",
            "brief_id": "ib-1",
            "concept": "trust",
            "ratio": "9x16",
            "version": "v1.0",
            "file_path_supabase": "ib-1/trust-9x16-v1.0.png",
        },
    ]
    tools_sb.events_rows = [
        {
            "id": "ev-1",
            "pipeline_id": "p-1",
            "kind": "task_done",
            "stage": "ideation",
            "payload": {"creative_id": "cr-c1"},
            "created_at": "2026-05-20T00:00:05Z",
        },
        {
            "id": "ev-2",
            "pipeline_id": "p-1",
            "kind": "stage_advanced",
            "stage": "ideation",
            "payload": {},
            "created_at": "2026-05-20T00:00:01Z",
        },
    ]

    resp = client.get("/work/pipeline/tools/p-1", headers=_auth())
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["pipeline_id"] == "p-1"
    assert body["status"] == "ideation"
    assert body["format_choice"] == "image"
    assert body["config_draft"] == {"image_payload": {"market": "Austin"}}
    assert body["picks"] == {"image": ["cr-final-1"], "video": []}
    assert body["brief"] == {
        "id": "ib-1",
        "payload": {"market": "Austin, TX", "offer_text": "$99 inspection"},
    }
    # Concepts = v0.ideation only; finals = v1*.
    assert [c["creative_id"] for c in body["concepts"]] == ["cr-c1"]
    assert [f["creative_id"] for f in body["finals"]] == ["cr-final-1"]
    # Events tail returned oldest-first.
    assert [e["id"] for e in body["events_tail"]] == ["ev-2", "ev-1"]


def test_read_null_brief_when_unlinked(
    client: TestClient, tools_sb: _ToolsSupabase
) -> None:
    tools_sb.pipeline_row = _pipeline_row(image_brief_id=None)
    resp = client.get("/work/pipeline/tools/p-1", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["brief"] is None
    assert body["concepts"] == []
    assert body["finals"] == []


# ===========================================================================
# POST /work/pipeline/tools/brief
# ===========================================================================


def test_brief_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/pipeline/tools/brief", json={})
    assert resp.status_code == 401


def test_brief_validates_required_keys(
    client: TestClient, tools_sb: _ToolsSupabase
) -> None:
    tools_sb.pipeline_row = _pipeline_row()
    # Missing offer_text + angles.
    resp = client.post(
        "/work/pipeline/tools/brief",
        headers=_auth(),
        json={"pipeline_id": "p-1", "image_payload": {"market": "Austin"}},
    )
    assert resp.status_code == 422


def test_brief_inserts_when_unlinked(
    client: TestClient, tools_sb: _ToolsSupabase
) -> None:
    tools_sb.pipeline_row = _pipeline_row(image_brief_id=None)
    tools_sb.client_row = {"slug": "acme"}

    resp = client.post(
        "/work/pipeline/tools/brief",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "image_payload": {
                "market": "Austin, TX",
                "offer_text": "$99 inspection",
                "angles": ["trust", "savings"],
            },
            "notes": "owner-led trust angle",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["brief_id"] == "briefs-id-1"

    # A briefs row was inserted with the constraint-satisfying defaults.
    brief_inserts = [d for n, d in tools_sb.inserts if n == "briefs"]
    assert len(brief_inserts) == 1
    payload = brief_inserts[0]["payload"]
    assert payload["market"] == "Austin, TX"
    assert payload["offer_text"] == "$99 inspection"
    assert payload["angles"] == ["trust", "savings"]
    # service + budget backfilled so the briefs.payload CHECK is satisfied.
    assert "service" in payload and "budget" in payload
    assert brief_inserts[0]["status"] == "draft"
    assert brief_inserts[0]["brief_id_human"]  # minted via rpc

    # The pipeline was linked + config_draft merged.
    pipe_updates = [d for n, d in tools_sb.updates if n == "pipelines"]
    assert pipe_updates and pipe_updates[0]["image_brief_id"] == "briefs-id-1"
    assert pipe_updates[0]["config_draft"]["notes"] == "owner-led trust angle"

    # brief_authored event emitted.
    events = [d for n, d in tools_sb.inserts if n == "pipeline_events"]
    assert any(e["kind"] == "brief_authored" for e in events)


def test_brief_updates_when_already_linked(
    client: TestClient, tools_sb: _ToolsSupabase
) -> None:
    """Idempotent re-author: existing image_brief_id → UPDATE, not INSERT."""
    tools_sb.pipeline_row = _pipeline_row(image_brief_id="ib-existing")

    resp = client.post(
        "/work/pipeline/tools/brief",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "image_payload": {
                "market": "Dallas, TX",
                "offer_text": "free quote",
                "angles": ["urgency"],
            },
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["brief_id"] == "ib-existing"

    # No new briefs INSERT; the existing brief was UPDATEd.
    assert not any(n == "briefs" for n, _ in tools_sb.inserts)
    brief_updates = [d for n, d in tools_sb.updates if n == "briefs"]
    assert len(brief_updates) == 1
    assert brief_updates[0]["payload"]["market"] == "Dallas, TX"


def test_brief_404_when_pipeline_missing(
    client: TestClient, tools_sb: _ToolsSupabase
) -> None:
    tools_sb.pipeline_row = None
    resp = client.post(
        "/work/pipeline/tools/brief",
        headers=_auth(),
        json={
            "pipeline_id": "p-nope",
            "image_payload": {
                "market": "X",
                "offer_text": "Y",
                "angles": ["z"],
            },
        },
    )
    assert resp.status_code == 404


# ===========================================================================
# POST /work/pipeline/tools/render
# ===========================================================================


def test_render_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/pipeline/tools/render", json={})
    assert resp.status_code == 401


def test_render_concept_preview(
    client: TestClient,
    tools_sb: _ToolsSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """concept_preview → 1x1 / 1K / v0.ideation, with task + cost events."""
    tools_sb.pipeline_row = _pipeline_row()
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie")
    from src.config import get_settings

    get_settings.cache_clear()
    from src.routes import pipeline_tools

    monkeypatch.setattr(pipeline_tools, "KieClient", _StubKieClient)

    resp = client.post(
        "/work/pipeline/tools/render",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "kind": "concept_preview",
            "items": [
                {"concept": "trust", "prompt": "owner on a roof, golden hour"},
                {"concept": "savings", "prompt": "happy homeowner, $99 sticker"},
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert len(body["renders"]) == 2
    assert body["errors"] == []
    # 2 previews at 0.02 each.
    assert body["total_cost_usd"] == pytest.approx(0.04)

    creatives = [d for n, d in tools_sb.inserts if n == "creatives"]
    assert len(creatives) == 2
    for c in creatives:
        assert c["ratio"] == "1x1"
        assert c["version"] == "v0.ideation"
        # 1K resolution + operator authorship marker in prompt_used.
        assert c["prompt_used"]["resolution"] == "1K"
        assert c["prompt_used"]["author"] == "operator"

    pe = [d for n, d in tools_sb.inserts if n == "pipeline_events"]
    kinds = [e["kind"] for e in pe]
    assert kinds.count("task_queued") == 2
    assert kinds.count("task_running") == 2
    assert kinds.count("task_done") == 2
    cost = [e for e in pe if e["kind"] == "cost_recorded"]
    assert len(cost) == 2
    assert all(e["stage"] == "ideation" for e in cost)
    assert all(e["payload"]["api"] == "kie.ai" for e in cost)


def test_render_final_both_ratios(
    client: TestClient,
    tools_sb: _ToolsSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """final → 1x1 + 9x16 / 2K / v1.0 with parent_creative_id set."""
    tools_sb.pipeline_row = _pipeline_row(status="generation")
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie")
    from src.config import get_settings

    get_settings.cache_clear()
    from src.routes import pipeline_tools

    monkeypatch.setattr(pipeline_tools, "KieClient", _StubKieClient)

    resp = client.post(
        "/work/pipeline/tools/render",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "kind": "final",
            "items": [
                {
                    "concept": "trust",
                    "prompt": "owner on a roof, golden hour, photoreal",
                    "offer_text": "$99 inspection",
                    "parent_creative_id": "cr-c1",
                }
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["renders"]) == 2
    assert sorted(r["ratio"] for r in body["renders"]) == ["1x1", "9x16"]
    assert body["total_cost_usd"] == pytest.approx(0.10)

    creatives = [d for n, d in tools_sb.inserts if n == "creatives"]
    assert len(creatives) == 2
    for c in creatives:
        assert c["version"] == "v1.0"
        assert c["prompt_used"]["resolution"] == "2K"
        assert c["prompt_used"]["parent_creative_id"] == "cr-c1"

    pe = [d for n, d in tools_sb.inserts if n == "pipeline_events"]
    done = [e for e in pe if e["kind"] == "task_done"]
    assert all(e["stage"] == "generation" for e in done)
    assert all(e["payload"]["parent_creative_id"] == "cr-c1" for e in done)


def test_render_final_requires_parent(
    client: TestClient,
    tools_sb: _ToolsSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tools_sb.pipeline_row = _pipeline_row()
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie")
    from src.config import get_settings

    get_settings.cache_clear()
    from src.routes import pipeline_tools

    monkeypatch.setattr(pipeline_tools, "KieClient", _StubKieClient)

    resp = client.post(
        "/work/pipeline/tools/render",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "kind": "final",
            "items": [{"concept": "trust", "prompt": "a roof"}],
        },
    )
    assert resp.status_code == 400
    assert "parent_creative_id" in resp.json()["detail"]


def test_render_per_item_error_continues(
    client: TestClient,
    tools_sb: _ToolsSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failing ratio emits task_error but the batch keeps going."""
    tools_sb.pipeline_row = _pipeline_row(status="generation")
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie")
    from src.config import get_settings

    get_settings.cache_clear()
    from src.routes import pipeline_tools

    monkeypatch.setattr(pipeline_tools, "KieClient", _FailKieClient)

    resp = client.post(
        "/work/pipeline/tools/render",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "kind": "final",
            "items": [
                {
                    "concept": "trust",
                    "prompt": "a roof",
                    "parent_creative_id": "cr-c1",
                }
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # 1x1 succeeded, 9x16 failed.
    assert len(body["renders"]) == 1
    assert body["renders"][0]["ratio"] == "1x1"
    assert len(body["errors"]) == 1
    assert body["errors"][0]["ratio"] == "9x16"

    pe = [d for n, d in tools_sb.inserts if n == "pipeline_events"]
    assert sum(1 for e in pe if e["kind"] == "task_done") == 1
    err = [e for e in pe if e["kind"] == "task_error"]
    assert len(err) == 1
    assert err[0]["payload"]["ratio"] == "9x16"


def test_render_404_when_pipeline_missing(
    client: TestClient, tools_sb: _ToolsSupabase
) -> None:
    tools_sb.pipeline_row = None
    resp = client.post(
        "/work/pipeline/tools/render",
        headers=_auth(),
        json={
            "pipeline_id": "p-nope",
            "kind": "concept_preview",
            "items": [{"concept": "x", "prompt": "y"}],
        },
    )
    assert resp.status_code == 404


def test_render_400_when_no_brief(
    client: TestClient, tools_sb: _ToolsSupabase
) -> None:
    tools_sb.pipeline_row = _pipeline_row(image_brief_id=None)
    resp = client.post(
        "/work/pipeline/tools/render",
        headers=_auth(),
        json={
            "pipeline_id": "p-1",
            "kind": "concept_preview",
            "items": [{"concept": "x", "prompt": "y"}],
        },
    )
    assert resp.status_code == 400


# ===========================================================================
# POST /work/pipeline/tools/dispatch
# ===========================================================================


def test_dispatch_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/pipeline/tools/dispatch", json={})
    assert resp.status_code == 401


def test_dispatch_builds_argv_and_returns_immediately(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """dispatch schedules the operator exec with the right argv + session id."""
    from src.services import operator_bridge

    # Mock docker so the bridge's fire-and-forget exec hits a fake daemon.
    api = MagicMock()
    api.exec_create.return_value = {"Id": "exec-xyz"}
    api.exec_start.return_value = iter([b"narration..."])
    docker_client = MagicMock()
    docker_client.api = api

    # Force a fresh bridge bound to our fake docker client.
    operator_bridge.reset_operator_bridge()
    bridge = operator_bridge.OperatorBridge(
        container_name="hermes-agent-operator", client=docker_client
    )
    monkeypatch.setattr(
        operator_bridge, "get_operator_bridge", lambda: bridge
    )
    from src.routes import pipeline_tools

    monkeypatch.setattr(
        pipeline_tools, "get_operator_bridge", lambda: bridge
    )

    resp = client.post(
        "/work/pipeline/tools/dispatch",
        headers=_auth(),
        json={
            "pipeline_id": "p-42",
            "instruction": "author concepts for pipeline p-42",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "dispatched": True}

    # The TestClient runs the BackgroundTask after the response, so the
    # exec has been created by now. No --pass-session-id: it's a boolean flag
    # on the Hermes CLI, and the operator is stateless per dispatch (the
    # pipeline id rides in the instruction).
    args, kwargs = api.exec_create.call_args
    assert args[0] == "hermes-agent-operator"
    assert args[1] == [
        "hermes",
        "chat",
        "-q",
        "author concepts for pipeline p-42",
        "--max-turns",
        "40",
    ]
    assert kwargs == {"stdout": True, "stderr": True, "tty": False}
    # stdout was drained to completion.
    api.exec_start.assert_called_once_with("exec-xyz", stream=True)


def test_dispatch_swallows_bridge_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A docker NotFound surfaces as a logged warning, not a 500."""
    import docker.errors

    from src.services import operator_bridge

    api = MagicMock()
    api.exec_create.side_effect = docker.errors.NotFound("no container")
    docker_client = MagicMock()
    docker_client.api = api

    bridge = operator_bridge.OperatorBridge(client=docker_client)
    from src.routes import pipeline_tools

    monkeypatch.setattr(
        pipeline_tools, "get_operator_bridge", lambda: bridge
    )

    resp = client.post(
        "/work/pipeline/tools/dispatch",
        headers=_auth(),
        json={"pipeline_id": "p-1", "instruction": "go"},
    )
    # The endpoint returns before the background task runs; the task's
    # OperatorBridgeError is caught and logged.
    assert resp.status_code == 200
    assert resp.json()["dispatched"] is True
