/**
 * AdEntityGraph (E5.1 / #595): read-only view of the recorded Meta entities.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AdEntityGraph } from "./AdEntityGraph";
import type { AdEntityRow } from "@/lib/ad-entity";

function entity(overrides: Partial<AdEntityRow> = {}): AdEntityRow {
  return {
    id: "e1",
    pipeline_id: "p1",
    launch_package_id: "l1",
    client_id: null,
    kind: "campaign",
    meta_id: "123",
    parent_meta_id: null,
    creative_id: null,
    copy_variant_id: null,
    state: "paused",
    meta_payload: null,
    created_at: "2026-05-26T00:00:00Z",
    updated_at: "2026-05-26T00:00:00Z",
    ...overrides,
  } as AdEntityRow;
}

describe("AdEntityGraph", () => {
  it("shows the empty state when there are no entities", () => {
    render(<AdEntityGraph entities={[]} />);
    expect(screen.getByTestId("ad-entity-empty")).toBeInTheDocument();
  });

  it("renders recorded entities parent-first with their state", () => {
    render(
      <AdEntityGraph
        entities={[
          entity({ id: "ad1", kind: "ad", meta_id: "ad-9", state: "paused" }),
          entity({ id: "camp1", kind: "campaign", meta_id: "camp-1", state: "active" }),
        ]}
      />,
    );
    const list = screen.getByTestId("ad-entity-graph");
    expect(list.children).toHaveLength(2);
    // Campaign sorts before ad.
    expect(list.children[0]).toHaveAttribute("data-testid", "ad-entity-camp1");
    expect(screen.getByText("camp-1")).toBeInTheDocument();
  });

  it("tolerates an unknown kind (sort + indent fallback)", () => {
    render(
      <AdEntityGraph
        entities={[
          entity({ id: "weird", kind: "widget" as never, meta_id: "w-1" }),
          entity({ id: "camp1", kind: "campaign", meta_id: "camp-1" }),
        ]}
      />,
    );
    const list = screen.getByTestId("ad-entity-graph");
    // Known campaign sorts ahead of the unknown kind (fallback weight 99).
    expect(list.children[0]).toHaveAttribute("data-testid", "ad-entity-camp1");
    expect(screen.getByText("w-1")).toBeInTheDocument();
  });
});
