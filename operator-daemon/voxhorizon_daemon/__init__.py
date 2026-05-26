"""VoxHorizon operator daemon package.

A sidecar container that drains the worker's ``work_item`` queue for the
``operator_dispatch`` kind. The package is intentionally narrow: one
async HTTP client (:mod:`queue_client`), one docker-exec wrapper
(:mod:`hermes_exec`), one pure-function startup self-test
(:mod:`startup`), one orchestrator (:mod:`daemon`), and one tiny
healthcheck sidecar (:mod:`healthz`).

The package is imported by tests via direct module access; ``__main__``
is the only entry point production uses.
"""

from __future__ import annotations

__version__ = "0.1.0"

__all__ = ["__version__"]
