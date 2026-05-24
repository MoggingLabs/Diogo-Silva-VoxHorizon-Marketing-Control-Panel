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

import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
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


# ===========================================================================
# Helpers / branches not reachable from the happy-path tests above
# ===========================================================================


def test_get_runner_constructs_default_when_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``_get_runner`` builds a real ClaudeRunner when no test double has
    been installed — covers the singleton-init branch."""
    from src.routes import pipeline as pipeline_route

    pipeline_route._reset_runner()
    runner = pipeline_route._get_runner()
    assert isinstance(runner, ClaudeRunner)
    # Idempotent — second call returns the same instance.
    assert pipeline_route._get_runner() is runner
    pipeline_route._reset_runner()


def test_system_prompt_includes_video_for_both_format() -> None:
    """``_system_prompt`` adds the 'video' track marker when format is
    ``video`` or ``both`` — covers the ``("video", "both")`` branch."""
    from src.routes.pipeline import _system_prompt

    both = _system_prompt("both", "p-1")
    assert "image + video" in both
    video_only = _system_prompt("video", "p-2")
    assert "video" in video_only
    assert "image + video" not in video_only


def test_default_tools_returns_propose_config_schema() -> None:
    from src.routes.pipeline import _default_tools

    tools = _default_tools()
    assert len(tools) == 1
    assert tools[0]["name"] == "propose_config"
    assert "format_choice" in tools[0]["input_schema"]["properties"]


def test_propose_config_tool_format_required() -> None:
    from src.routes.pipeline import _propose_config_tool

    spec = _propose_config_tool()
    assert spec["input_schema"]["required"] == ["format_choice"]


# ===========================================================================
# /work/pipeline/config-draft — SSE wrapper branches
# ===========================================================================


class _SilentRunner(ClaudeRunner):
    """Emits no chunks at all — used to force the ``not saw_terminal``
    branch and the heartbeat keepalive path."""

    def __init__(self, *, delay_s: float = 0.0, emit_terminal: bool = False) -> None:
        super().__init__(anthropic_api_key="test")
        self._delay_s = delay_s
        self._emit_terminal = emit_terminal

    async def stream(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        system_prompt: str | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
    ) -> AsyncIterator[StreamChunk]:
        if self._delay_s:
            await asyncio.sleep(self._delay_s)
        if self._emit_terminal:
            yield StreamChunk(type="message_stop")
        # else: no yields → producer's finally puts None, stream finishes
        # without a terminal frame, so the wrapper must synthesize one.


def test_config_draft_emits_synthetic_message_stop_when_runner_silent(
    client: TestClient,
) -> None:
    """When the runner yields no chunks the SSE wrapper still closes
    with a ``message_stop`` so the front end can release the connection.
    Exercises the ``if not saw_terminal:`` branch."""
    from src.routes import pipeline as pipeline_route

    pipeline_route._runner = _SilentRunner()

    resp = client.post(
        "/work/pipeline/config-draft",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "pipeline_id": "p-silent",
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert resp.status_code == 200
    frames = _parse_sse(resp.text)
    assert frames[-1]["type"] == "message_stop"


def test_config_draft_emits_keepalive_on_idle(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Shrinking the heartbeat to ~10 ms forces the timeout branch:
    the wrapper yields a ``: keepalive`` SSE comment before any chunk
    arrives. Exercises the heartbeat lines (315-318)."""
    from src.routes import pipeline as pipeline_route

    monkeypatch.setattr(pipeline_route, "_HEARTBEAT_INTERVAL_S", 0.05)
    # Delay one full heartbeat before emitting the terminal so a
    # keepalive is forced into the wire.
    pipeline_route._runner = _SilentRunner(delay_s=0.15, emit_terminal=True)

    resp = client.post(
        "/work/pipeline/config-draft",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "pipeline_id": "p-keepalive",
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert resp.status_code == 200
    assert ": keepalive" in resp.text
    # And the stream still closes with a terminal frame.
    frames = _parse_sse(resp.text)
    assert frames[-1]["type"] == "message_stop"


def test_config_draft_abort_mid_stream(
    client: TestClient,
) -> None:
    """Pre-flagging the abort store before the request runs causes the
    wrapper to short-circuit on the first iteration with a
    ``message_stop``. Exercises lines 303-307."""
    from src.routes import pipeline as pipeline_route
    from src.services.chat_abort import get_store

    # The wrapper polls the abort flag at the top of each loop
    # iteration. By pre-flagging we guarantee the first iteration sees
    # it; the wrapper's ``store.clear`` at the start of the wrapper has
    # to be re-flagged AFTER it runs. We do that with a runner that
    # flips the flag on first yield.

    class _AbortOnFirstYieldRunner(ClaudeRunner):
        def __init__(self) -> None:
            super().__init__(anthropic_api_key="test")

        async def stream(
            self,
            messages: list[dict[str, Any]],
            *,
            tools: list[dict[str, Any]] | None = None,
            system_prompt: str | None = None,
            model: str | None = None,
            max_tokens: int | None = None,
        ) -> AsyncIterator[StreamChunk]:
            # Flip the abort flag, then keep streaming. The wrapper will
            # see the flag on the next iteration and break.
            get_store().request("image", "pipeline:p-abort")
            for _ in range(50):
                yield StreamChunk(type="text_delta", delta="more")
                await asyncio.sleep(0)

    pipeline_route._runner = _AbortOnFirstYieldRunner()

    resp = client.post(
        "/work/pipeline/config-draft",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "pipeline_id": "p-abort",
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert resp.status_code == 200
    frames = _parse_sse(resp.text)
    # Must end with message_stop — the abort path emits one explicitly.
    assert frames[-1]["type"] == "message_stop"
    # The wrapper clears the flag on the way out so subsequent sessions
    # for the same pipeline_id start fresh.
    assert get_store().is_aborted("image", "pipeline:p-abort") is False


def test_config_draft_forwards_caller_supplied_tools_and_system(
    client: TestClient,
) -> None:
    """When the caller passes ``tools`` / ``system_prompt``, the route
    forwards them verbatim rather than substituting defaults."""
    from src.routes import pipeline as pipeline_route

    captured: dict[str, Any] = {}

    class _CapturingRunner(ClaudeRunner):
        def __init__(self) -> None:
            super().__init__(anthropic_api_key="test")

        async def stream(
            self,
            messages: list[dict[str, Any]],
            *,
            tools: list[dict[str, Any]] | None = None,
            system_prompt: str | None = None,
            model: str | None = None,
            max_tokens: int | None = None,
        ) -> AsyncIterator[StreamChunk]:
            captured["tools"] = tools
            captured["system_prompt"] = system_prompt
            captured["messages"] = messages
            yield StreamChunk(type="message_stop")

    pipeline_route._runner = _CapturingRunner()

    resp = client.post(
        "/work/pipeline/config-draft",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "pipeline_id": "p-fwd",
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [
                {
                    "name": "custom_tool",
                    "description": "do a thing",
                    "input_schema": {"type": "object"},
                }
            ],
            "system_prompt": "custom system prompt",
        },
    )
    assert resp.status_code == 200
    assert captured["system_prompt"] == "custom system prompt"
    assert captured["tools"] == [
        {
            "name": "custom_tool",
            "description": "do a thing",
            "input_schema": {"type": "object"},
        }
    ]


# ===========================================================================
# Ideation — error / branch paths
# ===========================================================================


def test_ideation_image_brief_missing_emits_task_error(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When ``_fetch_image_brief`` returns None the background producer
    must emit a ``task_error`` event with a clear payload and return —
    no Kie call, no creative insert."""
    pipeline_sb.pipeline_row = {
        "id": "p-mb",
        "status": "ideation",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib-missing",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    # brief_row left as None → ``_fetch_image_brief`` returns None.
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie")
    from src.config import get_settings

    get_settings.cache_clear()

    resp = client.post(
        "/work/pipeline/ideation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-mb"},
    )
    assert resp.status_code == 200
    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    errors = [d for d in pe if d.get("kind") == "task_error"]
    assert errors, [d for n, d in pipeline_sb.inserts]
    assert "brief not found" in errors[0]["payload"]["error"]
    # No Kie / creative insert side effects.
    assert not any(n == "creatives" for n, _ in pipeline_sb.inserts)


def test_ideation_image_kie_runtime_error_emits_task_error(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When ``KieClient()`` raises RuntimeError (missing API key) the
    producer must emit a ``task_error`` event and exit cleanly."""
    pipeline_sb.pipeline_row = {
        "id": "p-nokey",
        "status": "ideation",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib-nokey",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    pipeline_sb.brief_row = {
        "id": "ib-nokey",
        "brief_id_human": "ACM-NOKEY",
        "status": "approved",
        "payload": {"market": "X", "offer_text": "Y"},
        "clients": {},
    }

    # Ensure KIE_AI_API_KEY is not set → KieClient.__init__ raises.
    monkeypatch.delenv("KIE_AI_API_KEY", raising=False)
    from src.config import get_settings

    get_settings.cache_clear()

    resp = client.post(
        "/work/pipeline/ideation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-nokey"},
    )
    assert resp.status_code == 200
    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    errors = [d for d in pe if d.get("kind") == "task_error"]
    assert errors
    assert "KIE_AI_API_KEY" in errors[0]["payload"]["error"]
    assert not any(n == "creatives" for n, _ in pipeline_sb.inserts)


def test_ideation_image_kie_call_failure_emits_task_error_per_concept(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A KieClient call that raises mid-render is caught per concept —
    each concept emits a ``task_error`` but the loop continues."""
    pipeline_sb.pipeline_row = {
        "id": "p-kie-fail",
        "status": "ideation",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib-fail",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    pipeline_sb.brief_row = {
        "id": "ib-fail",
        "brief_id_human": "ACM-F",
        "status": "approved",
        # No angles → falls back to the canned defaults.
        "payload": {"market": "Boston", "offer_text": "50% off"},
        "clients": {"slug": "acme", "name": "Acme", "service_type": "roofing"},
    }
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie")
    from src.config import get_settings

    get_settings.cache_clear()
    from src.routes import pipeline as pipeline_route
    from src.services.kie import KieError

    class _BoomKie:
        def __init__(self, *_a: Any, **_kw: Any) -> None:
            pass

        async def generate_image_full(
            self, prompt: str, ratio: str, *, resolution: str = "2K"
        ) -> Any:
            raise KieError("Kie.ai 429")

    monkeypatch.setattr(pipeline_route, "KieClient", _BoomKie)

    resp = client.post(
        "/work/pipeline/ideation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-kie-fail"},
    )
    assert resp.status_code == 200
    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    errors = [d for d in pe if d.get("kind") == "task_error"]
    # One task_error per concept.
    assert len(errors) == 4
    # Each error payload carries the concept + ratio + error text.
    for d in errors:
        assert d["payload"]["kind"] == "image"
        assert d["payload"]["ratio"] == "1x1"
        assert "Kie.ai 429" in d["payload"]["error"]
    # No creative inserts despite the producer entering the loop.
    assert not any(n == "creatives" for n, _ in pipeline_sb.inserts)


def test_ideation_video_track_produces_drafts(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Format=video + video_brief_id set → background producer writes
    three ``video_creatives`` rows (one per draft) + matching ``task_done``."""
    pipeline_sb.pipeline_row = {
        "id": "p-vid",
        "status": "ideation",
        "format_choice": "video",
        "client_id": "c-1",
        "image_brief_id": None,
        "video_brief_id": "vb-1",
        "config_draft": {},
        "picks": {},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    pipeline_sb.video_brief_row = {
        "id": "vb-1",
        "payload": {"angles": ["urgency", "trust"]},
        "hook_style": "question",
        "target_duration_s": 30,
        "clients": {"slug": "acme", "name": "Acme"},
    }

    resp = client.post(
        "/work/pipeline/ideation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-vid"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["image_track"] is False
    assert body["video_track"] is True

    vc_inserts = [d for n, d in pipeline_sb.inserts if n == "video_creatives"]
    assert len(vc_inserts) == 3, [(n, d) for n, d in pipeline_sb.inserts]
    # Each video creative has a script_path set.
    for row in vc_inserts:
        assert "script_path" in row
        assert row["status"] == "script_ready"
    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    done = [d for d in pe if d.get("kind") == "task_done"]
    # Only video task_done events (no image track on this run).
    video_done = [d for d in done if d["payload"].get("kind") == "video"]
    assert len(video_done) == 3


def test_ideation_video_brief_missing_emits_task_error(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
) -> None:
    """Same ``brief not found`` flow for the video track."""
    pipeline_sb.pipeline_row = {
        "id": "p-vmiss",
        "status": "ideation",
        "format_choice": "video",
        "client_id": "c-1",
        "image_brief_id": None,
        "video_brief_id": "vb-miss",
        "config_draft": {},
        "picks": {},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    # video_brief_row left as None.

    resp = client.post(
        "/work/pipeline/ideation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-vmiss"},
    )
    assert resp.status_code == 200
    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    errors = [d for d in pe if d.get("kind") == "task_error"]
    assert errors
    assert errors[0]["payload"]["kind"] == "video"


def test_ideation_video_record_failure_emits_task_error(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If ``record_video_stage`` raises, the producer must catch it,
    emit a ``task_error`` for that draft, and continue with peers."""
    pipeline_sb.pipeline_row = {
        "id": "p-vrec-fail",
        "status": "ideation",
        "format_choice": "video",
        "client_id": "c-1",
        "image_brief_id": None,
        "video_brief_id": "vb-fail",
        "config_draft": {},
        "picks": {},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    pipeline_sb.video_brief_row = {
        "id": "vb-fail",
        # No angles → defaults; non-dict payload exercises the safety net.
        "payload": "not a dict",
        "clients": {},
    }

    from src.routes import pipeline as pipeline_route

    async def _boom(*_a: Any, **_kw: Any) -> Any:
        raise RuntimeError("simulated video stage failure")

    monkeypatch.setattr(pipeline_route, "record_video_stage", _boom)

    resp = client.post(
        "/work/pipeline/ideation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-vrec-fail"},
    )
    assert resp.status_code == 200
    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    errors = [d for d in pe if d.get("kind") == "task_error"]
    # 3 drafts, all fail.
    video_errors = [d for d in errors if d["payload"].get("kind") == "video"]
    assert len(video_errors) == 3


def test_ideation_video_skips_when_no_video_brief_id(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
) -> None:
    """Format=video but ``video_brief_id`` is missing → no producer
    queued, response carries ``video_track=False``."""
    pipeline_sb.pipeline_row = {
        "id": "p-novb",
        "status": "ideation",
        "format_choice": "video",
        "client_id": "c-1",
        "image_brief_id": None,
        "video_brief_id": None,
        "config_draft": {},
        "picks": {},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    resp = client.post(
        "/work/pipeline/ideation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-novb"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["video_track"] is False
    assert not any(
        n in ("video_creatives", "creatives") for n, _ in pipeline_sb.inserts
    )


# ===========================================================================
# Internal helpers (_fallback_*) — direct unit coverage
# ===========================================================================


def test_fallback_image_concepts_non_dict_payload_uses_defaults() -> None:
    """Non-dict ``payload`` is coerced to ``{}`` — covers line 590."""
    from src.routes.pipeline import _fallback_image_concepts

    concepts = _fallback_image_concepts({"payload": "string-instead"}, count=4)
    assert len(concepts) == 4
    # Defaults — "before-and-after" leads the angles list.
    assert concepts[0]["concept"].startswith("ideation-1-before-and-after")


def test_fallback_image_concepts_empty_angles_uses_defaults() -> None:
    """Missing ``angles`` list — covers line 596 (defaults assignment)."""
    from src.routes.pipeline import _fallback_image_concepts

    concepts = _fallback_image_concepts(
        {"payload": {"market": "Boston", "offer_text": "free"}}, count=4
    )
    assert len(concepts) == 4
    # Should use the canonical four-angle default set. Concept format is
    # ``ideation-{i}-{angle}`` and angles can contain dashes themselves;
    # strip the ``ideation-{i}-`` prefix to recover the angle.
    angles = [c["concept"].split("-", 2)[2] for c in concepts]
    assert angles == ["before-and-after", "trust", "savings", "urgency"]


def test_fallback_video_drafts_uses_default_angles_and_hook() -> None:
    """No angles list + missing hook_style/duration → all defaults."""
    from src.routes.pipeline import _fallback_video_drafts

    drafts = _fallback_video_drafts({}, count=3)
    assert len(drafts) == 3
    # Default angle ordering: before-and-after, trust, urgency.
    # Concept format: ``video-ideation-{i}-{angle}``; strip the prefix
    # so an angle that contains dashes ("before-and-after") survives.
    expected = ["before-and-after", "trust", "urgency"]
    actual = [d["concept"].split("-", 3)[3] for d in drafts]
    assert actual == expected
    # Defaults: hook_style=question, duration=30.
    assert drafts[0]["script_outline"]["total_duration_s"] == 30
    assert "question" in drafts[0]["script_outline"]["segments"][0]["voiceover_text"]


def test_fallback_video_drafts_with_payload_angles() -> None:
    """A brief with explicit angles produces matching concept names."""
    from src.routes.pipeline import _fallback_video_drafts

    drafts = _fallback_video_drafts(
        {
            "payload": {"angles": ["aurora", "borealis"]},
            "hook_style": "statement",
            "target_duration_s": 15,
        },
        count=3,
    )
    # Padded angles cycle: aurora, borealis, aurora.
    assert drafts[0]["concept"] == "video-ideation-1-aurora"
    assert drafts[1]["concept"] == "video-ideation-2-borealis"
    assert drafts[2]["concept"] == "video-ideation-3-aurora"
    assert drafts[0]["script_outline"]["total_duration_s"] == 15


def test_fallback_video_drafts_non_dict_payload_uses_defaults() -> None:
    """Defensive: a non-dict payload still produces drafts using the
    fallback defaults instead of crashing."""
    from src.routes.pipeline import _fallback_video_drafts

    drafts = _fallback_video_drafts({"payload": ["not", "a", "dict"]}, count=3)
    assert len(drafts) == 3


# ===========================================================================
# Generation — image error / branch paths
# ===========================================================================


def test_generation_image_kie_runtime_error_emits_task_error(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline_sb.pipeline_row = {
        "id": "p-gnokey",
        "status": "generation",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib-x",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {"image": ["cr-parent"]},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    pipeline_sb.creative_row = {
        "id": "cr-parent",
        "brief_id": "ib-x",
        "concept": "alpha",
        "offer_text": "promo",
        "prompt_used": {"prompt": "sunny roof"},
        "version": "v0.ideation",
        "file_path_supabase": "p.png",
    }
    pipeline_sb.events_data = []
    # No KIE_AI_API_KEY → KieClient() raises.
    monkeypatch.delenv("KIE_AI_API_KEY", raising=False)
    from src.config import get_settings

    get_settings.cache_clear()

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-gnokey"},
    )
    assert resp.status_code == 200
    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    errors = [d for d in pe if d.get("kind") == "task_error"]
    assert errors
    assert "KIE_AI_API_KEY" in errors[0]["payload"]["error"]


def test_generation_image_parent_creative_missing_continues_to_next(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A single missing parent creative emits a ``task_error`` but the
    loop continues to peers — exercises lines 1141-1151."""
    pipeline_sb.pipeline_row = {
        "id": "p-mp",
        "status": "generation",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {"image": ["cr-missing"]},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    # No creative_row set → ``_fetch_creative`` returns None.
    pipeline_sb.events_data = []
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie")
    from src.config import get_settings

    get_settings.cache_clear()

    from src.routes import pipeline as pipeline_route

    monkeypatch.setattr(pipeline_route, "KieClient", _StubKieClient)

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-mp"},
    )
    assert resp.status_code == 200
    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    errors = [d for d in pe if d.get("kind") == "task_error"]
    assert errors
    assert errors[0]["payload"]["error"] == "parent creative not found"
    # And: no creatives were inserted, since the only pick was missing.
    assert not any(n == "creatives" for n, _ in pipeline_sb.inserts)


def test_generation_image_kie_call_failure_emits_task_error(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A KieClient call that raises during generation must produce a
    ``task_error`` per ratio, leaving no creative row behind."""
    pipeline_sb.pipeline_row = {
        "id": "p-gboom",
        "status": "generation",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {"image": ["cr-p"]},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    pipeline_sb.creative_row = {
        "id": "cr-p",
        "brief_id": "ib",
        "concept": "alpha",
        # Non-dict prompt_used to exercise the fallback prompt.
        "prompt_used": "stringified",
        "offer_text": None,
        "version": "v0.ideation",
        "file_path_supabase": "p.png",
    }
    pipeline_sb.events_data = []
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie")
    from src.config import get_settings

    get_settings.cache_clear()

    from src.routes import pipeline as pipeline_route
    from src.services.kie import KieError

    class _BoomKie:
        def __init__(self, *_a: Any, **_kw: Any) -> None:
            pass

        async def generate_image_full(
            self, prompt: str, ratio: str, *, resolution: str = "2K"
        ) -> Any:
            raise KieError(f"kie 5xx for {ratio}")

    monkeypatch.setattr(pipeline_route, "KieClient", _BoomKie)

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-gboom"},
    )
    assert resp.status_code == 200
    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    errors = [d for d in pe if d.get("kind") == "task_error"]
    # One error per ratio (1x1 + 9x16).
    image_errors = [d for d in errors if d["payload"].get("kind") == "image"]
    assert len(image_errors) == 2
    ratios = sorted(d["payload"]["ratio"] for d in image_errors)
    assert ratios == ["1x1", "9x16"]


# ===========================================================================
# Generation — video pick / substages
# ===========================================================================


def _video_pick_pipeline_row() -> dict[str, Any]:
    return {
        "id": "p-vp",
        "status": "generation",
        "format_choice": "video",
        "client_id": "c-1",
        "image_brief_id": None,
        "video_brief_id": "vb-1",
        "config_draft": {},
        "picks": {"video": ["vc-p"]},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }


def test_generation_video_pick_missing_creative_emits_task_error(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
) -> None:
    """A video pick whose row is missing emits a ``task_error`` before
    the substage loop starts."""
    pipeline_sb.pipeline_row = _video_pick_pipeline_row()
    pipeline_sb.video_creative_row = None
    pipeline_sb.events_data = []

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-vp"},
    )
    assert resp.status_code == 200
    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    errors = [d for d in pe if d.get("kind") == "task_error"]
    assert errors
    assert errors[0]["payload"]["error"] == "video creative not found"


def test_generation_video_pick_runs_all_substages(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Happy-path video pick: every substage emits a ``task_done`` and
    paid substages emit ``cost_recorded``."""
    pipeline_sb.pipeline_row = _video_pick_pipeline_row()
    pipeline_sb.video_creative_row = {
        "id": "vc-p",
        "brief_id": "vb-1",
        # ``script_path`` set → script substage short-circuits without
        # calling the agent.
        "script_path": "vb-1/script.json",
        "video_briefs": {"id": "vb-1"},
    }
    pipeline_sb.events_data = []

    # Stub every video_route function used by ``_run_video_substage``.
    from src.routes import video as video_route_mod

    async def _ok_script(req: Any) -> dict[str, Any]:
        return {"script_path": "p", "creative_id": "vc-p"}

    async def _ok_voiceover(req: Any) -> dict[str, Any]:
        return {"voiceover_path": "vo.mp3"}

    async def _ok_broll_search(req: Any) -> dict[str, Any]:
        return {"candidates": [{"id": "x"}]}

    async def _ok_broll_select(req: Any) -> dict[str, Any]:
        return {"resolved": [{"id": "x"}]}

    async def _ok_compose(req: Any) -> dict[str, Any]:
        return {"composed_path": "c.mp4"}

    async def _ok_caption(req: Any) -> dict[str, Any]:
        return {"captioned_path": "cap.mp4"}

    monkeypatch.setattr(video_route_mod, "generate_script", _ok_script)
    monkeypatch.setattr(video_route_mod, "synthesize_voiceover", _ok_voiceover)
    monkeypatch.setattr(video_route_mod, "search_broll", _ok_broll_search)
    monkeypatch.setattr(video_route_mod, "select_broll", _ok_broll_select)
    monkeypatch.setattr(video_route_mod, "compose_video", _ok_compose)
    monkeypatch.setattr(video_route_mod, "caption_video", _ok_caption)

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-vp"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["video_picks"] == 1

    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    done = [d for d in pe if d.get("kind") == "task_done"]
    # 6 substages → 6 task_done events.
    video_done = [d for d in done if d["payload"].get("kind") == "video"]
    assert len(video_done) == 6
    # Cost recorded for 4 paid substages (voiceover, broll_search,
    # compose, caption — script and broll_pick are free).
    cost = [d for d in pe if d.get("kind") == "cost_recorded"]
    assert len(cost) == 4
    apis = sorted(d["payload"]["api"] for d in cost)
    assert apis == ["ffmpeg-local", "kie-tts", "kie-video", "whisper-local"]


def test_generation_video_substage_http_exception_short_circuits(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If a substage raises ``HTTPException`` the producer emits a
    ``task_error`` with the status code + detail and short-circuits the
    rest of the chain for that concept."""
    pipeline_sb.pipeline_row = _video_pick_pipeline_row()
    pipeline_sb.video_creative_row = {
        "id": "vc-p",
        "brief_id": "vb-1",
        # No script_path → script substage will call generate_script.
        "video_briefs": {"id": "vb-1"},
    }
    pipeline_sb.events_data = []

    from src.routes import video as video_route_mod

    async def _http_fail(req: Any) -> dict[str, Any]:
        raise HTTPException(status_code=502, detail="upstream blew up")

    monkeypatch.setattr(video_route_mod, "generate_script", _http_fail)

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-vp"},
    )
    assert resp.status_code == 200
    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    errors = [d for d in pe if d.get("kind") == "task_error"]
    assert errors
    err = errors[0]
    assert err["payload"]["substage"] == "script"
    assert err["payload"]["status_code"] == 502
    assert "upstream blew up" in err["payload"]["error"]

    # Short-circuit: only the failing substage emits running/error;
    # the four later substages should not have task_queued events.
    queued = [
        d
        for d in pe
        if d.get("kind") == "task_queued" and d["payload"].get("kind") == "video"
    ]
    # Only one substage attempted.
    assert len(queued) == 1
    assert queued[0]["payload"]["substage"] == "script"


def test_generation_video_substage_unexpected_exception_short_circuits(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Non-HTTP exceptions inside a substage also short-circuit, with a
    ``task_error`` carrying the str(exception) — no status_code."""
    pipeline_sb.pipeline_row = _video_pick_pipeline_row()
    pipeline_sb.video_creative_row = {
        "id": "vc-p",
        "brief_id": "vb-1",
        "video_briefs": {"id": "vb-1"},
    }
    pipeline_sb.events_data = []

    from src.routes import video as video_route_mod

    async def _explodes(req: Any) -> dict[str, Any]:
        raise RuntimeError("disk full")

    monkeypatch.setattr(video_route_mod, "generate_script", _explodes)

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-vp"},
    )
    assert resp.status_code == 200
    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    errors = [d for d in pe if d.get("kind") == "task_error"]
    assert errors
    err = errors[0]
    assert err["payload"]["substage"] == "script"
    assert "disk full" in err["payload"]["error"]
    # No status_code field for non-HTTPException paths.
    assert "status_code" not in err["payload"]


# ===========================================================================
# _run_video_substage direct unit coverage
# ===========================================================================


def test_run_video_substage_script_uses_existing_path() -> None:
    """If the creative already has a ``script_path`` the helper returns
    it verbatim and does NOT call ``generate_script``."""
    from src.routes import pipeline as pipeline_route, video as video_route_mod

    async def _wrap() -> dict[str, Any]:
        return await pipeline_route._run_video_substage(
            video_route_mod,
            substage="script",
            creative={
                "id": "c-1",
                "brief_id": "b-1",
                "script_path": "existing/script.json",
            },
        )

    result = asyncio.run(_wrap())
    assert result == {"script_path": "existing/script.json"}


def test_run_video_substage_each_branch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Smoke-test every substage dispatch by stubbing each route fn."""
    from src.routes import pipeline as pipeline_route, video as video_route_mod

    async def _script(req: Any) -> dict[str, Any]:
        return {"script_path": "s.json", "creative_id": "vc-p"}

    async def _voiceover(req: Any) -> dict[str, Any]:
        return {"voiceover_path": "v.mp3"}

    async def _bsearch(req: Any) -> dict[str, Any]:
        return {"candidates": ["a"]}

    async def _bselect(req: Any) -> dict[str, Any]:
        return {"resolved": ["a"]}

    async def _compose(req: Any) -> dict[str, Any]:
        return {"composed_path": "c.mp4"}

    async def _caption(req: Any) -> dict[str, Any]:
        return {"captioned_path": "x.mp4"}

    monkeypatch.setattr(video_route_mod, "generate_script", _script)
    monkeypatch.setattr(video_route_mod, "synthesize_voiceover", _voiceover)
    monkeypatch.setattr(video_route_mod, "search_broll", _bsearch)
    monkeypatch.setattr(video_route_mod, "select_broll", _bselect)
    monkeypatch.setattr(video_route_mod, "compose_video", _compose)
    monkeypatch.setattr(video_route_mod, "caption_video", _caption)

    base = {"id": "vc", "brief_id": "vb", "video_briefs": {}}

    async def _wrap(sub: str) -> dict[str, Any]:
        return await pipeline_route._run_video_substage(
            video_route_mod, substage=sub, creative=base
        )

    assert asyncio.run(_wrap("script")) == {
        "script_path": "s.json",
        "creative_id": "vc-p",
    }
    assert asyncio.run(_wrap("voiceover")) == {"voiceover_path": "v.mp3"}
    assert asyncio.run(_wrap("broll_search")) == {"candidates": ["a"]}
    assert asyncio.run(_wrap("broll_pick")) == {"selected": ["a"]}
    assert asyncio.run(_wrap("compose")) == {"composed_path": "c.mp4"}
    assert asyncio.run(_wrap("caption")) == {"captioned_path": "x.mp4"}


def test_run_video_substage_unknown_raises() -> None:
    """Unknown substage names raise ValueError — covers line 1495."""
    from src.routes import pipeline as pipeline_route, video as video_route_mod

    async def _wrap() -> dict[str, Any]:
        return await pipeline_route._run_video_substage(
            video_route_mod,
            substage="bogus",
            creative={"id": "vc", "brief_id": "vb"},
        )

    with pytest.raises(ValueError, match="unknown video substage"):
        asyncio.run(_wrap())


# ===========================================================================
# _video_substage_cost direct unit coverage
# ===========================================================================


def test_video_substage_cost_table() -> None:
    from src.routes.pipeline import _video_substage_cost

    assert _video_substage_cost("voiceover") == {
        "api": "kie-tts",
        "units": 1,
        "subtotal": 0.02,
    }
    assert _video_substage_cost("broll_search") == {
        "api": "kie-video",
        "units": 1,
        "subtotal": 1.20,
    }
    assert _video_substage_cost("compose") == {
        "api": "ffmpeg-local",
        "units": 1,
        "subtotal": 0.00,
    }
    assert _video_substage_cost("caption") == {
        "api": "whisper-local",
        "units": 1,
        "subtotal": 0.00,
    }
    # Script and broll_pick are free — None means "don't emit cost".
    assert _video_substage_cost("script") is None
    assert _video_substage_cost("broll_pick") is None
    assert _video_substage_cost("unknown") is None


# ===========================================================================
# _fetch_video_brief direct unit coverage
# ===========================================================================


def test_fetch_video_brief_returns_dict_when_present(
    pipeline_sb: _PipelineSupabase,
) -> None:
    from src.routes.pipeline import _fetch_video_brief

    pipeline_sb.video_brief_row = {"id": "vb-1", "payload": {}}
    row = _fetch_video_brief("vb-1")
    assert row == {"id": "vb-1", "payload": {}}


def test_fetch_video_brief_returns_none_when_missing(
    pipeline_sb: _PipelineSupabase,
) -> None:
    from src.routes.pipeline import _fetch_video_brief

    pipeline_sb.video_brief_row = None
    assert _fetch_video_brief("vb-missing") is None


def test_fetch_image_brief_returns_none_when_missing(
    pipeline_sb: _PipelineSupabase,
) -> None:
    from src.routes.pipeline import _fetch_image_brief

    pipeline_sb.brief_row = None
    assert _fetch_image_brief("ib-x") is None


def test_fetch_creative_returns_none_when_missing(
    pipeline_sb: _PipelineSupabase,
) -> None:
    from src.routes.pipeline import _fetch_creative

    pipeline_sb.creative_row = None
    assert _fetch_creative("cr-x") is None


def test_fetch_video_creative_returns_none_when_missing(
    pipeline_sb: _PipelineSupabase,
) -> None:
    from src.routes.pipeline import _fetch_video_creative

    pipeline_sb.video_creative_row = None
    assert _fetch_video_creative("vc-x") is None


def test_fetch_video_creative_returns_dict_when_present(
    pipeline_sb: _PipelineSupabase,
) -> None:
    from src.routes.pipeline import _fetch_video_creative

    pipeline_sb.video_creative_row = {"id": "vc-1", "video_briefs": {"id": "vb-1"}}
    row = _fetch_video_creative("vc-1")
    assert row == {"id": "vc-1", "video_briefs": {"id": "vb-1"}}


# ===========================================================================
# Pipeline cancellation — worker-side abort plumbing (Wave 17 D)
# ===========================================================================
#
# The dashboard cancel button POSTs ``/api/pipelines/[id]/cancel`` and
# flips ``pipelines.status='cancelled'`` in Supabase. The worker polls
# this status between substages via ``pipeline_is_cancelled`` and bails
# cleanly when the operator cancelled mid-flight — no further Kie calls,
# no more ``task_done`` events, one ``task_error`` with
# ``reason='cancelled_by_operator'`` so the timeline shows where the
# worker stopped.


def test_generation_image_pre_cancelled_emits_single_error(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pipeline cancelled BEFORE the background producer starts.

    The top-level ``_abort_if_cancelled`` fires immediately, emits one
    ``task_error(reason='cancelled_by_operator')`` event, and returns
    without constructing a Kie client or touching any creative. No
    ``creatives`` inserts, no per-ratio events.
    """
    pipeline_sb.pipeline_row = {
        "id": "p-cancel-pre",
        # Both the route's ``fetch_pipeline`` and the worker's
        # ``pipeline_is_cancelled`` poll the same row — set it cancelled
        # so the producer sees the cancel on the first poll.
        "status": "cancelled",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib-cancel",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {"image": ["cr-parent"]},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    pipeline_sb.events_data = []
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie")
    from src.config import get_settings

    get_settings.cache_clear()

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-cancel-pre"},
    )
    assert resp.status_code == 200, resp.text

    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    errors = [d for d in pe if d.get("kind") == "task_error"]
    # Exactly one task_error, tagged with the cancellation reason.
    assert len(errors) == 1, errors
    assert errors[0]["payload"]["reason"] == "cancelled_by_operator"
    assert errors[0]["payload"]["kind"] == "image"
    # No work was done — no creatives inserted, no task_queued events.
    assert not any(n == "creatives" for n, _ in pipeline_sb.inserts)
    queued = [d for d in pe if d.get("kind") == "task_queued"]
    assert queued == []


def test_generation_image_cancelled_mid_flight_skips_remaining_ratios(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pipeline cancelled AFTER the first ratio render completes.

    The 1x1 render finishes and emits ``task_done`` + ``cost_recorded``;
    then the operator cancels; on the next ``_abort_if_cancelled`` poll
    the worker sees the flip and bails out — the 9x16 render never runs.
    """
    pipeline_sb.pipeline_row = {
        "id": "p-cancel-mid",
        "status": "generation",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib-cm",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {"image": ["cr-parent"]},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    pipeline_sb.creative_row = {
        "id": "cr-parent",
        "brief_id": "ib-cm",
        "concept": "midcancel",
        "offer_text": "$99",
        "prompt_used": {"prompt": "a roof"},
        "version": "v0.ideation",
        "file_path_supabase": "ib-cm/p.png",
    }
    pipeline_sb.events_data = []
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie")
    from src.config import get_settings

    get_settings.cache_clear()

    from src.routes import pipeline as pipeline_route

    monkeypatch.setattr(pipeline_route, "KieClient", _StubKieClient)

    # Drive cancellation between ratio 1 and ratio 2 via a counter.
    # The top-level check (before KieClient construction) reads 0 → not
    # cancelled. The first ratio's check reads 1 → not cancelled. The
    # second ratio's check reads 2 → cancelled.
    call_count = {"n": 0}

    def _stateful_is_cancelled(_pipeline_id: str) -> bool:
        call_count["n"] += 1
        # First poll (producer top-level) + second poll (1x1 ratio) =
        # not cancelled. Third poll (9x16 ratio) = cancelled.
        return call_count["n"] >= 3

    monkeypatch.setattr(
        pipeline_route, "pipeline_is_cancelled", _stateful_is_cancelled
    )

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-cancel-mid"},
    )
    assert resp.status_code == 200, resp.text

    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    done = [d for d in pe if d.get("kind") == "task_done"]
    # Only the 1x1 ratio finished.
    image_done = [d for d in done if d["payload"].get("kind") == "image"]
    assert len(image_done) == 1
    assert image_done[0]["payload"]["ratio"] == "1x1"

    # Exactly one cancel error, tagged for the 9x16 substage that never ran.
    errors = [d for d in pe if d.get("kind") == "task_error"]
    cancel_errors = [
        d for d in errors if d["payload"].get("reason") == "cancelled_by_operator"
    ]
    assert len(cancel_errors) == 1, cancel_errors
    assert cancel_errors[0]["payload"]["ratio"] == "9x16"
    assert cancel_errors[0]["payload"]["creative_id"] == "cr-parent"

    # No second-ratio creative insert.
    creative_inserts = [
        d for n, d in pipeline_sb.inserts if n == "creatives"
    ]
    assert len(creative_inserts) == 1
    assert creative_inserts[0]["ratio"] == "1x1"


def test_generation_video_pre_cancelled_emits_single_error(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
) -> None:
    """Cancelled video pipeline before the video producer starts.

    Top-level ``_abort_if_cancelled`` fires, emits a single
    ``task_error(reason='cancelled_by_operator')`` and returns without
    fetching the video creative or entering the substage loop.
    """
    pipeline_sb.pipeline_row = {
        "id": "p-vcancel-pre",
        "status": "cancelled",
        "format_choice": "video",
        "client_id": "c-1",
        "image_brief_id": None,
        "video_brief_id": "vb-x",
        "config_draft": {},
        "picks": {"video": ["vc-p"]},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    pipeline_sb.events_data = []

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-vcancel-pre"},
    )
    assert resp.status_code == 200, resp.text

    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    errors = [d for d in pe if d.get("kind") == "task_error"]
    # Exactly one task_error, tagged for the video kind.
    assert len(errors) == 1, errors
    assert errors[0]["payload"]["reason"] == "cancelled_by_operator"
    assert errors[0]["payload"]["kind"] == "video"
    assert errors[0]["payload"]["creative_id"] == "vc-p"
    # No substage task_queued events.
    queued = [d for d in pe if d.get("kind") == "task_queued"]
    assert queued == []


def test_generation_video_cancelled_mid_substage_chain(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cancellation mid-substage-chain skips the rest cleanly.

    Specifically: the script substage completes (status=generation on
    poll 1+2). Then the operator cancels. On the second-substage check
    the worker sees ``cancelled`` and aborts — no voiceover, no broll,
    no compose, no caption. Exactly one cancel task_error event.
    """
    pipeline_sb.pipeline_row = _video_pick_pipeline_row()
    pipeline_sb.video_creative_row = {
        "id": "vc-p",
        "brief_id": "vb-1",
        # Skip the script-substage agent call.
        "script_path": "vb-1/script.json",
        "video_briefs": {"id": "vb-1"},
    }
    pipeline_sb.events_data = []

    from src.routes import pipeline as pipeline_route

    # First poll (top-level) + second poll (script substage) = not
    # cancelled. Third poll (voiceover substage) = cancelled.
    call_count = {"n": 0}

    def _stateful_is_cancelled(_pipeline_id: str) -> bool:
        call_count["n"] += 1
        return call_count["n"] >= 3

    monkeypatch.setattr(
        pipeline_route, "pipeline_is_cancelled", _stateful_is_cancelled
    )

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-vp"},
    )
    assert resp.status_code == 200, resp.text

    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    done = [d for d in pe if d.get("kind") == "task_done"]
    video_done = [d for d in done if d["payload"].get("kind") == "video"]
    # Only the script substage finished.
    assert len(video_done) == 1
    assert video_done[0]["payload"]["substage"] == "script"

    # Exactly one cancel error, tagged for the voiceover substage.
    errors = [d for d in pe if d.get("kind") == "task_error"]
    cancel_errors = [
        d for d in errors if d["payload"].get("reason") == "cancelled_by_operator"
    ]
    assert len(cancel_errors) == 1, cancel_errors
    assert cancel_errors[0]["payload"]["substage"] == "voiceover"
    assert cancel_errors[0]["payload"]["creative_id"] == "vc-p"

    # No task_queued events for substages past voiceover.
    queued_substages = [
        d["payload"].get("substage")
        for d in pe
        if d.get("kind") == "task_queued" and d["payload"].get("kind") == "video"
    ]
    # Only the script substage ever queued — the cancel fires BEFORE the
    # voiceover task_queued event is emitted.
    assert queued_substages == ["script"]


def test_generation_image_no_cancel_runs_normally_regression(
    client: TestClient,
    pipeline_sb: _PipelineSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: when ``pipeline_is_cancelled`` always returns False
    (i.e., the pipeline stays in 'generation') BOTH ratios render fully
    and zero cancel events land on the timeline. Guards against the
    abort plumbing accidentally short-circuiting healthy runs."""
    pipeline_sb.pipeline_row = {
        "id": "p-no-cancel",
        "status": "generation",
        "format_choice": "image",
        "client_id": "c-1",
        "image_brief_id": "ib-nc",
        "video_brief_id": None,
        "config_draft": {},
        "picks": {"image": ["cr-parent"]},
        "advanced_at": {},
        "created_at": "2025-01-01T00:00:00Z",
    }
    pipeline_sb.creative_row = {
        "id": "cr-parent",
        "brief_id": "ib-nc",
        "concept": "noop",
        "offer_text": None,
        "prompt_used": {"prompt": "a roof"},
        "version": "v0.ideation",
        "file_path_supabase": "ib-nc/p.png",
    }
    pipeline_sb.events_data = []
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie")
    from src.config import get_settings

    get_settings.cache_clear()

    from src.routes import pipeline as pipeline_route

    monkeypatch.setattr(pipeline_route, "KieClient", _StubKieClient)

    resp = client.post(
        "/work/pipeline/generation",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"pipeline_id": "p-no-cancel"},
    )
    assert resp.status_code == 200, resp.text

    pe = [d for n, d in pipeline_sb.inserts if n == "pipeline_events"]
    done = [d for d in pe if d.get("kind") == "task_done"]
    image_done = [d for d in done if d["payload"].get("kind") == "image"]
    assert len(image_done) == 2
    # No cancel events on the happy path.
    cancel_errors = [
        d
        for d in pe
        if d.get("kind") == "task_error"
        and d["payload"].get("reason") == "cancelled_by_operator"
    ]
    assert cancel_errors == []
