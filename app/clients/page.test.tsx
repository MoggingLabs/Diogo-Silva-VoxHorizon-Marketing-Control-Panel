import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

// Render a stub for the client component so this test stays a pure server-page
// data-wiring test (the table has its own component test).
vi.mock("@/components/clients/ClientsTable", () => ({
  ClientsTable: ({
    initialClients,
    loadError,
  }: {
    initialClients: { id: string }[];
    loadError: string | null;
  }) => <div data-testid="table" data-count={initialClients.length} data-error={loadError ?? ""} />,
}));

import ClientsPage from "./page";

describe("ClientsPage (server)", () => {
  it("passes the loaded rows to ClientsTable", async () => {
    currentSupabase = mockSupabaseClient({
      clients: { select: { data: [{ id: "c1" }, { id: "c2" }], error: null } },
    });
    render(await ClientsPage());
    expect(screen.getByTestId("table")).toHaveAttribute("data-count", "2");
    expect(screen.getByTestId("table")).toHaveAttribute("data-error", "");
  });

  it("passes an empty list + the error string on a query failure", async () => {
    currentSupabase = mockSupabaseClient({
      clients: { select: { data: null, error: { message: "db down" } } },
    });
    render(await ClientsPage());
    expect(screen.getByTestId("table")).toHaveAttribute("data-count", "0");
    expect(screen.getByTestId("table")).toHaveAttribute("data-error", "db down");
  });
});
