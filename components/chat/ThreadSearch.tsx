"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Cmd+F (Ctrl+F on Windows) search bar for the chat / iteration
 * thread inside a SidePanel.
 *
 * Architecture:
 *  - `data-thread-search` on the bar lives at the top of the panel,
 *    just under the header. It only renders when `open` is true.
 *  - The caller (SidePanel) wires Cmd+F via a `keydown` listener
 *    that calls `onOpen()`. We don't capture the global keydown
 *    here because multiple side panels could be mounted at once.
 *  - When `query` changes, we walk the live DOM under
 *    `searchScope.current` looking for elements with the
 *    `data-thread-searchable` attribute, then wrap matches in a
 *    `<mark>`. The wrapping is purely cosmetic — we don't mutate
 *    React state so the next render replaces our `<mark>`s.
 *  - Up/Down arrows + Enter cycle through matches. Each match
 *    scrolls into view + gets a `data-thread-search-active`
 *    attribute so the parent can style it differently.
 *
 * The component takes an explicit `searchScope` ref rather than
 * walking the whole document — multiple chats can be mounted (e.g.
 * after the operator clicks between cards quickly) and we want to
 * scope by panel.
 */
export type ThreadSearchProps = {
  open: boolean;
  onClose: () => void;
  searchScope: React.RefObject<HTMLElement | null>;
  /** Optional label for the empty-state hint. */
  label?: string;
};

const HIGHLIGHT_CLASS = "rounded-sm bg-amber-200/80 text-amber-900";
const ACTIVE_HIGHLIGHT_CLASS = "ring-1 ring-amber-500";

export function ThreadSearch({
  open,
  onClose,
  searchScope,
  label = "Search thread",
}: ThreadSearchProps) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus when the bar opens. Re-run on `open` flip so re-opening
  // restores cursor.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  // Reset state when the bar closes.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIdx(0);
      setMatchCount(0);
      clearHighlights(searchScope.current);
    }
  }, [open, searchScope]);

  // Re-highlight whenever the query or the active match changes.
  useEffect(() => {
    if (!open) return;
    const scope = searchScope.current;
    if (!scope) return;
    clearHighlights(scope);
    if (query.trim().length === 0) {
      setMatchCount(0);
      setActiveIdx(0);
      return;
    }
    const count = highlightMatches(scope, query.trim(), activeIdx);
    setMatchCount(count);
    if (activeIdx >= count && count > 0) setActiveIdx(0);
  }, [activeIdx, open, query, searchScope]);

  const stepActive = useCallback(
    (dir: 1 | -1) => {
      setActiveIdx((idx) => {
        if (matchCount === 0) return 0;
        const next = (idx + dir + matchCount) % matchCount;
        return next;
      });
    },
    [matchCount],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        stepActive(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        stepActive(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        stepActive(-1);
      }
    },
    [onClose, stepActive],
  );

  // Status string is memoized so the aria-live region only re-announces on a real change.
  const status = useMemo(() => {
    if (query.trim().length === 0) return "";
    if (matchCount === 0) return "No matches";
    return `${activeIdx + 1} of ${matchCount}`;
  }, [activeIdx, matchCount, query]);

  if (!open) return null;

  return (
    <div className="flex items-center gap-1 rounded-md border bg-card px-1.5 py-1 shadow-sm">
      <Search aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setActiveIdx(0);
          setQuery(e.target.value);
        }}
        onKeyDown={onKeyDown}
        placeholder={label}
        className="min-w-0 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
        aria-label={label}
      />
      <span aria-live="polite" className="px-1 text-[11px] text-muted-foreground">
        {status}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => stepActive(-1)}
        className="h-7 w-7 p-0"
        disabled={matchCount === 0}
        aria-label="Previous match"
      >
        <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => stepActive(1)}
        className="h-7 w-7 p-0"
        disabled={matchCount === 0}
        aria-label="Next match"
      >
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onClose}
        className="h-7 w-7 p-0"
        aria-label="Close search"
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/** Strip every `<mark data-thread-search-mark>` wrapper inside `scope`. */
function clearHighlights(scope: HTMLElement | null): void {
  if (!scope) return;
  const marks = scope.querySelectorAll<HTMLElement>("mark[data-thread-search-mark]");
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}

/**
 * Walk every text node inside `scope` whose ancestor is tagged with
 * `data-thread-searchable`, then wrap each occurrence of `needle`
 * (case-insensitive) in a `<mark data-thread-search-mark>`. The
 * `active` index gets an extra class so callers can style it.
 *
 * Returns the total match count. The scroll-into-view side effect for
 * the active match runs at the end so DOM mutations have settled.
 */
function highlightMatches(scope: HTMLElement, needle: string, active: number): number {
  if (needle.length === 0) return 0;
  const lower = needle.toLowerCase();
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.parentElement) return NodeFilter.FILTER_REJECT;
      // Only highlight inside opt-in regions so we don't paint markers
      // on header text / button labels / inputs.
      if (!node.parentElement.closest("[data-thread-searchable]")) {
        return NodeFilter.FILTER_REJECT;
      }
      // Skip text inside marks we already inserted to avoid double-wrap.
      if (node.parentElement.closest("mark[data-thread-search-mark]")) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!node.nodeValue || node.nodeValue.length === 0) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  let cur: Node | null;
  while ((cur = walker.nextNode())) textNodes.push(cur as Text);

  let total = 0;
  let activeMark: HTMLElement | null = null;
  for (const node of textNodes) {
    const text = node.nodeValue ?? "";
    const lowerText = text.toLowerCase();
    let from = 0;
    let next: number;
    const fragments: Array<string | HTMLElement> = [];
    while ((next = lowerText.indexOf(lower, from)) !== -1) {
      if (next > from) fragments.push(text.slice(from, next));
      const mark = document.createElement("mark");
      mark.setAttribute("data-thread-search-mark", "1");
      mark.className = HIGHLIGHT_CLASS;
      mark.textContent = text.slice(next, next + needle.length);
      if (total === active) {
        mark.classList.add(...ACTIVE_HIGHLIGHT_CLASS.split(" "));
        mark.setAttribute("data-thread-search-active", "1");
        activeMark = mark;
      }
      fragments.push(mark);
      total += 1;
      from = next + needle.length;
    }
    if (fragments.length === 0) continue;
    if (from < text.length) fragments.push(text.slice(from));
    const parent = node.parentNode;
    if (!parent) continue;
    for (const frag of fragments) {
      if (typeof frag === "string") parent.insertBefore(document.createTextNode(frag), node);
      else parent.insertBefore(frag, node);
    }
    parent.removeChild(node);
  }
  if (activeMark) {
    try {
      activeMark.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch {
      // Some test environments (jsdom) lack `scrollIntoView`; fail soft.
    }
  }
  return total;
}

/**
 * Helper hook that wires Cmd+F / Ctrl+F to a state setter. The caller
 * passes the ref of the surface the shortcut should apply to; we only
 * intercept the event when the focus is inside (or no element is
 * focused, which is the dashboard's default state).
 */
export function useThreadSearchShortcut(
  scopeRef: React.RefObject<HTMLElement | null>,
  onTrigger: () => void,
): void {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const isCmdF = (e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F");
      if (!isCmdF) return;
      const scope = scopeRef.current;
      if (!scope) return;
      // Only intercept when the focus is inside our panel — otherwise
      // we'd hijack the browser's default Find on the whole page,
      // which is rude when the user is reading a brief.
      const active = document.activeElement;
      const focusInside = active instanceof Node && scope.contains(active);
      const noFocus = !active || active === document.body;
      if (!focusInside && !noFocus) return;
      // Only intercept while the panel is visible to the user. A
      // detached scope ref means the panel is closed.
      if (!scope.isConnected) return;
      e.preventDefault();
      onTrigger();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onTrigger, scopeRef]);
}
