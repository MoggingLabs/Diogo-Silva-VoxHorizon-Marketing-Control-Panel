"""Shared worker-route test harness (T.2 / #315).

Centralises the fixtures every route/contract test needs so a new endpoint
test is a few lines, not a copy-pasted Supabase double + env block:

  * ``worker_env``    — autouse: provisions the minimal env + resets the cached
                        settings / queue / operator-bridge singletons around
                        each test so state never leaks between tests.
  * ``shared_secret`` — the bearer secret the env is wired with.
  * ``auth_headers``  — bearer-auth helper for the worker's ``verify_secret``
                        dependency (``{"Authorization": "Bearer <secret>"}``).
  * ``client``        — a FastAPI ``TestClient`` (sync, drives background tasks).
  * ``asgi_client``   — an ``httpx.AsyncClient`` over ``ASGITransport`` bound to
                        the app, for tests that prefer the async client surface.
  * ``fake_supabase`` — an in-memory Supabase double + installer that patches
                        ``get_supabase_admin`` everywhere the routes read it.

The in-memory double (:class:`FakeSupabase`) mirrors the slice of the
supabase-py fluent API the worker uses: ``table(name).select(...).eq(...)
.order(...).limit(...).maybe_single().execute()``, terminal ``insert`` /
``update``, ``rpc(fn, params).execute()``, and ``storage.from_(bucket).upload``.
It is the generalisation of the per-file ``_ToolsSupabase`` doubles that
already live in ``test_pipeline_tools_route.py`` / ``test_pipeline_route.py``.

Plugin registration (silent-failure PR-1): the work_item queue tests in
``tests/queue/`` share the Postgres-backed fixtures with the integration
tier in ``tests/integration/``. ``pytest_plugins`` MUST live at the top
level (recent pytest forbids non-top-level declarations), so it sits here
-- pytest loads the integration conftest as a plugin ONCE and the
session-scoped ``migrated_db`` fixture is shared (preventing the double-
migrate that would fail on ``type already exists``).
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

# Register the shared Postgres-backed fixtures (``pg_dsn`` / ``migrated_db`` /
# ``db_conn`` / ``image_creative`` / ``video_creative``) as a pytest plugin so
# the SAME session-scoped instances are shared between the integration tier
# (``tests/integration/``) and the work_item queue tests (``tests/queue/``).
# Defining ``pytest_plugins`` MUST happen at the top-level conftest -- recent
# pytest forbids it in nested conftests.
pytest_plugins = ["tests.db_fixtures"]

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient


# The bearer secret the harness wires into the worker env. Tests authenticate
# with ``auth_headers`` (or build ``Bearer <shared_secret>`` by hand).
SHARED_SECRET = "test-shared-secret-for-worker-harness"


# ===========================================================================
# In-memory Supabase double
# ===========================================================================


class _FakeRpc:
    """Result holder for ``rpc(fn, params).execute()``."""

    def __init__(self, value: Any) -> None:
        self._value = value

    def execute(self) -> SimpleNamespace:
        return SimpleNamespace(data=self._value)


class _FakeQuery:
    """One chainable query against a single table.

    Supports the read/write surface the worker uses. Filters (``eq``) and
    ordering/paging (``order`` / ``limit``) accumulate, then ``execute()``
    resolves against the parent :class:`FakeSupabase`'s row store.
    """

    def __init__(self, sb: "FakeSupabase", name: str) -> None:
        self._sb = sb
        self._name = name
        self._filters: list[tuple[str, Any]] = []
        self._select: str | None = None
        self._insert_data: Any = None
        self._update_data: dict[str, Any] | None = None
        self._maybe_single = False
        self._single = False
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None

    # -- builder methods (all return self) --------------------------------
    def select(self, columns: str = "*", **_kw: Any) -> "_FakeQuery":
        self._select = columns
        return self

    def eq(self, col: str, val: Any) -> "_FakeQuery":
        self._filters.append((col, val))
        return self

    def in_(self, col: str, vals: list[Any]) -> "_FakeQuery":
        """``column in (...)`` filter -- mirrors the supabase-py ``in_``.

        Encoded as a special tuple so ``_matches`` checks set membership rather
        than equality. Used by the silent-failure work_queue facade for
        token-scoped UPDATEs that constrain ``status in ('claimed','running')``.
        """
        self._filters.append((col, ("__in__", tuple(vals))))
        return self

    def order(self, col: str, *, desc: bool = False) -> "_FakeQuery":
        self._order = (col, desc)
        return self

    def limit(self, n: int) -> "_FakeQuery":
        self._limit = n
        return self

    def maybe_single(self) -> "_FakeQuery":
        self._maybe_single = True
        return self

    def single(self) -> "_FakeQuery":
        self._single = True
        return self

    def insert(self, data: Any) -> "_FakeQuery":
        self._insert_data = data
        return self

    def update(self, data: dict[str, Any]) -> "_FakeQuery":
        self._update_data = data
        return self

    # -- terminal ----------------------------------------------------------
    def execute(self) -> SimpleNamespace | None:
        if self._insert_data is not None:
            return self._do_insert()
        if self._update_data is not None:
            return self._do_update()
        return self._do_select()

    # -- internals ---------------------------------------------------------
    def _matches(self, row: dict[str, Any]) -> bool:
        for col, val in self._filters:
            if (
                isinstance(val, tuple)
                and len(val) == 2
                and val[0] == "__in__"
            ):
                if row.get(col) not in val[1]:
                    return False
            elif row.get(col) != val:
                return False
        return True

    def _do_insert(self) -> SimpleNamespace:
        rows = self._insert_data if isinstance(self._insert_data, list) else [self._insert_data]
        inserted: list[dict[str, Any]] = []
        for row in rows:
            self._sb.inserts.append((self._name, dict(row)))
            store = self._sb._store.setdefault(self._name, [])
            new_row = dict(row)
            new_row.setdefault("id", f"{self._name}-id-{len(self._sb.inserts)}")
            store.append(new_row)
            inserted.append(new_row)
        return SimpleNamespace(data=inserted)

    def _do_update(self) -> SimpleNamespace:
        assert self._update_data is not None
        self._sb.updates.append((self._name, dict(self._update_data)))
        store = self._sb._store.get(self._name, [])
        updated: list[dict[str, Any]] = []
        for row in store:
            if self._matches(row):
                row.update(self._update_data)
                updated.append(row)
        # Even when no stored row matches (tests that only seed via the
        # ``*_row`` overrides), echo the patch so callers reading ``.data``
        # don't crash on ``None``.
        if not updated:
            updated = [{**self._update_data, "id": f"{self._name}-u"}]
        return SimpleNamespace(data=updated)

    def _do_select(self) -> SimpleNamespace | None:
        override = self._sb.single_overrides.get(self._name)
        if (self._maybe_single or self._single) and override is not None:
            row = override() if callable(override) else override
            # maybe_single on an absent row returns None (not a response) in
            # supabase-py; mirror that so route guards exercise the real path.
            if row is None and self._maybe_single:
                return None
            return SimpleNamespace(data=row)

        rows = [r for r in self._sb._store.get(self._name, []) if self._matches(r)]
        if self._order:
            col, desc = self._order
            rows = sorted(rows, key=lambda r: (r.get(col) is None, r.get(col)), reverse=desc)
        if self._limit is not None:
            rows = rows[: self._limit]

        if self._maybe_single:
            return SimpleNamespace(data=rows[0]) if rows else None
        if self._single:
            return SimpleNamespace(data=rows[0] if rows else None)
        return SimpleNamespace(data=rows)


class _FakeBucket:
    def __init__(self, sb: "FakeSupabase") -> None:
        self._sb = sb

    def upload(self, *, path: str, file: bytes, file_options: dict | None = None) -> None:
        self._sb.storage_uploads.append((path, bytes(file)))

    def download(self, path: str) -> bytes:
        """Return seeded bytes for ``path`` (mirrors supabase-py download).

        Bytes are seeded with ``FakeSupabase.set_storage_object(path, data)``.
        A missing path raises (like the real client returning a storage error)
        so the route's download-failure branch is exercisable.
        """
        if path not in self._sb.storage_objects:
            raise FileNotFoundError(f"object not found: {path}")
        return self._sb.storage_objects[path]


class _FakeStorage:
    def __init__(self, sb: "FakeSupabase") -> None:
        self._sb = sb

    def from_(self, _bucket: str) -> _FakeBucket:
        return _FakeBucket(self._sb)


class FakeSupabase:
    """In-memory stand-in for the supabase-py service-role client.

    Two ways to seed read data:

      * ``seed(table, rows)``        — append rows to a table's multi-row store
                                       (``select().eq().execute()`` reads these);
      * ``set_single(table, row)``   — set the row a ``maybe_single`` /
                                       ``single`` read returns for that table
                                       (``row=None`` ⇒ the absent-row path).

    Writes are captured for assertions on ``inserts`` / ``updates`` /
    ``storage_uploads``. ``rpc`` returns ``rpc_return`` (override per test).
    """

    def __init__(self) -> None:
        self._store: dict[str, list[dict[str, Any]]] = {}
        self.single_overrides: dict[str, Any] = {}
        self.inserts: list[tuple[str, dict[str, Any]]] = []
        self.updates: list[tuple[str, dict[str, Any]]] = []
        self.storage_uploads: list[tuple[str, bytes]] = []
        self.storage_objects: dict[str, bytes] = {}
        self.rpc_calls: list[tuple[str, dict[str, Any]]] = []
        self.rpc_return: Any = None

    # -- seeding -----------------------------------------------------------
    def seed(self, table: str, rows: list[dict[str, Any]]) -> None:
        self._store.setdefault(table, []).extend(dict(r) for r in rows)

    def set_storage_object(self, path: str, data: bytes) -> None:
        """Seed bytes a ``storage.from_(bucket).download(path)`` returns."""
        self.storage_objects[path] = bytes(data)

    def set_single(self, table: str, row: dict[str, Any] | Callable[[], Any] | None) -> None:
        self.single_overrides[table] = row

    def rows(self, table: str) -> list[dict[str, Any]]:
        return list(self._store.get(table, []))

    # -- supabase-py surface ----------------------------------------------
    def table(self, name: str) -> _FakeQuery:
        return _FakeQuery(self, name)

    def rpc(self, fn: str, params: dict[str, Any]) -> _FakeRpc:
        self.rpc_calls.append((fn, dict(params)))
        # Silent-failure PR-4: ``compute_pipeline_status`` (migration 0050) is
        # the canonical pipeline-status source after 0051 dropped the column.
        # The fake folds the pipelines.single_overrides ``status`` field into
        # the RPC response so existing tests that seed
        # ``set_single("pipelines", {..., "status": ...})`` keep working
        # without growing a parallel rpc fixture.
        if fn == "compute_pipeline_status":
            pipeline_row = self.single_overrides.get("pipelines")
            if callable(pipeline_row):
                pipeline_row = pipeline_row()
            status: Any = None
            if isinstance(pipeline_row, dict):
                status = pipeline_row.get("status")
            return _FakeRpc(status)
        return _FakeRpc(self.rpc_return)

    @property
    def storage(self) -> _FakeStorage:
        return _FakeStorage(self)


# ===========================================================================
# Env + singleton lifecycle
# ===========================================================================


@pytest.fixture(autouse=True)
def worker_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Provision env + reset the cached singletons around every test.

    Autouse so plain ``client`` / ``asgi_client`` tests get a clean,
    fully-wired worker without opting in. Mirrors the per-file ``_env``
    fixtures the existing route tests each define.
    """
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")

    from src.config import get_settings
    from src.routes import health as health_mod
    from src.services.queue import reset_queue

    get_settings.cache_clear()
    reset_queue()
    health_mod._reset_bridge()

    # Pre-seed a fake Hermes bridge so create_app() / the /work/health route
    # never touches a real Docker socket (absent in CI).
    class _FakeBridge:
        def healthcheck(self) -> dict[str, Any]:
            return {"container": "running", "name": "hermes-agent-ekko"}

    monkeypatch.setattr(health_mod, "_get_bridge", lambda: _FakeBridge())

    yield

    get_settings.cache_clear()
    reset_queue()
    health_mod._reset_bridge()


@pytest.fixture
def shared_secret() -> str:
    """The bearer secret the harness env is wired with."""
    return SHARED_SECRET


@pytest.fixture
def auth_headers(shared_secret: str) -> dict[str, str]:
    """Bearer-auth header for the worker's ``verify_secret`` dependency."""
    return {"Authorization": f"Bearer {shared_secret}"}


# ===========================================================================
# App + clients
# ===========================================================================


@pytest.fixture
def app() -> FastAPI:
    """A fresh FastAPI app built against the per-test env."""
    from src.main import create_app

    return create_app()


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    """Sync ``TestClient`` — runs ``BackgroundTasks`` after the response."""
    return TestClient(app)


@pytest_asyncio.fixture
async def asgi_client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    """``httpx.AsyncClient`` over ``ASGITransport`` bound to the app.

    Drives the app in-process with no socket — the brief's required worker
    harness surface. Use for ``async def`` tests that prefer the httpx API;
    note ASGITransport does NOT run FastAPI ``BackgroundTasks``, so endpoints
    whose effects land in a background task should be exercised via ``client``.
    """
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://worker.test") as ac:
        yield ac


# ===========================================================================
# Supabase double installer
# ===========================================================================


@pytest.fixture
def fake_supabase(monkeypatch: pytest.MonkeyPatch) -> FakeSupabase:
    """Install an in-memory Supabase double everywhere the routes read it.

    Patches ``get_supabase_admin`` on every module that imports it by name so
    the route + the services it calls (``pipeline_runner``, ``atomic_inserts``)
    all share one fake. Returns the double for seeding + assertions.
    """
    sb = FakeSupabase()

    from src import supabase_client
    from src.routes import integrations, pipeline_tools, qa_compliance, video_callback
    from src.services import atomic_inserts, cost_ledger, pipeline_runner

    for mod in (
        supabase_client,
        pipeline_tools,
        integrations,
        qa_compliance,
        pipeline_runner,
        atomic_inserts,
        cost_ledger,
        video_callback,
    ):
        if hasattr(mod, "get_supabase_admin"):
            monkeypatch.setattr(mod, "get_supabase_admin", lambda: sb)

    return sb
