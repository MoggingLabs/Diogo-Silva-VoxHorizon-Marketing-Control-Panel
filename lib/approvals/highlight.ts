/**
 * Tool-args highlight classifier.
 *
 * Walks a JSON value and produces a flat list of leaf nodes annotated with a
 * risk class. The `ApprovalArgsDiff` component then renders each node with a
 * corresponding Tailwind background.
 *
 * Rules:
 *   - "path"   → values that look like paths (`/foo`, `~/bar`, `C:\baz`)
 *   - "url"    → values that look like http(s) URLs
 *   - "money"  → numeric values prefixed with `$` OR where the key matches
 *                `/cost|price|amount|spend/i` AND the number is > 50
 *   - "plain"  → everything else
 *
 * Sanitisation note: we never feed raw arg strings to `dangerouslySetInnerHTML`.
 * The walker emits structured tokens and the component renders them via plain
 * React children.
 */

export type ArgKind = "plain" | "path" | "url" | "money";

export type HighlightLeaf = {
  /** Dot-path through the tree (`"args.input.cost"`). */
  path: string;
  /** The terminating key for this leaf — drives the money key match. */
  key: string | null;
  /** Display-ready value (always a string after canonicalisation). */
  value: string;
  /** Raw value as JS (for tests + future renderers). */
  raw: unknown;
  /** Computed risk class. */
  kind: ArgKind;
};

const PATH_RE = /^(?:\/|~\/|[A-Za-z]:[\\/])/;
const URL_RE = /^https?:\/\//i;
const MONEY_KEY_RE = /cost|price|amount|spend/i;
const DOLLAR_RE = /^\s*\$\s*([0-9]+(?:\.[0-9]+)?)\s*$/;

/**
 * Classify a single key/value pair.
 *
 * The `key` is checked against `MONEY_KEY_RE`. If it matches and the value is
 * numeric (or a `$1234.5`-style string), we surface a money classification
 * when the amount exceeds `50`.
 */
export function classifyValue(key: string | null, value: unknown): ArgKind {
  // Money via string `$` prefix — independent of key.
  if (typeof value === "string") {
    const m = value.match(DOLLAR_RE);
    if (m && Number(m[1]) > 50) return "money";
    if (URL_RE.test(value)) return "url";
    if (PATH_RE.test(value)) return "path";
    return "plain";
  }
  if (typeof value === "number") {
    if (key && MONEY_KEY_RE.test(key) && value > 50) return "money";
    return "plain";
  }
  return "plain";
}

/**
 * Stringify a leaf value for display. Strings keep their content unwrapped
 * (so the highlight wraps the literal text, not the JSON quotes); other
 * primitives go through `JSON.stringify` for an accurate render.
 */
function formatLeaf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

/**
 * Walk a JSON value depth-first and emit a flat leaf list. Each leaf is a
 * primitive (string / number / boolean / null) or `undefined`. Container
 * nodes (objects / arrays) don't appear in the output; the renderer handles
 * the surrounding braces/brackets itself.
 */
export function walk(value: unknown, path = "", key: string | null = null): HighlightLeaf[] {
  if (Array.isArray(value)) {
    const out: HighlightLeaf[] = [];
    value.forEach((v, i) => {
      out.push(...walk(v, `${path}[${i}]`, null));
    });
    return out;
  }
  if (value !== null && typeof value === "object") {
    const out: HighlightLeaf[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(...walk(v, path ? `${path}.${k}` : k, k));
    }
    return out;
  }
  return [
    {
      path: path || "(root)",
      key,
      raw: value,
      value: formatLeaf(value),
      kind: classifyValue(key, value),
    },
  ];
}

/**
 * Convenience: classify each top-level key of a `tool_args` object. The
 * component uses `walk` for the full tree; this helper is the simple one for
 * the audit page's table cell.
 */
export function summariseArgs(args: Record<string, unknown> | null | undefined): {
  totalLeaves: number;
  kinds: Record<ArgKind, number>;
} {
  const empty: Record<ArgKind, number> = { plain: 0, path: 0, url: 0, money: 0 };
  if (!args) return { totalLeaves: 0, kinds: empty };
  const leaves = walk(args);
  for (const leaf of leaves) empty[leaf.kind] += 1;
  return { totalLeaves: leaves.length, kinds: empty };
}
