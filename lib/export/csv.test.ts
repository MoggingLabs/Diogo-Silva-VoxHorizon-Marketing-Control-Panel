/**
 * Unit tests for the client-side CSV/JSON serializers (Makeover M7).
 *
 * Covers: header-only output for empty rows, value coercion (null/undefined,
 * numbers, booleans, Date, nested objects, JSON.stringify failure), RFC-4180
 * quoting/escaping, CRLF joins, and the JSON projection (with + without
 * columns).
 */
import { describe, expect, it } from "vitest";

import { toCsv, toJson, type CsvColumn } from "./csv";

type Row = { name: string; count: number; active: boolean; note?: string | null };

const COLUMNS: CsvColumn<Row>[] = [
  { header: "Name", value: (r) => r.name },
  { header: "Count", value: (r) => r.count },
  { header: "Active", value: (r) => r.active },
  { header: "Note", value: (r) => r.note },
];

describe("toCsv", () => {
  it("emits just the header line for empty rows", () => {
    expect(toCsv<Row>([], COLUMNS)).toBe("Name,Count,Active,Note");
  });

  it("serializes rows with CRLF line endings and coerces primitives", () => {
    const csv = toCsv<Row>([{ name: "Acme", count: 3, active: true, note: "ok" }], COLUMNS);
    expect(csv).toBe("Name,Count,Active,Note\r\nAcme,3,true,ok");
  });

  it("renders null/undefined cells as empty strings", () => {
    const csv = toCsv<Row>([{ name: "X", count: 0, active: false, note: null }], COLUMNS);
    expect(csv).toBe("Name,Count,Active,Note\r\nX,0,false,");
    const csv2 = toCsv<Row>([{ name: "Y", count: 1, active: false }], COLUMNS);
    expect(csv2.endsWith("Y,1,false,")).toBe(true);
  });

  it("quotes fields containing commas, quotes, or newlines and doubles quotes", () => {
    const csv = toCsv<{ v: string }>(
      [{ v: "a,b" }, { v: 'say "hi"' }, { v: "line1\nline2" }],
      [{ header: "v", value: (r) => r.v }],
    );
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe('"a,b"');
    expect(lines[2]).toBe('"say ""hi"""');
    expect(lines[3]).toBe('"line1\nline2"');
  });

  it("quotes a header that itself contains a comma", () => {
    const csv = toCsv<{ v: string }>([], [{ header: "a,b", value: (r) => r.v }]);
    expect(csv).toBe('"a,b"');
  });

  it("stringifies object cells and serializes Date as ISO", () => {
    const date = new Date("2026-05-26T00:00:00.000Z");
    const csv = toCsv<{ obj: unknown; when: Date }>(
      [{ obj: { a: 1 }, when: date }],
      [
        { header: "obj", value: (r) => r.obj },
        { header: "when", value: (r) => r.when },
      ],
    );
    // The object cell is JSON then CSV-quoted (it contains a comma-free brace
    // pair, but quotes appear so it is quoted).
    expect(csv).toContain('"{""a"":1}"');
    expect(csv).toContain("2026-05-26T00:00:00.000Z");
  });

  it("falls back to String() when JSON.stringify throws (circular)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const csv = toCsv<{ v: unknown }>([{ v: circular }], [{ header: "v", value: (r) => r.v }]);
    // String(circular) is "[object Object]", which has no special chars.
    expect(csv).toBe("v\r\n[object Object]");
  });
});

describe("toJson", () => {
  it("emits the raw rows pretty-printed when no columns are given", () => {
    const rows = [{ name: "Acme", count: 3 }];
    expect(toJson(rows)).toBe(JSON.stringify(rows, null, 2));
  });

  it("projects rows to the column headers when columns are given", () => {
    const json = toJson<Row>([{ name: "Acme", count: 3, active: true, note: null }], COLUMNS);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual([{ Name: "Acme", Count: 3, Active: true, Note: null }]);
  });

  it("projects an empty array to an empty array", () => {
    expect(JSON.parse(toJson<Row>([], COLUMNS))).toEqual([]);
  });
});
