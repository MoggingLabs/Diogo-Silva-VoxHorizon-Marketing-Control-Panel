"""Docker-socket bridge to the colocated ``hermes-agent-operator`` container.

This mirrors :mod:`worker.src.services.hermes_bridge` but targets a
*separate* Hermes container: the dedicated **operator** agent that drives
the image-ad pipeline like a hired employee. We keep it a distinct service
(rather than parameterising HermesBridge) so the two agents never share an
exec-tracking map or a default container name, and so the operator's
fire-and-forget dispatch semantics stay isolated from Ekko's bidirectional
chat streaming.

The operator is kicked by the dashboard's stage-gate flow (config approved
→ author concepts; picks set → render finals). The dashboard does NOT want
to stream the operator's stdout — it watches progress through
``pipeline_events`` / Realtime instead. So the public surface here is a
single fire-and-forget :meth:`dispatch` that runs ``hermes chat -q
<instruction> --pass-session-id <pipeline_id>`` and drains stdout to
completion in the background, discarding the bytes.

Like the Ekko bridge we use the host Docker socket via ``docker exec``
rather than an HTTP hop, and run the blocking SDK iterator on a worker
thread so the FastAPI event loop stays responsive.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import docker
import docker.errors
import structlog


log = structlog.get_logger(__name__)


DEFAULT_OPERATOR_CONTAINER = "hermes-agent-operator"
"""Default container name. Overridable via ``OPERATOR_CONTAINER_NAME``."""


class OperatorBridgeError(RuntimeError):
    """Raised when the bridge can't start the operator exec.

    The route layer catches this so a docker failure surfaces as a clean
    HTTP error rather than a raw ``docker.errors.*`` exception.
    """


class OperatorBridge:
    """Thin wrapper around the Docker SDK for the operator ``hermes chat`` exec.

    A single instance is reused across requests (the route layer holds a
    module-level singleton) so the underlying ``DockerClient`` socket pool
    is shared. The class is stateless — dispatch is fire-and-forget, so we
    don't track live execs the way the Ekko bridge does for abort.
    """

    def __init__(
        self,
        container_name: str | None = None,
        client: Any | None = None,
    ) -> None:
        self.container_name = container_name or os.environ.get(
            "OPERATOR_CONTAINER_NAME", DEFAULT_OPERATOR_CONTAINER
        )
        # ``client`` is injectable for tests; production callers leave it
        # None so ``docker.from_env()`` picks up DOCKER_HOST /
        # /var/run/docker.sock from the environment.
        self._client = client if client is not None else docker.from_env()

    def _api(self) -> Any:
        """Return the low-level ``APIClient`` used for exec calls."""
        return self._client.api

    @staticmethod
    def _build_argv(instruction: str, session_id: str | None) -> list[str]:
        """Assemble the operator ``hermes chat`` command-line.

        Kept static + small so tests can pin the exact argv we send to
        ``exec_create`` without spinning up a real bridge. The session
        flag is ``--pass-session-id`` per the Hermes CLI contract; the
        pipeline id IS the operator's session id, which is how the
        playbook re-loads pipeline state on each dispatch.
        """
        argv = ["hermes", "chat", "-q", instruction]
        if session_id:
            argv.extend(["--pass-session-id", session_id])
        return argv

    async def dispatch(self, instruction: str, session_id: str) -> None:
        """Run ``hermes chat`` in the operator container, draining stdout.

        Fire-and-forget: we open the exec, then pull the stdout stream to
        EOF on a worker thread so the operator process isn't reaped early
        by Docker closing the exec, but we discard the bytes — the caller
        does not receive a stream. Intended to be scheduled on a FastAPI
        ``BackgroundTask`` so the HTTP handler returns immediately.

        Raises :class:`OperatorBridgeError` if the exec can't be created;
        once streaming has started, transient stream errors are logged and
        swallowed (the operator's own progress lands in ``pipeline_events``,
        so a dropped stdout tail must not crash the background task).
        """
        argv = self._build_argv(instruction, session_id)
        api = self._api()
        try:
            exec_create = api.exec_create(
                self.container_name,
                argv,
                stdout=True,
                stderr=True,
                tty=False,
            )
        except docker.errors.NotFound as exc:
            raise OperatorBridgeError(
                f"Operator container '{self.container_name}' not found"
            ) from exc
        except docker.errors.APIError as exc:
            raise OperatorBridgeError(
                f"docker exec_create failed: {exc}"
            ) from exc

        # Normalise the dict / bare-id shapes the SDK returns across
        # versions.
        exec_id = (
            exec_create["Id"] if isinstance(exec_create, dict) else exec_create
        )
        log.info(
            "operator_bridge_dispatch_started",
            container=self.container_name,
            exec_id=exec_id,
            session_id=session_id,
        )

        try:
            stream = api.exec_start(exec_id, stream=True)
            # Drain to completion on a worker thread; we don't yield the
            # chunks anywhere — this just keeps the exec alive until the
            # operator finishes its turn.
            await asyncio.to_thread(_drain, stream)
        except docker.errors.APIError as exc:
            log.warning(
                "operator_bridge_stream_failed",
                exec_id=exec_id,
                session_id=session_id,
                error=str(exc),
            )
        log.info(
            "operator_bridge_dispatch_done",
            exec_id=exec_id,
            session_id=session_id,
        )


def _drain(stream: Any) -> None:
    """Exhaust a blocking byte-stream iterator, discarding the chunks.

    Lives at module scope so ``asyncio.to_thread`` has a stable, picklable
    reference. Any iteration error is left to propagate to the caller's
    ``try`` (which logs it) — we don't want to hide a docker-side failure.
    """
    for _chunk in stream:
        pass


# Module-level singleton — the route layer reuses one bridge so the Docker
# socket pool is shared. Tests reset it via :func:`reset_operator_bridge`.
_singleton: OperatorBridge | None = None


def get_operator_bridge() -> OperatorBridge:
    """Return the process-wide :class:`OperatorBridge` singleton."""
    global _singleton
    if _singleton is None:
        _singleton = OperatorBridge()
    return _singleton


def reset_operator_bridge() -> None:
    """Drop the singleton so the next accessor rebuilds it (test seam)."""
    global _singleton
    _singleton = None
