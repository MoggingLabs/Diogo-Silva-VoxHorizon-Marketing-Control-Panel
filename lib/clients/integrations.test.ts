import { describe, expect, it } from "vitest";

import { isSecretKey, maskConfig, maskIntegration, maskIntegrations } from "./integrations";

describe("isSecretKey", () => {
  it("flags credential-looking keys", () => {
    for (const k of [
      "api_key",
      "secret",
      "access_token",
      "refresh_token",
      "client_secret",
      "password",
      "webhook_signature",
      "auth",
      "private_key",
    ]) {
      expect(isSecretKey(k)).toBe(true);
    }
  });

  it("does not flag plain identifiers", () => {
    for (const k of ["external_id", "account_id", "location_id", "id", "name", "region"]) {
      expect(isSecretKey(k)).toBe(false);
    }
  });
});

describe("maskConfig", () => {
  it("masks secret values keeping a 4-char tail", () => {
    const out = maskConfig({ api_key: "supersecretvalue1234", region: "us" }) as Record<
      string,
      unknown
    >;
    expect(out.api_key).toBe("********1234");
    // non-secret value passes through untouched.
    expect(out.region).toBe("us");
  });

  it("masks short secrets to a fixed sentinel (no length leak)", () => {
    const out = maskConfig({ token: "abc" }) as Record<string, unknown>;
    expect(out.token).toBe("********");
  });

  it("returns {} for null / undefined", () => {
    expect(maskConfig(null)).toEqual({});
    expect(maskConfig(undefined)).toEqual({});
  });

  it("leaves array / scalar configs unchanged (no named keys to judge)", () => {
    expect(maskConfig(["a", "b"])).toEqual(["a", "b"]);
    expect(maskConfig("plain")).toBe("plain");
  });
});

describe("maskIntegration(s)", () => {
  it("masks a single row's config", () => {
    const row = { id: "i1", provider: "meta", config: { secret: "longsecret9999" } };
    const out = maskIntegration(row);
    expect((out.config as Record<string, unknown>).secret).toBe("********9999");
    // does not mutate the source row.
    expect((row.config as Record<string, unknown>).secret).toBe("longsecret9999");
  });

  it("masks a list", () => {
    const out = maskIntegrations([
      { id: "i1", config: { api_key: "aaaabbbbcccc" } },
      { id: "i2", config: { plain: "ok" } },
    ]);
    expect((out[0]!.config as Record<string, unknown>).api_key).toBe("********cccc");
    expect((out[1]!.config as Record<string, unknown>).plain).toBe("ok");
  });
});
