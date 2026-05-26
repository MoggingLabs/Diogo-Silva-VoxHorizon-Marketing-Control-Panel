/**
 * Tests for the browser-side Clients API wrappers (lib/clients/api).
 *
 * Covers: each wrapper hits the right URL + method + body; success returns the
 * parsed JSON; non-2xx throws with the mapped operator copy (known code,
 * zod-issue fallback, raw code fallback); an empty body tolerated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  archiveChild,
  archiveClient,
  archiveIntegration,
  createChild,
  createClient,
  createIntegration,
  restoreChild,
  restoreClient,
  saveProfile,
  updateChild,
  updateClient,
  updateIntegration,
} from "./api";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}
function errJson(status: number, body: unknown) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) } as Response);
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls[0]!;
  return { url, init: init as RequestInit };
}

describe("client wrappers", () => {
  it("createClient POSTs to /api/clients", async () => {
    fetchMock.mockReturnValue(okJson({ client: { id: "c1" } }));
    const out = await createClient({ name: "Acme" });
    expect(out).toEqual({ client: { id: "c1" } });
    const { url, init } = lastCall();
    expect(url).toBe("/api/clients");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Acme" });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("updateClient PATCHes /api/clients/:id", async () => {
    fetchMock.mockReturnValue(okJson({ client: {} }));
    await updateClient("c1", { name: "X" });
    const { url, init } = lastCall();
    expect(url).toBe("/api/clients/c1");
    expect(init.method).toBe("PATCH");
  });

  it("archiveClient DELETEs and restoreClient POSTs restore", async () => {
    fetchMock.mockReturnValue(okJson({}));
    await archiveClient("c1");
    expect(lastCall().init.method).toBe("DELETE");
    fetchMock.mockClear();
    fetchMock.mockReturnValue(okJson({}));
    await restoreClient("c1");
    expect(lastCall().url).toBe("/api/clients/c1/restore");
  });
});

describe("profile + children + integration wrappers", () => {
  it("saveProfile PUTs the profile", async () => {
    fetchMock.mockReturnValue(okJson({}));
    await saveProfile("c1", { tone: "warm" });
    const { url, init } = lastCall();
    expect(url).toBe("/api/clients/c1/profile");
    expect(init.method).toBe("PUT");
  });

  it("child wrappers target the child sub-resource", async () => {
    fetchMock.mockReturnValue(okJson({ item: { id: "s1" } }));
    await createChild("c1", "services", { service_name: "Roof" });
    expect(lastCall().url).toBe("/api/clients/c1/services");

    fetchMock.mockClear();
    fetchMock.mockReturnValue(okJson({}));
    await updateChild("c1", "services", "s1", { service_name: "X" });
    expect(lastCall().url).toBe("/api/clients/c1/services/s1");

    fetchMock.mockClear();
    fetchMock.mockReturnValue(okJson({}));
    await archiveChild("c1", "services", "s1");
    expect(lastCall().init.method).toBe("DELETE");

    fetchMock.mockClear();
    fetchMock.mockReturnValue(okJson({}));
    await restoreChild("c1", "services", "s1");
    expect(lastCall().url).toBe("/api/clients/c1/services/s1/restore");
  });

  it("integration wrappers target the integrations sub-resource", async () => {
    fetchMock.mockReturnValue(okJson({}));
    await createIntegration("c1", { provider: "meta" });
    expect(lastCall().url).toBe("/api/clients/c1/integrations");

    fetchMock.mockClear();
    fetchMock.mockReturnValue(okJson({}));
    await updateIntegration("c1", "i1", { active: false });
    expect(lastCall().url).toBe("/api/clients/c1/integrations/i1");

    fetchMock.mockClear();
    fetchMock.mockReturnValue(okJson({}));
    await archiveIntegration("c1", "i1");
    expect(lastCall().init.method).toBe("DELETE");
  });
});

describe("error mapping", () => {
  it("maps a known error code to friendly copy", async () => {
    fetchMock.mockReturnValue(errJson(409, { error: "slug_taken" }));
    await expect(createClient({})).rejects.toThrow(/already in use/i);
  });

  it("falls back to the first zod issue message", async () => {
    fetchMock.mockReturnValue(
      errJson(400, {
        error: "some_unknown",
        issues: [{ message: "name too short", path: ["name"] }],
      }),
    );
    await expect(createClient({})).rejects.toThrow("name too short");
  });

  it("falls back to the raw code when nothing else matches", async () => {
    fetchMock.mockReturnValue(errJson(500, { error: "weird_db_thing" }));
    await expect(createClient({})).rejects.toThrow("weird_db_thing");
  });

  it("synthesises a code from the status when the body has no error", async () => {
    fetchMock.mockReturnValue(errJson(503, {}));
    await expect(createClient({})).rejects.toThrow("request_failed_503");
  });

  it("tolerates a non-JSON error body", async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error("not json")),
      } as unknown as Response),
    );
    await expect(createClient({})).rejects.toThrow("request_failed_500");
  });

  it("tolerates a non-JSON success body", async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: true,
        json: () => Promise.reject(new Error("not json")),
      } as unknown as Response),
    );
    await expect(archiveClient("c1")).resolves.toEqual({});
  });
});
