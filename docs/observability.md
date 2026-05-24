# Observability and ops alerting

This document describes how the worker surfaces operational health, the SLO
targets and alert thresholds it watches, and how it pages a human when an SLO is
breached (E5.6 / #526).

## The two halves: classify and deliver

The worker already CLASSIFIES operational problems. The pure cores in
`worker/src/services/observability.py` (`stuck_dispatches`, `stuck_outbox`,
`metrics_snapshot`) compute the findings, and the supervised scheduler loops in
`worker/src/services/scheduler.py` run them on an interval and emit structured
log lines (greppable by `pipeline_id`). That makes log-based alerting work today.

E5.6 adds the missing half: DELIVERY. When the observability tick detects a
problem it now posts a Slack alert to a separate ops channel so a human is paged,
not just a log line written.

## Alert delivery

- Channel: a dedicated ops channel, configured via `SLACK_OPS_CHANNEL_ID`. It is
  deliberately distinct from the approval channel (`SLACK_APPROVAL_CHANNEL_ID`)
  so on-call noise never drowns the approval queue and vice versa.
- Sender: the same Slack `chat.postMessage` helper the approval fan-out uses
  (`services.approval_notifications.post_slack_message`), authenticated with the
  shared `SLACK_BOT_TOKEN`.
- Best-effort: the delivery path never raises and never blocks the supervised
  loop. A missing channel, a Slack outage, or any unexpected error degrades to a
  logged warning (`ops_alert_skipped_no_channel`, `ops_alert_delivery_failed`,
  `ops_alert_tick_failed`). The structured watchdog logs always emit regardless.

## De-dupe and throttle

A persistent bad state must not page on every tick. The throttle
(`scheduler._AlertThrottle`) keys on the alert kind:

- An alert pages on TRANSITION into a bad state (the first tick that detects it).
- The same kind is then suppressed for `OPS_ALERT_THROTTLE_S` (default 3600s).
- When a condition clears (a return to healthy), its kind re-arms, so a flap that
  recovers and then breaks again pages a fresh alert rather than staying silent.

Multiple conditions that fire on the same tick are batched into one Slack message.

## SLO targets and thresholds

Every threshold is env-backed via `worker/src/config.py` with a conservative
default set far above a healthy steady state, so a slow-but-alive system is never
paged. The alert kind in parentheses is the throttle key.

| Condition (kind)               | SLO target                  | Env knob                                  | Default |
| ------------------------------ | --------------------------- | ----------------------------------------- | ------- |
| Stuck dispatch (stuck_dispatch)| Re-dispatch within 15 min   | `OPS_ALERT_STUCK_DISPATCH_AGE_S`          | 900     |
| Outbox dead letters (outbox_dead_letter) | Zero dead letters | `OPS_ALERT_OUTBOX_DEAD_LETTER_THRESHOLD`  | 1       |
| Outbox backlog (outbox_backlog)| Depth below 100             | `OPS_ALERT_OUTBOX_DEPTH_THRESHOLD`        | 100     |
| Breaker open (breaker_open)    | No open circuit breakers    | (state-driven, no numeric threshold)      | n/a     |
| Cost over cap (cost_over_cap)  | Spend at or under the cap   | (cap-driven, fires only when a cap is set)| n/a     |
| Alert throttle window          | n/a                         | `OPS_ALERT_THROTTLE_S`                     | 3600    |

Notes on the two state-driven conditions:

- `breaker_open` fires when any host in the metrics snapshot's breaker map is in
  the `open` state. The breaker map is empty until the cron-held connector
  singleton feeds it (see the `/work/metrics` route docstring); the alert fires
  the moment a real breaker state lands there.
- `cost_over_cap` fires only when a cost cap is configured and the snapshot
  reports `over_cap`. The cap is not yet wired to a live source, so this is a
  forward-looking hook that activates by construction when the cap arrives.

## Out of scope (follow-ups)

- Shipping logs and metrics fully off-box (a log shipper or a metrics scrape to a
  hosted backend) is infrastructure, not application code. This change delivers
  ALERTS, which is the gap; off-box log/metric retention is a separate follow-up.
- Feeding the breaker map and the cost cap into the metrics snapshot from the
  live cron-held connector singleton (the snapshot shape is already stable; the
  alert conditions already read these fields).
