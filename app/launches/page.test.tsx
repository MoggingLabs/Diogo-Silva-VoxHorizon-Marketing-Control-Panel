import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

import LaunchesIndexPage from "./page";

describe("LaunchesIndexPage", () => {
  it("renders the empty state when no launches", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: { select: { data: [], error: null } },
    });
    const el = await LaunchesIndexPage();
    render(el);
    expect(screen.getByText(/No launches yet/i)).toBeInTheDocument();
  });

  it("renders the alert when the query errors", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: { select: { data: null, error: { message: "load failed" } } },
    });
    const el = await LaunchesIndexPage();
    render(el);
    expect(screen.getByRole("alert")).toHaveTextContent(/load failed/);
  });

  it("renders launch rows with pill + brief id when payload is valid", async () => {
    const payload = {
      brief_id_human: "br-1",
      client: { id: "c1", slug: "acme", name: "Acme" },
      creative_ids: [],
      copy_variant_ids: [],
      issues: [],
      validation: { ok: true, via: "preflight" },
    };
    currentSupabase = mockSupabaseClient({
      launch_packages: {
        select: {
          data: [
            {
              id: "l1",
              brief_id: "b1",
              status: "posted",
              payload,
              created_at: "2026-05-17T00:00:00Z",
              decided_at: null,
            },
          ],
          error: null,
        },
      },
    });
    const el = await LaunchesIndexPage();
    render(el);
    expect(screen.getByRole("link", { name: /br-1/ })).toHaveAttribute("href", "/launches/l1");
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Posted")).toBeInTheDocument();
  });

  it("falls back to a status-only pill for an unknown status enum", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: {
        select: {
          data: [
            {
              id: "l2",
              brief_id: "b2",
              status: "future-unknown",
              payload: { malformed: true },
              created_at: "2026-05-17T00:00:00Z",
              decided_at: null,
            },
          ],
          error: null,
        },
      },
    });
    const el = await LaunchesIndexPage();
    render(el);
    // Falls back to the row id slice when payload doesn't parse.
    expect(screen.getByRole("link", { name: /l2/ })).toBeInTheDocument();
    expect(screen.getByText("future-unknown")).toBeInTheDocument();
  });
});
