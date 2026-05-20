"use client";

import { useEffect, useRef } from "react";

import {
  encodeSubs,
  type RealtimeChangeEvent,
  type RealtimeEventType,
  type RealtimeSubscriptionSpec,
} from "@/lib/realtime/topics";

/**
 * The payload shape handed to a listener callback. Intentionally mirrors the
 * fields the old Supabase `postgres_changes` callbacks read (`payload.new`,
 * `payload.old`) so migrating a component is a near-mechanical swap.
 */
export type RealtimeStreamPayload = {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: Record<string, unknown>;
  old: Record<string, unknown>;
};

/**
 * One subscription + its handler. `event` may be `*` to receive all of
 * INSERT/UPDATE/DELETE for the table, matching Supabase's wildcard.
 */
export type RealtimeListener = {
  table: string;
  event: RealtimeEventType;
  filter?: string;
  callback: (payload: RealtimeStreamPayload) => void;
};

export type UseRealtimeStreamOptions = {
  /**
   * Override the relay endpoint (tests). Defaults to `/api/realtime`. The
   * `?subs=` param is appended by the hook.
   */
  url?: string;
  /** Disable the connection (e.g. when a required id is null). Default false. */
  disabled?: boolean;
};

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Subscribe to the server-side Realtime SSE relay (`/api/realtime`).
 *
 * Replaces the per-component `createBrowserClient().channel(...).on(...)
 * .subscribe()` pattern that broke once RLS deny-all blocked the anon key
 * from receiving `postgres_changes`. The Next.js server holds the Realtime
 * subscription with the service-role credential and streams changes here as
 * Server-Sent Events.
 *
 * Behaviour:
 *  - Opens one `EventSource` for the whole listener set (one TCP connection
 *    per component, same as the old single channel).
 *  - Dispatches each change to every listener whose `(table, event)` matches.
 *    A listener with `event: "*"` receives all event types for its table.
 *  - Reconnects with exponential backoff (1s → 30s) on transport error.
 *    `EventSource` auto-reconnects too, but we add an explicit ladder so a
 *    persistent server error doesn't hot-loop.
 *  - Tears down the connection on unmount / dependency change.
 *
 * The listener set is captured in a ref so frequently-changing callback
 * closures (which capture component state) don't churn the connection. The
 * effect only re-runs when the *spec* (tables/events/filters/url/disabled)
 * changes — encoded into a stable string key.
 */
export function useRealtimeStream(
  listeners: RealtimeListener[],
  options: UseRealtimeStreamOptions = {},
): void {
  const { url = "/api/realtime", disabled = false } = options;

  // Hold the latest listeners without restarting the connection on every
  // render — only the encoded spec key (below) gates the effect.
  const listenersRef = useRef(listeners);
  listenersRef.current = listeners;

  // Stable key describing *what* we subscribe to. Two renders with identical
  // tables/events/filters produce the same key, so the effect is stable even
  // when callback identities change every render.
  const specs: RealtimeSubscriptionSpec[] = listeners.map((l) => ({
    table: l.table,
    event: l.event,
    ...(l.filter ? { filter: l.filter } : {}),
  }));
  const specKey = disabled ? "" : JSON.stringify(specs);

  useEffect(() => {
    if (disabled || specs.length === 0) return;
    if (typeof EventSource === "undefined") return;

    const encoded = encodeSubs(specs);
    const endpoint = `${url}?subs=${encoded}`;

    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const dispatch = (evt: RealtimeChangeEvent) => {
      const payload: RealtimeStreamPayload = {
        eventType: evt.eventType,
        new: evt.new ?? {},
        old: evt.old ?? {},
      };
      for (const l of listenersRef.current) {
        if (l.table !== evt.table) continue;
        if (l.event !== "*" && l.event !== evt.eventType) continue;
        try {
          l.callback(payload);
        } catch (e) {
          // One bad listener must not break the others or the stream.
          console.error("[useRealtimeStream] listener threw:", e);
        }
      }
    };

    const connect = () => {
      if (disposed) return;
      source = new EventSource(endpoint);

      source.onmessage = (e: MessageEvent) => {
        // Default (unnamed) events carry row changes. Named events
        // (`ready`/`error`) are handled below and never hit `onmessage`.
        if (!e.data) return;
        let parsed: RealtimeChangeEvent | null = null;
        try {
          parsed = JSON.parse(e.data) as RealtimeChangeEvent;
        } catch {
          return;
        }
        if (parsed && parsed.table && parsed.eventType) {
          dispatch(parsed);
        }
      };

      source.addEventListener("ready", () => {
        // Successful (re)subscribe — reset the backoff ladder.
        attempt = 0;
      });

      source.onerror = () => {
        // EventSource fires `error` on transient drops (it will retry on its
        // own) and on hard failures. Close and schedule our own backoff so a
        // persistent 4xx/5xx doesn't reconnect every ~3s forever.
        if (disposed) return;
        if (source) {
          source.close();
          source = null;
        }
        const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (source) source.close();
    };
    // `specKey` captures all of url/disabled/specs; listenersRef is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, url]);
}
