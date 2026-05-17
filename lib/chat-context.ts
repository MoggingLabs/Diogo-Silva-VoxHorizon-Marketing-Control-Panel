import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types.gen";

/**
 * Translation layer: the agent (worker) needs a focused, format-agnostic
 * view of "what is going on with this creative right now" so its system
 * prompt and tool-use loop have the same context the operator does. This
 * module owns the round-trip from raw Supabase rows -> a single
 * `ChatContext` payload that travels over the chat SSE proxy.
 *
 * Issue: #152 (Wave 5.5-10) — `lib/chat-context.ts` translation layer.
 *
 * Design notes:
 *  - `creative_type` discriminates image (`creatives` + `creative_iterations`)
 *    from video (`video_creatives` + `video_iterations`). Each path queries
 *    the canonical table for that vertical and shapes the rows into the
 *    same `ChatContext` envelope.
 *  - The brief is loaded from `briefs` for image and `video_briefs` for
 *    video — both expose `payload` jsonb so callers get a uniform shape.
 *  - Iterations and chat messages are bounded with sane defaults (5 / 10)
 *    so the prompt stays tight; callers can override per-call.
 *  - The tool list is hardcoded per format — the worker still owns the
 *    canonical schemas, but the agent prompt benefits from advertising
 *    them up front. When the worker adds a new tool, update the registry
 *    here in lock-step with the upstream handler.
 *  - Server-only: this module pulls service-role-shaped data and is
 *    imported from API route handlers exclusively. The `server-only`
 *    sentinel prevents accidental client imports.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatCreativeType = "image" | "video";

export type ChatContextBrief = {
  id: string;
  status: string;
  payload: Record<string, unknown>;
};

export type ChatContextCreative = {
  id: string;
  type: ChatCreativeType;
  status: string;
  brief_id: string;
  created_at: string;
  /**
   * Format-specific extras. Image: `concept`, `offer_text`, `ratio`,
   * `version`, `file_path_supabase`. Video: `version` (int), the various
   * pipeline paths (`script_path`, `voiceover_path`, `composed_path`,
   * `captioned_path`), `duration_actual_s`, and `broll_clips` jsonb.
   * Anything the worker may want to reason about goes here as a generic
   * jsonb bag so the schema can evolve without breaking the agent.
   */
  extra: Record<string, unknown>;
};

export type ChatContextIteration = {
  kind: string;
  author: string;
  created_at: string;
  content: unknown;
};

export type ChatContextChatMessage = {
  author: string;
  content_type: string;
  content: string | null;
  created_at: string;
};

export type ChatContextTool = {
  name: string;
  description: string;
  input_schema: unknown;
};

export type ChatContext = {
  brief: ChatContextBrief;
  creative: ChatContextCreative;
  iterations: ChatContextIteration[];
  chat_history: ChatContextChatMessage[];
  available_tools: ChatContextTool[];
};

export type BuildChatContextArgs = {
  creative_id: string;
  creative_type: ChatCreativeType;
  limit_iterations?: number;
  limit_chat?: number;
};

/** Default rolling-window sizes — small enough to keep prompts cheap. */
export const DEFAULT_LIMIT_ITERATIONS = 5;
export const DEFAULT_LIMIT_CHAT = 10;

// ---------------------------------------------------------------------------
// Tool registry (hardcoded per format for now)
// ---------------------------------------------------------------------------

/**
 * Image-format tools the worker exposes for chat-with-Ekko. Keep names in
 * lock-step with `worker/src/routes/chat_stream.py` — the worker is the
 * canonical handler; this list is purely for the prompt advertisement.
 */
const IMAGE_TOOLS: ChatContextTool[] = [
  {
    name: "regenerate",
    description:
      "Regenerate the image using the existing prompt with optional adjustments. The new render becomes a new creative iteration of kind `regenerate`.",
    input_schema: {
      type: "object",
      properties: {
        adjustments: {
          type: "string",
          description:
            "Free-form note describing what to change in the next render (style, framing, mood).",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "composite",
    description:
      "Composite the current creative with an overlay (offer text, logo, badge). Produces a `user_edit` iteration with the layered output path.",
    input_schema: {
      type: "object",
      properties: {
        overlay_text: {
          type: "string",
          description: "Text to overlay (e.g. offer copy or CTA).",
        },
        position: {
          type: "string",
          enum: ["top", "center", "bottom"],
          description: "Where on the canvas the overlay should sit.",
        },
      },
      required: ["overlay_text"],
      additionalProperties: false,
    },
  },
];

/**
 * Video-format tools the worker exposes. Mirror the upstream video chat
 * handler — same naming convention as the `video_iteration_kind` enum
 * where it makes sense.
 */
const VIDEO_TOOLS: ChatContextTool[] = [
  {
    name: "rewrite_script",
    description:
      "Rewrite the script for this video creative. The new script is stored and the pipeline can be re-run from `script_ready`.",
    input_schema: {
      type: "object",
      properties: {
        notes: {
          type: "string",
          description:
            "What to change about the script (hook tone, tighter pacing, swap CTA, etc.).",
        },
      },
      required: ["notes"],
      additionalProperties: false,
    },
  },
  {
    name: "regenerate_voiceover",
    description:
      "Regenerate the voiceover audio using the current script. Useful after tweaking voice id, pace, or punctuation.",
    input_schema: {
      type: "object",
      properties: {
        voice_id: {
          type: "string",
          description: "Override the brief's voice id for this regeneration only.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "swap_broll",
    description: "Swap the b-roll clip for a single segment with another candidate from the pool.",
    input_schema: {
      type: "object",
      properties: {
        segment_idx: {
          type: "integer",
          minimum: 0,
          description: "Which script segment to swap (0-indexed).",
        },
        clip_id: {
          type: "string",
          description: "Identifier of the replacement clip in the b-roll store.",
        },
      },
      required: ["segment_idx", "clip_id"],
      additionalProperties: false,
    },
  },
  {
    name: "rerender",
    description:
      "Re-run the composition step (voiceover + b-roll -> composed MP4) without changing inputs. Useful after swap_broll or regenerate_voiceover.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "recaption",
    description:
      "Re-run the captioning step against the latest composed MP4 with optional style overrides.",
    input_schema: {
      type: "object",
      properties: {
        style: {
          type: "string",
          description: "Caption style override (e.g. `bold-yellow`, `clean-white`).",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

/** Return the tool catalog for a creative type. Pure / stateless. */
export function getAvailableTools(creative_type: ChatCreativeType): ChatContextTool[] {
  return creative_type === "video" ? VIDEO_TOOLS : IMAGE_TOOLS;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

type Client = SupabaseClient<Database>;

/**
 * Build the agent-facing context payload for one creative. Throws on a
 * missing creative / missing brief — callers should treat those as 404s
 * before invoking the worker.
 *
 * The function performs four small parallel selects (creative, iterations,
 * chat history, plus the brief once we know its id) so a typical call
 * fits in one round-trip's worth of latency. Iterations and chat history
 * are returned newest-first by the DB and then re-ordered ascending so
 * the agent reads them in conversational order.
 */
export async function buildChatContext(
  supabase: Client,
  args: BuildChatContextArgs,
): Promise<ChatContext> {
  const {
    creative_id,
    creative_type,
    limit_iterations = DEFAULT_LIMIT_ITERATIONS,
    limit_chat = DEFAULT_LIMIT_CHAT,
  } = args;

  // 1. Load the creative row first — we need its `brief_id` before we can
  //    pick up the brief in parallel with iterations + chat history.
  const creative = await loadCreative(supabase, creative_type, creative_id);

  // 2. Fan-out the remaining three reads.
  const [brief, iterations, chat_history] = await Promise.all([
    loadBrief(supabase, creative_type, creative.brief_id),
    loadIterations(supabase, creative_type, creative_id, limit_iterations),
    loadChatHistory(supabase, creative_type, creative_id, limit_chat),
  ]);

  return {
    brief,
    creative,
    iterations,
    chat_history,
    available_tools: getAvailableTools(creative_type),
  };
}

// ---------------------------------------------------------------------------
// Internal loaders
// ---------------------------------------------------------------------------

async function loadCreative(
  supabase: Client,
  creative_type: ChatCreativeType,
  creative_id: string,
): Promise<ChatContextCreative> {
  if (creative_type === "image") {
    const { data, error } = await supabase
      .from("creatives")
      .select(
        "id, brief_id, status, created_at, concept, offer_text, ratio, version, file_path_supabase, prompt_used",
      )
      .eq("id", creative_id)
      .maybeSingle();
    if (error) throw new Error(`load image creative: ${error.message}`);
    if (!data) throw new Error(`creative ${creative_id} not found`);
    const { id, brief_id, status, created_at, ...extra } = data;
    return {
      id,
      type: "image",
      status: String(status),
      brief_id,
      created_at,
      extra: extra as Record<string, unknown>,
    };
  }

  const { data, error } = await supabase
    .from("video_creatives")
    .select(
      "id, brief_id, status, created_at, version, script_path, voiceover_path, broll_clips, composed_path, captioned_path, drive_url, duration_actual_s",
    )
    .eq("id", creative_id)
    .maybeSingle();
  if (error) throw new Error(`load video creative: ${error.message}`);
  if (!data) throw new Error(`video creative ${creative_id} not found`);
  const { id, brief_id, status, created_at, ...extra } = data;
  return {
    id,
    type: "video",
    status: String(status),
    brief_id,
    created_at,
    extra: extra as Record<string, unknown>,
  };
}

async function loadBrief(
  supabase: Client,
  creative_type: ChatCreativeType,
  brief_id: string,
): Promise<ChatContextBrief> {
  if (creative_type === "image") {
    const { data, error } = await supabase
      .from("briefs")
      .select("id, status, payload")
      .eq("id", brief_id)
      .maybeSingle();
    if (error) throw new Error(`load brief: ${error.message}`);
    if (!data) throw new Error(`brief ${brief_id} not found`);
    return {
      id: data.id,
      status: String(data.status),
      payload: toPayloadRecord(data.payload),
    };
  }

  const { data, error } = await supabase
    .from("video_briefs")
    .select("id, status, payload")
    .eq("id", brief_id)
    .maybeSingle();
  if (error) throw new Error(`load video brief: ${error.message}`);
  if (!data) throw new Error(`video brief ${brief_id} not found`);
  return {
    id: data.id,
    status: String(data.status),
    payload: toPayloadRecord(data.payload),
  };
}

async function loadIterations(
  supabase: Client,
  creative_type: ChatCreativeType,
  creative_id: string,
  limit: number,
): Promise<ChatContextIteration[]> {
  const table = creative_type === "image" ? "creative_iterations" : "video_iterations";
  // Newest first so we can take(limit) cheaply, then reverse so the agent
  // reads them in chronological order.
  const { data, error } = await supabase
    .from(table)
    .select("kind, author, created_at, content")
    .eq("creative_id", creative_id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`load iterations: ${error.message}`);
  return (data ?? [])
    .map((row) => ({
      kind: String(row.kind),
      author: String(row.author),
      created_at: row.created_at,
      content: row.content,
    }))
    .reverse();
}

async function loadChatHistory(
  supabase: Client,
  creative_type: ChatCreativeType,
  creative_id: string,
  limit: number,
): Promise<ChatContextChatMessage[]> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("author, content_type, content, created_at")
    .eq("creative_type", creative_type)
    .eq("creative_id", creative_id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`load chat history: ${error.message}`);
  return (data ?? [])
    .map((row) => ({
      author: String(row.author),
      content_type: String(row.content_type),
      content: row.content,
      created_at: row.created_at,
    }))
    .reverse();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a jsonb cell into a plain object record. `null`, scalars, and
 * arrays are wrapped in `{ value: <raw> }` so the consumer always sees a
 * dict shape. Postgres returns objects as objects already; we only need
 * the guard for defensive callers (e.g. fixtures that stored a string).
 */
function toPayloadRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value: value ?? null };
}
