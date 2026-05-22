/**
 * Human-friendly description of an approval for the queue card + modal header.
 *
 * Pure (no React, no IO) so it's trivially unit-testable and reusable. Given an
 * `Approval`, it returns:
 *   - `purpose` — a short verb phrase ("Render 3 concept preview(s)",
 *     "Generate image", or a humanised tool name for unknown tools).
 *   - `detail`  — a one-line secondary string ("Pipeline render", a truncated
 *     prompt, …) used as the card's secondary line.
 *
 * Known shapes (from the Hermes plugin):
 *   - operator render:  tool_name="mcp_pipeline_operator_pipeline_operator_render",
 *       tool_args={ pipeline_id, kind: "concept_preview" | "final", items: [...] }
 *   - Ekko image gen:   tool_name="kie_generate",
 *       tool_args={ prompt, size, n, quality }, context={ pipeline_id?, … }
 */
import type { Approval } from "./types";

export interface ApprovalDescription {
  /** Short verb phrase describing what the call does. */
  purpose: string;
  /** Optional secondary line — extra context for the operator. */
  detail: string;
}

const RENDER_TOOL = "mcp_pipeline_operator_pipeline_operator_render";
const KIE_GENERATE_TOOL = "kie_generate";

const PROMPT_MAX = 120;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Count the items array on a render call. Returns `null` when no explicit
 * items/n are present — the DETERMINISTIC path, where the worker renders all
 * persisted concepts/picks itself, so a fixed count is unknown at gate time.
 */
function countItems(args: Record<string, unknown>): number | null {
  const items = args.items;
  if (Array.isArray(items) && items.length > 0) return items.length;
  if (typeof args.n === "number" && args.n > 0) return args.n;
  if (items === undefined || items === null) return null;
  return 1;
}

/** Truncate a string to `max` chars, appending an ellipsis when clipped. */
function truncate(value: string, max = PROMPT_MAX): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Humanise a snake/camel tool name into a Title-ish phrase, dropping a known
 * `mcp_…` prefix so the fallback stays readable.
 */
export function humanizeToolName(toolName: string): string {
  const cleaned = toolName
    .replace(/^mcp_/, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  if (!cleaned) return toolName;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Resolve the `purpose` + `detail` for an approval. Never throws — unknown
 * shapes fall back to a humanised tool name.
 */
export function describeApproval(approval: Approval): ApprovalDescription {
  const args = asRecord(approval.tool_args);

  if (approval.tool_name === RENDER_TOOL) {
    const n = countItems(args);
    if (args.kind === "final") {
      return {
        purpose:
          n === null
            ? "Render all final images"
            : `Render ${n} final image${n === 1 ? "" : "s"}`,
        detail: "Final render for the pipeline.",
      };
    }
    // Default render kind is concept_preview.
    return {
      purpose:
        n === null
          ? "Render all concept previews"
          : `Render ${n} concept preview${n === 1 ? "" : "s"}`,
      detail: "Concept preview render for the pipeline.",
    };
  }

  if (approval.tool_name === KIE_GENERATE_TOOL) {
    const prompt = typeof args.prompt === "string" ? truncate(args.prompt) : "";
    return {
      purpose: "Generate image",
      detail: prompt || "Generate an image from a prompt.",
    };
  }

  return {
    purpose: humanizeToolName(approval.tool_name),
    detail: approval.tool_name,
  };
}

/**
 * Build the "Client — Purpose" card title. Falls back to the skill name, then
 * the session id, then the bare purpose when no client is resolved.
 */
export function approvalTitle(approval: Approval): string {
  const { purpose } = describeApproval(approval);
  const lead =
    approval.client_name ?? approval.context?.skill_name ?? approval.ekko_session_id ?? null;
  return lead ? `${lead} — ${purpose}` : purpose;
}
