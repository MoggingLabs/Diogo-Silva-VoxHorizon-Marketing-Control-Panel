/**
 * Shared notification types + helpers.
 *
 * The notification system bridges the worker (which records events into the
 * `events` table) with the Next.js delivery channels (Resend email + Web Push).
 * This file is the single source of truth for what notification kinds exist
 * and what their payload shapes look like, so both the email templates and
 * the push payload builder stay in sync.
 *
 * NOTE: framework-agnostic — no `server-only` imports. Components that just
 * render template names / payload shapes can pull from this safely.
 */

import type { Database } from "@/lib/supabase/types.gen";

// ---------------------------------------------------------------------------
// Notification kinds
// ---------------------------------------------------------------------------

/**
 * Stable string identifiers we use for every notification we emit. New kinds
 * must be added here AND to the worker's `notifications.py` vocabulary so
 * both sides agree on the dedupe scope.
 */
export const NOTIFICATION_KINDS = [
  "brief_awaits_approval",
  "creative_fatigue",
  "kill_threshold",
  "launch_approved",
  "worker_job_failed",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Discriminated payload shapes. Each maps to a single email template +
 * push body builder. Add a new variant when adding a new kind.
 */
export type BriefAwaitingApprovalPayload = {
  kind: "brief_awaits_approval";
  briefId: string;
  briefIdHuman: string;
  clientName: string;
  format: "image" | "video";
  url: string;
};

export type CreativeFatigueAlertPayload = {
  kind: "creative_fatigue";
  campaignId: string;
  campaignName: string;
  clientName: string;
  spend: number;
  ctr: number;
  freq: number;
  reason: string;
  url: string;
};

export type KillThresholdPayload = {
  kind: "kill_threshold";
  campaignId: string;
  campaignName: string;
  clientName: string;
  spend: number;
  leads: number;
  reason: string;
  url: string;
};

export type LaunchApprovedPayload = {
  kind: "launch_approved";
  launchId: string;
  briefIdHuman: string;
  clientName: string;
  format: "image" | "video";
  url: string;
};

export type WorkerJobFailedPayload = {
  kind: "worker_job_failed";
  job: string;
  error: string;
  url: string;
};

export type NotificationPayload =
  | BriefAwaitingApprovalPayload
  | CreativeFatigueAlertPayload
  | KillThresholdPayload
  | LaunchApprovedPayload
  | WorkerJobFailedPayload;

// ---------------------------------------------------------------------------
// Supabase row shape — for the in-app feed
// ---------------------------------------------------------------------------

export type EventRow = Database["public"]["Tables"]["events"]["Row"];

/**
 * Best-effort label for an event row's payload. Used by the in-app
 * NotificationCenter component to show a one-line summary without forcing
 * the operator to know the kind vocabulary.
 */
export function labelForKind(kind: NotificationKind | string): string {
  switch (kind) {
    case "brief_awaits_approval":
      return "Brief awaiting approval";
    case "creative_fatigue":
      return "Creative fatigue alert";
    case "kill_threshold":
      return "Kill threshold reached";
    case "launch_approved":
      return "Launch approved";
    case "worker_job_failed":
      return "Worker job failed";
    default:
      return kind;
  }
}

// ---------------------------------------------------------------------------
// Push payload shape (matches public/sw.js expectations)
// ---------------------------------------------------------------------------

/**
 * The exact shape the Service Worker reads from `event.data.json()`.
 * Keep this tiny — the push service caps payloads at ~4KB after encryption.
 */
export type WebPushBody = {
  title: string;
  body: string;
  url: string;
  kind: NotificationKind | string;
};

export function pushBodyFromPayload(payload: NotificationPayload): WebPushBody {
  switch (payload.kind) {
    case "brief_awaits_approval":
      return {
        kind: payload.kind,
        title: `Brief ${payload.briefIdHuman} awaiting approval`,
        body: `${payload.clientName} • ${payload.format}`,
        url: payload.url,
      };
    case "creative_fatigue":
      return {
        kind: payload.kind,
        title: `Creative fatigue: ${payload.campaignName}`,
        body: payload.reason,
        url: payload.url,
      };
    case "kill_threshold":
      return {
        kind: payload.kind,
        title: `Kill recommended: ${payload.campaignName}`,
        body: payload.reason,
        url: payload.url,
      };
    case "launch_approved":
      return {
        kind: payload.kind,
        title: `Launch approved: ${payload.briefIdHuman}`,
        body: `${payload.clientName} • ${payload.format}`,
        url: payload.url,
      };
    case "worker_job_failed":
      return {
        kind: payload.kind,
        title: `Worker job failed: ${payload.job}`,
        body: payload.error,
        url: payload.url,
      };
  }
}
