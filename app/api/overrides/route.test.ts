import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upsertMock = vi.fn();
const fromMock = vi.fn(() => ({ upsert: upsertMock }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

import { POST } from "./route";

function makeRequest(body: unknown, opts: { invalidJson?: boolean } = {}) {
  return {
    json: vi.fn().mockImplementation(() => {
      if (opts.invalidJson) throw new SyntaxError("not json");
      return Promise.resolve(body);
    }),
  } as unknown as Parameters<typeof POST>[0];
}

const VALID_BODY = {
  table_name: "creatives",
  row_id: "11111111-2222-4333-8444-555555555555",
  field_name: "approved_at",
  corrected_value: { iso: "2026-05-17T10:00:00Z" },
};

describe("POST /api/overrides", () => {
  beforeEach(() => {
    upsertMock.mockReset();
    fromMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await POST(makeRequest(null, { invalidJson: true }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("returns 400 with zod issues when the body fails validation", async () => {
    const res = await POST(makeRequest({ table_name: "creatives" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("validation_failed");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("upserts a valid row and returns ok", async () => {
    upsertMock.mockResolvedValueOnce({ error: null });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(fromMock).toHaveBeenCalledWith("overrides");
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        table_name: "creatives",
        row_id: VALID_BODY.row_id,
        field_name: "approved_at",
        corrected_value: VALID_BODY.corrected_value,
        edited_by: "operator",
      }),
      { onConflict: "table_name,row_id,field_name" },
    );
  });

  it("returns 500 with the supabase error message when upsert fails", async () => {
    upsertMock.mockResolvedValueOnce({ error: { message: "unique violation" } });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "unique violation" });
  });
});
