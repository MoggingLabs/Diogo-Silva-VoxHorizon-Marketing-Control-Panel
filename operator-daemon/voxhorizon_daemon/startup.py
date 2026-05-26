"""Pure-function startup self-test.

Three checks in stable order. The order matches the dependency direction
so a queue-reachability failure short-circuits before we try to introspect
the Hermes container, and a missing container short-circuits before we
try to probe its auth. Each check has its own ``ok|fail`` + ``detail`` so
the dashboard can show exactly which step is the blocker.

The function is async because each check awaits I/O; it is otherwise
side-effect-free (no logging, no DB writes) so unit tests can compose
small fakes and assert on the structured return value.
"""

from __future__ import annotations

import asyncio
from typing import Any

import structlog

from .hermes_exec import HermesExec
from .queue_client import QueueAuthError, QueueClient, QueueServerError
from .types import StartupCheck, StartupCheckEntry


log = structlog.get_logger(__name__)


async def run_startup_check(
    *,
    queue_client: QueueClient,
    hermes_exec: HermesExec,
    auth_probe_enabled: bool = True,
) -> StartupCheck:
    """Run the three-step startup self-test and return a structured result.

    The three steps:

    1. ``queue_reachable`` — ``GET /work/health`` returns 2xx. A bad bearer
       (401/403) is FATAL and surfaces here as a queue-reachable failure so
       the daemon does not silently treat it as "Hermes is the problem".
    2. ``hermes_container_up`` — ``docker.containers.get(name).status`` is
       ``running``. Anything else (``exited``, ``not_found``, ``error:...``)
       is a fail.
    3. ``hermes_auth`` — :meth:`HermesExec.auth_probe` returns ``ok=True``.
       Skipped (and marked ok) when ``auth_probe_enabled`` is False; the
       daemon's settings default this to True in production.
    """

    queue_ok, queue_detail = await _probe_queue(queue_client)
    if not queue_ok:
        return StartupCheck(
            queue_reachable=StartupCheckEntry(ok=False, detail=queue_detail),
            hermes_container_up=StartupCheckEntry(
                ok=False, detail={"reason": "skipped_due_to_prior_failure"}
            ),
            hermes_auth=StartupCheckEntry(
                ok=False, detail={"reason": "skipped_due_to_prior_failure"}
            ),
        )

    container_status = await asyncio.to_thread(hermes_exec.container_status)
    if container_status == "running":
        container_entry = StartupCheckEntry(
            ok=True, detail={"status": container_status, "name": hermes_exec.container_name}
        )
    else:
        return StartupCheck(
            queue_reachable=StartupCheckEntry(ok=True, detail=queue_detail),
            hermes_container_up=StartupCheckEntry(
                ok=False,
                detail={
                    "status": container_status,
                    "name": hermes_exec.container_name,
                },
            ),
            hermes_auth=StartupCheckEntry(
                ok=False, detail={"reason": "skipped_due_to_prior_failure"}
            ),
        )

    if not auth_probe_enabled:
        return StartupCheck(
            queue_reachable=StartupCheckEntry(ok=True, detail=queue_detail),
            hermes_container_up=container_entry,
            hermes_auth=StartupCheckEntry(
                ok=True, detail={"reason": "probe_disabled"}
            ),
        )

    auth = await hermes_exec.auth_probe()
    return StartupCheck(
        queue_reachable=StartupCheckEntry(ok=True, detail=queue_detail),
        hermes_container_up=container_entry,
        hermes_auth=StartupCheckEntry(ok=auth.ok, detail=auth.detail),
    )


async def _probe_queue(client: QueueClient) -> tuple[bool, dict[str, Any]]:
    """Hit ``/work/health``; return (ok, detail). Auth failures classify here."""
    try:
        ok = await client.health_ping()
    except QueueAuthError as exc:
        return False, {"reason": "auth_rejected", "error": str(exc)}
    except QueueServerError as exc:
        return False, {"reason": "unreachable", "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — surface anything else cleanly
        return False, {"reason": "client_error", "error": str(exc)}
    if not ok:
        return False, {"reason": "non_2xx_response"}
    return True, {"reason": "ok"}


__all__ = ["run_startup_check"]
