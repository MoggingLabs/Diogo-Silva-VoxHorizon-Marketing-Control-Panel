"""Tests for the pipeline worker routes.

Covers three endpoints on the pipeline router:

  * /work/pipeline/config-draft — PF-B-3 (existing, Wave 10).
  * /work/pipeline/ideation     — PF-C-2 (Wave 11).
  * /work/pipeline/generation   — PF-E-1 + PF-D-5 idempotency (Wave 11).

The config-draft cases drive a stubbed ClaudeRunner; the ideation
cases stub Kie.ai + Supabase so the background producer can run
without external network calls. The generation cases mock the picks
read + the substage dispatch.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from src.services.claude_runner import ClaudeRunner, StreamChunk


SHARED_SECRET = "test-secret-for-pipeline-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Provision env + reset cached settings + runner singleton."""
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")
    # Avoid the SDK complaining when the runner is constructed by the
    # real default factory.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-api-key")

    from src.config import get_settings
    from src.routes import pipeline as pipeline_route
    from src.services.queue import reset_queue

    get_settings.cache_clear()
    reset_queue()
    pipeline_route._reset_runner()
    yield
    get_settings.cache_clear()
    reset_queue()
    pipeline_route._reset_runner()


class _FakeProposeRunner(ClaudeRunner):
    """Test double that emits a brief assistant message + a tool_use call.

    We bypass the Anthropic SDK entirely by overriding `stream` — the
    runner's transport is monkey-patched out and we drive the SSE flow
    from a hard-coded sequence of StreamChunks.
    """

    def __init__(self, payload: dict[str, Any]) -> None:
        super().__init__(anthropic_api_key="test")
        self._payload = payload

    async def stream(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        system_prompt: str | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
    ) -> AsyncIterator[StreamChunk]:
        # Short text delta so the consumer sees realistic shape.
        yield StreamChunk(type="text_delta", delta="Drafting brief…")
        # Tool invocation — the runner's _translate_event surfaces full
        # tool_use blocks as tool_call_start with the complete `input`.
        yield StreamChunk(
            type="tool_call_start",
            tool="propose_config",
            input=self._payload,
        )
        yield StreamChunk(type="message_stop")


@pytest.fixture
def client() -> TestClient:
    from src.main import create_app

    return TestClient(create_app())


def _parse_sse(body: str) -> list[dict[str, Any]]:
    """Pull `data:` JSON frames out of the SSE response body."""
    frames: list[dict[str, Any]] = []
    for raw_event in body.split("\n\n"):
        for line in raw_event.splitlines():
            if line.startswith("data:"):
                payload = line.removeprefix("data:").strip()
                if not payload:
                    continue
                frames.append(json.loads(payload))
    return frames


def test_config_draft_emits_tool_call_result(client: TestClient) -> None:
    from src.routes import pipeline as pipeline_route

    proposed: dict[str, Any] = {
        "format_choice": "image",
        "image_payload": {
            "service": "roofing",
            "budget": 5000,
            "market": "Tampa, FL",
        },
        "video_payload": None,
        "notes": "operator asked for an image-only test run",
    }
    pipeline_route._runner = _FakeProposeRunner(proposed)

    resp = client.post(
        "/work/pipeline/config-draft",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "pipeline_id": "p-test-1",
            "format_choice": "image",
            "messages": [
                {"role": "user", "content": "Draft an image brief for me."}
            ],
        },
    )

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    frames = _parse_sse(resp.text)
    # We expect at least the text delta, the tool_call_start, the
    # synthesized tool_call_result, and the message_stop.
    types = [f["type"] for f in frames]
    assert "text_delta" in types
    assert "tool_call_start" in types
    assert "tool_call_result" in types
    assert types[-1] == "message_stop"

    # The synthesized result mirrors the propose_config input verbatim.
    result_frame = next(
        f for f in frames if f["type"] == "tool_call_result"
    )
    assert result_frame["tool"] == "propose_config"
    assert result_frame["result"] == proposed


def test_config_draft_requires_auth(client: TestClient) -> None:
    resp = client.post(
        "/work/pipeline/config-draft",
        json={
            "pipeline_id": "p-test-1",
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert resp.status_code == 401


def test_config_draft_rejects_empty_messages(client: TestClient) -> None:
    resp = client.post(
        "/work/pipeline/config-draft",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "pipeline_id": "p-test-1",
            "messages": [],
        },
    )
    assert resp.status_code == 400


# ===========================================================================
# Ideation + Generation: shared Supabase + Kie test doubles
# ===========================================================================
#
# These doubles are scoped narrowly: they capture exactly the table /
# storage calls the new endpoints make so the tests can assert on the
# side effects without spinning up a real Supabase or Kie.ai. They're
# intentionally simpler than the _FakeSupabase in test_creative_route —
# the pipeline routes don't read complex joins; they hit a few tables
# with predictable shapes.


class _PipelineSupabase:
    """Stand-in for the supabase-py client used by pipeline routes.

    Captures inserts and "select" filters so the test assertions can
    inspect what the producer wrote. ``pipeline_row`` /
    ``brief_row`` / ``video_brief_row`` / ``creative_row`` /
    ``video_creative_row`` set the response payloads the fake returns
    on the corresponding ``maybe_single`` calls. ``events_data`` is
    pre-seeded for the pipeline_events table queries that drive the
    idempotency probes.
    """

    def __init__(self) -> None:
        self.pipeline_row: dict | None = None
        self.brief_row: dict | None = None
        self.video_brief_row: dict | None = None
        self.creative_row: dict | None = None
        self.video_creative_row: dict | None = None
        # Pre-seeded rows the *select* returns for pipeline_events.
        # The fake honours the kind / stage filters at execute time.
        self.events_data: list[dict] = []

        # Captured side effects:
        self.inserts: list[tuple[str, dict]] = []
        self.updates: list[tuple[str, dict]] = []
        self.storage_uploads: list[tuple[str, bytes]] = []

    def table(self, name: str) -> "_PipelineTable":
        return _PipelineTable(self, name)

    @property
    def storage(self) -> "_PipelineStorage":
        return _PipelineStorage(self)


class _PipelineTable:
    def __init__(self, sb: _PipelineSupabase, name: str) -> None:
        self.sb = sb
        self.name = name
        self._filters: list[tuple[str, str]] = []
        self._gt: tuple[str, str] | None = None
        self._select: str | None = None
        self._insert_data: dict | None = None
        self._update_data: dict | None = None
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None

    def select(self, columns: str) -> "_PipelineTable":
        self._select = columns
        return self

    def eq(self, col: str, val: str) -> "_PipelineTable":
        self._filters.append((col, val))
        return self

    def gt(self, col: str, val: str) -> "_PipelineTable":
        self._gt = (col, val)
        return self

    def order(self, col: str, *, desc: bool = False) -> "_PipelineTable":
        self._order = (col, desc)
        return self

    def limit(self, n: int) -> "_PipelineTable":
        self._limit = n
        return self

    def maybe_single(self) -> "_PipelineTable":
        return self

    def insert(self, data: dict) -> "_PipelineTable":
        self._insert_data = data
        return self

    def update(self, data: dict) -> "_PipelineTable":
        self._update_data = data
        return self

    def execute(self) -> SimpleNamespace:
        # Mutations:
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

        # Selects:
        if self.name == "pipelines":
            return SimpleNamespace(data=self.sb.pipeline_row)
        if self.name == "briefs":
            return SimpleNamespace(data=self.sb.brief_row)
        if self.name == "video_briefs":
            return SimpleNamespace(data=self.sb.video_brief_row)
        if self.name == "creatives":
            return SimpleNamespace(data=self.sb.creative_row)
        if self.name == "video_creatives":
            return SimpleNamespace(data=self.sb.video_creative_row)
        if self.name == "pipeline_events":
            # Apply the kind / stage filters before returning. The
            # idempotency probes call this with (kind=stage_advanced,
            # stage=<X>) + an order/limit, OR with no kind filter and
            # a gt(created_at, cutoff).
            results = list(self.sb.events_data)
            for col, val in self._filters:
                # All filters are equality matches against payload
                # fields. None or missing fields don't match.
                results = [r for r in results if r.get(col) == val]
            if self._gt is not None:
                col, val = self._gt
                results = [r for r in results if str(r.get(col, "")) > val]
            if self._order:
                col, desc = self._order
                results.sort(key=lambda r: r.get(col, ""), reverse=desc)
            if self._limit:
                results = results[: self._limit]
            return SimpleNamespace(data=results)

        return SimpleNamespace(data=None)


class _PipelineStorage:
    def __init__(self, sb: _PipelineSupabase) -> None:
        self.sb = sb

    def from_(self, bucket: str) -> "_PipelineBucket":
        return _PipelineBucket(self.sb, bucket)


class _PipelineBucket:
    def __init__(self, sb: _PipelineSupabase, bucket: str) -> None:
        self.sb = sb
        self.bucket = bucket

    def upload(self, *, path: str, file: bytes, file_options: dict) -> None:
        self.sb.storage_uploads.append((path, bytes(file)))


class _StubKieClient:
    """Drop-in for KieClient that returns canned bytes + metadata."""

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

    async def generate_image(
        self, prompt: str, ratio: str, *, resolution: str = "2K"
    ) -> bytes:
        result = await self.generate_image_full(
            prompt, ratio, resolution=resolution
        )
        return result.image_bytes


@pytest.fixture
def pipeline_sb(monkeypatch: pytest.MonkeyPatch) -> _PipelineSupabase:
    """Install the pipeline-specific Supabase stub everywhere it's read."""
    sb = _PipelineSupabase()

    from src.routes import pipeline as pipeline_route
    from src.services import atomic_inserts, atomic_inserts_video, pipeline_runner

    monkeypatch.setattr(pipeline_route, "get_supabase_admin", lambda: sb)
    monkeypatch.setattr(pipeline_runner, "get_supabase_admin", lambda: sb)
    monkeypatch.setattr(atomic_inserts, "get_supabase_admin", lambda: sb)
    monkeypatch.setattr(atomic_inserts_video, "get_supabase_admin", lambda: sb)
    return sb


# ===========================================================================
# /work/pipeline/ideation
# ===========================================================================


def test_ideation_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/pipeline/ideation", json={"pipeline_id": "p"})
    assert resp.status_code == 401


def test_ideation_404_when_pipeline_missing(
    client: TestClient, pipeline_sb: _PipelineSupabase
) -> None:
    pipeline_sb.pipeline_row = None
    resp = client.post(
        "/work/pipeline/ideation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-nope"},
    )
    assert resp.status_code == 404


def test_ideation_image_track_produces_concepts(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Happy path for the image side.

    With format=image, brief_id set, no prior events, the route should
    accept + queue + producer should hit Kie + record creative rows +
    emit task_done events.
    """
    pipeline_sb.pipeline_row = {
        "id": "p-1",
        "status": "ideation",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib-1",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    pipeline_sb.brief_row = {
        "id": "ib-1",
        "brief_id_human": "ACM-001",
        "status": "approved",
        "payload": {
            "market": "Austin, TX",
            "offer_text": "$99 inspection",
            "angles": ["trust", "savings"],
        },
        "clients": {"slug": "acme", "name": "Acme", "service_type": "roofing"},
    }
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie")
    from src.config import get_settings

    get_settings.cache_clear()
    from src.routes import pipeline as pipeline_route

    monkeypatch.setattr(pipeline_route, "KieClient", _StubKieClient)

    resp = client.post(
        "/work/pipeline/ideation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-1"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accepted"] is True
    assert body["already_run"] is False
    assert body["image_track"] is True
    assert body["video_track"] is False

    # FastAPI's TestClient runs background tasks synchronously after
    # the response is sent — so by the time the JSON is back, our
    # producer has run.
    creative_inserts = [
        d for n, d in pipeline_sb.inserts if n == "creatives"
    ]
    assert len(creative_inserts) == 4, [
        (n, d) for n, d in pipeline_sb.inserts
    ]
    # Each should be a 1x1 ratio render at the ideation version.
    for ins in creative_inserts:
        assert ins["ratio"] == "1x1"
        assert ins["version"] == "v0.ideation"
    # 4 task_done events on the timeline.
    pe_inserts = [
        d for n, d in pipeline_sb.inserts if n == "pipeline_events"
    ]
    done = [
        d for d in pe_inserts if d.get("kind") == "task_done"
    ]
    assert len(done) == 4
    # Each done event references the freshly inserted creative.
    for ev in done:
        assert "creative_id" in ev["payload"]


def test_ideation_idempotent_on_retrigger(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A second call after events already exist must short-circuit."""
    pipeline_sb.pipeline_row = {
        "id": "p-2",
        "status": "ideation",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib-2",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    pipeline_sb.brief_row = {
        "id": "ib-2",
        "brief_id_human": "ACM-002",
        "status": "approved",
        "payload": {"market": "Austin, TX", "offer_text": "$99"},
        "clients": {"slug": "acme", "name": "Acme", "service_type": "roofing"},
    }
    # Prior events: one stage_advanced→ideation, then four task_done.
    pipeline_sb.events_data = [
        {
            "id": "ev-0",
            "pipeline_id": "p-2",
            "kind": "stage_advanced",
            "stage": "ideation",
            "payload": {},
            "created_at": "2025-01-01T00:00:00Z",
        },
        {
            "id": "ev-1",
            "pipeline_id": "p-2",
            "kind": "task_done",
            "stage": "ideation",
            "payload": {"creative_id": "cr-1"},
            "created_at": "2025-01-01T00:00:10Z",
        },
    ]
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie")
    from src.config import get_settings

    get_settings.cache_clear()
    from src.routes import pipeline as pipeline_route

    monkeypatch.setattr(pipeline_route, "KieClient", _StubKieClient)

    resp = client.post(
        "/work/pipeline/ideation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-2"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accepted"] is True
    assert body["already_run"] is True
    # No fresh inserts to ``creatives`` — the producer was skipped.
    assert not any(n == "creatives" for n, _ in pipeline_sb.inserts)


# ===========================================================================
# /work/pipeline/generation
# ===========================================================================


def test_generation_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/pipeline/generation", json={"pipeline_id": "p"})
    assert resp.status_code == 401


def test_generation_404_when_pipeline_missing(
    client: TestClient, pipeline_sb: _PipelineSupabase
) -> None:
    pipeline_sb.pipeline_row = None
    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-nope"},
    )
    assert resp.status_code == 404


def test_generation_image_picks_render_both_ratios(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One image pick → two final renders (1x1 + 9x16) + cost events."""
    pipeline_sb.pipeline_row = {
        "id": "p-g1",
        "status": "generation",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib-3",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {"image": ["cr-parent"], "video": []},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    pipeline_sb.creative_row = {
        "id": "cr-parent",
        "brief_id": "ib-3",
        "concept": "sunny",
        "offer_text": "$99",
        "prompt_used": {
            "prompt": "sunny roof, square aspect, vibrant",
        },
        "version": "v0.ideation",
        "file_path_supabase": "ib-3/sunny-1x1-v0.ideation.png",
    }
    # No prior generation events yet.
    pipeline_sb.events_data = [
        {
            "id": "ev-g0",
            "pipeline_id": "p-g1",
            "kind": "stage_advanced",
            "stage": "generation",
            "payload": {},
            "created_at": "2025-01-02T00:00:00Z",
        }
    ]
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie")
    from src.config import get_settings

    get_settings.cache_clear()
    from src.routes import pipeline as pipeline_route

    monkeypatch.setattr(pipeline_route, "KieClient", _StubKieClient)

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-g1"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accepted"] is True
    assert body["already_running"] is False
    assert body["already_complete"] is False
    assert body["image_picks"] == 1
    assert body["video_picks"] == 0

    # After background-tasks complete: two creative rows (one per
    # ratio) + matching pipeline_events.
    creative_inserts = [
        d for n, d in pipeline_sb.inserts if n == "creatives"
    ]
    assert len(creative_inserts) == 2
    ratios = sorted(d["ratio"] for d in creative_inserts)
    assert ratios == ["1x1", "9x16"]

    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    done = [d for d in pe if d.get("kind") == "task_done"]
    assert len(done) == 2
    cost = [d for d in pe if d.get("kind") == "cost_recorded"]
    assert len(cost) == 2
    for ev in cost:
        assert ev["payload"]["api"] == "kie.ai"


def test_generation_idempotent_when_running(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
) -> None:
    """PF-D-5: a second POST during in-flight tasks must short-circuit."""
    pipeline_sb.pipeline_row = {
        "id": "p-g2",
        "status": "generation",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib-4",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {"image": ["cr-parent"]},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    # Stage advance + queued/running events that haven't terminated.
    pipeline_sb.events_data = [
        {
            "id": "ev-g0",
            "pipeline_id": "p-g2",
            "kind": "stage_advanced",
            "stage": "generation",
            "payload": {},
            "created_at": "2025-01-02T00:00:00Z",
        },
        {
            "id": "ev-g1",
            "pipeline_id": "p-g2",
            "kind": "task_queued",
            "stage": "generation",
            "payload": {"kind": "image"},
            "created_at": "2025-01-02T00:00:05Z",
        },
        {
            "id": "ev-g2",
            "pipeline_id": "p-g2",
            "kind": "task_running",
            "stage": "generation",
            "payload": {"kind": "image"},
            "created_at": "2025-01-02T00:00:06Z",
        },
    ]

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-g2"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["already_running"] is True
    assert body["already_complete"] is False
    assert body["started_at"] == "2025-01-02T00:00:00Z"

    # No new creative inserts were triggered.
    assert not any(n == "creatives" for n, _ in pipeline_sb.inserts)


def test_generation_idempotent_when_complete(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
) -> None:
    """All prior tasks terminal => already_complete branch."""
    pipeline_sb.pipeline_row = {
        "id": "p-g3",
        "status": "generation",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib-5",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {"image": ["cr-parent"]},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    pipeline_sb.events_data = [
        {
            "id": "ev-g0",
            "pipeline_id": "p-g3",
            "kind": "stage_advanced",
            "stage": "generation",
            "payload": {},
            "created_at": "2025-01-02T00:00:00Z",
        },
        {
            "id": "ev-g1",
            "pipeline_id": "p-g3",
            "kind": "task_queued",
            "stage": "generation",
            "payload": {},
            "created_at": "2025-01-02T00:00:05Z",
        },
        {
            "id": "ev-g2",
            "pipeline_id": "p-g3",
            "kind": "task_done",
            "stage": "generation",
            "payload": {},
            "created_at": "2025-01-02T00:00:30Z",
        },
    ]

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-g3"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["already_running"] is False
    assert body["already_complete"] is True
    assert not any(n == "creatives" for n, _ in pipeline_sb.inserts)
