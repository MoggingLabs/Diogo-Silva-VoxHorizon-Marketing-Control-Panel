"""Tests for the Drive folder routing + filename builders.

The actual ``gog`` CLI call is mocked behind an asyncio subprocess fixture
so these tests run on Linux CI without needing the Mac toolchain installed.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.services import drive as drive_mod
from src.services.drive import (
    FOLDER_IDS,
    build_image_filename,
    build_video_filename,
    parse_drive_url,
    route_folder,
    route_subpath,
    upload_to_drive,
)


# ---------------------------------------------------------------------------
# route_folder — image vs. video parent
# ---------------------------------------------------------------------------


def test_image_routes_to_3_image_ads() -> None:
    assert route_folder(service_type="roofing", branded=True, fmt="image") == FOLDER_IDS["3_image_ads"]
    assert route_folder(service_type="roofing", branded=False, fmt="image") == FOLDER_IDS["3_image_ads"]
    assert route_folder(service_type="remodeling", branded=True, fmt="image") == FOLDER_IDS["3_image_ads"]


def test_video_routes_to_4_2_video_output() -> None:
    assert route_folder(service_type="roofing", branded=True, fmt="video") == FOLDER_IDS["4.2_video_output"]
    assert route_folder(service_type="roofing", branded=False, fmt="video") == FOLDER_IDS["4.2_video_output"]
    assert route_folder(service_type="remodeling", branded=True, fmt="video") == FOLDER_IDS["4.2_video_output"]


# ---------------------------------------------------------------------------
# route_subpath — sub-tree under the parent folder
# ---------------------------------------------------------------------------


def test_subpath_roofing_branded_with_state_and_client() -> None:
    assert (
        route_subpath(service_type="roofing", branded=True, state="TX", client_slug="sunny-day")
        == "TX/sunny-day/"
    )


def test_subpath_roofing_unbranded_goes_universal() -> None:
    assert route_subpath(service_type="roofing", branded=False, state="TX", client_slug="x") == "_Universal/"


def test_subpath_remodeling_goes_universal() -> None:
    assert route_subpath(service_type="remodeling", branded=True, state="TX", client_slug="x") == "_Universal/"
    assert route_subpath(service_type="remodeling", branded=False, state=None, client_slug=None) == "_Universal/"


def test_subpath_branded_falls_back_when_inputs_thin() -> None:
    assert route_subpath(service_type="roofing", branded=True, state=None, client_slug=None) == "_Universal/"
    assert route_subpath(service_type="roofing", branded=True, state="CA", client_slug=None) == "CA/"
    # Line 115: client_slug only, no state.
    assert route_subpath(service_type="roofing", branded=True, state=None, client_slug="sunny") == "sunny/"


# ---------------------------------------------------------------------------
# Filename builders
# ---------------------------------------------------------------------------


def test_build_image_filename_matches_naming_convention() -> None:
    name = build_image_filename(
        client_label="Sunny Day Roofing",
        concept="Storm Damage",
        ratio="1x1",
        version="v1.0",
    )
    assert name == "Sunny Day Roofing | Storm Damage | 1x1 | v1.0.png"


def test_build_image_filename_strips_pipe_chars_in_fields() -> None:
    # Pipe is the field delimiter — strip it from free-text fields so the
    # downstream parser doesn't get confused.
    name = build_image_filename(
        client_label="A | B",
        concept="C | D",
        ratio="9x16",
        version="v2.3",
    )
    assert name == "A / B | C / D | 9x16 | v2.3.png"


def test_build_image_filename_accepts_version_with_or_without_v_prefix() -> None:
    a = build_image_filename(client_label="x", concept="y", ratio="16x9", version="v1.0")
    b = build_image_filename(client_label="x", concept="y", ratio="16x9", version="1.0")
    assert a == b == "x | y | 16x9 | v1.0.png"


def test_build_video_filename_matches_naming_convention() -> None:
    name = build_video_filename(
        client_label="Sunny Day Roofing",
        concept="Storm Damage",
        duration_s=30,
        version="v1.0",
    )
    assert name == "Sunny Day Roofing | Storm Damage | 30s | v1.0.png".replace("png", "mp4")


def test_build_video_filename_strips_pipe() -> None:
    name = build_video_filename(
        client_label="A | B",
        concept="C | D",
        duration_s=15,
        version="v2.0",
    )
    assert name == "A / B | C / D | 15s | v2.0.mp4"


# ---------------------------------------------------------------------------
# parse_drive_url
# ---------------------------------------------------------------------------


def test_parse_drive_url_extracts_first_match() -> None:
    out = "Uploaded: https://drive.google.com/file/d/abc123/view?usp=drivesdk\n"
    assert parse_drive_url(out) == "https://drive.google.com/file/d/abc123/view?usp=drivesdk"


def test_parse_drive_url_raises_when_no_url() -> None:
    with pytest.raises(RuntimeError, match="could not find Drive URL"):
        parse_drive_url("nothing here")


# ---------------------------------------------------------------------------
# upload_to_drive — mocked asyncio subprocess
# ---------------------------------------------------------------------------


@pytest.fixture
def sample_png(tmp_path: Path) -> Path:
    p = tmp_path / "creative.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    return p


def _mock_subprocess(returncode: int, stdout: bytes, stderr: bytes = b"") -> AsyncMock:
    """Build an AsyncMock that mimics asyncio.create_subprocess_exec()."""
    proc = MagicMock()
    proc.returncode = returncode
    proc.communicate = AsyncMock(return_value=(stdout, stderr))
    return AsyncMock(return_value=proc)


def test_upload_to_drive_returns_url_on_success(sample_png: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_exec = _mock_subprocess(
        0, b"Uploaded: https://drive.google.com/file/d/xyz789/view\n"
    )
    monkeypatch.setattr(drive_mod, "_resolve_gog_binary", lambda: "/usr/local/bin/gog")
    monkeypatch.setattr(drive_mod.asyncio, "create_subprocess_exec", fake_exec)

    url = asyncio.run(
        upload_to_drive(
            sample_png,
            filename="x | y | 1x1 | v1.0.png",
            parent_folder_id="folder123",
            subpath="TX/sunny-day/",
        )
    )

    assert url == "https://drive.google.com/file/d/xyz789/view"
    args, _kwargs = fake_exec.call_args
    cmd = list(args)
    assert cmd[0] == "/usr/local/bin/gog"
    assert "--parent" in cmd and "folder123" in cmd
    assert "--name" in cmd and "x | y | 1x1 | v1.0.png" in cmd
    assert "--subpath" in cmd and "TX/sunny-day/" in cmd
    assert str(sample_png) in cmd


def test_upload_to_drive_omits_subpath_when_empty(sample_png: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_exec = _mock_subprocess(
        0, b"Uploaded: https://drive.google.com/file/d/abc/view\n"
    )
    monkeypatch.setattr(drive_mod, "_resolve_gog_binary", lambda: "/usr/local/bin/gog")
    monkeypatch.setattr(drive_mod.asyncio, "create_subprocess_exec", fake_exec)

    asyncio.run(
        upload_to_drive(
            sample_png,
            filename="x.png",
            parent_folder_id="folder123",
            subpath="",
        )
    )
    cmd = list(fake_exec.call_args.args)
    assert "--subpath" not in cmd


def test_upload_to_drive_raises_on_nonzero_exit(sample_png: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_exec = _mock_subprocess(2, b"", b"401 unauthorized\n")
    monkeypatch.setattr(drive_mod, "_resolve_gog_binary", lambda: "/usr/local/bin/gog")
    monkeypatch.setattr(drive_mod.asyncio, "create_subprocess_exec", fake_exec)

    with pytest.raises(RuntimeError, match="gog upload failed"):
        asyncio.run(
            upload_to_drive(
                sample_png,
                filename="x.png",
                parent_folder_id="folder123",
            )
        )


def test_upload_to_drive_raises_when_gog_missing(sample_png: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(drive_mod.shutil, "which", lambda _name: None)
    with pytest.raises(RuntimeError, match="gog CLI not found"):
        asyncio.run(
            upload_to_drive(
                sample_png,
                filename="x.png",
                parent_folder_id="folder123",
            )
        )


def test_upload_to_drive_raises_when_local_missing(tmp_path: Path) -> None:
    missing = tmp_path / "ghost.png"
    with pytest.raises(FileNotFoundError):
        asyncio.run(
            upload_to_drive(
                missing,
                filename="x.png",
                parent_folder_id="folder123",
            )
        )


def test_folder_ids_table_is_stable() -> None:
    """Regression guard: the operator depends on these IDs being constant."""
    # Spot-check the two parents most exercised by Wave 4.
    assert FOLDER_IDS["3_image_ads"] == "1C3KA10R1vH39bTPWXoey-tub8bajd7FQ"
    assert FOLDER_IDS["4.2_video_output"] == "17HZ41N0-uKyTRg1fVM5phd5oe0TPRpvq"


def test_resolve_gog_binary_returns_path_when_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Line 147: ``_resolve_gog_binary`` returns the resolved path."""
    monkeypatch.setattr(drive_mod.shutil, "which", lambda _n: "/usr/local/bin/gog")
    assert drive_mod._resolve_gog_binary() == "/usr/local/bin/gog"


def test_resolve_gog_binary_raises_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(drive_mod.shutil, "which", lambda _n: None)
    with pytest.raises(RuntimeError, match="gog CLI not found"):
        drive_mod._resolve_gog_binary()
