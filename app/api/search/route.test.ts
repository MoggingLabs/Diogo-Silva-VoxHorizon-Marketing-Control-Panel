/**
 * Unit tests for `app/api/search/route.ts` (E1.3 / #585).
 *
 * Covers:
 *  - empty / whitespace q -> 200 with an empty list (no DB hit)
 *  - free-text q -> aggregates across clients / briefs / creatives / launches,
 *    builds the right kind/id/label/href, and excludes pipelines (uuid-only)
 *  - uuid q -> additionally resolves a pipeline by exact id
 *  - per-kind + total caps
 *  - a kind that errors degrades to its slice being empty (non-fatal)
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { GET } from "./route";

function req(q: string): NextRequest {
  return new NextRequest(new Request(`http://localhost/api/search?q=${encodeURIComponent(q)}`));
}

const UUID = "11111111-1111-4111-8111-111111111111";

describe("GET /api/search", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("returns an empty list for a blank q without hitting the DB", async () => {
    currentSupabase = mockClient();
    const res = await GET(req("   "));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    expect(currentSupabase._spies.from).not.toHaveBeenCalled();
  });

  it("returns an empty list for a totally empty q", async () => {
    const res = await GET(new NextRequest(new Request("http://localhost/api/search")));
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([]);
  });

  it("aggregates free-text matches across kinds with the right shape", async () => {
    currentSupabase = mockClient({
      clients: { select: { data: [{ id: "c1", name: "Acme Roofing", slug: "acme" }] } },
      briefs: { select: { data: [{ id: "b1", brief_id_human: "ROOF-001" }] } },
      video_briefs: { select: { data: [{ id: "vb1", brief_id_human: "ROOF-V-001" }] } },
      creatives: {
        select: { data: [{ id: "cr1", concept: "roof hook", asset_name: null, brief_id: "b1" }] },
      },
      video_creatives: {
        select: { data: [{ id: "vcr1", asset_name: "roof reel", brief_id: "vb1" }] },
      },
      launch_packages: { select: { data: [{ id: "lp1", status: "approved", brief_id: "b1" }] } },
      video_launch_packages: {
        select: { data: [{ id: "vlp1", status: "validating", brief_id: "vb1" }] },
      },
    });

    const res = await GET(req("roof"));
    expect(res.status).toBe(200);
    const { results } = await res.json();

    const byKind = Object.fromEntries(results.map((r: { kind: string }) => [r.kind, r]));
    expect(byKind.client).toMatchObject({ id: "c1", label: "Acme Roofing", href: "/clients/c1" });
    expect(byKind.brief).toMatchObject({ id: "b1", label: "ROOF-001", href: "/briefs/b1" });
    expect(byKind.video_brief).toMatchObject({ href: "/briefs/vb1?format=video" });
    expect(byKind.creative).toMatchObject({ id: "cr1", label: "roof hook", href: "/creatives/b1" });
    expect(byKind.video_creative).toMatchObject({ href: "/creatives/vb1?format=video" });
    expect(byKind.launch_package).toMatchObject({ id: "lp1", href: "/launches/lp1" });
    expect(byKind.video_launch_package).toMatchObject({ href: "/launches/vlp1?format=video" });
    // pipelines are uuid-only; a free-text query must not include them.
    expect(byKind.pipeline).toBeUndefined();
  });

  it("prefers asset_name over concept for the creative label", async () => {
    currentSupabase = mockClient({
      creatives: {
        select: { data: [{ id: "cr1", concept: "hook", asset_name: "ACME_v2", brief_id: "b1" }] },
      },
    });
    const res = await GET(req("acme"));
    const { results } = await res.json();
    const creative = results.find((r: { kind: string }) => r.kind === "creative");
    expect(creative.label).toBe("ACME_v2");
  });

  it("resolves a pipeline by exact id when q is a uuid", async () => {
    // Silent-failure PR-4: `pipelines.status` was dropped (migration 0051);
    // the search route reads `derived_status` from `v_pipeline_dispatch_state`.
    currentSupabase = mockClient({
      pipelines: {
        select: { data: [{ id: UUID, format_choice: "image" }] },
      },
      v_pipeline_dispatch_state: {
        select: { data: [{ pipeline_id: UUID, derived_status: "ideation" }] },
      },
    });
    const res = await GET(req(UUID));
    const { results } = await res.json();
    const pipeline = results.find((r: { kind: string }) => r.kind === "pipeline");
    expect(pipeline).toMatchObject({
      id: UUID,
      label: "Pipeline image / ideation",
      href: `/pipeline/${UUID}`,
    });
  });

  it("caps the total result list at the limit", async () => {
    const many = (prefix: string) =>
      Array.from({ length: 5 }, (_, i) => ({
        id: `${prefix}${i}`,
        name: `${prefix}${i}`,
        slug: `${prefix}${i}`,
        brief_id_human: `${prefix}${i}`,
        concept: `${prefix}${i}`,
        asset_name: `${prefix}${i}`,
        status: "approved",
        brief_id: "b1",
      }));
    currentSupabase = mockClient({
      clients: { select: { data: many("c") } },
      briefs: { select: { data: many("b") } },
      video_briefs: { select: { data: many("vb") } },
      creatives: { select: { data: many("cr") } },
      video_creatives: { select: { data: many("vcr") } },
      launch_packages: { select: { data: many("lp") } },
      video_launch_packages: { select: { data: many("vlp") } },
    });
    const res = await GET(req("a"));
    const { results } = await res.json();
    // 7 kinds * 5 = 35 candidates, capped at 25.
    expect(results.length).toBe(25);
  });

  it("degrades gracefully: a kind returning no data yields no rows for it", async () => {
    currentSupabase = mockClient({
      clients: { select: { data: null, error: { message: "down" } } },
      briefs: { select: { data: [{ id: "b1", brief_id_human: "ROOF-1" }] } },
    });
    const res = await GET(req("roof"));
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results.find((r: { kind: string }) => r.kind === "client")).toBeUndefined();
    expect(results.find((r: { kind: string }) => r.kind === "brief")).toBeDefined();
  });

  it("falls back to slug then id for the client label", async () => {
    currentSupabase = mockClient({
      clients: { select: { data: [{ id: "c1", name: null, slug: "acme" }] } },
    });
    const res = await GET(req("acme"));
    const { results } = await res.json();
    expect(results.find((r: { kind: string }) => r.kind === "client").label).toBe("acme");
  });
});
