import { describe, expect, it } from "vitest";

import { buildNarration, eventToNarration } from "./narration";
import type { PipelineEvent } from "@/lib/pipeline/types";

let seq = 0;
function ev(partial: Partial<PipelineEvent> & { kind: string }): PipelineEvent {
  seq += 1;
  return {
    id: partial.id ?? `e${seq}`,
    pipeline_id: "p1",
    kind: partial.kind,
    stage: partial.stage ?? null,
    payload: partial.payload ?? {},
    created_at: partial.created_at ?? `2026-05-20T00:00:0${seq % 10}.000Z`,
  };
}

describe("eventToNarration", () => {
  it("describes kickoff vs each re-task reason for operator_dispatched", () => {
    expect(
      eventToNarration(ev({ kind: "operator_dispatched", payload: { reason: "kickoff" } }))?.text,
    ).toMatch(/hired the operator/i);
    expect(
      eventToNarration(ev({ kind: "operator_dispatched", payload: { reason: "config_approved" } }))
        ?.text,
    ).toMatch(/concept previews/i);
    expect(
      eventToNarration(ev({ kind: "operator_dispatched", payload: { reason: "picks_set" } }))?.text,
    ).toMatch(/render the finals/i);
    expect(
      eventToNarration(ev({ kind: "operator_dispatched", payload: { reason: "review_approved" } }))
        ?.text,
    ).toMatch(/final assets/i);
    // Unknown reason still yields a generic system line (no crash).
    const generic = eventToNarration(ev({ kind: "operator_dispatched", payload: {} }));
    expect(generic?.tone).toBe("system");
  });

  it("renders brief_authored with and without notes", () => {
    expect(eventToNarration(ev({ kind: "brief_authored", payload: {} }))?.text).toMatch(
      /drafted the image brief/i,
    );
    const withNotes = eventToNarration(
      ev({ kind: "brief_authored", payload: { notes: "lean into savings" } }),
    );
    expect(withNotes?.text).toContain("lean into savings");
    expect(withNotes?.tone).toBe("operator");
  });

  it("surfaces a free-form operator_narration message, else drops it", () => {
    expect(
      eventToNarration(ev({ kind: "operator_narration", payload: { message: "halfway" } }))?.text,
    ).toBe("halfway");
    expect(eventToNarration(ev({ kind: "operator_narration", payload: {} }))).toBeNull();
  });

  it("distinguishes concept vs final renders by stage", () => {
    const concept = eventToNarration(
      ev({
        kind: "task_queued",
        stage: "ideation",
        payload: { concept: "Before/After", ratio: "1x1" },
      }),
    );
    expect(concept?.text).toMatch(/concept "Before\/After" \(1x1\)/i);
    const finalDone = eventToNarration(
      ev({ kind: "task_done", stage: "generation", payload: { concept: "Owner", ratio: "9x16" } }),
    );
    expect(finalDone?.text).toMatch(/final "Owner" \(9x16\) is ready/i);
  });

  it("drops task events with no concept and the picks_recorded marker", () => {
    expect(eventToNarration(ev({ kind: "task_queued", payload: {} }))).toBeNull();
    expect(
      eventToNarration(
        ev({ kind: "task_done", payload: { action: "picks_recorded", image_count: 2 } }),
      ),
    ).toBeNull();
  });

  it("renders task_error with the error tone", () => {
    const line = eventToNarration(
      ev({ kind: "task_error", payload: { concept: "Urgency", error: "kie timeout" } }),
    );
    expect(line?.tone).toBe("error");
    expect(line?.text).toMatch(/Urgency.*kie timeout/);
  });

  it("formats cost_recorded as dollars and drops it when subtotal missing", () => {
    expect(eventToNarration(ev({ kind: "cost_recorded", payload: { subtotal: 0.05 } }))?.text).toBe(
      "Spend recorded: $0.05.",
    );
    expect(eventToNarration(ev({ kind: "cost_recorded", payload: {} }))).toBeNull();
  });

  it("maps stage_advanced for known stages and drops unknown ones", () => {
    expect(eventToNarration(ev({ kind: "stage_advanced", stage: "ideation" }))?.text).toMatch(
      /Ideation/,
    );
    expect(eventToNarration(ev({ kind: "stage_advanced", stage: "generation" }))?.text).toMatch(
      /Generation/,
    );
    expect(eventToNarration(ev({ kind: "stage_advanced", stage: "cancelled" }))?.text).toMatch(
      /cancelled/i,
    );
    // configuration bootstrap is not narrated.
    expect(eventToNarration(ev({ kind: "stage_advanced", stage: "configuration" }))).toBeNull();
  });

  it("returns null for unrecognised kinds", () => {
    expect(eventToNarration(ev({ kind: "some_other_kind" }))).toBeNull();
  });
});

describe("buildNarration", () => {
  it("filters non-narration events and preserves order", () => {
    const events: PipelineEvent[] = [
      ev({ kind: "operator_dispatched", stage: "configuration", payload: { reason: "kickoff" } }),
      ev({ kind: "stage_advanced", stage: "configuration" }), // dropped
      ev({ kind: "brief_authored", payload: {} }),
      ev({ kind: "task_done", payload: { action: "picks_recorded" } }), // dropped
      ev({ kind: "cost_recorded", payload: { subtotal: 0.02 } }),
    ];
    const lines = buildNarration(events);
    expect(lines).toHaveLength(3);
    expect(lines[0]!.text).toMatch(/hired the operator/i);
    expect(lines[1]!.text).toMatch(/drafted the image brief/i);
    expect(lines[2]!.text).toMatch(/Spend recorded/i);
    // Stable ids carried from the source events.
    expect(lines[0]!.id).toBe(events[0]!.id);
  });
});
