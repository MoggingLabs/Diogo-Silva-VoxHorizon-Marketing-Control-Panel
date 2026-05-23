/**
 * CreativeCard renders a single tile in the variants grid. Tests cover:
 *  - Image rendering + placeholder fallback
 *  - Status pill + label resolution
 *  - Concept fallback when blank
 *  - timeSince formatting for various age windows
 *  - onSelect callback wiring + aria-pressed reflection
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Creative } from "@/lib/creatives";

import { CreativeCard } from "./CreativeCard";

function makeCreative(over: Partial<Creative> = {}): Creative {
  return {
    id: "c1",
    brief_id: "b1",
    concept: "Hurricane-ready",
    ratio: "1x1",
    version: "v1.0",
    status: "draft",
    file_path_supabase: "x.png",
    file_path_drive: null,
    type: "image",
    prompt_used: null,
    offer_text: null,
    approved_at: null,
    asset_name: null,
    concept_id: null,
    deleted_at: null,
    drive_folder_id: null,
    finalize_verified: false,
    finalized_at: null,
    pipeline_id: null,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    ...(over as object),
  } as Creative;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-17T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CreativeCard", () => {
  it("renders the image when signedUrl is provided", () => {
    render(
      <CreativeCard
        creative={makeCreative()}
        signedUrl="https://x.example/img.png"
        onSelect={() => {}}
      />,
    );
    const img = screen.getByAltText("Hurricane-ready") as HTMLImageElement;
    expect(img.src).toBe("https://x.example/img.png");
  });

  it("renders the placeholder when signedUrl is null", () => {
    render(<CreativeCard creative={makeCreative()} signedUrl={null} onSelect={() => {}} />);
    expect(screen.getByText(/No render yet/)).toBeInTheDocument();
  });

  it("renders the status pill label", () => {
    render(
      <CreativeCard
        creative={makeCreative({ status: "approved" })}
        signedUrl={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getAllByText(/approved/i).length).toBeGreaterThan(0);
  });

  it("falls back to 'Untitled concept' when concept is blank", () => {
    render(
      <CreativeCard
        creative={makeCreative({ concept: "   " })}
        signedUrl={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getAllByText(/Untitled concept/).length).toBeGreaterThan(0);
  });

  it("falls back to a generic status pill class for unknown statuses", () => {
    render(
      <CreativeCard
        creative={makeCreative({ status: "weird" as Creative["status"] })}
        signedUrl={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getAllByText(/weird/).length).toBeGreaterThan(0);
  });

  it("fires onSelect with the creative id when clicked", async () => {
    const onSelect = vi.fn();
    vi.useRealTimers();
    const user = userEvent.setup();
    render(<CreativeCard creative={makeCreative()} signedUrl="x" onSelect={onSelect} />);
    await user.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("c1");
  });

  it("sets aria-pressed when active is true", () => {
    render(<CreativeCard creative={makeCreative()} signedUrl={null} active onSelect={() => {}} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("renders '—' ratio fallback when ratio missing", () => {
    render(
      <CreativeCard
        creative={makeCreative({ ratio: null })}
        signedUrl={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  // timeSince branches:
  it("renders 'just now' for < 1 minute old", () => {
    render(
      <CreativeCard
        creative={makeCreative({ created_at: new Date().toISOString() })}
        signedUrl={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("just now")).toBeInTheDocument();
  });

  it("renders Nm ago for < 1 hour old", () => {
    render(
      <CreativeCard
        creative={makeCreative({
          created_at: new Date(Date.now() - 7 * 60_000).toISOString(),
        })}
        signedUrl={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("7m ago")).toBeInTheDocument();
  });

  it("renders Nh ago for < 24 hours old", () => {
    render(
      <CreativeCard
        creative={makeCreative({
          created_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        })}
        signedUrl={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("3h ago")).toBeInTheDocument();
  });

  it("renders Nd ago for < 30 days old", () => {
    render(
      <CreativeCard
        creative={makeCreative({
          created_at: new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString(),
        })}
        signedUrl={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("5d ago")).toBeInTheDocument();
  });

  it("renders Nmo ago for ≥ 30 days old", () => {
    render(
      <CreativeCard
        creative={makeCreative({
          created_at: new Date(Date.now() - 60 * 24 * 60 * 60_000).toISOString(),
        })}
        signedUrl={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/mo ago/)).toBeInTheDocument();
  });

  it("renders 'just now' for a future timestamp", () => {
    render(
      <CreativeCard
        creative={makeCreative({
          created_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        })}
        signedUrl={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("just now")).toBeInTheDocument();
  });

  it("renders an em-dash when created_at is unparseable", () => {
    render(
      <CreativeCard
        creative={makeCreative({ created_at: "not-a-date" })}
        signedUrl={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
