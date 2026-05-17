import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanEnv } from "./env";

const ENV_KEY = "__VOX_TEST_ENV__";

beforeEach(() => {
  delete process.env[ENV_KEY];
});

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("cleanEnv", () => {
  it("returns the trimmed value when present", () => {
    process.env[ENV_KEY] = "  hello\n";
    expect(cleanEnv(ENV_KEY)).toBe("hello");
  });

  it("throws when required value is missing", () => {
    expect(() => cleanEnv(ENV_KEY)).toThrow(/Missing required/);
  });

  it("throws when required value is empty string", () => {
    process.env[ENV_KEY] = "";
    expect(() => cleanEnv(ENV_KEY)).toThrow(/Missing required/);
  });

  it("returns undefined for optional missing", () => {
    expect(cleanEnv(ENV_KEY, { optional: true })).toBeUndefined();
  });

  it("returns trimmed value when optional and set", () => {
    process.env[ENV_KEY] = "  set ";
    expect(cleanEnv(ENV_KEY, { optional: true })).toBe("set");
  });
});
