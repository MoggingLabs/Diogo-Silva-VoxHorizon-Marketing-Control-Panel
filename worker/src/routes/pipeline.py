"""Pipeline router stub.

The original ~1500-line orchestrator (Wave 10/11/12 image+video pipeline)
was deleted in Wave 19 (HI-8) — Hermes/Ekko owns multi-stage agentic
work natively now via the kanban bridge (``/work/hermes/kanban``).

This file is intentionally empty: an :class:`APIRouter` with no
endpoints. The router is still wired into :mod:`worker.src.main` so any
in-flight import in app/api/* that references ``/work/pipeline/*``
404s cleanly rather than the worker process crashing on startup. The
Next.js side (HI-7) is repointing those calls to the Hermes kanban
surface; once that lands the import of ``pipeline`` from
:mod:`worker.src.main` can be removed entirely and this file deleted.

If you find yourself adding endpoints here, you're almost certainly
solving the problem in the wrong layer. The pipeline lives in Hermes
now.
"""

from __future__ import annotations

from fastapi import APIRouter


router = APIRouter()


__all__ = ["router"]
