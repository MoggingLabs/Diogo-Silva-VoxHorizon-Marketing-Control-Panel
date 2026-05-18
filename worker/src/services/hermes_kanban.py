"""Hermes kanban bridge service (HI-3 / Wave 18).

The dashboard's long-running pipeline ops (custom audience refreshes,
multi-stage video renders that exceed the worker's request budget,
catalog imports, etc.) are modelled as Hermes kanban tasks. Hermes'
own gateway is configured with ``kanban.dispatch_in_gateway: true`` so
Ekko picks the task up the moment a row lands in his board and runs
to completion in his own runtime — the worker just creates / queries
/ cancels via the ``hermes kanban`` CLI it reaches through the Ekko
container's exec endpoint.

The service wraps :class:`worker.src.services.hermes_bridge.HermesBridge`
from HI-1 (Agent A): one container handle gets reused for one-shot
``docker exec`` calls and for the long-running ``tail`` stream. We do
NOT shell out to ``docker`` on the host — every call goes through the
Docker SDK so it works the same way under compose's user-namespaced
group access (see HI-5 Agent D for the ``group_add`` plumbing).

State mirror: every create / cancel / retry writes a matching row into
the Supabase ``hermes_tasks`` table (HI-15 Agent E migration). The
worker's row is a *mirror*, not the source of truth — the canonical
state lives on Hermes' board, and a periodic reconcile (out of scope
for this issue) would re-sync if the two ever diverge. The mirror is
what the dashboard's realtime subscription reads from, so the write
must happen on the worker side after each transition.

Subcommands we reach for (matches the Hermes 0.7+ kanban surface):

* ``hermes kanban create --board <b> --title "<t>" --assignee <a> --context <json>``
  Prints ``Created kanban task: <task-id>`` to stdout. We grep the id
  with a regex; the format is stable across Hermes versions because
  the CLI commits to the ``Created kanban task: <uuid-or-shortid>``
  line for scripting consumers.

* ``hermes kanban list [--status <s>]``
  Outputs one task per line in the form
  ``<task-id>  <status>  <assignee>  <title>``. We parse defensively
  — leading whitespace, blank lines between sections, and lines that
  don't have at least four fields are skipped.

* ``hermes kanban show <id> --json``
  Returns a JSON blob with task + comments + events. We parse and
  pass it back to the caller verbatim; the route then forwards it to
  the dashboard.

* ``hermes kanban block <id>`` — used as the "cancel" verb. Hermes
  doesn't have a hard "cancel" command; ``block`` transitions the
  task to ``blocked`` which freezes Ekko's processing. The mirror
  status flips to ``cancelled`` so the dashboard can show the
  operator-initiated nature distinctly from a Hermes-side block.

* ``hermes kanban reclaim <id>`` + ``hermes kanban unblock <id>`` —
  used as the "retry" pair. ``reclaim`` re-queues a failed task;
  ``unblock`` removes the block flag if the task had been cancelled
  via the route above. We try both unconditionally so retry is
  idempotent regardless of which state the task is currently in.

* ``hermes kanban tail <id> --json`` — streams one JSON object per
  event over stdout, NDJSON-style. We tee that through an async
  iterator so the SSE route can forward each event to the dashboard.

Service-vs-route split: this module owns the parsing + Supabase
mirroring; the route in :mod:`worker.src.routes.hermes_kanban` owns
HTTP framing + bearer auth + SSE wrapping. Tests cover both layers.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Any

import structlog

from ..supabase_client import get_supabase_admin


if TYPE_CHECKING:
    # Imported only for typing — runtime cost of the docker SDK pulled
    # in by hermes_bridge is paid by the bridge module itself, not here.
    from .hermes_bridge import HermesBridge


log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


# Default board name. Hermes operations can host multiple boards (one per
# operator surface) but for now everything funnels through "voxhorizon".
# Override per-call via the ``board`` arg on :meth:`HermesKanbanService.create_task`.
DEFAULT_BOARD = "voxhorizon"

# Default assignee. Hermes routes a task to the named agent's queue;
# ``ekko`` is the dashboard's default operator-facing agent.
DEFAULT_ASSIGNEE = "ekko"

# Regex that extracts the task id from ``hermes kanban create`` stdout.
# The CLI prints e.g.::
#
#     Created kanban task: 7c4f1b2d-9a3e-4ff0-8001-3b6e1f2a9d11
#
# Some shipping versions also print a short id (8 hex chars) when the
# board is configured for short ids; we accept either form. The regex
# uses a non-greedy capture so trailing whitespace or extra log noise
# doesn't break the parse.
_TASK_ID_RE = re.compile(
    r"Created\s+kanban\s+task[:\s]+([A-Za-z0-9][A-Za-z0-9_-]*)",
    re.IGNORECASE,
)

# Default Hermes timeouts (seconds) for one-shot exec_run calls. The
# create / list / show / block / unblock / reclaim calls are all
# nominally sub-second; we give them a generous ceiling so a slow
# container start doesn't surface as a parsing failure. The tail call
# is unbounded — it streams until the caller cancels.
_EXEC_TIMEOUT_S = 30.0


# Mapping from Hermes kanban statuses to our Supabase mirror enum
# (``hermes_task_status_enum`` from HI-15). Hermes uses a richer set of
# strings; the mirror collapses some near-synonyms (e.g. ``ready`` ↔
# ``queued``) into the canonical 8-value enum. Anything unrecognised
# stays as ``pending`` so we never violate the enum constraint.
_STATUS_MIRROR_MAP: dict[str, str] = {
    "pending": "pending",
    "queued": "ready",
    "ready": "ready",
    "claimed": "claimed",
    "running": "running",
    "in_progress": "running",
    "completed": "completed",
    "done": "completed",
    "failed": "failed",
    "errored": "failed",
    "blocked": "blocked",
    "cancelled": "cancelled",
}


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HermesTask:
    """Parsed shape of a Hermes kanban task.

    The Hermes ``show --json`` payload carries a fuller object than
    we surface here (per-comment author, per-event raw payload), but
    the dashboard only needs id / status / assignee / title / context
    / result + the comment + event lists; we keep the dataclass narrow
    so callers can rely on the fields being present.
    """

    task_id: str
    status: str
    assignee: str
    title: str = ""
    board: str = DEFAULT_BOARD
    context: dict[str, Any] = field(default_factory=dict)
    result: dict[str, Any] | None = None
    comments: list[dict[str, Any]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    parent_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serialisable view (route response body)."""
        return asdict(self)


class HermesKanbanError(RuntimeError):
    """Raised when a kanban subcommand exits non-zero or its output
    fails to parse. Carries the exit code + stdout/stderr so the route
    layer can surface a structured 500 for the dashboard.
    """

    def __init__(
        self,
        message: str,
        *,
        exit_code: int | None = None,
        stdout: str | None = None,
        stderr: str | None = None,
    ) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class HermesKanbanService:
    """Async wrapper around ``hermes kanban`` subcommands.

    The service is intentionally thin — it doesn't own any state of
    its own beyond the bridge handle + the supabase client. All the
    coordination (per-session abort, kanban→Supabase reconcile) lives
    on the route layer or upstream tooling.
    """

    def __init__(
        self,
        bridge: HermesBridge,
        *,
        board: str = DEFAULT_BOARD,
        supabase: Any = None,
    ) -> None:
        self._bridge = bridge
        self._board = board
        # Lazily resolve the Supabase admin client at first write — tests
        # inject a mock here so we don't need a live Supabase to exercise
        # the parse / dispatch logic.
        self._supabase: Any = supabase

    # ---- internal plumbing ----------------------------------------------

    def _sb(self) -> Any:
        """Return the cached Supabase client (lazy-init)."""
        if self._supabase is None:
            self._supabase = get_supabase_admin()
        return self._supabase

    def _container(self) -> Any:
        """Return the bridge's container handle.

        The bridge exposes ``_container()`` per HI-1 (see issue body).
        We go through it on every call rather than caching ourselves so
        a container restart (and the corresponding bridge re-resolve)
        flows through transparently.
        """
        return self._bridge._container()

    @staticmethod
    def _decode_stream_chunk(chunk: Any) -> str:
        """Decode a docker SDK stream chunk into text.

        The SDK yields ``bytes`` chunks by default but with ``demux=True``
        the chunk is a ``(stdout, stderr)`` tuple. We collapse both into
        a single string so the caller's NDJSON parser doesn't have to
        special-case stderr (the kanban CLI uses stderr only for
        warnings; the JSON event stream is on stdout).
        """
        if chunk is None:
            return ""
        if isinstance(chunk, tuple):
            stdout_b, stderr_b = chunk
            stdout = stdout_b.decode("utf-8", errors="replace") if stdout_b else ""
            stderr = stderr_b.decode("utf-8", errors="replace") if stderr_b else ""
            return stdout + stderr
        if isinstance(chunk, bytes):
            return chunk.decode("utf-8", errors="replace")
        return str(chunk)

    async def _exec(
        self,
        argv: list[str],
        *,
        demux: bool = False,
    ) -> tuple[int, str, str]:
        """Run one ``hermes <argv>`` command in the Ekko container.

        Returns ``(exit_code, stdout, stderr)``. The docker SDK's
        ``exec_run`` is synchronous; we call it directly here because
        the calls are bounded (sub-second typical) and wrapping in
        ``asyncio.to_thread`` would just add scheduler hop overhead.
        FastAPI already runs route handlers in a threadpool when the
        function isn't async, and our async chain is purely for the
        streaming tail — one-shots can run inline.
        """
        container = self._container()
        full_argv = ["hermes", *argv]
        result = container.exec_run(full_argv, demux=demux)
        # The SDK exposes results either as a (exit_code, output) tuple
        # or an ExecResult object depending on the install version; we
        # handle both for robustness.
        exit_code: int = 0
        output: Any = None
        if isinstance(result, tuple):
            exit_code, output = result
        else:
            exit_code = getattr(result, "exit_code", 0) or 0
            output = getattr(result, "output", None)

        if demux:
            # ``demux=True`` normally yields a ``(stdout, stderr)`` tuple,
            # but some SDK shapes (ExecResult objects, older versions) can
            # surface raw bytes — fall back to treating the whole payload
            # as stdout in that case so the test doubles can stay simple.
            if isinstance(output, tuple) and len(output) == 2:
                stdout_b, stderr_b = output
            elif isinstance(output, bytes):
                stdout_b, stderr_b = output, b""
            else:
                stdout_b, stderr_b = b"", b""
            stdout = (stdout_b or b"").decode("utf-8", errors="replace")
            stderr = (stderr_b or b"").decode("utf-8", errors="replace")
        else:
            stdout = (output or b"").decode("utf-8", errors="replace") if isinstance(output, bytes) else str(output or "")
            stderr = ""

        log.debug(
            "hermes_kanban_exec",
            argv=full_argv,
            exit_code=exit_code,
            stdout_len=len(stdout),
            stderr_len=len(stderr),
        )
        return exit_code, stdout, stderr

    def _mirror_status(self, kanban_status: str) -> str:
        """Map a Hermes-side status string to the Supabase enum value."""
        return _STATUS_MIRROR_MAP.get(kanban_status.lower(), "pending")

    def _mirror_upsert(
        self,
        *,
        kanban_task_id: str,
        status: str,
        assignee: str,
        context: dict[str, Any],
        pipeline_id: str | None = None,
        result: dict[str, Any] | None = None,
    ) -> None:
        """Upsert one row into ``hermes_tasks``.

        Schema (HI-15)::

            hermes_tasks(
              id uuid PRIMARY KEY,
              kanban_task_id text UNIQUE NOT NULL,
              pipeline_id uuid NULL,
              status hermes_task_status_enum,
              assignee text NOT NULL,
              context jsonb NOT NULL DEFAULT '{}',
              result jsonb NULL,
              ...
            )

        Failures here log + swallow — the mirror is a denormalised
        cache, the canonical state lives on Hermes' board. We don't
        want a transient Supabase outage to fail the kanban operation
        itself.
        """
        sb = self._sb()
        row: dict[str, Any] = {
            "kanban_task_id": kanban_task_id,
            "status": self._mirror_status(status),
            "assignee": assignee,
            "context": context or {},
        }
        if pipeline_id is not None:
            row["pipeline_id"] = pipeline_id
        if result is not None:
            row["result"] = result
        try:
            sb.table("hermes_tasks").upsert(
                row, on_conflict="kanban_task_id"
            ).execute()
        except Exception as e:  # noqa: BLE001
            log.warning(
                "hermes_task_mirror_upsert_failed",
                kanban_task_id=kanban_task_id,
                status=status,
                error=str(e),
            )

    # ---- create ---------------------------------------------------------

    async def create_task(
        self,
        title: str,
        assignee: str = DEFAULT_ASSIGNEE,
        context: dict[str, Any] | None = None,
        parent_id: str | None = None,
        *,
        board: str | None = None,
    ) -> str:
        """Create a new kanban task. Returns the task id.

        The Hermes CLI invocation::

            hermes kanban create --board <board> --title "<title>" \\
                --assignee <assignee> --context '<json>' [--parent <id>]

        The created id is grepped from stdout via :data:`_TASK_ID_RE`.
        If parsing fails we raise :class:`HermesKanbanError` with the
        stdout/stderr so the route layer can surface a structured 500
        instead of letting the empty string propagate downstream.

        On success we mirror the new task into ``hermes_tasks``. The
        ``pipeline_id`` lifted off ``context`` when present so the
        dashboard can join hermes_tasks against pipelines without an
        extra round-trip.
        """
        board_arg = board or self._board
        ctx = context or {}
        argv = [
            "kanban",
            "create",
            "--board",
            board_arg,
            "--title",
            title,
            "--assignee",
            assignee,
            "--context",
            json.dumps(ctx),
        ]
        if parent_id:
            argv.extend(["--parent", parent_id])

        exit_code, stdout, stderr = await self._exec(argv, demux=True)
        if exit_code != 0:
            raise HermesKanbanError(
                "hermes kanban create failed",
                exit_code=exit_code,
                stdout=stdout,
                stderr=stderr,
            )

        match = _TASK_ID_RE.search(stdout)
        if not match:
            raise HermesKanbanError(
                "could not parse task id from hermes kanban create output",
                exit_code=exit_code,
                stdout=stdout,
                stderr=stderr,
            )
        task_id = match.group(1)

        # Mirror after parsing so we never have a row without an id.
        pipeline_id = ctx.get("pipeline_id") if isinstance(ctx, dict) else None
        if isinstance(pipeline_id, str) and not pipeline_id:
            pipeline_id = None
        self._mirror_upsert(
            kanban_task_id=task_id,
            status="pending",
            assignee=assignee,
            context=ctx,
            pipeline_id=pipeline_id if isinstance(pipeline_id, str) else None,
        )
        log.info(
            "hermes_kanban_task_created",
            task_id=task_id,
            board=board_arg,
            assignee=assignee,
            parent_id=parent_id,
        )
        return task_id

    # ---- list -----------------------------------------------------------

    async def list_tasks(
        self,
        status_filter: str | None = None,
    ) -> list[HermesTask]:
        """List kanban tasks, optionally filtered to one status.

        We prefer ``--json`` if available (Hermes 0.7+) and fall back
        to the line-oriented format if the parse fails — older boards
        still in production speak the legacy format.

        Returns a list of :class:`HermesTask` with the *summary* fields
        populated (``task_id``, ``status``, ``assignee``, ``title``).
        Full state (context, comments, events) requires a follow-up
        :meth:`show_task` call; the listing endpoint stays cheap.
        """
        argv = ["kanban", "list", "--json"]
        if status_filter:
            argv.extend(["--status", status_filter])
        exit_code, stdout, stderr = await self._exec(argv)
        if exit_code != 0:
            raise HermesKanbanError(
                "hermes kanban list failed",
                exit_code=exit_code,
                stdout=stdout,
                stderr=stderr,
            )
        return self._parse_list(stdout)

    def _parse_list(self, stdout: str) -> list[HermesTask]:
        """Parse ``hermes kanban list`` stdout into HermesTask rows.

        First tries JSON (array or NDJSON), then falls back to
        whitespace-separated columns. Defensive: lines that don't
        match the expected shape are skipped, not failed.
        """
        stripped = stdout.strip()
        if not stripped:
            return []
        # JSON array path.
        if stripped.startswith("["):
            try:
                payload = json.loads(stripped)
                return [self._task_from_json(item) for item in payload if isinstance(item, dict)]
            except json.JSONDecodeError:
                pass
        # NDJSON path.
        if stripped.startswith("{"):
            tasks: list[HermesTask] = []
            for line in stripped.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict):
                    tasks.append(self._task_from_json(item))
            if tasks:
                return tasks
        # Legacy whitespace-separated rows.
        tasks_legacy: list[HermesTask] = []
        for line in stripped.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(None, 3)
            if len(parts) < 3:
                continue
            task_id = parts[0]
            status = parts[1]
            assignee = parts[2]
            title = parts[3] if len(parts) > 3 else ""
            tasks_legacy.append(
                HermesTask(
                    task_id=task_id,
                    status=status,
                    assignee=assignee,
                    title=title,
                    board=self._board,
                )
            )
        return tasks_legacy

    def _task_from_json(self, item: dict[str, Any]) -> HermesTask:
        """Build a :class:`HermesTask` from one parsed JSON payload."""
        context_raw = item.get("context") or {}
        result_raw = item.get("result")
        comments_raw = item.get("comments") or []
        events_raw = item.get("events") or []
        return HermesTask(
            task_id=str(item.get("id") or item.get("task_id") or ""),
            status=str(item.get("status") or "pending"),
            assignee=str(item.get("assignee") or ""),
            title=str(item.get("title") or ""),
            board=str(item.get("board") or self._board),
            context=context_raw if isinstance(context_raw, dict) else {},
            result=result_raw if isinstance(result_raw, dict) else None,
            comments=[c for c in comments_raw if isinstance(c, dict)],
            events=[e for e in events_raw if isinstance(e, dict)],
            parent_id=str(item["parent_id"]) if item.get("parent_id") else None,
        )

    # ---- show -----------------------------------------------------------

    async def show_task(self, task_id: str) -> HermesTask:
        """Return the full state for a single task.

        Hermes emits a JSON object with ``task`` + ``comments`` +
        ``events`` keys when called with ``--json``. We flatten the
        envelope so the caller sees one :class:`HermesTask` regardless.
        """
        argv = ["kanban", "show", task_id, "--json"]
        exit_code, stdout, stderr = await self._exec(argv)
        if exit_code != 0:
            raise HermesKanbanError(
                f"hermes kanban show {task_id} failed",
                exit_code=exit_code,
                stdout=stdout,
                stderr=stderr,
            )
        stripped = stdout.strip()
        if not stripped:
            raise HermesKanbanError(
                f"hermes kanban show {task_id} returned empty output",
                exit_code=exit_code,
                stdout=stdout,
                stderr=stderr,
            )
        try:
            payload = json.loads(stripped)
        except json.JSONDecodeError as e:
            raise HermesKanbanError(
                f"hermes kanban show {task_id} returned invalid JSON: {e}",
                exit_code=exit_code,
                stdout=stdout,
                stderr=stderr,
            ) from e

        if not isinstance(payload, dict):
            raise HermesKanbanError(
                f"hermes kanban show {task_id}: expected object, got {type(payload).__name__}",
                exit_code=exit_code,
                stdout=stdout,
            )

        # Two envelope shapes are in the wild: a flat object or a
        # ``{"task": {...}, "comments": [...], "events": [...]}`` wrapper.
        inner_task = payload.get("task")
        if isinstance(inner_task, dict):
            merged: dict[str, Any] = dict(inner_task)
            merged.setdefault("comments", payload.get("comments") or [])
            merged.setdefault("events", payload.get("events") or [])
        else:
            merged = payload

        task = self._task_from_json(merged)
        if not task.task_id:
            # Sometimes show omits the id field because the caller passed it.
            task = HermesTask(
                task_id=task_id,
                status=task.status,
                assignee=task.assignee,
                title=task.title,
                board=task.board,
                context=task.context,
                result=task.result,
                comments=task.comments,
                events=task.events,
                parent_id=task.parent_id,
            )
        return task

    # ---- cancel ---------------------------------------------------------

    async def cancel_task(self, task_id: str) -> None:
        """Cancel a kanban task via the ``block`` verb.

        Hermes' kanban surface has no hard ``cancel`` — the operator
        intent we surface as "cancel" maps onto ``block`` (which
        transitions the task to ``blocked`` so Ekko stops touching it)
        plus a mirror status of ``cancelled`` so the dashboard
        distinguishes operator-initiated stops from Hermes-side blocks.
        """
        argv = ["kanban", "block", task_id]
        exit_code, stdout, stderr = await self._exec(argv)
        if exit_code != 0:
            raise HermesKanbanError(
                f"hermes kanban block {task_id} failed",
                exit_code=exit_code,
                stdout=stdout,
                stderr=stderr,
            )

        # Mirror the cancellation. We don't re-read the task to confirm
        # — the block CLI is synchronous, and a follow-up tail will
        # show the transition if anything's wrong. The dashboard reads
        # from realtime so the optimistic write is fine.
        try:
            self._sb().table("hermes_tasks").update(
                {"status": "cancelled"}
            ).eq("kanban_task_id", task_id).execute()
        except Exception as e:  # noqa: BLE001
            log.warning(
                "hermes_task_mirror_cancel_failed",
                kanban_task_id=task_id,
                error=str(e),
            )
        log.info("hermes_kanban_task_cancelled", task_id=task_id)

    # ---- retry ----------------------------------------------------------

    async def retry_task(self, task_id: str) -> None:
        """Retry a kanban task.

        Both ``reclaim`` and ``unblock`` are issued unconditionally so
        retry is idempotent regardless of whether the task is currently
        failed (needs reclaim) or blocked (needs unblock). The Hermes
        CLI tolerates a no-op on either — calling ``reclaim`` on a
        running task is a soft warning, calling ``unblock`` on an
        unblocked task is also a warning. We surface a hard failure
        only when *both* exit non-zero.
        """
        argv_reclaim = ["kanban", "reclaim", task_id]
        exit_reclaim, stdout_r, stderr_r = await self._exec(argv_reclaim)

        argv_unblock = ["kanban", "unblock", task_id]
        exit_unblock, stdout_u, stderr_u = await self._exec(argv_unblock)

        if exit_reclaim != 0 and exit_unblock != 0:
            raise HermesKanbanError(
                f"hermes kanban retry {task_id} failed (reclaim exit={exit_reclaim}, unblock exit={exit_unblock})",
                exit_code=exit_reclaim or exit_unblock,
                stdout=stdout_r + stdout_u,
                stderr=stderr_r + stderr_u,
            )

        try:
            self._sb().table("hermes_tasks").update(
                {"status": "ready"}
            ).eq("kanban_task_id", task_id).execute()
        except Exception as e:  # noqa: BLE001
            log.warning(
                "hermes_task_mirror_retry_failed",
                kanban_task_id=task_id,
                error=str(e),
            )
        log.info("hermes_kanban_task_retried", task_id=task_id)

    # ---- tail events ----------------------------------------------------

    async def tail_events(
        self,
        task_id: str,
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream kanban events for one task as parsed JSON objects.

        Hermes' ``tail --json`` emits one event per line on stdout, so
        we wire it through the docker SDK's streaming exec API and
        yield each parsed line. The stream stays open until either the
        task reaches a terminal state (Hermes closes its end) or the
        caller stops iterating (we never close the exec ourselves — the
        SDK does that when the iterator is garbage-collected).

        Latency: the docker SDK's ``stream=True`` mode delivers each
        chunk as soon as the container flushes its stdout buffer.
        Hermes flushes after every JSON line, so the typical end-to-end
        latency from emit→yield is well under the 500 ms acceptance
        criterion. We never buffer ourselves.

        Non-JSON lines (banners, decoration) are skipped silently so a
        slightly chatty Hermes build doesn't break the iterator.
        """
        container = self._container()
        argv = ["hermes", "kanban", "tail", task_id, "--json"]
        # ``exec_run(stream=True)`` returns ``(exit_code=None, stream)``
        # for the streaming path. We don't unpack it — we just walk
        # the iterable. ``demux=True`` keeps stdout / stderr separate
        # so a stderr warning doesn't corrupt our JSON parse.
        result = container.exec_run(argv, stream=True, demux=True)
        # The SDK returns either a 2-tuple ``(exit_code, gen)`` or a
        # ``CancellableStream`` exposing ``output``; handle both.
        if isinstance(result, tuple) and len(result) == 2:
            _exit_code, gen = result
        else:
            gen = getattr(result, "output", result)

        buffer = ""
        for chunk in gen:
            text = self._decode_stream_chunk(chunk)
            if not text:
                continue
            buffer += text
            # Yield one event per newline. Anything trailing after the
            # last \n is held over for the next chunk.
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    log.debug(
                        "hermes_kanban_tail_non_json",
                        task_id=task_id,
                        line=line[:200],
                    )
                    continue
                if isinstance(event, dict):
                    yield event

        # Flush any tail content that wasn't terminated by a newline.
        tail = buffer.strip()
        if tail:
            try:
                event = json.loads(tail)
                if isinstance(event, dict):
                    yield event
            except json.JSONDecodeError:
                pass


__all__ = [
    "DEFAULT_BOARD",
    "DEFAULT_ASSIGNEE",
    "HermesKanbanError",
    "HermesKanbanService",
    "HermesTask",
]
