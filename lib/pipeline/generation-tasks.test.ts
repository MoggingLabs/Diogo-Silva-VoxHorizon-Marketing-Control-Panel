import { describe, expect, it } from "vitest";

import {
  collapseGenerationTasks,
  labelFor,
  prettySubstage,
  readCostTotal,
  statusFromKind,
  taskKeyFromPayload,
} from "./generation-tasks";
import type { PipelineEvent } from "./types";

/**
 * Tiny factory so tests stay readable. The `pipeline_id` is the same
 * across the fixtures — every event in collapseGenerationTasks() is
 * already filtered upstream by `pipeline_id`.
 */
function event(
  overrides: Partial<PipelineEvent> & { kind: string; payload: Record<string, unknown> },
  idx = 0,
): PipelineEvent {
  return {
    id: overrides.id ?? `evt-${idx.toString().padStart(3, "0")}`,
    pipeline_id: overrides.pipeline_id ?? "pipeline-1",
    kind: overrides.kind,
    stage: overrides.stage ?? "generation",
    payload: overrides.payload,
    created_at: overrides.created_at ?? `2026-05-17T12:00:${idx.toString().padStart(2, "0")}Z`,
  };
}

describe("statusFromKind", () => {
  it("maps the four task kinds", () => {
    expect(statusFromKind("task_queued")).toBe("queued");
    expect(statusFromKind("task_running")).toBe("running");
    expect(statusFromKind("task_done")).toBe("done");
    expect(statusFromKind("task_error")).toBe("error");
  });
  it("falls back to queued for unknown kinds", () => {
    expect(statusFromKind("nope")).toBe("queued");
  });
});

describe("taskKeyFromPayload", () => {
  const ev = event({ kind: "task_queued", payload: {} }, 0);

  it("image: parent_creative_id + ratio", () => {
    expect(taskKeyFromPayload({ kind: "image", parent_creative_id: "p1", ratio: "1x1" }, ev)).toBe(
      "image:p1:1x1",
    );
  });
  it("image: missing parent → null", () => {
    expect(taskKeyFromPayload({ kind: "image", ratio: "1x1" }, ev)).toBeNull();
  });
  it("video: creative_id + substage", () => {
    expect(
      taskKeyFromPayload({ kind: "video", creative_id: "vc1", substage: "voiceover" }, ev),
    ).toBe("video:vc1:voiceover");
  });
  it("retry events get a distinct suffix", () => {
    expect(
      taskKeyFromPayload(
        { kind: "image", parent_creative_id: "p1", ratio: "1x1", retry_of: "ev-err" },
        ev,
      ),
    ).toBe("image:p1:1x1:retry:ev-err");
  });
  it("unknown kind: falls back to event id", () => {
    expect(taskKeyFromPayload({}, ev)).toBe("event:evt-000");
  });
});

describe("labelFor", () => {
  it("image with concept + ratio", () => {
    expect(labelFor("image", { concept: "Hero shot", ratio: "9x16" })).toBe(
      "Image render: Hero shot (9x16)",
    );
  });
  it("image with missing concept defaults to 'Concept'", () => {
    expect(labelFor("image", { ratio: "1x1" })).toBe("Image render: Concept (1x1)");
  });
  it("video uses prettySubstage", () => {
    expect(labelFor("video", { substage: "voiceover" })).toBe("Video · Voiceover (ElevenLabs)");
  });
});

describe("prettySubstage", () => {
  it("maps known substages to human labels", () => {
    expect(prettySubstage("compose")).toBe("Compose (Hyperframes)");
    expect(prettySubstage("caption")).toBe("Captions (Submagic)");
  });
  it("echoes unknown substages", () => {
    expect(prettySubstage("magic")).toBe("magic");
  });
  it("handles empty substage", () => {
    expect(prettySubstage("")).toBe("Substage");
  });
});

describe("collapseGenerationTasks", () => {
  it("groups a queued→running→done chain into a single done row", () => {
    const events: PipelineEvent[] = [
      event(
        { kind: "task_queued", payload: { kind: "image", parent_creative_id: "p1", ratio: "1x1" } },
        0,
      ),
      event(
        {
          kind: "task_running",
          payload: { kind: "image", parent_creative_id: "p1", ratio: "1x1" },
        },
        1,
      ),
      event(
        {
          kind: "task_done",
          payload: {
            kind: "image",
            parent_creative_id: "p1",
            ratio: "1x1",
            creative_id: "c1",
            file_path_supabase: "creatives/x.png",
          },
        },
        2,
      ),
    ];
    const tasks = collapseGenerationTasks(events);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("done");
    expect(tasks[0]!.donePayload?.creative_id).toBe("c1");
    expect(tasks[0]!.errorEventId).toBeNull();
  });

  it("surfaces task_error and stamps errorEventId", () => {
    const events: PipelineEvent[] = [
      event(
        { kind: "task_queued", payload: { kind: "image", parent_creative_id: "p1", ratio: "1x1" } },
        0,
      ),
      event(
        {
          id: "err-1",
          kind: "task_error",
          payload: { kind: "image", parent_creative_id: "p1", ratio: "1x1", error: "kie 502" },
        },
        1,
      ),
    ];
    const tasks = collapseGenerationTasks(events);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("error");
    expect(tasks[0]!.errorEventId).toBe("err-1");
  });

  it("treats retries as a distinct row from the original error", () => {
    const events: PipelineEvent[] = [
      event(
        {
          id: "err-1",
          kind: "task_error",
          payload: { kind: "image", parent_creative_id: "p1", ratio: "1x1", error: "kie 502" },
        },
        0,
      ),
      event(
        {
          kind: "task_queued",
          payload: { kind: "image", parent_creative_id: "p1", ratio: "1x1", retry_of: "err-1" },
        },
        1,
      ),
      event(
        {
          kind: "task_done",
          payload: {
            kind: "image",
            parent_creative_id: "p1",
            ratio: "1x1",
            retry_of: "err-1",
            creative_id: "c2",
          },
        },
        2,
      ),
    ];
    const tasks = collapseGenerationTasks(events);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.status).toBe("error");
    expect(tasks[0]!.isRetry).toBe(false);
    expect(tasks[1]!.status).toBe("done");
    expect(tasks[1]!.isRetry).toBe(true);
  });

  it("filters out non-generation events (e.g. ideation task_done from picks_recorded)", () => {
    const events: PipelineEvent[] = [
      event(
        {
          kind: "task_done",
          stage: "ideation",
          payload: { kind: "image", parent_creative_id: "p1", ratio: "1x1" },
        },
        0,
      ),
      event(
        {
          kind: "task_queued",
          stage: "generation",
          payload: { kind: "image", parent_creative_id: "p1", ratio: "1x1" },
        },
        1,
      ),
    ];
    const tasks = collapseGenerationTasks(events);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("queued");
  });

  it("ignores cost_recorded / stage_advanced events entirely", () => {
    const events: PipelineEvent[] = [
      event({ kind: "stage_advanced", payload: {} }, 0),
      event({ kind: "cost_recorded", payload: { api: "kie.ai", units: 1, subtotal: 0.05 } }, 1),
      event(
        { kind: "task_queued", payload: { kind: "image", parent_creative_id: "p1", ratio: "1x1" } },
        2,
      ),
    ];
    expect(collapseGenerationTasks(events)).toHaveLength(1);
  });

  it("preserves first-seen order across multiple tasks", () => {
    const events: PipelineEvent[] = [
      event(
        { kind: "task_queued", payload: { kind: "image", parent_creative_id: "p1", ratio: "1x1" } },
        0,
      ),
      event(
        {
          kind: "task_queued",
          payload: { kind: "video", creative_id: "vc1", substage: "voiceover" },
        },
        1,
      ),
      event(
        {
          kind: "task_running",
          payload: { kind: "image", parent_creative_id: "p1", ratio: "1x1" },
        },
        2,
      ),
    ];
    const tasks = collapseGenerationTasks(events);
    expect(tasks.map((t) => t.taskKey)).toEqual(["image:p1:1x1", "video:vc1:voiceover"]);
  });
});

describe("readCostTotal", () => {
  it("returns 0 for null / missing", () => {
    expect(readCostTotal(null)).toBe(0);
    expect(readCostTotal({})).toBe(0);
  });
  it("returns numeric total", () => {
    expect(readCostTotal({ total: 1.74 })).toBeCloseTo(1.74, 4);
  });
  it("coerces string totals (defensive)", () => {
    expect(readCostTotal({ total: "0.45" })).toBeCloseTo(0.45, 4);
  });
  it("clamps negative to 0", () => {
    expect(readCostTotal({ total: -1 })).toBe(0);
  });
  it("returns 0 for non-finite", () => {
    expect(readCostTotal({ total: Number.POSITIVE_INFINITY })).toBe(0);
    expect(readCostTotal({ total: Number.NaN })).toBe(0);
  });
});
