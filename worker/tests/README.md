# Worker tests

Pytest suite for the FastAPI worker. Run from `worker/`:

```bash
uv run pytest -q
uv run pytest --cov=src --cov-fail-under=90   # the coverage gate CI enforces
```

`pytest.ini_options` in `pyproject.toml` sets `asyncio_mode = "auto"`, so
`async def test_*` functions run without an explicit `@pytest.mark.asyncio`.

## Shared route harness (T.2 / #315)

`conftest.py` provides the fixtures every route/contract test needs, so a new
endpoint test is a few lines instead of a copy-pasted Supabase double + env
block:

| fixture         | what it gives you                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker_env`    | autouse — minimal env + resets the cached `get_settings` / queue / operator-bridge / health-bridge singletons around each test (so state never leaks). Pre-seeds a fake Hermes bridge so `/work/health` never touches a real Docker socket. |
| `shared_secret` | the bearer secret the env is wired with.                                                                                                                                                                                                    |
| `auth_headers`  | `{"Authorization": "Bearer <secret>"}` — satisfies the `verify_secret` dependency.                                                                                                                                                          |
| `client`        | a `fastapi.testclient.TestClient` (sync; **runs** `BackgroundTasks` after the response).                                                                                                                                                    |
| `asgi_client`   | an `httpx.AsyncClient` over `ASGITransport` bound to the app (async; does **not** run `BackgroundTasks`).                                                                                                                                   |
| `fake_supabase` | an in-memory `FakeSupabase` double + installer that patches `get_supabase_admin` on every module the routes read it from (`supabase_client`, `pipeline_tools`, `pipeline_runner`, `atomic_inserts`) so they all share one fake.             |

### `FakeSupabase`

Mirrors the slice of the supabase-py fluent API the worker uses:
`table(name).select(...).eq(...).order(...).limit(...).maybe_single()/single().execute()`,
terminal `insert` / `update`, `rpc(fn, params).execute()`, and
`storage.from_(bucket).upload(...)`.

Seed read data two ways:

```python
fake_supabase.set_single("pipelines", pipeline_row)   # maybe_single/single read
fake_supabase.set_single("pipelines", None)           # the absent-row (→ 404) path
fake_supabase.seed("creatives", [row1, row2])         # multi-row select().eq() reads
```

Assert on writes via `fake_supabase.inserts` / `.updates` / `.storage_uploads`
/ `.rpc_calls`. Set `fake_supabase.rpc_return` to control an `rpc(...)` result.

The contract matrix (happy / 401 / 422 / idempotency) is demonstrated in
`test_route_harness.py`.

## Fake-integration mode (T.4 / #317)

So the pipeline can run locally / in CI with **zero external calls** and **zero
credentials**, each external integration is gated behind a `FAKE_*` env flag in
`src/config.py`. When the flag is on, the integration is stubbed in-process with
a **deterministic** response and makes no outbound network call. All default to
`false` (off) — production behaviour is never accidentally faked.

| flag          | integration                                                                 | status                                |
| ------------- | --------------------------------------------------------------------------- | ------------------------------------- |
| `FAKE_RENDER` | Kie.ai / codex image render → deterministic 1×1 PNG (`src/services/kie.py`) | **live**                              |
| `FAKE_META`   | Meta Ads recorder / launch saga → canned ad ids                             | reserved (service lands with Layer 6) |
| `FAKE_GHL`    | GoHighLevel lead pull / webhook → canned leads                              | reserved                              |
| `FAKE_DRIVE`  | Google Drive upload → deterministic fake url                                | reserved                              |

Convention for the services that arrive later (Meta / GHL / Drive): read the
flag via `get_settings().fake_*` at the client/service boundary and short-circuit
to a deterministic stub _before_ any network call — exactly as
`KieClient.generate_image_full` does today. Keep the stub:

- **deterministic** — same inputs ⇒ same output (so idempotency / skip-already
  probes stay honest);
- **credential-free** — never require the real API key when faking;
- **shaped like the real return** — return the same type the real path returns
  (e.g. `KieGenerationResult` with valid PNG bytes a Pillow step can open).

```bash
# run the worker against zero real render credentials
FAKE_RENDER=true uv run uvicorn src.main:app --port 8000
```

`test_fake_render.py` proves the render stub: no key required, valid + decodable
PNG bytes, deterministic, and zero httpx calls.
