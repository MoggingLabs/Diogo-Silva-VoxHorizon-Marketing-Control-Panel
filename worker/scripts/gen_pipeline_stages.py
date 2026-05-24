#!/usr/bin/env python3
"""Generate the worker's pipeline-stage mirror from ``lib/pipeline/stages.ts``.

E2.1 stage registry: the 12-stage DAG + each stage's mechanism / class /
per-creative flag / hard-gate flag / next edge live ONCE in the checked-in TS
manifest ``lib/pipeline/stages.ts`` (``PIPELINE_STAGE_REGISTRY``). This script
parses that manifest and emits ``worker/src/generated/pipeline_stages.py`` so the
Python worker stops hand-maintaining the ``PipelineStage`` Literal that used to
live in ``services/pipeline_runner.py``.

It mirrors the #550 ``gen_db_enums.py`` codegen pattern (same allow-listed,
committed-output, ``--check`` drift-gate shape) but its upstream is the stage
registry rather than the DB enum block. The two share a value set -- the registry
order MUST equal the DB ``pipeline_status_enum`` order -- which is asserted from
both sides: the TS ``stages.parity.test.ts`` and the worker
``test_pipeline_stages_parity.py``.

Usage::

    # regenerate the Python mirror in place
    uv run python scripts/gen_pipeline_stages.py

    # CI / pre-commit drift gate: exit 1 if the committed file is stale
    uv run python scripts/gen_pipeline_stages.py --check

Run both from the ``worker/`` directory (paths resolve relative to the repo root,
the parent of ``worker/``).
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Repo layout: this file lives at <repo>/worker/scripts/gen_pipeline_stages.py.
REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST = REPO_ROOT / "lib" / "pipeline" / "stages.ts"
OUT_FILE = REPO_ROOT / "worker" / "src" / "generated" / "pipeline_stages.py"

# The registry literal we slice out of the manifest. Everything between the
# opening bracket of `PIPELINE_STAGE_REGISTRY: readonly StageDef[] = [` and its
# matching `] as const;` is the array body.
_REGISTRY_START = "export const PIPELINE_STAGE_REGISTRY: readonly StageDef[] = ["
_REGISTRY_END = "] as const;"


class StageRow:
    """One parsed stage entry from the TS registry."""

    __slots__ = ("key", "mechanism", "stage_class", "phase", "per_creative", "hard_gate", "next")

    def __init__(
        self,
        *,
        key: str,
        mechanism: str,
        stage_class: str,
        phase: str,
        per_creative: bool,
        hard_gate: bool,
        next_: str | None,
    ) -> None:
        self.key = key
        self.mechanism = mechanism
        self.stage_class = stage_class
        self.phase = phase
        self.per_creative = per_creative
        self.hard_gate = hard_gate
        self.next = next_


def _extract_registry_body(source: str) -> str:
    """Return the array body of ``PIPELINE_STAGE_REGISTRY`` from the manifest."""
    start = source.find(_REGISTRY_START)
    if start == -1:
        raise SystemExit(
            f"could not find `{_REGISTRY_START}` in {MANIFEST} "
            "(did the registry export name change?)"
        )
    body_start = start + len(_REGISTRY_START)
    end = source.find(_REGISTRY_END, body_start)
    if end == -1:
        raise SystemExit(f"could not find `{_REGISTRY_END}` after the registry in {MANIFEST}")
    return source[body_start:end]


def _parse_field(block: str, name: str) -> str | None:
    """Return the raw value text of ``name: <value>`` inside one object block."""
    m = re.search(rf'{name}:\s*("?[A-Za-z_][A-Za-z0-9_]*"?|true|false|null)', block)
    return m.group(1) if m else None


def _unquote(value: str | None) -> str | None:
    if value is None:
        return None
    return value.strip('"')


def _parse_registry(body: str) -> list[StageRow]:
    """Parse each ``{ key: ..., mechanism: ..., ... }`` object into a StageRow.

    The manifest writes one object per stage as a brace-delimited block. We split
    on top-level objects by matching balanced braces, then pull each field by
    name -- order-independent and robust to formatting / extra fields.
    """
    rows: list[StageRow] = []
    depth = 0
    buf: list[str] = []
    for ch in body:
        if ch == "{":
            if depth == 0:
                buf = []
            depth += 1
            buf.append(ch)
        elif ch == "}":
            depth -= 1
            buf.append(ch)
            if depth == 0:
                block = "".join(buf)
                key = _unquote(_parse_field(block, "key"))
                if key is None:
                    # Not a stage object (shouldn't happen) -- skip defensively.
                    continue
                mechanism = _unquote(_parse_field(block, "mechanism"))
                stage_class = _unquote(_parse_field(block, "stageClass"))
                phase = _unquote(_parse_field(block, "phase"))
                per_creative = _parse_field(block, "perCreative") == "true"
                hard_gate = _parse_field(block, "hardGate") == "true"
                next_raw = _parse_field(block, "next")
                next_ = None if next_raw in (None, "null") else _unquote(next_raw)
                if mechanism is None or stage_class is None or phase is None:
                    raise SystemExit(
                        f"stage `{key}` in {MANIFEST} is missing a required field "
                        "(mechanism / stageClass / phase)"
                    )
                rows.append(
                    StageRow(
                        key=key,
                        mechanism=mechanism,
                        stage_class=stage_class,
                        phase=phase,
                        per_creative=per_creative,
                        hard_gate=hard_gate,
                        next_=next_,
                    )
                )
        elif depth > 0:
            buf.append(ch)
    if not rows:
        raise SystemExit(f"parsed zero stages from the registry in {MANIFEST}")
    return rows


def _py_str(value: str | None) -> str:
    return "None" if value is None else f'"{value}"'


def _render(rows: list[StageRow]) -> str:
    """Render the generated Python module text."""
    keys = [r.key for r in rows]
    literal_args = ", ".join(f'"{k}"' for k in keys)
    tuple_args = ", ".join(f'"{k}"' for k in keys)
    per_creative = [r.key for r in rows if r.per_creative]
    hard_gate = [r.key for r in rows if r.hard_gate]

    lines: list[str] = [
        '"""Generated pipeline-stage mirror -- DO NOT EDIT BY HAND.',
        "",
        "Source of truth: the stage registry in ``lib/pipeline/stages.ts``",
        "(``PIPELINE_STAGE_REGISTRY``). Regenerate this module with::",
        "",
        "    uv run python scripts/gen_pipeline_stages.py",
        "",
        "and verify it in CI with ``--check``. See ``docs/codegen.md``.",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "from typing import Literal",
        "",
        "# pipeline_status_enum / PIPELINE_STAGE_REGISTRY order (DAG + terminal cancelled)",
        f"PipelineStage = Literal[{literal_args}]",
        f"PIPELINE_STAGES: tuple[PipelineStage, ...] = ({tuple_args})",
        "",
        "# Per-creative gate stages (registry `perCreative` flag).",
    ]
    pc_args = ", ".join(f'"{k}"' for k in per_creative)
    lines.append(f"PER_CREATIVE_STAGES: tuple[PipelineStage, ...] = ({pc_args})")
    lines.append("")
    lines.append("# Hard-gate stages (registry `hardGate` flag): compliance + launch.")
    hg_args = ", ".join(f'"{k}"' for k in hard_gate)
    lines.append(f"HARD_GATE_STAGES: tuple[PipelineStage, ...] = ({hg_args})")
    lines.append("")
    lines.append("# Each stage's advance mechanism (registry `mechanism`).")
    lines.append("STAGE_MECHANISM: dict[PipelineStage, str] = {")
    for r in rows:
        lines.append(f'    "{r.key}": "{r.mechanism}",')
    lines.append("}")
    lines.append("")
    lines.append("# Each stage's successor in the DAG (registry `next`; None at terminals).")
    lines.append("NEXT_STAGE: dict[PipelineStage, str | None] = {")
    for r in rows:
        lines.append(f'    "{r.key}": {_py_str(r.next)},')
    lines.append("}")
    lines.append("")
    lines.append("__all__ = [")
    for name in [
        "HARD_GATE_STAGES",
        "NEXT_STAGE",
        "PER_CREATIVE_STAGES",
        "PIPELINE_STAGES",
        "PipelineStage",
        "STAGE_MECHANISM",
    ]:
        lines.append(f'    "{name}",')
    lines.append("]")
    lines.append("")
    return "\n".join(lines)


def generate() -> str:
    if not MANIFEST.exists():
        raise SystemExit(f"stage manifest not found at {MANIFEST}")
    source = MANIFEST.read_text(encoding="utf-8")
    body = _extract_registry_body(source)
    rows = _parse_registry(body)
    return _render(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit 1 if the committed pipeline_stages.py differs from a fresh generation",
    )
    args = parser.parse_args(argv)

    rendered = generate()

    if args.check:
        if not OUT_FILE.exists():
            print(
                f"pipeline_stages.py is missing at {OUT_FILE}; run "
                "`uv run python scripts/gen_pipeline_stages.py`",
                file=sys.stderr,
            )
            return 1
        existing = OUT_FILE.read_text(encoding="utf-8")
        if existing != rendered:
            print(
                "pipeline_stages.py is stale -- regenerate with "
                "`uv run python scripts/gen_pipeline_stages.py` and commit the result.",
                file=sys.stderr,
            )
            return 1
        print("pipeline_stages.py is up to date.")
        return 0

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(rendered, encoding="utf-8")
    print(f"wrote {OUT_FILE.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
