"""Google Drive upload service.

The worker shells out to the ``gog`` CLI (Diogo's Drive multi-account shim)
to upload finished creatives into the marketing-dept Drive tree. The CLI is
NOT installed in CI / WSL dev environments — these helpers degrade to a
clear ``RuntimeError`` when ``gog`` is missing so the route can return a
structured 503 rather than an opaque crash.

Folder layout mirrors the live marketing-dept Drive tree (see
``ARCHITECTURE.md`` and ``lib/drive-routing.ts``):

    60.2 Marketing Dept (root)
    ├─ 0 Sourcing
    ├─ 1 Radar
    ├─ 2 Strategy
    ├─ 3 Image Ads          ← image creatives (sub-pathed by state/client)
    ├─ 4.1 Video Input
    ├─ 4.2 Video Output     ← video creatives (sub-pathed by state/client)
    ├─ 5 Copy
    ├─ 6 Launch
    └─ 7 Ops

The exact folder IDs are the live IDs from Diogo's account. They are stable
across the lifetime of v1 so we hardcode them rather than reading from
``clients.drive_root_folder_id`` (which is reserved for future per-client
overrides).
"""

from __future__ import annotations

import asyncio
import re
import shutil
from pathlib import Path
from typing import Literal


# Google account that owns the marketing-dept Drive tree. The ``gog`` CLI
# uses this to pick a token from its account store.
GOG_ACCOUNT = "diogo@voxhorizon.com"

# Hardcoded Drive folder IDs. Keys are stable identifiers; values are the
# live folder IDs from production. See module docstring for the layout.
FOLDER_IDS: dict[str, str] = {
    "60.2_marketing_dept": "15WwyDWgVOxoqqj5QxjXR8tS354WQZ0go",
    "0_sourcing": "1vKm9eg9tGtxZMJTjw_rwYnXQD33DH9o-",
    "1_radar": "1LHQz0GiFSQ6mnxvLI0ZHWSb617MMTsp_",
    "2_strategy": "1V5cnU-6-UKLf2prpXgIZoZ7pKCmWWi8Z",
    "3_image_ads": "1C3KA10R1vH39bTPWXoey-tub8bajd7FQ",
    "4.1_video_input": "1w4vtJB32CVkco-RctyH84XIvnD7lCGSL",
    "4.2_video_output": "17HZ41N0-uKyTRg1fVM5phd5oe0TPRpvq",
    "5_copy": "17ZFnZVULxkwbCszX1r_S1IEIQZmxxt15",
    "6_launch": "1_bS6gNQ8M-Ve5zFBPgR68DXXQlzvaY4a",
    "7_ops": "1fk4fJrGhM03grRsCI-YTh4rOBACKdf_z",
}

ServiceType = Literal["roofing", "remodeling"]
CreativeFormat = Literal["image", "video"]

# A Drive file URL we parse out of gog stdout. Matches both the modern
# ``/file/d/<id>/view`` and the older ``open?id=<id>`` shapes.
_DRIVE_URL_RE = re.compile(r"https?://(?:drive\.google\.com|drive\.googleusercontent\.com)\S+")


def route_folder(
    *,
    service_type: ServiceType,
    branded: bool,
    fmt: CreativeFormat,
) -> str:
    """Pick the parent Drive folder ID for a creative.

    Routing rules (mirrors ``lib/drive-routing.ts``):

    - **image + roofing + branded** → ``3 Image Ads`` (sub-pathed by state/client).
    - **image + roofing + unbranded** → ``3 Image Ads`` (``_Universal`` subtree).
    - **image + remodeling** → ``3 Image Ads`` (``_Universal`` subtree).
    - **video + roofing + branded** → ``4.2 Video Output`` (sub-pathed by state/client).
    - **video + roofing + unbranded** → ``4.2 Video Output`` (``_Universal`` subtree).
    - **video + remodeling** → ``4.2 Video Output`` (``_Universal`` subtree).

    For v1 we always return the parent (``3 Image Ads`` or
    ``4.2 Video Output``) — the gog CLI walks any sub-path provided
    via ``--subpath`` and creates folders if needed. The branded /
    unbranded / remodeling distinction shapes the sub-path the caller
    passes in, not the parent folder ID.
    """
    if fmt == "image":
        return FOLDER_IDS["3_image_ads"]
    return FOLDER_IDS["4.2_video_output"]


def route_subpath(
    *,
    service_type: ServiceType,
    branded: bool,
    state: str | None,
    client_slug: str | None,
) -> str:
    """Compute the sub-path within the parent folder.

    - **roofing + branded** → ``<state>/<client_slug>/`` (e.g. ``TX/sunny-day/``)
    - **roofing + unbranded** → ``_Universal/``
    - **remodeling** → ``_Universal/`` (no branded carve-out per the v1 spec)

    Returns ``""`` if the inputs are too thin to compute a meaningful
    sub-path — the gog CLI will then drop the file directly into the parent.
    """
    if service_type == "roofing" and branded:
        if state and client_slug:
            return f"{state}/{client_slug}/"
        if state:
            return f"{state}/"
        if client_slug:
            return f"{client_slug}/"
        return "_Universal/"
    return "_Universal/"


def parse_drive_url(stdout: str) -> str:
    """Pull the first Drive URL out of gog's stdout.

    ``gog drive upload`` prints a human-friendly success line that includes
    the public Drive URL. We extract it with a regex rather than rely on
    the exact wording because the CLI has been known to tweak its output
    formatting between releases.
    """
    match = _DRIVE_URL_RE.search(stdout)
    if not match:
        raise RuntimeError(f"could not find Drive URL in gog output: {stdout!r}")
    return match.group(0)


def _resolve_gog_binary() -> str:
    """Locate the ``gog`` binary, raising a friendly error if missing.

    The CLI is part of Diogo's Mac toolchain and isn't installed on Linux
    CI / WSL. Returning a clear failure here lets the route surface a 503
    instead of an obscure ``FileNotFoundError`` from ``create_subprocess_exec``.
    """
    binary = shutil.which("gog")
    if binary is None:
        raise RuntimeError(
            "gog CLI not found on PATH — Drive upload is unavailable in this environment. "
            "Install the marketing-dept toolchain (Mac) or stub the upload in tests."
        )
    return binary


async def upload_to_drive(
    local_path: Path,
    *,
    filename: str,
    parent_folder_id: str,
    subpath: str = "",
    account: str = GOG_ACCOUNT,
) -> str:
    """Upload ``local_path`` to Drive, naming it ``filename``.

    Returns the resulting Drive file URL on success. Raises
    ``RuntimeError`` if the CLI is missing or the upload exits non-zero.

    The function is ``async`` because we shell out via
    ``asyncio.create_subprocess_exec`` — keeps the FastAPI event loop free
    while the upload (potentially tens of MB) is in flight.
    """
    if not local_path.exists():
        raise FileNotFoundError(f"local_path does not exist: {local_path}")

    binary = _resolve_gog_binary()

    cmd: list[str] = [
        binary,
        "drive",
        "upload",
        "--account",
        account,
        "--parent",
        parent_folder_id,
        "--name",
        filename,
    ]
    if subpath:
        cmd.extend(["--subpath", subpath])
    cmd.append(str(local_path))

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out_b, err_b = await proc.communicate()
    out = out_b.decode("utf-8", errors="replace")
    err = err_b.decode("utf-8", errors="replace")

    if proc.returncode != 0:
        raise RuntimeError(f"gog upload failed (exit {proc.returncode}): {err.strip() or out.strip()}")

    return parse_drive_url(out)


def build_image_filename(
    *,
    client_label: str,
    concept: str,
    ratio: Literal["1x1", "9x16", "16x9"],
    version: str,
) -> str:
    """Compose a launch-ready image filename.

    Matches the naming convention enforced in ``lib/naming.ts`` and
    accepted by the upstream ``launch_package.py`` validator::

        <Client Label> | <Concept> | <Ratio> | v<X.Y>.png

    Inputs are not aggressively sanitised here — we trust the caller (the
    Next.js side has already validated, and the operator can override
    via the editable UI) but we DO strip ``|`` characters from the free-
    text fields to keep the delimiter unambiguous.
    """
    safe_client = client_label.replace("|", "/").strip()
    safe_concept = concept.replace("|", "/").strip()
    version_clean = version.lstrip("v")
    return f"{safe_client} | {safe_concept} | {ratio} | v{version_clean}.png"


def build_video_filename(
    *,
    client_label: str,
    concept: str,
    duration_s: int,
    version: str,
) -> str:
    """Same shape as :func:`build_image_filename` but for video creatives.

    The third segment is the duration in seconds (e.g. ``30s``) instead of
    the aspect ratio, mirroring the upstream convention::

        <Client Label> | <Concept> | <Ns> | v<X.Y>.mp4
    """
    safe_client = client_label.replace("|", "/").strip()
    safe_concept = concept.replace("|", "/").strip()
    version_clean = version.lstrip("v")
    return f"{safe_client} | {safe_concept} | {duration_s}s | v{version_clean}.mp4"
