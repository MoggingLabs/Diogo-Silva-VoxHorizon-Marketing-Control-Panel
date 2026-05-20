"""Tests for /work/creative/generate and /work/creative/composite.

The SSE chat-with-Ekko coverage that originally lived here was dropped when
the worker's ``chat_stream`` route was removed in Wave 19 (HI-8) — the
dashboard chat path now runs through the Hermes bridge (``/work/hermes/chat``),
not this worker. Only the deterministic image-generation surface
(``/work/creative/*``) is exercised here.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient


SHARED_SECRET = "test-secret-for-creative-tests"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")
    monkeypatch.setenv("KIE_AI_API_KEY", "test-kie-key")

    from src.config import get_settings
    from src.services.queue import reset_queue
    from src.routes import creative as creative_route

    get_settings.cache_clear()
    reset_queue()
    creative_route._reset_runner()
    yield
    get_settings.cache_clear()
    reset_queue()
    creative_route._reset_runner()


@pytest.fixture
def client() -> TestClient:
    from src.main import create_app

    return TestClient(create_app())


# ---------------------------------------------------------------------------
# Supabase mock plumbing
# ---------------------------------------------------------------------------


class _FakeSupabase:
    """Minimal stand-in for the supabase-py client.

    Captures every insert/update so tests can assert on the sequence of
    writes. Storage uploads/downloads are recorded in ``storage_writes``
    / ``storage_reads``.
    """

    def __init__(self) -> None:
        self.brief_row: dict | None = None
        self.creative_row: dict | None = None
        self.inserts: list[tuple[str, dict]] = []
        self.updates: list[tuple[str, dict]] = []
        self.storage_writes: list[tuple[str, bytes]] = []
        self.storage_reads: dict[str, bytes] = {}

    # The bits the route layer touches:

    def table(self, name: str) -> "_FakeTable":
        return _FakeTable(self, name)

    # Storage surface
    @property
    def storage(self) -> "_FakeStorage":
        return _FakeStorage(self)


class _FakeTable:
    def __init__(self, sb: _FakeSupabase, name: str) -> None:
        self.sb = sb
        self.name = name
        self._filters: list[tuple[str, str]] = []
        self._select: str | None = None
        self._insert_data: dict | None = None
        self._update_data: dict | None = None

    def select(self, columns: str) -> "_FakeTable":
        self._select = columns
        return self

    def eq(self, col: str, val: str) -> "_FakeTable":
        self._filters.append((col, val))
        return self

    def maybe_single(self) -> "_FakeTable":
        return self

    def insert(self, data: dict) -> "_FakeTable":
        self._insert_data = data
        return self

    def update(self, data: dict) -> "_FakeTable":
        self._update_data = data
        return self

    def execute(self) -> SimpleNamespace:
        if self._insert_data is not None:
            self.sb.inserts.append((self.name, self._insert_data))
            # Synthesise an id for the row.
            row = {**self._insert_data, "id": f"{self.name}-id-{len(self.sb.inserts)}"}
            return SimpleNamespace(data=[row])
        if self._update_data is not None:
            self.sb.updates.append((self.name, self._update_data))
            return SimpleNamespace(data=[{**self._update_data, "id": "u-id"}])
        # SELECT
        if self.name == "briefs":
            return SimpleNamespace(data=self.sb.brief_row)
        if self.name == "creatives":
            return SimpleNamespace(data=self.sb.creative_row)
        return SimpleNamespace(data=None)


class _FakeStorage:
    def __init__(self, sb: _FakeSupabase) -> None:
        self.sb = sb

    def from_(self, bucket: str) -> "_FakeBucket":
        return _FakeBucket(self.sb, bucket)


class _FakeBucket:
    def __init__(self, sb: _FakeSupabase, bucket: str) -> None:
        self.sb = sb
        self.bucket = bucket

    def upload(self, *, path: str, file: bytes, file_options: dict) -> None:
        self.sb.storage_writes.append((path, bytes(file)))

    def download(self, path: str) -> bytes:
        return self.sb.storage_reads.get(path, b"")


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def test_generate_requires_auth(client: TestClient) -> None:
    resp = client.post("/work/creative/generate", json={"brief_id": "b"})
    assert resp.status_code == 401


def test_composite_requires_auth(client: TestClient) -> None:
    resp = client.post(
        "/work/creative/composite",
        json={"creative_id": "c", "headline": "h"},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# /work/creative/generate
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_sb(monkeypatch: pytest.MonkeyPatch) -> _FakeSupabase:
    """Install a stub supabase client; return it for assertions."""
    sb = _FakeSupabase()
    sb.brief_row = {
        "id": "brief-1",
        "brief_id_human": "ABC-001",
        "status": "approved",
        "payload": {"market": "Austin, TX", "offer_text": "$99 inspection"},
        "clients": {"slug": "acme", "name": "Acme Roofing", "service_type": "roofing"},
    }

    from src.routes import creative as creative_route
    from src.services import atomic_inserts
    from src.services import storage

    monkeypatch.setattr(creative_route, "get_supabase_admin", lambda: sb)
    monkeypatch.setattr(atomic_inserts, "get_supabase_admin", lambda: sb)
    monkeypatch.setattr(storage, "get_supabase_admin", lambda: sb)
    return sb


class _StubKieClient:
    """Drop-in for KieClient that returns canned bytes + metadata."""

    def __init__(self, *a, **kw) -> None:
        pass

    async def generate_image_full(
        self, prompt: str, ratio: str, *, resolution: str = "2K"
    ):
        from src.services.kie import KieGenerationResult

        return KieGenerationResult(
            image_bytes=b"PNGBYTES",
            task_id=f"task-{ratio}",
            source_url=f"https://kie/{ratio}.png",
            aspect_ratio=ratio,
            resolution=resolution,
        )

    async def generate_image(self, prompt: str, ratio: str, *, resolution: str = "2K"):
        result = await self.generate_image_full(prompt, ratio, resolution=resolution)
        return result.image_bytes


def test_generate_with_explicit_prompts_creates_creatives(
    client: TestClient,
    fake_sb: _FakeSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.routes import creative as creative_route

    monkeypatch.setattr(creative_route, "KieClient", _StubKieClient)

    resp = client.post(
        "/work/creative/generate",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "brief_id": "brief-1",
            "prompts": [
                {
                    "concept": "Sunny",
                    "prompts": [
                        {"ratio": "1x1", "text": "a sunny roof"},
                        {"ratio": "9x16", "text": "a sunny roof, vertical"},
                    ],
                }
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["creatives_created"] == 2
    assert body["errors"] == []
    assert {c["ratio"] for c in body["creatives"]} == {"1x1", "9x16"}
    # Two storage uploads happened.
    assert len(fake_sb.storage_writes) == 2
    # Each creative had a corresponding insert in `creatives`.
    insert_tables = [name for name, _ in fake_sb.inserts]
    assert insert_tables.count("creatives") == 2
    assert insert_tables.count("creative_iterations") == 2


def test_generate_missing_brief_returns_404(
    client: TestClient,
    fake_sb: _FakeSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_sb.brief_row = None
    from src.routes import creative as creative_route

    monkeypatch.setattr(creative_route, "KieClient", _StubKieClient)

    resp = client.post(
        "/work/creative/generate",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "brief_id": "nope",
            "prompts": [
                {
                    "concept": "X",
                    "prompts": [{"ratio": "1x1", "text": "x"}],
                }
            ],
        },
    )
    assert resp.status_code == 404


def test_generate_returns_503_when_no_kie_key(
    client: TestClient,
    fake_sb: _FakeSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("KIE_AI_API_KEY", raising=False)
    from src.config import get_settings

    get_settings.cache_clear()

    resp = client.post(
        "/work/creative/generate",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "brief_id": "brief-1",
            "prompts": [
                {
                    "concept": "X",
                    "prompts": [{"ratio": "1x1", "text": "x"}],
                }
            ],
        },
    )
    assert resp.status_code == 503


def test_generate_kie_failure_lists_in_errors(
    client: TestClient,
    fake_sb: _FakeSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.routes import creative as creative_route
    from src.services.kie import KieError

    class FailingKie(_StubKieClient):
        async def generate_image_full(self, *a, **kw):
            raise KieError("rate limit")

    monkeypatch.setattr(creative_route, "KieClient", FailingKie)

    resp = client.post(
        "/work/creative/generate",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "brief_id": "brief-1",
            "prompts": [
                {
                    "concept": "X",
                    "prompts": [{"ratio": "1x1", "text": "x"}],
                }
            ],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["creatives_created"] == 0
    assert any("rate limit" in e for e in body["errors"])


def test_generate_uses_agent_when_no_prompts(
    client: TestClient,
    fake_sb: _FakeSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When prompts is omitted the route should call ClaudeRunner."""
    from src.routes import creative as creative_route

    monkeypatch.setattr(creative_route, "KieClient", _StubKieClient)

    pack_json = json.dumps(
        [
            {
                "concept": "agent-concept",
                "prompts": [{"ratio": "1x1", "text": "ai prompt"}],
            }
        ]
    )

    class FakeRunner:
        async def run_subprocess(self, prompt, **kwargs):
            return f"some prelude\n```json\n{pack_json}\n```"

        async def stream(self, *a, **kw):
            return
            yield  # type: ignore[unreachable]

    creative_route._runner = FakeRunner()  # type: ignore[assignment]

    resp = client.post(
        "/work/creative/generate",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"brief_id": "brief-1"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["creatives_created"] == 1
    assert body["creatives"][0]["concept"] == "agent-concept"


def test_generate_502_when_agent_returns_garbage(
    client: TestClient,
    fake_sb: _FakeSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.routes import creative as creative_route

    class GarbageRunner:
        async def run_subprocess(self, *a, **kw):
            return "this is not json"

        async def stream(self, *a, **kw):
            return
            yield  # type: ignore[unreachable]

    creative_route._runner = GarbageRunner()  # type: ignore[assignment]

    resp = client.post(
        "/work/creative/generate",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"brief_id": "brief-1"},
    )
    assert resp.status_code == 502
    assert "unparseable" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# /work/creative/composite
# ---------------------------------------------------------------------------


def test_composite_runs_compositor_and_records_new_row(
    client: TestClient,
    fake_sb: _FakeSupabase,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    fake_sb.creative_row = {
        "id": "c-parent",
        "brief_id": "brief-1",
        "concept": "Sunny",
        "offer_text": "$99",
        "ratio": "1x1",
        "version": "v1.0",
        "file_path_supabase": "brief-1/sunny-1x1-v1.0.png",
    }
    fake_sb.storage_reads["brief-1/sunny-1x1-v1.0.png"] = b"PARENT_PNG"

    async def fake_composite(
        input_path: Path,
        output_path: Path,
        **kwargs,
    ):
        output_path.write_bytes(b"COMPOSED_PNG")
        from src.services.image_compositor import CompositorResult

        return CompositorResult(
            output_path=output_path,
            raw_stdout="",
            raw_stderr="",
        )

    from src.routes import creative as creative_route

    monkeypatch.setattr(creative_route, "image_composite", fake_composite)

    resp = client.post(
        "/work/creative/composite",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "creative_id": "c-parent",
            "style": "bold-bottom",
            "headline": "Best Roof In Town",
            "cta": "Get Quote",
            "version": "v1.1",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["parent_creative_id"] == "c-parent"
    assert body["style"] == "bold-bottom"
    # Composed bytes were uploaded.
    assert len(fake_sb.storage_writes) == 1
    assert fake_sb.storage_writes[0][1] == b"COMPOSED_PNG"


def test_composite_503_when_script_missing(
    client: TestClient,
    fake_sb: _FakeSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_sb.creative_row = {
        "id": "c-parent",
        "brief_id": "brief-1",
        "concept": "Sunny",
        "offer_text": None,
        "ratio": "1x1",
        "version": "v1.0",
        "file_path_supabase": "brief-1/sunny-1x1-v1.0.png",
    }
    fake_sb.storage_reads["brief-1/sunny-1x1-v1.0.png"] = b"P"

    async def fake_composite(*a, **kw):
        raise RuntimeError("image_compositor.py not found under nowhere")

    from src.routes import creative as creative_route

    monkeypatch.setattr(creative_route, "image_composite", fake_composite)

    resp = client.post(
        "/work/creative/composite",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "c-parent", "headline": "X"},
    )
    assert resp.status_code == 503


def test_composite_404_when_parent_missing(
    client: TestClient,
    fake_sb: _FakeSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_sb.creative_row = None
    resp = client.post(
        "/work/creative/composite",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "missing", "headline": "X"},
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Helpers in creative.py we can hit directly
# ---------------------------------------------------------------------------


def test_parse_prompt_pack_raw_json_array() -> None:
    """A bare JSON array on stdout (no fence) parses correctly."""
    from src.routes.creative import _parse_prompt_pack

    raw = json.dumps(
        [
            {"concept": "X", "prompts": [{"ratio": "1x1", "text": "x prompt"}]},
        ]
    )
    pack = _parse_prompt_pack(raw)
    assert len(pack) == 1
    assert pack[0].concept == "X"


def test_parse_prompt_pack_dict_wraps_to_list() -> None:
    """A single dict at top level is wrapped into a one-item list."""
    from src.routes.creative import _parse_prompt_pack

    raw = json.dumps(
        {"concept": "Y", "prompts": [{"ratio": "9x16", "text": "y prompt"}]}
    )
    pack = _parse_prompt_pack(raw)
    assert len(pack) == 1
    assert pack[0].concept == "Y"


def test_parse_prompt_pack_skips_garbage_and_uses_fenced() -> None:
    """Unparseable raw + a valid fenced block downstream picks the fence."""
    from src.routes.creative import _parse_prompt_pack

    raw = (
        "intro chatter\n"
        "```json\n"
        '[{"concept": "ok", "prompts": [{"ratio": "1x1", "text": "ok"}]}]\n'
        "```\n"
    )
    pack = _parse_prompt_pack(raw)
    assert pack[0].concept == "ok"


def test_parse_prompt_pack_raises_when_no_valid_pack() -> None:
    """Item that fails PromptItem validation surfaces a ValueError."""
    from src.routes.creative import _parse_prompt_pack

    # Valid JSON but `prompts` missing → PromptItem(**) raises.
    raw = json.dumps([{"concept": "bad"}])
    with pytest.raises(ValueError, match="Could not parse"):
        _parse_prompt_pack(raw)


def test_parse_prompt_pack_skips_non_list_non_dict() -> None:
    """Top-level scalar JSON is ignored — falls through to the ValueError."""
    from src.routes.creative import _parse_prompt_pack

    raw = "42"
    with pytest.raises(ValueError):
        _parse_prompt_pack(raw)


def test_parse_prompt_pack_handles_malformed_fenced_json() -> None:
    """A fenced block whose body is not valid JSON triggers the
    JSONDecodeError branch and falls through to the ValueError."""
    from src.routes.creative import _parse_prompt_pack

    raw = "```json\n{not valid json}\n```"
    with pytest.raises(ValueError, match="Could not parse"):
        _parse_prompt_pack(raw)


def test_get_runner_constructs_singleton_then_reuses() -> None:
    """First call constructs; subsequent calls return the same instance."""
    from src.routes import creative as creative_route

    creative_route._reset_runner()
    r1 = creative_route._get_runner()
    r2 = creative_route._get_runner()
    assert r1 is r2


def test_extract_context_handles_non_dict_payload() -> None:
    """When payload / clients aren't dicts, we coerce to empty mappings."""
    from src.routes.creative import _extract_context

    row = {"id": "brief-z", "payload": "not-a-dict", "clients": "also-not"}
    ctx = _extract_context(row)
    assert ctx.payload == {}
    assert ctx.client_slug == "client"
    assert ctx.client_name == "Client"


def test_extract_context_handles_none_client() -> None:
    """Missing/None ``clients`` falls back to {} and the default labels."""
    from src.routes.creative import _extract_context

    row = {"id": "brief-z", "payload": {"market": "TX"}, "clients": None}
    ctx = _extract_context(row)
    assert ctx.client_slug == "client"
    assert ctx.client_name == "Client"


def test_emit_event_swallows_exceptions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Event-emit failures must NEVER bubble up out of the route."""
    from src.routes import creative as creative_route

    class BoomSb:
        def table(self, name):
            raise RuntimeError("connection died")

    monkeypatch.setattr(creative_route, "get_supabase_admin", lambda: BoomSb())

    # Should not raise.
    creative_route._emit_event(kind="x", ref_id="r", payload={"k": "v"})


def test_download_bytes_returns_bytes_directly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the supabase-py client returns bytes directly, we pass them through."""
    from src.routes import creative as creative_route

    class _FakeBucket:
        def download(self, path):
            return b"DIRECT_BYTES"

    class _FakeStorage:
        def from_(self, _bucket):
            return _FakeBucket()

    class _FakeSb:
        storage = _FakeStorage()

    monkeypatch.setattr(creative_route, "get_supabase_admin", lambda: _FakeSb())
    out = creative_route._download_bytes("any/path")
    assert out == b"DIRECT_BYTES"


def test_download_bytes_reads_content_attribute(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the response wraps bytes on `.content`, we unwrap them."""
    from src.routes import creative as creative_route

    class _Resp:
        content = b"RESP_BYTES"

    class _FakeBucket:
        def download(self, path):
            return _Resp()

    class _FakeStorage:
        def from_(self, _bucket):
            return _FakeBucket()

    class _FakeSb:
        storage = _FakeStorage()

    monkeypatch.setattr(creative_route, "get_supabase_admin", lambda: _FakeSb())
    out = creative_route._download_bytes("any/path")
    assert out == b"RESP_BYTES"


def test_download_bytes_raises_on_unexpected_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Anything else → RuntimeError so the caller can surface a clear 5xx."""
    from src.routes import creative as creative_route

    class _FakeBucket:
        def download(self, path):
            return object()  # not bytes, no .content

    class _FakeStorage:
        def from_(self, _bucket):
            return _FakeBucket()

    class _FakeSb:
        storage = _FakeStorage()

    monkeypatch.setattr(creative_route, "get_supabase_admin", lambda: _FakeSb())
    with pytest.raises(RuntimeError, match="unexpected Storage download"):
        creative_route._download_bytes("any/path")


# ---------------------------------------------------------------------------
# /work/creative/generate — agent + plan + claude-error edge cases
# ---------------------------------------------------------------------------


def test_generate_uses_creative_plan_image_count(
    client: TestClient,
    fake_sb: _FakeSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The brief.payload.creative_plan.image_count overrides the default."""
    fake_sb.brief_row["payload"]["creative_plan"] = {"image_count": 2}  # type: ignore[index]

    from src.routes import creative as creative_route

    captured: dict = {}

    pack_json = json.dumps(
        [
            {
                "concept": "C1",
                "prompts": [{"ratio": "1x1", "text": "p"}],
            },
            {
                "concept": "C2",
                "prompts": [{"ratio": "1x1", "text": "p"}],
            },
        ]
    )

    class FakeRunner:
        async def run_subprocess(self, prompt, **kwargs):
            captured["prompt"] = prompt
            return f"```json\n{pack_json}\n```"

    creative_route._runner = FakeRunner()  # type: ignore[assignment]
    monkeypatch.setattr(creative_route, "KieClient", _StubKieClient)

    resp = client.post(
        "/work/creative/generate",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"brief_id": "brief-1"},
    )
    assert resp.status_code == 200, resp.text
    # The agent prompt should mention the image_count we surfaced.
    assert "2 concept" in captured["prompt"]


def test_generate_502_when_claude_runner_fails(
    client: TestClient,
    fake_sb: _FakeSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A ClaudeError during the prompt-pack call surfaces as a 502."""
    from src.routes import creative as creative_route
    from src.services.claude_runner import ClaudeError

    class BoomRunner:
        async def run_subprocess(self, *a, **kw):
            raise ClaudeError("CLI exited 1")

    creative_route._runner = BoomRunner()  # type: ignore[assignment]
    monkeypatch.setattr(creative_route, "KieClient", _StubKieClient)

    resp = client.post(
        "/work/creative/generate",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"brief_id": "brief-1"},
    )
    assert resp.status_code == 502
    assert "claude agent failed" in resp.json()["detail"]


def test_generate_502_when_prompt_pack_empty(
    client: TestClient,
    fake_sb: _FakeSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty (but parseable) prompt pack must surface as 502."""
    from src.routes import creative as creative_route

    class EmptyRunner:
        async def run_subprocess(self, *a, **kw):
            return "```json\n[]\n```"

    creative_route._runner = EmptyRunner()  # type: ignore[assignment]
    monkeypatch.setattr(creative_route, "KieClient", _StubKieClient)

    resp = client.post(
        "/work/creative/generate",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"brief_id": "brief-1"},
    )
    assert resp.status_code == 502
    assert "empty" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# /work/creative/composite — extra branches
# ---------------------------------------------------------------------------


def test_composite_409_when_parent_has_no_file_path(
    client: TestClient,
    fake_sb: _FakeSupabase,
) -> None:
    """Parent row exists but `file_path_supabase` is empty → 409."""
    fake_sb.creative_row = {
        "id": "c-no-file",
        "brief_id": "brief-1",
        "concept": "Concept",
        "offer_text": None,
        "ratio": "1x1",
        "version": "v1.0",
        "file_path_supabase": None,
    }
    resp = client.post(
        "/work/creative/composite",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "c-no-file", "headline": "X"},
    )
    assert resp.status_code == 409


def test_composite_502_when_compositor_error(
    client: TestClient,
    fake_sb: _FakeSupabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Upstream compositor reports failure → 502."""
    from src.routes import creative as creative_route
    from src.services.image_compositor import CompositorError

    fake_sb.creative_row = {
        "id": "c-parent",
        "brief_id": "brief-1",
        "concept": "Sunny",
        "offer_text": None,
        "ratio": "9x16",
        "version": "v1.0",
        "file_path_supabase": "brief-1/sunny-9x16-v1.0.png",
    }
    fake_sb.storage_reads["brief-1/sunny-9x16-v1.0.png"] = b"P"

    async def fake_composite(*a, **kw):
        raise CompositorError("missing font")

    monkeypatch.setattr(creative_route, "image_composite", fake_composite)

    resp = client.post(
        "/work/creative/composite",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "c-parent", "headline": "H"},
    )
    assert resp.status_code == 502
    assert "missing font" in resp.json()["detail"]
