"use client";

import { walk, type ArgKind, type HighlightLeaf } from "@/lib/approvals/highlight";
import { cn } from "@/lib/utils";

/**
 * Pretty-print of a Hermes tool-call's `tool_args` payload, with leaves
 * highlighted by inferred risk class.
 *
 * Rules (see `lib/approvals/highlight.ts`):
 *   - path-like values   → yellow background
 *   - http(s) URLs       → blue background
 *   - money/spend > $50  → red background
 *   - everything else    → muted text
 *
 * Sanitisation: each leaf is rendered as a React text child (no
 * `dangerouslySetInnerHTML`), so arg strings cannot inject markup.
 */
export type ApprovalArgsDiffProps = {
  /** The tool args object to render. Pass `null`/`undefined` for an empty state. */
  args: Record<string, unknown> | null | undefined;
  /** Extra classes for the outer container. */
  className?: string;
};

const KIND_CLASS: Record<ArgKind, string> = {
  plain: "text-foreground",
  path: "bg-yellow-100 text-yellow-900 dark:bg-yellow-900/40 dark:text-yellow-100 rounded px-1",
  url: "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100 rounded px-1",
  money: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100 rounded px-1 font-semibold",
};

const KIND_TITLE: Record<ArgKind, string> = {
  plain: "",
  path: "Looks like a path — review filesystem access",
  url: "External URL — review network destination",
  money: "Spend-like value over $50 — review carefully",
};

function LeafRow({ leaf }: { leaf: HighlightLeaf }) {
  return (
    <li className="flex items-baseline gap-2 font-mono text-sm">
      <span className="shrink-0 text-muted-foreground" data-testid="leaf-path">
        {leaf.path}
      </span>
      <span className="text-muted-foreground">=</span>
      <span
        data-testid={`leaf-value-${leaf.kind}`}
        title={KIND_TITLE[leaf.kind] || undefined}
        className={cn("break-all", KIND_CLASS[leaf.kind])}
      >
        {leaf.value}
      </span>
    </li>
  );
}

export function ApprovalArgsDiff({ args, className }: ApprovalArgsDiffProps) {
  if (!args || (typeof args === "object" && Object.keys(args).length === 0)) {
    return (
      <p className={cn("text-sm italic text-muted-foreground", className)} data-testid="args-empty">
        No arguments
      </p>
    );
  }
  const leaves = walk(args);
  return (
    <div
      className={cn("rounded-md border border-border bg-muted/30 px-3 py-2", className)}
      data-testid="args-diff"
    >
      <ul className="flex flex-col gap-1">
        {leaves.map((leaf) => (
          <LeafRow key={leaf.path} leaf={leaf} />
        ))}
      </ul>
    </div>
  );
}
