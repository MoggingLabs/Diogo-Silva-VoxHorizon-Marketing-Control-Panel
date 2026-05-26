/**
 * Tests for the video-brief detail action cluster (E3.2 / #591).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/briefs-client", () => ({
  archiveBrief: vi.fn(),
  restoreBrief: vi.fn(),
  updateVideoBrief: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { VideoBriefDetailActions } from "./VideoBriefDetailActions";
import type { VideoBrief } from "@/lib/video-briefs";

const brief = {
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
  payload: { notes: "" },
  created_at: "2026-05-20T00:00:00Z",
  posted_at: null,
  decided_at: null,
  decided_by: null,
  decided_notes: null,
  deleted_at: null,
} as VideoBrief;

afterEach(() => vi.clearAllMocks());

describe("VideoBriefDetailActions", () => {
  it("shows Edit + Archive when active, and opens the edit drawer", async () => {
    const user = userEvent.setup();
    render(<VideoBriefDetailActions brief={brief} archived={false} />);
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /archive brief/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    expect(await screen.findByText("Edit video brief")).toBeInTheDocument();
  });

  it("hides Edit and shows Restore when archived", () => {
    render(<VideoBriefDetailActions brief={brief} archived />);
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /restore brief/i })).toBeInTheDocument();
  });
});
