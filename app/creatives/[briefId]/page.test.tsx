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
    getSignedUrl: vi.fn(async (_client, path: string | null) =>
      path ? `https://signed/${path}` : null,
    ),
  };
});

vi.mock("@/components/creative/VariantsGrid", () => ({
  VariantsGrid: ({
    initialCreatives,
    selectedId,
  }: {
    initialCreatives: { id: string }[];
    selectedId: string | null;
  }) => (
    <div
      data-testid="variants"
      data-count={initialCreatives.length}
      data-selected={selectedId ?? ""}
    />
  ),
}));

const notFoundSpy = vi.fn(() => {
  throw new Error("__NOT_FOUND__");
});
vi.mock("next/navigation", () => ({
  notFound: () => notFoundSpy(),
}));

import CreativesByBriefPage, { generateMetadata } from "./page";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

describe("CreativesByBriefPage", () => {
  it("renders header + meta + variants grid for a valid brief uuid", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: {
          data: null,
          error: null,
          single: {
            data: {
              id: VALID_UUID,
              brief_id_human: "br-1",
              status: "approved",
              client_id: "c1",
              payload: { service: "roofing", budget: 1000, market: "Austin" },
            },
            error: null,
          },
        },
      },
      clients: {
        select: {
          data: null,
          error: null,
          single: { data: { id: "c1", name: "Acme", slug: "acme" }, error: null },
        },
      },
      creatives: {
        select: {
          data: [
            { id: "cr1", brief_id: VALID_UUID, status: "draft", file_path_supabase: "p1.png" },
            { id: "cr2", brief_id: VALID_UUID, status: "approved", file_path_supabase: null },
          ],
          error: null,
        },
      },
    });
    currentAdmin = mockSupabaseClient();
    const el = await CreativesByBriefPage({
      params: Promise.resolve({ briefId: VALID_UUID }),
      searchParams: Promise.resolve({}),
    });
    render(el);
    expect(screen.getByRole("heading", { name: /creative variants/i })).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Austin")).toBeInTheDocument();
    expect(screen.getByTestId("variants")).toHaveAttribute("data-count", "2");
  });

  it("falls back to human id lookup", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: {
          data: null,
          error: null,
          single: {
            data: {
              id: VALID_UUID,
              brief_id_human: "br-h",
              status: "approved",
              client_id: null,
              payload: {},
            },
            error: null,
          },
        },
      },
      creatives: { select: { data: [], error: null } },
    });
    currentAdmin = mockSupabaseClient();
    const el = await CreativesByBriefPage({
      params: Promise.resolve({ briefId: "br-h" }),
      searchParams: Promise.resolve({}),
    });
    render(el);
    expect(screen.getByText("No client")).toBeInTheDocument();
  });

  it("throws when the brief lookup errors", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: { data: null, error: null, single: { data: null, error: { message: "boom" } } },
      },
    });
    currentAdmin = mockSupabaseClient();
    await expect(
      CreativesByBriefPage({
        params: Promise.resolve({ briefId: VALID_UUID }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("boom");
  });

  it("calls notFound when brief is missing", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { data: null, error: null, single: { data: null, error: null } } },
    });
    currentAdmin = mockSupabaseClient();
    await expect(
      CreativesByBriefPage({
        params: Promise.resolve({ briefId: VALID_UUID }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("__NOT_FOUND__");
  });

  it("throws when the creatives query errors", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: {
          data: null,
          error: null,
          single: {
            data: {
              id: VALID_UUID,
              brief_id_human: "br-1",
              status: "draft",
              client_id: null,
              payload: {},
            },
            error: null,
          },
        },
      },
      creatives: { select: { data: null, error: { message: "bad" } } },
    });
    currentAdmin = mockSupabaseClient();
    await expect(
      CreativesByBriefPage({
        params: Promise.resolve({ briefId: VALID_UUID }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("bad");
  });

  it("respects ?creative=<uuid> as selectedId", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: {
          data: null,
          error: null,
          single: {
            data: {
              id: VALID_UUID,
              brief_id_human: "br-1",
              status: "draft",
              client_id: null,
              payload: {},
            },
            error: null,
          },
        },
      },
      creatives: { select: { data: [], error: null } },
    });
    currentAdmin = mockSupabaseClient();
    const el = await CreativesByBriefPage({
      params: Promise.resolve({ briefId: VALID_UUID }),
      searchParams: Promise.resolve({ creative: VALID_UUID }),
    });
    render(el);
    expect(screen.getByTestId("variants")).toHaveAttribute("data-selected", VALID_UUID);
  });

  it("ignores ?creative when not a uuid", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: {
          data: null,
          error: null,
          single: {
            data: {
              id: VALID_UUID,
              brief_id_human: "br-1",
              status: "draft",
              client_id: null,
              payload: {},
            },
            error: null,
          },
        },
      },
      creatives: { select: { data: [], error: null } },
    });
    currentAdmin = mockSupabaseClient();
    const el = await CreativesByBriefPage({
      params: Promise.resolve({ briefId: VALID_UUID }),
      searchParams: Promise.resolve({ creative: "not-a-uuid" }),
    });
    render(el);
    expect(screen.getByTestId("variants")).toHaveAttribute("data-selected", "");
  });

  it("generateMetadata returns truncated id", async () => {
    const m = await generateMetadata({
      params: Promise.resolve({ briefId: VALID_UUID }),
      searchParams: Promise.resolve({}),
    });
    expect(m.title).toMatch(/Creatives 11111111-111/);
  });
});
