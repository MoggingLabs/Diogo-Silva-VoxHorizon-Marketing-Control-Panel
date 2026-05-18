/**
 * Canonical JSON serialisation used for the `tool_args_hash` value written
 * to `approvals_policy_cache`.
 *
 * The Hermes plugin computes the same hash when probing the cache before
 * opening a new approval. Both sides must agree on the byte-for-byte form
 * of the JSON or the cache lookup will miss every time.
 *
 * Rules:
 *  - Object keys are sorted alphabetically.
 *  - Arrays preserve order (JSON arrays are ordered).
 *  - Primitives serialise with native `JSON.stringify` (no whitespace).
 *  - `undefined` properties are dropped (matches `JSON.stringify`).
 *  - Functions / symbols are also dropped, matching `JSON.stringify`.
 *
 * Pure / dependency-free so this runs in both the API route (Node) and the
 * unit tests (jsdom + node).
 */

import { createHash } from "node:crypto";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively canonicalise a value: sort object keys, leave arrays in place.
 *
 * The result still goes through `JSON.stringify` to produce the actual byte
 * stream — we only re-order the structure here. That keeps the path through
 * `JSON.stringify` (and therefore the escaping rules) identical to anything
 * the rest of the codebase already does.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = canonicalise(value[key]);
      if (v === undefined) continue;
      sorted[key] = v;
    }
    return sorted;
  }
  return value;
}

/**
 * Stable JSON serialisation. Two values that are equal under canonical
 * ordering produce byte-identical output.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

/**
 * SHA-256 hex digest of `canonicalJson(value)`. Used as the `tool_args_hash`
 * column on `approvals_policy_cache`.
 */
export function hashToolArgs(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
