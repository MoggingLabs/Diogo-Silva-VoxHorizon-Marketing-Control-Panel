/**
 * Tests for the image-brief detail action cluster (E3.2 / #591).
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
  updateImageBrief: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { BriefDetailActions } from "./BriefDetailActions";
import type { Brief } from "@/lib/briefs";

const brief = {
  id: "b1",
  brief_id_human: "img-1",
  client_id: "c1",
  status: "draft",
  payload: { service: "roofing", budget: 1000, market: "Austin" },
  created_at: "2026-05-20T00:00:00Z",
  posted_at: null,
  decided_at: null,
  decided_by: null,
  decided_notes: null,
  deleted_at: null,
} as Brief;

afterEach(() => vi.clearAllMocks());

describe("BriefDetailActions", () => {
  it("shows Edit + Archive when active, and opens the edit drawer", async () => {
    const user = userEvent.setup();
    render(<BriefDetailActions brief={brief} archived={false} />);
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /archive brief/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    expect(await screen.findByText("Edit brief")).toBeInTheDocument();
  });

  it("hides Edit and shows Restore when archived", () => {
    render(<BriefDetailActions brief={brief} archived />);
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /restore brief/i })).toBeInTheDocument();
  });
});
