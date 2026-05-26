/**
 * Tests for the video-brief edit drawer (E3.2 / #591).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const updateVideoBrief = vi.fn();
vi.mock("@/lib/briefs-client", () => ({
  updateVideoBrief: (id: string, body: unknown) => updateVideoBrief(id, body),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { VideoBriefEditDrawer } from "./VideoBriefEditDrawer";
import type { VideoBrief } from "@/lib/video-briefs";

function makeBrief(over: Partial<VideoBrief> = {}): VideoBrief {
  return {
    id: "v1",
    brief_id_human: "vid-1",
    client_id: "c1",
    status: "draft",
    script_outline: { hook: "h", segments: [{ topic: "t", duration_s: 30 }] },
    target_duration_s: 30,
    voice_id: "voice-1",
    music_track: null,
    hook_style: null,
    dimensions: "9x16",
    captions_style: null,
    broll_selection_mode: "review_each",
    payload: { notes: "hello" },
    created_at: "2026-05-20T00:00:00Z",
    posted_at: null,
    decided_at: null,
    decided_by: null,
    decided_notes: null,
    deleted_at: null,
    ...over,
  } as VideoBrief;
}

afterEach(() => vi.clearAllMocks());

describe("VideoBriefEditDrawer", () => {
  it("prefills the scalar fields + notes from the brief", () => {
    render(<VideoBriefEditDrawer open onOpenChange={vi.fn()} brief={makeBrief()} />);
    expect(screen.getByLabelText(/voice id/i)).toHaveValue("voice-1");
    expect(screen.getByLabelText(/^notes$/i)).toHaveValue("hello");
  });

  it("submits scalar fields, coercing empty music to null, omitting status when unchanged", async () => {
    const user = userEvent.setup();
    render(<VideoBriefEditDrawer open onOpenChange={vi.fn()} brief={makeBrief()} />);

    const voice = screen.getByLabelText(/voice id/i);
    await user.clear(voice);
    await user.type(voice, "voice-2");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(updateVideoBrief).toHaveBeenCalled());
    const [id, body] = updateVideoBrief.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe("v1");
    expect(body.voice_id).toBe("voice-2");
    expect(body.music_track).toBeNull();
    expect(body.dimensions).toBe("9x16");
    expect(body.broll_selection_mode).toBe("review_each");
    expect(body.status).toBeUndefined();
  });

  it("sets music + hook + captions + a status change (truthy branches)", async () => {
    const user = userEvent.setup();
    render(
      <VideoBriefEditDrawer
        open
        onOpenChange={vi.fn()}
        brief={makeBrief({
          status: "posted",
          music_track: null,
          hook_style: null,
          captions_style: null,
        })}
      />,
    );

    await user.type(screen.getByLabelText(/music track/i), "epic.mp3");

    // hook style select (set to a real value)
    await user.click(screen.getByLabelText(/hook style/i));
    await user.click(await screen.findByRole("option", { name: /curiosity/i }));

    // captions style select
    await user.click(screen.getByLabelText(/captions style/i));
    await user.click(await screen.findByRole("option", { name: /bold yellow/i }));

    // status posted -> draft
    const triggers = screen.getAllByRole("combobox");
    const statusTrigger = triggers.at(-1);
    if (!statusTrigger) throw new Error("status select not found");
    await user.click(statusTrigger);
    await user.click(await screen.findByRole("option", { name: "Draft" }));

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(updateVideoBrief).toHaveBeenCalled());
    const [, body] = updateVideoBrief.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.music_track).toBe("epic.mp3");
    expect(body.hook_style).toBe("curiosity");
    expect(body.captions_style).toBe("bold_yellow");
    expect(body.status).toBe("draft");
  });

  it("blocks submit when voice_id is cleared (zod)", async () => {
    const user = userEvent.setup();
    render(<VideoBriefEditDrawer open onOpenChange={vi.fn()} brief={makeBrief()} />);
    await user.clear(screen.getByLabelText(/voice id/i));
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText(/voice_id is required/i)).toBeInTheDocument());
    expect(updateVideoBrief).not.toHaveBeenCalled();
  });
});
