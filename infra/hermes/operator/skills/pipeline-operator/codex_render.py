"""In-container codex image renderer for the pipeline operator.

This module is the *subscription-backed render backend* for
``pipeline_operator_render`` (see :mod:`helper`). Instead of paying Kie, it
generates the ad image IN THE OPERATOR CONTAINER using Hermes' bundled codex
image-gen plugin — i.e. the operator's own ChatGPT/Codex OAuth (the manager's
subscription, $0) calling ``gpt-image-2`` through the Codex Responses
``image_generation`` tool on ``https://chatgpt.com/backend-api/codex``.

Why we reuse Hermes' plugin (not a hand-rolled OpenAI call)
----------------------------------------------------------
The plugin already encapsulates the exact working call pattern a prior deepdive
proved: the canonical Codex OAuth token reader
(``agent.auxiliary_client._read_codex_access_token``), the Cloudflare headers,
the ``responses.stream(...)`` request with the ``image_generation`` tool, and
the b64 result extraction. We import the plugin module and call its lower-level
helpers (``_build_codex_client`` + ``_collect_image_b64``) so we stay in
lockstep with whatever Hermes ships — but pass an EXPLICIT pixel ``size`` so we
get a TRUE 9:16 (864x1536) instead of the plugin's public ``generate()``, whose
``portrait`` aspect maps to 2:3 (1024x1536).

The 9:16 fix (no VPS plugin edit required)
------------------------------------------
``gpt-image-2`` accepts non-square sizes up to 3:1, and the Codex backend
honors ``size="864x1536"`` even though the OpenAI SDK's local pydantic model
only *declares* the three canonical sizes (it emits a harmless serialization
warning). Calling ``_collect_image_b64(..., size="864x1536")`` therefore returns
a real 864x1536 PNG — verified on the VPS. So finals get true 9:16 directly from
codex with no plugin patch and no post-crop.

Config (env)
------------
* ``HERMES_CODEX_PLUGIN_PATH`` — path to the plugin ``__init__.py``. Default
  ``/opt/hermes/plugins/image_gen/openai-codex/__init__.py``.
* ``HERMES_SRC_PATH`` — the Hermes source root to put on ``sys.path`` so the
  plugin's ``from agent.image_gen_provider import ...`` resolves. Default
  ``/opt/hermes``.
* ``OPENAI_IMAGE_QUALITY`` — ``low`` | ``medium`` | ``high`` codex image
  quality. Default ``high`` for finals-grade output.

Everything is lazy: importing this module is free and never touches the
plugin, the network, or the OAuth token. The work happens only when
:func:`render_image` is called, so the helper's non-codex (Kie) path and the
unit tests don't need Hermes installed.
"""

from __future__ import annotations

import base64
import importlib.util
import os
import sys
from typing import Any, Optional


class CodexRenderError(Exception):
    """Raised when in-container codex image generation fails."""


#: Default location of the Hermes codex image-gen plugin inside the operator
#: container (confirmed on the VPS).
DEFAULT_PLUGIN_PATH = "/opt/hermes/plugins/image_gen/openai-codex/__init__.py"
#: Default Hermes source root (editable install) the plugin imports ``agent``
#: from.
DEFAULT_HERMES_SRC = "/opt/hermes"

ENV_PLUGIN_PATH = "HERMES_CODEX_PLUGIN_PATH"
ENV_HERMES_SRC = "HERMES_SRC_PATH"
ENV_IMAGE_QUALITY = "OPENAI_IMAGE_QUALITY"

#: Ratio → explicit pixel size for gpt-image-2. 9x16 is TRUE 9:16 (864x1536),
#: not the plugin's 2:3 portrait (1024x1536). 16x9 mirrors it.
RATIO_TO_SIZE: dict[str, str] = {
    "1x1": "1024x1024",
    "9x16": "864x1536",
    "16x9": "1536x864",
}

_VALID_QUALITY = frozenset({"low", "medium", "high"})

# Cache the loaded plugin module so repeated renders in one process don't
# re-exec the plugin file.
_plugin_module: Any = None


def _load_plugin() -> Any:
    """Import the Hermes codex image-gen plugin module (cached).

    Puts the Hermes source root on ``sys.path`` first so the plugin's
    top-level ``from agent.image_gen_provider import ...`` resolves, then
    loads the plugin ``__init__.py`` by path under a private module name.
    """
    global _plugin_module
    if _plugin_module is not None:
        return _plugin_module

    hermes_src = os.environ.get(ENV_HERMES_SRC, "").strip() or DEFAULT_HERMES_SRC
    if hermes_src and hermes_src not in sys.path:
        sys.path.insert(0, hermes_src)

    plugin_path = (
        os.environ.get(ENV_PLUGIN_PATH, "").strip() or DEFAULT_PLUGIN_PATH
    )
    if not os.path.isfile(plugin_path):
        raise CodexRenderError(
            f"codex image plugin not found at {plugin_path!r} "
            f"(set {ENV_PLUGIN_PATH} to override)"
        )

    spec = importlib.util.spec_from_file_location(
        "_voxhorizon_codex_imggen", plugin_path
    )
    if spec is None or spec.loader is None:
        raise CodexRenderError(f"could not load codex plugin spec from {plugin_path!r}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:  # noqa: BLE001 — surface a clean operator error
        raise CodexRenderError(
            f"failed to import codex plugin {plugin_path!r}: {exc}"
        ) from exc

    # Sanity-check the helpers we depend on are present (guards against a
    # future Hermes refactor silently changing the surface).
    for attr in ("_build_codex_client", "_collect_image_b64"):
        if not hasattr(module, attr):
            raise CodexRenderError(
                f"codex plugin {plugin_path!r} is missing required helper {attr!r}"
            )

    _plugin_module = module
    return module


def _resolve_quality() -> str:
    q = os.environ.get(ENV_IMAGE_QUALITY, "").strip().lower()
    return q if q in _VALID_QUALITY else "high"


def size_for_ratio(ratio: str) -> str:
    """Return the explicit gpt-image-2 pixel size for a worker ratio label."""
    size = RATIO_TO_SIZE.get(ratio)
    if size is None:
        raise CodexRenderError(
            f"unsupported ratio {ratio!r} (expected one of {sorted(RATIO_TO_SIZE)})"
        )
    return size


def render_image(
    prompt: str,
    ratio: str,
    *,
    quality: Optional[str] = None,
) -> bytes:
    """Generate one image via the operator's ChatGPT/Codex subscription.

    Returns the raw PNG bytes. ``ratio`` is a worker ratio label
    (``1x1`` / ``9x16`` / ``16x9``); it is mapped to an explicit pixel size so
    9:16 finals come back as a true 864x1536 PNG. ``quality`` overrides the
    ``OPENAI_IMAGE_QUALITY`` env (default ``high``).

    Raises :class:`CodexRenderError` on any failure (missing plugin, no OAuth
    token, empty response, bad base64).
    """
    prompt = (prompt or "").strip()
    if not prompt:
        raise CodexRenderError("prompt must be a non-empty string")

    size = size_for_ratio(ratio)
    q = (quality or _resolve_quality()).strip().lower()
    if q not in _VALID_QUALITY:
        q = "high"

    plugin = _load_plugin()

    client = plugin._build_codex_client()
    if client is None:
        raise CodexRenderError(
            "could not initialize Codex image client — no ChatGPT/Codex OAuth "
            "credentials available in the operator container (auth.json)"
        )

    try:
        b64 = plugin._collect_image_b64(
            client, prompt=prompt, size=size, quality=q
        )
    except Exception as exc:  # noqa: BLE001 — wrap any SDK/network failure
        raise CodexRenderError(
            f"codex image generation failed (ratio={ratio}, size={size}): {exc}"
        ) from exc

    if not b64:
        raise CodexRenderError(
            f"codex returned no image for ratio={ratio} (size={size})"
        )

    try:
        return base64.b64decode(b64)
    except Exception as exc:  # noqa: BLE001
        raise CodexRenderError(f"codex returned invalid base64: {exc}") from exc


__all__ = [
    "CodexRenderError",
    "DEFAULT_PLUGIN_PATH",
    "DEFAULT_HERMES_SRC",
    "ENV_PLUGIN_PATH",
    "ENV_HERMES_SRC",
    "ENV_IMAGE_QUALITY",
    "RATIO_TO_SIZE",
    "render_image",
    "size_for_ratio",
]
