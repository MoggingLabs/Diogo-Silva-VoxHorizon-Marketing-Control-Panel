import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

let currentSupabase: SupabaseClientMock;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

vi.mock("@/components/launch/LaunchBuilderForm", () => ({
  LaunchBuilderForm: ({
    mode,
    eligibleBriefs,
    prefill,
  }: {
    mode: string;
    eligibleBriefs?: { id: string }[];
    prefill?: { pipeline_id: string };
  }) => (
    <div
      data-testid="builder"
      data-mode={mode}
      data-briefs={eligibleBriefs?.length ?? ""}
      data-pipeline={prefill?.pipeline_id ?? ""}
    />
  ),
}));

const notFound = vi.fn(() => {
  throw new Error("__NEXT_NOT_FOUND__");
});

vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
}));

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";
import LaunchesNewPage from "./page";

describe("LaunchesNewPage", () => {
  it("renders the scratch builder with eligible briefs", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: {
          data: [
            {
              id: "b1",
              brief_id_human: "br-1",
              status: "approved",
              client_id: "c",
              clients: { name: "Acme" },
            },
          ],
          error: null,
        },
      },
    });
    const el = await LaunchesNewPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByTestId("builder")).toHaveAttribute("data-mode", "scratch");
    expect(screen.getByTestId("builder")).toHaveAttribute("data-briefs", "1");
  });

  it("throws when the briefs query errors", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { data: null, error: { message: "bad" } } },
    });
    await expect(LaunchesNewPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("bad");
  });

  it("renders the pipeline-handoff builder when pipeline + brief load", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          data: null,
          error: null,
          single: {
            data: {
              id: "p1",
              status: "done",
              format_choice: "image",
              image_brief_id: "b1",
              video_brief_id: null,
              config_draft: { budget: 1000 },
              launch_package_id: null,
            },
            error: null,
          },
        },
      },
      briefs: {
        select: {
          data: null,
          error: null,
          single: { data: { id: "b1", brief_id_human: "br-1" }, error: null },
        },
      },
      creatives: { select: { data: [{ id: "c1" }], error: null } },
    });
    const el = await LaunchesNewPage({
      searchParams: Promise.resolve({ pipeline_id: "p1" }),
    });
    render(el);
    expect(screen.getByTestId("builder")).toHaveAttribute("data-mode", "pipeline");
    expect(screen.getByTestId("builder")).toHaveAttribute("data-pipeline", "p1");
  });

  it("shows the 'already built' guardrail when launch_package_id is set", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          data: null,
          error: null,
          single: {
            data: {
              id: "p1",
              status: "done",
              format_choice: "image",
              image_brief_id: "b1",
              video_brief_id: null,
              config_draft: {},
              launch_package_id: "L1",
            },
            error: null,
          },
        },
      },
      briefs: {
        select: {
          data: null,
          error: null,
          single: { data: { id: "b1", brief_id_human: "br-1" }, error: null },
        },
      },
      creatives: { select: { data: [], error: null } },
    });
    const el = await LaunchesNewPage({
      searchParams: Promise.resolve({ pipeline_id: "p1" }),
    });
    render(el);
    expect(screen.getByRole("heading", { name: /launch already built/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view launch package/i })).toHaveAttribute(
      "href",
      "/launches/L1",
    );
  });

  it("404s when the pipeline_id doesn't exist", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { data: null, error: null, single: { data: null, error: null } } },
    });
    await expect(
      LaunchesNewPage({ searchParams: Promise.resolve({ pipeline_id: "p1" }) }),
    ).rejects.toThrow("__NEXT_NOT_FOUND__");
  });

  it("throws when the pipeline query errors", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: { data: null, error: null, single: { data: null, error: { message: "boom" } } },
      },
    });
    await expect(
      LaunchesNewPage({ searchParams: Promise.resolve({ pipeline_id: "p1" }) }),
    ).rejects.toThrow("boom");
  });
});
