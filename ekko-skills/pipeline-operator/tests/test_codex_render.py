"""Unit tests for the in-container codex render backend.

These exercise the pure logic (ratio→size mapping, quality resolution, error
surfaces, and the plugin-helper call wiring) WITHOUT Hermes installed — the
Hermes plugin is faked by pointing ``HERMES_CODEX_PLUGIN_PATH`` at a temp
module that exposes the two helpers ``codex_render`` depends on. No network,
no OAuth, no real image generation.
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

import pytest

HELPER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HELPER_DIR))

import codex_render  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_plugin_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """Clear the cached plugin module + env between tests."""
    monkeypatch.setattr(codex_render, "_plugin_module", None)
    monkeypatch.delenv(codex_render.ENV_PLUGIN_PATH, raising=False)
    monkeypatch.delenv(codex_render.ENV_HERMES_SRC, raising=False)
    monkeypatch.delenv(codex_render.ENV_IMAGE_QUALITY, raising=False)


def _write_fake_plugin(tmp_path: Path, body: str) -> Path:
    """Drop a fake codex plugin module and return its path."""
    p = tmp_path / "fake_codex_plugin.py"
    p.write_text(body, encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# size mapping
# ---------------------------------------------------------------------------


def test_size_for_ratio_true_9x16() -> None:
    assert codex_render.size_for_ratio("9x16") == "864x1536"


def test_size_for_ratio_square_and_landscape() -> None:
    assert codex_render.size_for_ratio("1x1") == "1024x1024"
    assert codex_render.size_for_ratio("16x9") == "1536x864"


def test_size_for_ratio_rejects_unknown() -> None:
    with pytest.raises(codex_render.CodexRenderError, match="unsupported ratio"):
        codex_render.size_for_ratio("4x5")


# ---------------------------------------------------------------------------
# render_image — happy path through a faked plugin
# ---------------------------------------------------------------------------


_FAKE_OK = """
def _build_codex_client():
    return object()

CALLS = []

def _collect_image_b64(client, *, prompt, size, quality):
    import base64
    CALLS.append({"prompt": prompt, "size": size, "quality": quality})
    return base64.b64encode(b"FAKEPNG-" + size.encode()).decode()
"""


def test_render_image_passes_explicit_size_and_returns_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plugin = _write_fake_plugin(tmp_path, _FAKE_OK)
    monkeypatch.setenv(codex_render.ENV_PLUGIN_PATH, str(plugin))
    # No real Hermes src needed for the fake plugin (it imports nothing).
    monkeypatch.setenv(codex_render.ENV_HERMES_SRC, str(tmp_path))

    out = codex_render.render_image("a roof", "9x16")
    assert out == b"FAKEPNG-864x1536"

    mod = codex_render._load_plugin()
    assert mod.CALLS[-1]["size"] == "864x1536"
    # Default quality is high (finals-grade).
    assert mod.CALLS[-1]["quality"] == "high"


def test_render_image_quality_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plugin = _write_fake_plugin(tmp_path, _FAKE_OK)
    monkeypatch.setenv(codex_render.ENV_PLUGIN_PATH, str(plugin))
    monkeypatch.setenv(codex_render.ENV_HERMES_SRC, str(tmp_path))
    monkeypatch.setenv(codex_render.ENV_IMAGE_QUALITY, "low")

    codex_render.render_image("a roof", "1x1")
    mod = codex_render._load_plugin()
    assert mod.CALLS[-1]["quality"] == "low"
    assert mod.CALLS[-1]["size"] == "1024x1024"


# ---------------------------------------------------------------------------
# render_image — error surfaces
# ---------------------------------------------------------------------------


def test_render_image_missing_plugin_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(
        codex_render.ENV_PLUGIN_PATH, str(tmp_path / "nope.py")
    )
    with pytest.raises(codex_render.CodexRenderError, match="not found"):
        codex_render.render_image("a roof", "1x1")


def test_render_image_empty_prompt_raises() -> None:
    with pytest.raises(codex_render.CodexRenderError, match="non-empty"):
        codex_render.render_image("   ", "1x1")


def test_render_image_no_client_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plugin = _write_fake_plugin(
        tmp_path,
        "def _build_codex_client():\n    return None\n"
        "def _collect_image_b64(client, *, prompt, size, quality):\n"
        "    return 'x'\n",
    )
    monkeypatch.setenv(codex_render.ENV_PLUGIN_PATH, str(plugin))
    monkeypatch.setenv(codex_render.ENV_HERMES_SRC, str(tmp_path))
    with pytest.raises(codex_render.CodexRenderError, match="OAuth"):
        codex_render.render_image("a roof", "1x1")


def test_render_image_empty_b64_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plugin = _write_fake_plugin(
        tmp_path,
        "def _build_codex_client():\n    return object()\n"
        "def _collect_image_b64(client, *, prompt, size, quality):\n"
        "    return None\n",
    )
    monkeypatch.setenv(codex_render.ENV_PLUGIN_PATH, str(plugin))
    monkeypatch.setenv(codex_render.ENV_HERMES_SRC, str(tmp_path))
    with pytest.raises(codex_render.CodexRenderError, match="no image"):
        codex_render.render_image("a roof", "1x1")


def test_render_image_missing_helper_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A plugin missing the helpers we depend on fails loudly."""
    plugin = _write_fake_plugin(tmp_path, "X = 1\n")
    monkeypatch.setenv(codex_render.ENV_PLUGIN_PATH, str(plugin))
    monkeypatch.setenv(codex_render.ENV_HERMES_SRC, str(tmp_path))
    with pytest.raises(codex_render.CodexRenderError, match="missing required helper"):
        codex_render.render_image("a roof", "1x1")
