/**
 * Tests for the image launch summary (a server component — synchronous,
 * no hooks).
 *
 * Covers:
 *   - Brief overview fields render with locale-formatted budget.
 *   - Em-dash fallback when payload fields are missing.
 *   - Landing page renders as an anchor.
 *   - Validation issues banner appears when payload has issues; severity pill class differs.
 *   - "No approved creatives" empty state when creatives is empty.
 *   - Creative card renders concept, ratio badge, version, Drive link, copy variants.
 *   - Missing Drive link → "missing".
 *   - Empty copies → "No paired copy variants".
 *   - Validation block reflects payload.validation.ok and via.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LaunchSummary } from "./LaunchSummary";
import type { Brief } from "@/lib/briefs";
import type { Creative } from "@/lib/creatives";
import type { LaunchPayloadT } from "@/lib/launches";

function brief(over: Partial<Brief> = {}): Brief {
  return {
    id: "b1",
    brief_id_human: "BRF-001",
    client_id: "c1",
    payload: {
      service: "roofing",
      market: "Tampa, FL",
      budget: 5000,
      landing_page_url: "https://example.com/lp",
    },
    status: "approved",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    posted_at: null,
    decided_at: null,
    notes: null,
    ...over,
  } as unknown as Brief;
}

function creative(over: Partial<Creative> = {}): Creative {
  return {
    id: "cr-1",
    brief_id: "b1",
    concept: "Hook A",
    ratio: "1x1",
    version: "v1",
    status: "approved",
    file_path_drive: "https://drive.example/file1",
    drive_url: "https://drive.example/file1",
    file_path_supabase: null,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  } as unknown as Creative;
}

function payload(over: Partial<LaunchPayloadT> = {}): LaunchPayloadT {
  return {
    brief_id_human: "BRF-001",
    client: { id: "c1", slug: "acme", name: "Acme" },
    creative_ids: [],
    copy_variant_ids: [],
    asset_refs: [],
    issues: [],
    validation: { ok: true, via: "preflight" },
    ...over,
  };
}

describe("LaunchSummary", () => {
  it("renders brief overview with formatted budget + landing page link", () => {
    render(
      <LaunchSummary
        brief={brief()}
        creatives={[]}
        copyByCreativeId={{}}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText("BRF-001")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("roofing")).toBeInTheDocument();
    expect(screen.getByText("$5,000")).toBeInTheDocument();
    expect(screen.getByText("Tampa, FL")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://example.com/lp" })).toBeInTheDocument();
  });

  it("renders em-dash fallbacks when the payload is unparseable", () => {
    render(
      <LaunchSummary
        brief={brief({ payload: null as never })}
        creatives={[]}
        copyByCreativeId={{}}
        signedUrls={{}}
        payload={payload({ client: null })}
      />,
    );

    // Multiple em-dashes appear.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders the issues banner with severity pills", () => {
    render(
      <LaunchSummary
        brief={brief()}
        creatives={[]}
        copyByCreativeId={{}}
        signedUrls={{}}
        payload={payload({
          issues: [
            { severity: "error", message: "missing drive" },
            { severity: "warning", message: "low budget" },
          ],
        })}
      />,
    );

    expect(screen.getByText(/Validation issues \(2\)/)).toBeInTheDocument();
    expect(screen.getByText("missing drive")).toBeInTheDocument();
    expect(screen.getByText("low budget")).toBeInTheDocument();
  });

  it("hides the issues banner when issues is empty", () => {
    render(
      <LaunchSummary
        brief={brief()}
        creatives={[]}
        copyByCreativeId={{}}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.queryByText(/Validation issues/)).not.toBeInTheDocument();
  });

  it("renders the 'no approved creatives' empty state", () => {
    render(
      <LaunchSummary
        brief={brief()}
        creatives={[]}
        copyByCreativeId={{}}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText(/No approved creatives bundled with this launch/)).toBeInTheDocument();
  });

  it("renders a creative card with its concept, version, and ratio badge", () => {
    render(
      <LaunchSummary
        brief={brief()}
        creatives={[creative()]}
        copyByCreativeId={{
          "cr-1": [
            {
              id: "cv-1",
              creative_id: "cr-1",
              headline: "Big Headline",
              body: "Body copy",
              cta: "Call now",
              status: "approved",
              created_at: "2026-05-01T00:00:00Z",
              updated_at: "2026-05-01T00:00:00Z",
            } as never,
          ],
        }}
        signedUrls={{ "cr-1": "https://signed.example/c1.png" }}
        payload={payload()}
      />,
    );

    expect(screen.getByText("Hook A")).toBeInTheDocument();
    expect(screen.getByText("1x1")).toBeInTheDocument();
    // version label has the "v1" text next to the "Version:" label
    expect(screen.getByText("v1")).toBeInTheDocument();
    // Headlines / body / CTA render
    expect(screen.getByText("Big Headline")).toBeInTheDocument();
    expect(screen.getByText("Body copy")).toBeInTheDocument();
    expect(screen.getByText("CTA: Call now")).toBeInTheDocument();
  });

  it('renders the "no preview" placeholder when signed URL is missing', () => {
    render(
      <LaunchSummary
        brief={brief()}
        creatives={[creative()]}
        copyByCreativeId={{ "cr-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText("no preview")).toBeInTheDocument();
  });

  it("renders missing-drive copy when file_path_drive is absent", () => {
    render(
      <LaunchSummary
        brief={brief()}
        creatives={[creative({ file_path_drive: null })]}
        copyByCreativeId={{ "cr-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText("missing")).toBeInTheDocument();
  });

  it('renders "No paired copy variants" when copy array is empty', () => {
    render(
      <LaunchSummary
        brief={brief()}
        creatives={[creative()]}
        copyByCreativeId={{ "cr-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText("No paired copy variants.")).toBeInTheDocument();
  });

  it("renders 'ok' validation summary when payload.validation.ok is true", () => {
    render(
      <LaunchSummary
        brief={brief()}
        creatives={[]}
        copyByCreativeId={{}}
        signedUrls={{}}
        payload={payload({ validation: { ok: true, via: "preflight" } })}
      />,
    );

    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.getByText("preflight")).toBeInTheDocument();
  });

  it("renders 'issues present' validation summary when ok is false and shows stderr", () => {
    render(
      <LaunchSummary
        brief={brief()}
        creatives={[]}
        copyByCreativeId={{}}
        signedUrls={{}}
        payload={payload({
          validation: {
            ok: false,
            via: "scripts_runner",
            raw_stderr: "something wrong",
          },
        })}
      />,
    );

    expect(screen.getByText("issues present")).toBeInTheDocument();
    expect(screen.getByText("something wrong")).toBeInTheDocument();
  });

  it("falls back to default ratio badge for unknown ratios", () => {
    // The DB type allows only "1x1" | "9x16" | "16x9" | null, but the
    // RATIO_BADGE lookup falls back to a neutral pill for anything not in
    // the map — exercise that path with an "as never" cast.
    render(
      <LaunchSummary
        brief={brief()}
        creatives={[creative({ ratio: "foo-bar" as never })]}
        copyByCreativeId={{ "cr-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText("foo-bar")).toBeInTheDocument();
  });

  it("renders 'Untitled concept' when concept is null", () => {
    render(
      <LaunchSummary
        brief={brief()}
        creatives={[creative({ concept: null, ratio: null })]}
        copyByCreativeId={{ "cr-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText("Untitled concept")).toBeInTheDocument();
  });
});
