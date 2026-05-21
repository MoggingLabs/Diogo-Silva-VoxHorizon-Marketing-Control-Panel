/**
 * Exemplar server-component test. Demonstrates:
 *  - Awaiting an async server component the same way RSC would render it.
 *  - Mocking `@/lib/pipeline/client.listPipelines` and the
 *    `@/lib/supabase/server.createClient` lookup.
 *  - Mocking the realtime-dependent `PipelineList` client child so we don't
 *    need to wire a real Supabase channel in jsdom.
 *
 * Server components return a `ReactElement` from an async function. We pull
 * the rendered tree by calling the component directly and feeding the
 * result into `render(...)`.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

const listPipelines = vi.fn();
let currentSupabase: SupabaseClientMock = mockSupabaseClient();

vi.mock("@/lib/pipeline/client", () => ({
  listPipelines: (...args: unknown[]) => listPipelines(...args),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

// Stub the realtime-subscribing child so we can verify it received the
// SSR-fetched data without booting a real Supabase channel inside jsdom.
vi.mock("@/components/pipeline/PipelineList", () => ({
  PipelineList: ({
    initialPipelines,
    clientNames,
  }: {
    initialPipelines: { id: string; client_id: string | null }[];
    clientNames: Record<string, string>;
  }) => (
    <div data-testid="pipeline-list">
      <span data-testid="pipeline-count">{initialPipelines.length}</span>
      <span data-testid="client-names">{JSON.stringify(clientNames)}</span>
    </div>
  ),
}));

// Import the page module AFTER the mocks so they're in place when the
// page module resolves its imports.
import PipelineIndexPage from "./page";

beforeEach(() => {
  listPipelines.mockReset();
  currentSupabase = mockSupabaseClient();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PipelineIndexPage", () => {
  it("renders the header and pipeline list with SSR-fetched data", async () => {
    listPipelines.mockResolvedValue({
      pipelines: [
        {
          id: "p1",
          client_id: "c1",
          status: "configuration",
          format_choice: "image",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      next_cursor: null,
    });
    currentSupabase = mockSupabaseClient({
      clients: { select: { data: [{ id: "c1", name: "Acme" }], error: null } },
    });

    const element = await PipelineIndexPage();
    render(element);

    expect(screen.getByRole("heading", { name: /pipeline/i })).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-count")).toHaveTextContent("1");
    expect(screen.getByTestId("client-names")).toHaveTextContent('"c1":"Acme"');
    // Operator kickoff entry point links to the dedicated page.
    expect(screen.getByRole("link", { name: /hire the operator/i })).toHaveAttribute(
      "href",
      "/pipeline/operator",
    );
  });

  it("renders the error banner when listPipelines throws", async () => {
    listPipelines.mockRejectedValue(new Error("worker down"));

    const element = await PipelineIndexPage();
    render(element);

    expect(screen.getByText(/failed to load pipelines/i)).toBeInTheDocument();
    expect(screen.getByText(/worker down/)).toBeInTheDocument();
    // Empty list still rendered.
    expect(screen.getByTestId("pipeline-count")).toHaveTextContent("0");
  });

  it("skips the clients table lookup when no pipeline has a client_id", async () => {
    listPipelines.mockResolvedValue({
      pipelines: [
        {
          id: "p1",
          client_id: null,
          status: "ideation",
          format_choice: "video",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      next_cursor: null,
    });

    const element = await PipelineIndexPage();
    render(element);

    expect(screen.getByTestId("client-names")).toHaveTextContent("{}");
    // No `from('clients')` call should have happened.
    expect(currentSupabase._spies.from).not.toHaveBeenCalled();
  });

  it("uses string fallback when listPipelines throws a non-Error value", async () => {
    listPipelines.mockRejectedValue("plain string failure");

    const element = await PipelineIndexPage();
    render(element);

    expect(screen.getByText(/failed to load pipelines/i)).toBeInTheDocument();
  });
});
