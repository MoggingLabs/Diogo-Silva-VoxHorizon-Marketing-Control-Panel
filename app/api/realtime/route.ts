import type { NextRequest } from "next/server";
import type { RealtimePostgresChangesPayload, RealtimeChannel } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  parseSubs,
  type RealtimeChangeEvent,
  type RealtimeSubscriptionSpec,
} from "@/lib/realtime/topics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Heartbeat cadence — keeps the connection alive through Caddy's idle timeout. */
const HEARTBEAT_MS = 25_000;

/**
 * GET /api/realtime?subs=<base64url JSON spec[]>
 *
 * Server-side Realtime relay (Phase 2 of the Supabase lockdown).
 *
 * The browser can no longer receive `postgres_changes` directly: RLS deny-all
 * blocks the anon role. Instead this route opens a Supabase Realtime
 * subscription with the **service-role** client (which bypasses RLS) and
 * streams every matching change to the browser as Server-Sent Events. The
 * dashboard sits behind Caddy basic auth, so reaching this route already
 * implies an authenticated operator.
 *
 * The `subs` param is a base64url-encoded JSON array of
 * `{ table, event, filter? }` specs (see `lib/realtime/topics.ts`). Tables are
 * validated against an allowlist; an empty/invalid list is a 400.
 *
 * Wire format (text/event-stream):
 *   - `: ping\n\n`                          heartbeat comment (ignored by EventSource)
 *   - `event: ready\ndata: {...}\n\n`       one-shot, after the channel subscribes
 *   - `data: {table,eventType,new,old}\n\n` one per row change
 *
 * Cleanup: the Supabase channel is removed when the client disconnects
 * (`request.signal` abort) or the stream is cancelled.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const specs = parseSubs(url.searchParams.get("subs"));

  if (specs.length === 0) {
    return new Response(
      JSON.stringify({ error: "bad_request", detail: "missing or invalid `subs`" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const encoder = new TextEncoder();
  const supabase = createAdminClient();

  // Hold references so both `start` and `cancel`/abort can tear down.
  let channel: RealtimeChannel | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed (client vanished mid-flush) — ignore.
        }
      };

      const sendEvent = (evt: RealtimeChangeEvent) => {
        send(`data: ${JSON.stringify(evt)}\n\n`);
      };

      const teardown = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (channel) {
          void supabase.removeChannel(channel);
          channel = null;
        }
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      // Disconnect path: the browser closed the EventSource or navigated away.
      req.signal.addEventListener("abort", teardown);

      // Open a single channel and register every requested spec on it. A
      // stable per-connection channel name keeps Supabase from coalescing
      // unrelated connections.
      const channelName = `relay:${Math.random().toString(36).slice(2)}:${Date.now()}`;
      let ch = supabase.channel(channelName);

      const handleChange =
        (spec: RealtimeSubscriptionSpec) =>
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          // `eventType` is INSERT | UPDATE | DELETE at runtime.
          const eventType = payload.eventType as RealtimeChangeEvent["eventType"];
          sendEvent({
            table: spec.table,
            eventType,
            new: (payload.new as Record<string, unknown>) ?? {},
            old: (payload.old as Record<string, unknown>) ?? {},
          });
        };

      for (const spec of specs) {
        ch = ch.on(
          // The supabase-js typings model `postgres_changes` as a string
          // literal channel type; cast keeps us off `any` at the call site.
          "postgres_changes" as never,
          {
            event: spec.event,
            schema: "public",
            table: spec.table,
            ...(spec.filter ? { filter: spec.filter } : {}),
          } as never,
          handleChange(spec) as never,
        );
      }

      channel = ch;
      ch.subscribe((status: string) => {
        if (status === "SUBSCRIBED") {
          // Let the client flip into "live" mode and stop showing a spinner.
          send(`event: ready\ndata: ${JSON.stringify({ count: specs.length })}\n\n`);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          // Surface terminal channel failures so the client reconnects.
          send(`event: error\ndata: ${JSON.stringify({ status })}\n\n`);
        }
      });

      // Initial comment so proxies flush headers immediately, then a periodic
      // heartbeat to defeat idle timeouts at the Caddy edge.
      send(": connected\n\n");
      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
    },

    cancel() {
      // Reader released (e.g. controller.close() upstream or GC). Mirror the
      // abort teardown so we never leak a Supabase channel.
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (channel) {
        void supabase.removeChannel(channel);
        channel = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disable proxy buffering (nginx/Caddy) so events flush immediately.
      "x-accel-buffering": "no",
    },
  });
}
