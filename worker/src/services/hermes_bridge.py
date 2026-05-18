"""Docker-socket bridge to the colocated ``hermes-agent-ekko`` container.

The dashboard ↔ Hermes Ekko integration runs Hermes inside a sibling
container on the same host as the worker. Rather than expose Hermes over
HTTP we mount the host's Docker socket into this worker container and
invoke ``hermes chat -q <prompt>`` via ``docker exec``. That keeps every
shell out of a network hop (sub-15 ms overhead in practice), preserves
Hermes' session-id semantics, and lets us reuse the same container's
filesystem for any artifacts it produces.

Wire-level flow:

1. :func:`chat_stream` constructs the ``hermes chat`` argv, calls the
   Docker low-level ``APIClient.exec_create`` to make an exec instance
   in the target container, records the resulting ``exec_id`` in an
   in-memory map keyed by ``session_id``, then opens ``exec_start`` with
   ``stream=True`` so stdout is delivered chunk-by-chunk as Hermes
   writes it.
2. :func:`abort` looks up the recorded ``exec_id`` for a session,
   resolves the PID via ``exec_inspect``, and sends SIGTERM into the
   container with a second ``container.exec_run(["kill", "-TERM",
   <pid>])``. The Docker SDK doesn't ship an ``exec_kill`` primitive
   (verified with ``docker==7.1``: ``APIClient`` exposes only
   ``exec_create``, ``exec_inspect``, ``exec_resize``, ``exec_start``)
   so signalling the PID inside the target container is the supported
   path.
3. :func:`healthcheck` returns a small status dict the worker's
   ``/health`` route can include without bubbling raw Docker errors.

The async surface is iterator-shaped because callers (the SSE route in
:mod:`worker.src.routes.hermes_chat`) want backpressured streaming.
Internally we run the blocking iterator the SDK returns in a thread via
``asyncio.to_thread`` so we don't tie up the FastAPI event loop while
Hermes is mid-thought.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from typing import Any

import docker
import docker.errors
import structlog


log = structlog.get_logger(__name__)


DEFAULT_HERMES_CONTAINER = "hermes-agent-ekko"
"""Default container name. Overridable via ``HERMES_CONTAINER_NAME``."""


class HermesBridgeError(RuntimeError):
    """Raised when the bridge can't establish or sustain an exec stream.

    The route layer catches this to surface a clean SSE ``error`` frame
    rather than letting a raw ``docker.errors.*`` exception propagate.
    """


class HermesBridge:
    """Thin wrapper around the Docker SDK for ``hermes chat`` exec calls.

    A single instance is reused across requests (the route layer holds
    a module-level singleton) so the underlying ``DockerClient`` socket
    pool is shared. The class is otherwise stateless apart from
    :attr:`_active_execs`, which maps live ``session_id`` strings to the
    Docker exec instance id we'd need to signal on abort.
    """

    def __init__(
        self,
        container_name: str | None = None,
        client: Any | None = None,
    ) -> None:
        self.container_name = container_name or os.environ.get(
            "HERMES_CONTAINER_NAME", DEFAULT_HERMES_CONTAINER
        )
        # ``client`` is injectable for tests; production callers leave
        # it None so ``docker.from_env()`` picks up DOCKER_HOST /
        # /var/run/docker.sock from the environment.
        self._client = client if client is not None else docker.from_env()
        # session_id → exec_id. Used by :meth:`abort`. We also clear
        # entries from :meth:`chat_stream`'s ``finally`` so a session
        # that finishes naturally doesn't leak.
        self._active_execs: dict[str, str] = {}

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------

    def _container(self) -> Any:
        """Resolve the live :class:`docker.models.containers.Container`.

        Wrapping this in a helper keeps the ``containers.get`` lookup —
        and any future caching — in one place and gives tests an obvious
        hook to monkeypatch.
        """
        return self._client.containers.get(self.container_name)

    def _api(self) -> Any:
        """Return the low-level ``APIClient``.

        We use the low-level API for streaming because ``Container.exec_run``
        returns a ``(exit_code, output)`` tuple even with ``stream=True``,
        and we want the ``exec_id`` separately so we can record it for
        ``abort``.
        """
        return self._client.api

    @staticmethod
    def _build_argv(
        prompt: str,
        session_id: str | None,
        system_prompt: str | None,
    ) -> list[str]:
        """Assemble the ``hermes chat`` command-line.

        Kept static + small so tests can pin the exact argv we send to
        ``exec_create`` without spinning up an actual bridge.

        The session flag is ``--pass-session-id`` per the Hermes CLI
        contract; ``--system`` is the conventional name for ad-hoc
        system-prompt overrides. If a future Hermes release renames it
        the change is contained here.
        """
        argv = ["hermes", "chat", "-q", prompt]
        if session_id:
            argv.extend(["--pass-session-id", session_id])
        if system_prompt:
            argv.extend(["--system", system_prompt])
        return argv

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    async def chat_stream(
        self,
        prompt: str,
        session_id: str | None = None,
        system_prompt: str | None = None,
    ) -> AsyncIterator[bytes]:
        """Stream ``hermes chat`` stdout as it's emitted.

        Yields raw ``bytes`` chunks. The route layer is responsible for
        decoding and re-framing as SSE ``text_delta`` events.

        ``session_id`` is forwarded to Hermes (so multi-turn context
        survives across calls) and also used as the key in
        :attr:`_active_execs` so :meth:`abort` can target this exec.
        If no ``session_id`` is provided we fall back to the exec id
        itself, which keeps the map well-formed but means the caller
        won't be able to abort externally.
        """
        argv = self._build_argv(prompt, session_id, system_prompt)
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
            raise HermesBridgeError(
                f"Hermes container '{self.container_name}' not found"
            ) from exc
        except docker.errors.APIError as exc:
            raise HermesBridgeError(f"docker exec_create failed: {exc}") from exc

        # The SDK can return either a bare id string (older versions)
        # or a dict-like ``{"Id": "..."}``. Normalise both.
        exec_id = (
            exec_create["Id"] if isinstance(exec_create, dict) else exec_create
        )
        track_key = session_id or exec_id
        self._active_execs[track_key] = exec_id

        log.info(
            "hermes_bridge_exec_started",
            container=self.container_name,
            exec_id=exec_id,
            session_id=session_id,
        )

        # ``exec_start`` with ``stream=True`` returns a blocking
        # generator that yields ``bytes`` chunks as Docker delivers
        # them. We pull from it in a worker thread so the event loop
        # stays responsive — each chunk hops back via ``asyncio.to_thread``.
        try:
            stream = api.exec_start(exec_id, stream=True)
            iterator = iter(stream)
            while True:
                chunk = await asyncio.to_thread(_next_or_sentinel, iterator)
                if chunk is _STREAM_DONE:
                    break
                if chunk:
                    yield chunk
        except asyncio.CancelledError:
            # Caller (route layer) cancelled — propagate after cleanup.
            log.info(
                "hermes_bridge_exec_cancelled",
                exec_id=exec_id,
                session_id=session_id,
            )
            raise
        except docker.errors.APIError as exc:
            raise HermesBridgeError(
                f"docker exec_start stream errored: {exc}"
            ) from exc
        finally:
            # Drop the tracking entry whether we finished, raised, or
            # were aborted. ``pop`` with default avoids a KeyError if
            # ``abort`` already cleared it.
            self._active_execs.pop(track_key, None)

    async def abort(self, session_id: str) -> bool:
        """Signal SIGTERM into the running ``hermes chat`` process.

        Returns ``True`` if we found a matching active exec and
        successfully issued the kill, ``False`` otherwise (no live
        exec for that session — typical when the stream already
        finished or never started).

        Implementation: look up ``exec_id``, ask Docker for the PID
        via ``exec_inspect``, then run ``kill -TERM <pid>`` inside
        the same container. SIGTERM is the polite signal — Hermes
        handles it as "wrap up the current message and exit"; the
        outer ``chat_stream`` loop will see the stdout EOF and
        return naturally.
        """
        exec_id = self._active_execs.get(session_id)
        if not exec_id:
            return False

        try:
            info = await asyncio.to_thread(self._api().exec_inspect, exec_id)
        except docker.errors.APIError as exc:
            log.warning(
                "hermes_bridge_abort_inspect_failed",
                exec_id=exec_id,
                error=str(exc),
            )
            self._active_execs.pop(session_id, None)
            return False

        pid = info.get("Pid") if isinstance(info, dict) else None
        if not pid:
            # Exec already exited — nothing to signal, but we should
            # still consider the abort "honoured" from the caller's
            # perspective because the process is gone. We return False
            # to make the route surface a clean "nothing to abort".
            self._active_execs.pop(session_id, None)
            return False

        try:
            container = self._container()
            await asyncio.to_thread(
                container.exec_run,
                ["kill", "-TERM", str(pid)],
            )
        except (docker.errors.NotFound, docker.errors.APIError) as exc:
            log.warning(
                "hermes_bridge_abort_kill_failed",
                exec_id=exec_id,
                pid=pid,
                error=str(exc),
            )
            self._active_execs.pop(session_id, None)
            return False

        log.info(
            "hermes_bridge_abort_signalled",
            exec_id=exec_id,
            pid=pid,
            session_id=session_id,
        )
        self._active_execs.pop(session_id, None)
        return True

    def healthcheck(self) -> dict[str, Any]:
        """Synchronous status snapshot for the worker /health endpoint.

        Returns a small dict; never raises. The three shapes:

        * ``{"container": "<status>", "name": "<n>"}`` — healthy lookup.
        * ``{"container": "not_found", "name": "<n>"}`` — container
          missing (compose hasn't started Hermes yet, or env var points
          at the wrong name).
        * ``{"container": "error", "name": "<n>", "error": "..."}`` —
          any other failure (socket missing, permission denied, etc.).
        """
        try:
            c = self._container()
            c.reload()
            return {"container": c.status, "name": c.name}
        except docker.errors.NotFound:
            return {"container": "not_found", "name": self.container_name}
        except Exception as exc:  # noqa: BLE001 — surface as dict, not raise
            return {
                "container": "error",
                "name": self.container_name,
                "error": str(exc),
            }


# Sentinel for the to_thread iterator pump below. Using a unique object
# (rather than ``None`` or ``b""``) lets ``chat_stream`` distinguish
# "stream done" from "Hermes emitted an empty chunk", which the SDK
# does occasionally between log flushes.
_STREAM_DONE: Any = object()


def _next_or_sentinel(iterator: Any) -> Any:
    """Pull one item from a sync iterator or return ``_STREAM_DONE``.

    Lives at module scope so ``asyncio.to_thread`` can pickle a stable
    reference. Catching ``StopIteration`` here (rather than in
    ``chat_stream``) keeps the async loop simple — it just compares
    against the sentinel.
    """
    try:
        return next(iterator)
    except StopIteration:
        return _STREAM_DONE
