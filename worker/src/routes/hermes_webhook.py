"""POST /work/hermes/webhook — receiver for Hermes shell-hook callbacks.

The Hermes harness (Claude Code) running on the same host fires shell
hooks on lifecycle events: post_tool_call, session_start, session_end,
pre_skill, etc. Each hook ``curl``s a JSON body into this endpoint with
a bearer token. We persist the event into ``pipeline_events`` and
optionally fan out a web-push notification.

Auth model
----------
The Hermes hooks run on the same machine but as a different user, so
they get their OWN shared secret (``DASHBOARD_WEBHOOK_TOKEN``) rather
than the dashboard's ``WORKER_SHARED_SECRET``. This way the hook secret
can be rotated independently and a compromise of one doesn't leak the
other. Comparison is constant-time via :func:`hmac.compare_digest`.

Failure semantics
-----------------
* Missing / wrong bearer → 401. Hooks log the rejection and move on.
* Valid bearer + malformed body → 200 with an empty body and a
  structured warning log. Returning 5xx here would (potentially) block
  Hermes' agent loop — the entire point of the shell-hook design is
  non-blocking observability, so we eat the parse error.
* Valid bearer + valid body → 204 No Content after the service-layer
  ``handle_event`` finishes. The service itself never raises.
"""

from __future__ import annotations

import hmac

import structlog
from fastapi import APIRouter, Header, Request, Response, status

from ..services import hermes_webhook as hermes_webhook_service


log = structlog.get_logger(__name__)


router = APIRouter()


_BEARER_PREFIX = "Bearer "


def _check_token(authorization: str | None) -> bool:
    """Return ``True`` iff ``authorization`` carries the expected hook token.

    Comparison is constant-time. A missing env var means *no* token will
    ever validate — fail-closed so a misconfigured deploy doesn't silently
    accept anonymous traffic.
    """
    expected = hermes_webhook_service.get_dashboard_webhook_token()
    if not expected:
        return False
    if not authorization or not authorization.startswith(_BEARER_PREFIX):
        return False
    presented = authorization[len(_BEARER_PREFIX) :].strip()
    return hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8"))


@router.post("/work/hermes/webhook")
async def hermes_webhook(
    request: Request,
    authorization: str | None = Header(default=None),
) -> Response:
    """Receive one shell-hook event from Hermes.

    Returns:
        * ``204 No Content`` — token valid and event handed off cleanly.
        * ``401 Unauthorized`` — missing or wrong bearer token. No DB write.
        * ``200 OK`` (with empty body) — body could not be parsed as JSON
          or ``handle_event`` raised unexpectedly. We log and swallow
          because returning 5xx may block Hermes' agent loop.
    """
    if not _check_token(authorization):
        log.info("hermes_webhook_unauthorized")
        return Response(
            status_code=status.HTTP_401_UNAUTHORIZED,
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Parse the body. A malformed payload is logged and we still return
    # success so Ekko's hook caller doesn't escalate.
    try:
        event = await request.json()
    except Exception as e:  # noqa: BLE001 — body might not be JSON at all
        log.warning("hermes_webhook_bad_json", error=str(e))
        return Response(status_code=status.HTTP_200_OK)

    # The service swallows its own errors, but we wrap it once more in case
    # something truly unexpected slips through (e.g. an import-time failure
    # in a downstream dependency under test).
    try:
        await hermes_webhook_service.handle_event(event)
    except Exception as e:  # noqa: BLE001 — never 5xx to Ekko
        log.warning("hermes_webhook_handler_failed", error=str(e))
        return Response(status_code=status.HTTP_200_OK)

    return Response(status_code=status.HTTP_204_NO_CONTENT)
