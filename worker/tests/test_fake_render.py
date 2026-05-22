"""Tests for FAKE_RENDER fake-integration mode (T.4 / #317).

Proves the Kie render stub:

  * is reachable with NO api key and NO network when ``FAKE_RENDER=true``;
  * returns *real*, decodable PNG bytes (so downstream Pillow steps work);
  * is deterministic — same (prompt, ratio, resolution) ⇒ same task id/bytes;
  * never opens an httpx client (the no-external-call guarantee);
  * stays OFF by default — without the flag the client still requires a key.

This is the worker-side half of the fake-integration convention documented in
``worker/tests/README.md``; FAKE_META / FAKE_GHL / FAKE_DRIVE follow the same
flag pattern (their services land with Layer 6).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest


SHARED_SECRET = "test-secret-for-fake-render"


@pytest.fixture
def fake_render_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Env with FAKE_RENDER on and NO Kie key — the zero-credential case."""
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("WORKER_CORS_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("WORKER_PUBLIC_BASE_URL", "http://localhost:8000")
    monkeypatch.setenv("BROLL_STORE_BACKEND", "local")
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.setenv("TAILSCALE_HOSTNAME", "voxhorizon-worker-test")
    monkeypatch.setenv("FAKE_RENDER", "true")
    monkeypatch.delenv("KIE_AI_API_KEY", raising=False)

    from src.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_settings_fake_flags_default_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without env, every FAKE_* flag is false (production-safe default)."""
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    for var in ("FAKE_RENDER", "FAKE_META", "FAKE_GHL", "FAKE_DRIVE"):
        monkeypatch.delenv(var, raising=False)
    from src.config import get_settings

    get_settings.cache_clear()
    s = get_settings()
    assert s.fake_render is False
    assert s.fake_meta is False
    assert s.fake_ghl is False
    assert s.fake_drive is False


def test_settings_reads_fake_flags(fake_render_env: None) -> None:
    from src.config import get_settings

    assert get_settings().fake_render is True


def test_client_constructs_without_key_in_fake_mode(fake_render_env: None) -> None:
    """The real failure mode (missing key → RuntimeError) is suppressed."""
    from src.services.kie import KieClient

    client = KieClient()  # no key, no raise
    assert client.fake is True


def test_client_still_requires_key_when_not_faking(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Off by default: no flag + no key still raises loudly."""
    monkeypatch.setenv("WORKER_SHARED_SECRET", SHARED_SECRET)
    monkeypatch.setenv("BROLL_LOCAL_ROOT", str(tmp_path))
    monkeypatch.delenv("FAKE_RENDER", raising=False)
    monkeypatch.delenv("KIE_AI_API_KEY", raising=False)
    from src.config import get_settings
    from src.services.kie import KieClient

    get_settings.cache_clear()
    with pytest.raises(RuntimeError, match="KIE_AI_API_KEY"):
        KieClient()


async def test_fake_render_returns_valid_png(fake_render_env: None) -> None:
    """generate_image_full returns decodable PNG bytes + fake provenance."""
    from src.services.kie import KieClient

    result = await KieClient().generate_image_full(
        "owner on a roof, golden hour", "1x1", resolution="1K"
    )
    # Real PNG signature so the compositor / Pillow can open it.
    assert result.image_bytes.startswith(b"\x89PNG\r\n\x1a\n")
    assert result.task_id.startswith("fake-")
    assert result.source_url.startswith("https://fake.kie.local/")
    assert result.aspect_ratio == "1:1"
    assert result.resolution == "1K"

    # The bytes survive a Pillow round-trip (1x1 image).
    import io

    from PIL import Image

    img = Image.open(io.BytesIO(result.image_bytes))
    assert img.size == (1, 1)


async def test_fake_render_is_deterministic(fake_render_env: None) -> None:
    """Same inputs ⇒ same task id + bytes (keeps idempotency probes honest)."""
    from src.services.kie import KieClient

    a = await KieClient().generate_image_full("p", "9x16", resolution="2K")
    b = await KieClient().generate_image_full("p", "9x16", resolution="2K")
    assert a.task_id == b.task_id
    assert a.image_bytes == b.image_bytes
    # A different prompt yields a different deterministic id.
    c = await KieClient().generate_image_full("other", "9x16", resolution="2K")
    assert c.task_id != a.task_id


async def test_fake_render_makes_no_network_call(
    fake_render_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The fake path never opens an httpx client — the zero-call guarantee."""
    from src.services import kie as kie_mod
    from src.services.kie import KieClient

    def _boom(*_a: object, **_kw: object) -> None:
        raise AssertionError("FAKE_RENDER must not open an httpx client")

    monkeypatch.setattr(kie_mod.httpx, "AsyncClient", _boom)
    # Would raise inside _open_client if the fake branch didn't short-circuit.
    result = await KieClient().generate_image("a roof", "1x1", resolution="1K")
    assert result.startswith(b"\x89PNG\r\n\x1a\n")


async def test_fake_render_rejects_unsupported_ratio(fake_render_env: None) -> None:
    """Even in fake mode the ratio contract is enforced."""
    from src.services.kie import KieClient, KieError

    with pytest.raises(KieError, match="Unsupported ratio"):
        await KieClient().generate_image_full("p", "16x9", resolution="1K")  # type: ignore[arg-type]


def test_fake_generation_result_helper_is_pure() -> None:
    """The module-level helper works standalone (no settings / no client)."""
    from src.services.kie import fake_generation_result

    r1 = fake_generation_result("p", "1x1", "1K")
    r2 = fake_generation_result("p", "1x1", "1K")
    assert r1 == r2
    assert r1.image_bytes.startswith(b"\x89PNG\r\n\x1a\n")
