import type { PipelineEvent } from "@/lib/pipeline/types";

/**
 * Translate the raw `pipeline_events` stream into plain-language narration
 * the manager reads in the supervision cockpit.
 *
 * Why events (not a live operator chat): the operator narrates its progress
 * as it drives the pipeline, and every meaningful step it takes already lands
 * as a `pipeline_events` row (brief authored, concepts rendered, finals
 * rendered, cost recorded). The dashboard already streams those rows over the
 * SSE realtime relay, so deriving narration from them needs no extra
 * transport and no worker change. A live operator chat would require the
 * worker's chat bridge to target the operator container/session — see the
 * Wave C integration note — so we deliberately read events here.
 *
 * This module is pure (no React, no I/O) so it's unit-testable on its own.
 */

export type NarrationTone = "operator" | "system" | "cost" | "error";

export type NarrationLine = {
  /** Stable id — reuse the source event id so React keys stay stable. */
  id: string;
  /** ISO timestamp of the underlying event. */
  at: string;
  /** Plain-language line shown to the manager. */
  text: string;
  /** Drives the dot colour / icon in the UI. */
  tone: NarrationTone;
};

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Map a single pipeline event to a narration line, or `null` when the event
 * carries no manager-facing meaning (those are folded into the technical
 * generation task list, not the narration feed).
 */
export function eventToNarration(event: PipelineEvent): NarrationLine | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const base = { id: event.id, at: event.created_at };

  switch (event.kind) {
    case "operator_dispatched": {
      const reason = str(payload, "reason");
      const text =
        reason === "kickoff"
          ? "You hired the operator for this run — it's reading the brief now."
          : reason === "config_approved"
            ? "You approved the brief. The operator is authoring concept previews."
            : reason === "picks_set"
              ? "You picked the concepts. The operator will render the finals."
              : reason === "review_approved"
                ? "You approved the picks. The operator is rendering the final assets."
                : "The operator was re-tasked for the next step.";
      return { ...base, text, tone: "system" };
    }

    case "brief_authored": {
      const notes = str(payload, "notes");
      const text = notes
        ? `Operator drafted the image brief — ready for your review. Notes: ${notes}`
        : "Operator drafted the image brief — ready for your review.";
      return { ...base, text, tone: "operator" };
    }

    case "operator_narration": {
      // A free-form note the operator can emit for the manager. Optional —
      // surfaced verbatim when present.
      const message = str(payload, "message") ?? str(payload, "text");
      if (!message) return null;
      return { ...base, text: message, tone: "operator" };
    }

    case "task_queued": {
      const concept = str(payload, "concept");
      const ratio = str(payload, "ratio");
      if (!concept) return null;
      const where = ratio ? ` (${ratio})` : "";
      return {
        ...base,
        text:
          event.stage === "generation"
            ? `Rendering final "${concept}"${where}…`
            : `Rendering concept "${concept}"${where}…`,
        tone: "operator",
      };
    }

    case "task_done": {
      // Picks-recorded is a manager action, not operator narration.
      if (str(payload, "action") === "picks_recorded") return null;
      const concept = str(payload, "concept");
      if (!concept) return null;
      const ratio = str(payload, "ratio");
      const where = ratio ? ` (${ratio})` : "";
      return {
        ...base,
        text:
          event.stage === "generation"
            ? `Final "${concept}"${where} is ready.`
            : `Concept "${concept}"${where} is ready for review.`,
        tone: "operator",
      };
    }

    case "task_error": {
      const concept = str(payload, "concept");
      const err = str(payload, "error") ?? "render failed";
      return {
        ...base,
        text: concept ? `Render of "${concept}" failed: ${err}` : `A render failed: ${err}`,
        tone: "error",
      };
    }

    case "cost_recorded": {
      const subtotal = num(payload, "subtotal");
      if (subtotal === undefined) return null;
      return { ...base, text: `Spend recorded: $${subtotal.toFixed(2)}.`, tone: "cost" };
    }

    case "stage_advanced": {
      switch (event.stage) {
        case "ideation":
          return { ...base, text: "Stage advanced to Ideation.", tone: "system" };
        case "review":
          return { ...base, text: "Stage advanced to Review.", tone: "system" };
        case "generation":
          return { ...base, text: "Stage advanced to Generation.", tone: "system" };
        case "cancelled":
          return { ...base, text: "Pipeline was cancelled.", tone: "system" };
        default:
          return null;
      }
    }

    default:
      return null;
  }
}

/**
 * Reduce a full event list to the narration feed, oldest-first. The caller
 * hands us the already-sorted list from `usePipelineEvents`; we only filter +
 * map, preserving order.
 */
export function buildNarration(events: PipelineEvent[]): NarrationLine[] {
  const lines: NarrationLine[] = [];
  for (const ev of events) {
    const line = eventToNarration(ev);
    if (line) lines.push(line);
  }
  return lines;
}
