import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
let currentAdmin: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentAdmin,
}));

vi.mock("@/lib/creatives", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creatives")>("@/lib/creatives");
  return {
    ...actual,
    getSignedUrl: vi.fn(async () => "https://signed"),
  };
});

vi.mock("@/components/launch/LaunchSummary", () => ({
  LaunchSummary: () => <div data-testid="summary" />,
}));
vi.mock("@/components/launch/LaunchTimeline", () => ({
  LaunchTimeline: ({ initialEvents }: { initialEvents: unknown[] }) => (
    <div data-testid="timeline" data-count={initialEvents.length} />
  ),
}));
vi.mock("@/components/launch/LaunchApprovalGate", () => ({
  LaunchApprovalGate: () => <div data-testid="approval-gate" />,
}));
vi.mock("@/components/launch/LaunchPackageActions", () => ({
  LaunchPackageActions: () => <div data-testid="launch-actions" />,
}));
vi.mock("@/components/launch/AdEntityGraph", () => ({
  AdEntityGraph: ({ entities }: { entities: unknown[] }) => (
    <div data-testid="ad-entities" data-count={entities.length} />
  ),
}));
const getAdEntitiesForLaunchMock = vi.fn(async () => [] as unknown[]);
vi.mock("@/lib/ad-entity", () => ({
  getAdEntitiesForLaunch: () => getAdEntitiesForLaunchMock(),
}));

const notFoundSpy = vi.fn(() => {
  throw new Error("__NOT_FOUND__");
});
vi.mock("next/navigation", () => ({
  notFound: () => notFoundSpy(),
}));

import LaunchDetailPage, { generateMetadata } from "./page";

const validPayload = {
  brief_id_human: "br-1",
  client: { id: "c", slug: "s", name: "Acme" },
  creative_ids: ["11111111-1111-4111-8111-111111111111"],
  copy_variant_ids: ["22222222-2222-4222-9222-222222222222"],
  issues: [],
  validation: { ok: true, via: "preflight" },
};

const launchRow = {
  id: "l1",
  brief_id: "b1",
  status: "posted",
  payload: validPayload,
  decided_at: null,
  decided_by: null,
  decided_notes: null,
};

describe("LaunchDetailPage", () => {
  it("renders summary + approval gate + timeline for a posted launch", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: {
        select: { data: null, error: null, single: { data: launchRow, error: null } },
      },
      briefs: { select: { data: null, error: null, single: { data: { id: "b1" }, error: null } } },
      creatives: { select: { data: [{ id: "c1", file_path_supabase: "p.png" }], error: null } },
      copy_variants: { select: { data: [{ id: "cv1", creative_id: "c1" }], error: null } },
      events: { select: { data: [{ id: "e1" }], error: null } },
    });
    currentAdmin = mockSupabaseClient();
    const el = await LaunchDetailPage({ params: Promise.resolve({ id: "l1" }) });
    render(el);
    expect(screen.getByTestId("summary")).toBeInTheDocument();
    expect(screen.getByTestId("approval-gate")).toBeInTheDocument();
    expect(screen.getByTestId("timeline")).toHaveAttribute("data-count", "1");
    expect(screen.getByText(/Posted/i)).toBeInTheDocument();
  });

  it("renders the decision banner when decided_at is set", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: {
        select: {
          data: null,
          error: null,
          single: {
            data: {
              ...launchRow,
              status: "approved",
              decided_at: "2026-05-17T10:00:00Z",
              decided_notes: "ship it",
            },
            error: null,
          },
        },
      },
      briefs: { select: { data: null, error: null, single: { data: { id: "b1" }, error: null } } },
      creatives: { select: { data: [], error: null } },
      copy_variants: { select: { data: [], error: null } },
      events: { select: { data: [], error: null } },
    });
    currentAdmin = mockSupabaseClient();
    const el = await LaunchDetailPage({ params: Promise.resolve({ id: "l1" }) });
    render(el);
    expect(screen.getByText("ship it")).toBeInTheDocument();
  });

  it("throws when launch query errors", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: {
        select: { data: null, error: null, single: { data: null, error: { message: "boom" } } },
      },
    });
    currentAdmin = mockSupabaseClient();
    await expect(LaunchDetailPage({ params: Promise.resolve({ id: "l1" }) })).rejects.toThrow(
      "boom",
    );
  });

  it("notFounds when launch row is missing", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: { select: { data: null, error: null, single: { data: null, error: null } } },
    });
    currentAdmin = mockSupabaseClient();
    await expect(LaunchDetailPage({ params: Promise.resolve({ id: "l1" }) })).rejects.toThrow(
      "__NOT_FOUND__",
    );
  });

  it("throws when the launch payload fails schema validation", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: {
        select: {
          data: null,
          error: null,
          single: { data: { ...launchRow, payload: { bad: true } }, error: null },
        },
      },
    });
    currentAdmin = mockSupabaseClient();
    await expect(LaunchDetailPage({ params: Promise.resolve({ id: "l1" }) })).rejects.toThrow(
      /payload failed schema/,
    );
  });

  it("throws when the brief query errors", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: {
        select: { data: null, error: null, single: { data: launchRow, error: null } },
      },
      briefs: {
        select: { data: null, error: null, single: { data: null, error: { message: "brf" } } },
      },
      creatives: { select: { data: [], error: null } },
      copy_variants: { select: { data: [], error: null } },
      events: { select: { data: [], error: null } },
    });
    currentAdmin = mockSupabaseClient();
    await expect(LaunchDetailPage({ params: Promise.resolve({ id: "l1" }) })).rejects.toThrow(
      "brf",
    );
  });

  it("notFounds when brief is missing", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: {
        select: { data: null, error: null, single: { data: launchRow, error: null } },
      },
      briefs: { select: { data: null, error: null, single: { data: null, error: null } } },
      creatives: { select: { data: [], error: null } },
      copy_variants: { select: { data: [], error: null } },
      events: { select: { data: [], error: null } },
    });
    currentAdmin = mockSupabaseClient();
    await expect(LaunchDetailPage({ params: Promise.resolve({ id: "l1" }) })).rejects.toThrow(
      "__NOT_FOUND__",
    );
  });

  it("generateMetadata returns truncated id", async () => {
    const m = await generateMetadata({ params: Promise.resolve({ id: "abcdef12-rest" }) });
    expect(m.title).toBe("Launch abcdef12 — VoxHorizon");
  });
});
