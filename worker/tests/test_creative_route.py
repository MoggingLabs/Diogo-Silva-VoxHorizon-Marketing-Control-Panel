"""Tests for /work/creative/generate, /work/creative/composite, and SSE chat."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

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
    from src.routes import chat_stream

    get_settings.cache_clear()
    reset_queue()
    creative_route._reset_runner()
    chat_stream._reset_runner()
    yield
    get_settings.cache_clear()
    reset_queue()
    creative_route._reset_runner()
    chat_stream._reset_runner()


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


def test_chat_stream_requires_auth(client: TestClient) -> None:
    resp = client.post(
        "/work/chat/creative",
        json={
            "creative_id": "c",
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert resp.status_code == 401


def test_chat_video_stream_requires_auth(client: TestClient) -> None:
    resp = client.post(
        "/work/chat/video-creative",
        json={
            "creative_id": "c",
            "messages": [{"role": "user", "content": "hi"}],
        },
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
# /work/chat/creative — SSE
# ---------------------------------------------------------------------------


def test_chat_stream_400_when_messages_empty(client: TestClient) -> None:
    resp = client.post(
        "/work/chat/creative",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={"creative_id": "c", "messages": []},
    )
    assert resp.status_code == 400


def test_chat_stream_returns_sse_content_type(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Smoke: route should return text/event-stream with at least one data line."""
    from src.routes import chat_stream
    from src.services.claude_runner import StreamChunk

    class FakeRunner:
        async def run_subprocess(self, *a, **kw):
            return ""

        async def stream(self, messages, **kwargs):
            yield StreamChunk(type="text_delta", delta="hi")

    chat_stream._runner = FakeRunner()  # type: ignore[assignment]

    with client.stream(
        "POST",
        "/work/chat/creative",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "creative_id": "c-1",
            "messages": [{"role": "user", "content": "hello"}],
        },
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        body = b"".join(resp.iter_bytes())
    assert b"data: " in body
    assert b"text_delta" in body
    assert b"message_stop" in body


def test_chat_stream_uses_video_defaults(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The video route should default to the video tool set."""
    from src.routes import chat_stream
    from src.services.claude_runner import StreamChunk

    captured: dict = {}

    class FakeRunner:
        async def run_subprocess(self, *a, **kw):
            return ""

        async def stream(self, messages, *, tools=None, system_prompt=None, **kw):
            captured["tools"] = tools
            captured["system"] = system_prompt
            yield StreamChunk(type="text_delta", delta="ok")

    chat_stream._runner = FakeRunner()  # type: ignore[assignment]

    with client.stream(
        "POST",
        "/work/chat/video-creative",
        headers={"Authorization": f"Bearer {SHARED_SECRET}"},
        json={
            "creative_id": "vc-1",
            "messages": [{"role": "user", "content": "hello"}],
        },
    ) as resp:
        assert resp.status_code == 200
        b"".join(resp.iter_bytes())

    names = {t["name"] for t in (captured["tools"] or [])}
    # Video defaults include voiceover regen + b-roll swap.
    assert "regenerate_voiceover" in names
    assert "swap_broll" in names
    assert "rerender_video" in names
