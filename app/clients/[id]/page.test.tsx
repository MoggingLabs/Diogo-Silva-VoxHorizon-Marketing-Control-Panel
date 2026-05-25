import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
}));

vi.mock("@/components/clients/ClientDetail", () => ({
  ClientDetail: ({ client }: { client: { name: string } }) => (
    <div data-testid="detail">{client.name}</div>
  ),
}));

import ClientDetailPage from "./page";

function ctx(id = "c1") {
  return { params: Promise.resolve({ id }) };
}

describe("ClientDetailPage (server)", () => {
  it("calls notFound when the client is missing", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: null, error: null } } },
    });
    await expect(ClientDetailPage(ctx())).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("renders ClientDetail with the loaded client", async () => {
    currentSupabase = mockClient({
      clients: {
        select: {
          single: { data: { id: "c1", name: "Acme", service_type: "roofing" }, error: null },
        },
      },
      client_profiles: { select: { single: { data: null, error: null } } },
      client_services: { select: { data: [] } },
      client_value_props: { select: { data: [] } },
      client_offers: { select: { data: [] } },
      client_offer_constraints: { select: { data: [] } },
      client_assets: { select: { data: [] } },
      client_past_projects: { select: { data: [] } },
      client_integrations: { select: { data: [] } },
      events: { select: { data: [] } },
    });
    render(await ClientDetailPage(ctx()));
    expect(screen.getByTestId("detail")).toHaveTextContent("Acme");
  });
});
