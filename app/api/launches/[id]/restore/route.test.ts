/**
 * Tests for `app/api/launches/[id]/restore/route.ts` (POST restore).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/launches/${id}/restore`, { method: "POST" }),
  );
}

describe("POST /api/launches/:id/restore", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 + clears deleted_at when restoring an archived package", async () => {
    currentSupabase = mockClient({
      launch_packages: {
        update: { single: { data: { id, status: "posted", deleted_at: null }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.launch.deleted_at).toBeNull();
  });

  it("409 when the row is not archived (compare-and-set finds it live)", async () => {
    currentSupabase = mockClient({
      launch_packages: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id, deleted_at: null }, error: null } },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("not_archived");
  });

  it("404 when the package does not exist", async () => {
    currentSupabase = mockClient({
      launch_packages: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(404);
  });

  it("500 on a DB error during restore", async () => {
    currentSupabase = mockClient({
      launch_packages: { update: { single: { data: null, error: { message: "nope" } } } },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(500);
  });
});
