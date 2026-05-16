"use client";

import * as React from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { overrideClient } from "@/lib/overrides";
import { cn } from "@/lib/utils";

/**
 * Type of editor to render when the operator clicks the value.
 *  - `text`   single-line input (default)
 *  - `number` numeric input; persists as a number
 *  - `select` dropdown bound to `options`
 */
export type EditableValueType = "text" | "number" | "select";

export type EditableValueProps = {
  tableName: string;
  rowId: string;
  field: string;
  value: string | number | null;
  type?: EditableValueType;
  /** Required when `type === "select"`. Ignored otherwise. */
  options?: ReadonlyArray<string>;
  placeholder?: string;
  /** Called with the saved value after a successful upsert. */
  onSaved?: (newValue: string | number | null) => void;
  /** Disables the click-to-edit affordance. */
  disabled?: boolean;
  /** Visual override (size / colour). Layout-only — wrapper is `inline-flex`. */
  className?: string;
  /** ARIA label for the edit button (defaults to `Edit {field}`). */
  ariaLabel?: string;
};

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Generic operator-override primitive. Renders the current `value` as plain
 * text; clicking (or pressing Enter / Space when focused) swaps in the
 * appropriate editor inline.
 *
 * Keyboard:
 *  - Enter        commit
 *  - Esc          cancel (no write)
 *  - Tab / blur   commit if value changed; cancel otherwise
 *
 * The component is intentionally generic — it doesn't import any row-specific
 * types. Pass `tableName`, `rowId`, `field` literally; the API route validates
 * the tuple and the unique constraint on `(table_name, row_id, field_name)`
 * makes repeated edits idempotent.
 *
 * The display value is uncontrolled after first render: we track the locally
 * edited value to support optimistic updates. Parents that subscribe to the
 * `overrides` realtime channel will receive their own echo and can re-render
 * authoritatively via the `value` prop (the component reseeds when `value`
 * changes from outside).
 */
export function EditableValue({
  tableName,
  rowId,
  field,
  value,
  type = "text",
  options,
  placeholder,
  onSaved,
  disabled = false,
  className,
  ariaLabel,
}: EditableValueProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<string>(formatForInput(value));
  const [committed, setCommitted] = React.useState<string | number | null>(value);
  const [state, setState] = React.useState<SaveState>("idle");
  const [errorText, setErrorText] = React.useState<string | null>(null);

  const inputRef = React.useRef<HTMLInputElement>(null);
  const lastSyncedValue = React.useRef<string | number | null>(value);

  // Reseed when parent pushes a new value (e.g. Realtime echo).
  React.useEffect(() => {
    if (Object.is(value, lastSyncedValue.current)) return;
    lastSyncedValue.current = value;
    setCommitted(value);
    if (!editing) {
      setDraft(formatForInput(value));
    }
  }, [value, editing]);

  // Auto-clear the "saved" check after a brief moment.
  React.useEffect(() => {
    if (state !== "saved") return;
    const t = setTimeout(() => setState("idle"), 1200);
    return () => clearTimeout(t);
  }, [state]);

  React.useEffect(() => {
    if (editing && type !== "select") {
      inputRef.current?.focus();
      inputRef.current?.select?.();
    }
  }, [editing, type]);

  function startEdit() {
    if (disabled) return;
    setDraft(formatForInput(committed));
    setErrorText(null);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setDraft(formatForInput(committed));
    setErrorText(null);
  }

  async function commit(rawDraft: string) {
    const next = parseForCommit(rawDraft, type);
    if (next.kind === "invalid") {
      setErrorText(next.message);
      return;
    }
    if (next.value === committed) {
      // No-op edit. Don't write.
      setEditing(false);
      setErrorText(null);
      return;
    }

    // Optimistic update.
    const previous = committed;
    setCommitted(next.value);
    setEditing(false);
    setState("saving");
    setErrorText(null);

    const result = await overrideClient.set({
      table_name: tableName,
      row_id: rowId,
      field_name: field,
      corrected_value: next.value,
    });

    if (!result.ok) {
      // Roll back optimistic update.
      setCommitted(previous);
      setDraft(formatForInput(previous));
      setState("error");
      setErrorText(result.error || "Save failed");
      return;
    }
    setState("saved");
    onSaved?.(next.value);
  }

  // ---- Display mode ----------------------------------------------------
  if (!editing) {
    const display = committed === null || committed === "" ? null : String(committed);
    return (
      <span className={cn("group inline-flex items-center gap-1.5 align-middle", className)}>
        <button
          type="button"
          onClick={startEdit}
          disabled={disabled}
          aria-label={ariaLabel ?? `Edit ${field}`}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 py-0.5 text-left",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            disabled
              ? "cursor-not-allowed opacity-50"
              : "cursor-text hover:bg-accent hover:text-accent-foreground",
          )}
        >
          <span className={cn(display === null && "italic text-muted-foreground")}>
            {display ?? placeholder ?? "—"}
          </span>
          {!disabled ? (
            <Pencil
              aria-hidden
              className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-focus-within:opacity-60 group-hover:opacity-60"
            />
          ) : null}
        </button>
        {state === "saving" ? (
          <Loader2 aria-hidden className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : null}
        {state === "saved" ? <Check aria-hidden className="h-3 w-3 text-emerald-600" /> : null}
        {state === "error" ? (
          <span role="alert" className="inline-flex items-center gap-1 text-xs text-destructive">
            <X aria-hidden className="h-3 w-3" />
            <span>{errorText ?? "error"}</span>
          </span>
        ) : null}
      </span>
    );
  }

  // ---- Edit mode -------------------------------------------------------
  if (type === "select") {
    const opts = options ?? [];
    return (
      <span className={cn("inline-flex items-center gap-1.5", className)}>
        <Select
          defaultOpen
          value={draft}
          onValueChange={(v) => {
            setDraft(v);
            void commit(v);
          }}
        >
          <SelectTrigger className="h-8 w-auto min-w-[8rem] text-sm">
            <SelectValue placeholder={placeholder ?? "Select..."} />
          </SelectTrigger>
          <SelectContent>
            {opts.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          onClick={cancel}
          aria-label="Cancel edit"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden className="h-3 w-3" />
        </button>
      </span>
    );
  }

  // text / number input
  const inputType = type === "number" ? "number" : "text";
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <input
        ref={inputRef}
        type={inputType}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit(draft);
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => void commit(draft)}
        className={cn(
          "h-8 w-[10rem] rounded-md border border-input bg-background px-2 py-1 text-sm",
          "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        )}
      />
      <button
        type="button"
        // mousedown beats the input's blur, which would otherwise commit first
        onMouseDown={(e) => {
          e.preventDefault();
          cancel();
        }}
        aria-label="Cancel edit"
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X aria-hidden className="h-3 w-3" />
      </button>
      {errorText ? (
        <span role="alert" className="text-xs text-destructive">
          {errorText}
        </span>
      ) : null}
    </span>
  );
}

// --- helpers -----------------------------------------------------------

function formatForInput(v: string | number | null): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

type Parsed = { kind: "ok"; value: string | number | null } | { kind: "invalid"; message: string };

function parseForCommit(raw: string, type: EditableValueType): Parsed {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "ok", value: null };
  }
  if (type === "number") {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return { kind: "invalid", message: "must be a number" };
    return { kind: "ok", value: n };
  }
  return { kind: "ok", value: trimmed };
}
