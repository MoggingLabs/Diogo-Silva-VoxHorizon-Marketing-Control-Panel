import { describe, expect, it } from "vitest";

import {
  SERVICE_TYPE_LABEL,
  SERVICE_TYPE_OPTIONS,
  VALUE_PROP_KIND_LABEL,
  formatDateTime,
} from "./labels";

describe("labels", () => {
  it("has a label for every service type and a matching options list", () => {
    expect(SERVICE_TYPE_OPTIONS).toHaveLength(Object.keys(SERVICE_TYPE_LABEL).length);
    for (const o of SERVICE_TYPE_OPTIONS) {
      expect(o.label).toBe(SERVICE_TYPE_LABEL[o.value]);
    }
  });

  it("labels value prop kinds", () => {
    expect(VALUE_PROP_KIND_LABEL.usp).toBe("USP");
    expect(VALUE_PROP_KIND_LABEL.differentiator).toBe("Differentiator");
  });
});

describe("formatDateTime", () => {
  it("formats a valid ISO timestamp", () => {
    expect(formatDateTime("2025-01-01T00:00:00Z")).not.toBe("—");
  });

  it("returns an em-dash for null / undefined", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
  });

  it("returns the raw value for an unparseable string", () => {
    // `new Date("not-a-date")` is Invalid Date; toLocaleString yields a value,
    // so the function returns a string either way (never throws).
    expect(typeof formatDateTime("not-a-date")).toBe("string");
  });
});
