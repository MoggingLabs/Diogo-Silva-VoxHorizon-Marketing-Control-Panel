/**
 * Small keyboard-shortcut helpers shared by the efficiency layer (Makeover M7).
 *
 * Global single-key shortcuts (e.g. `n` = new) must never fire while the
 * operator is typing into a field or has a dialog/menu open. `isTypingTarget`
 * centralizes that guard so every shortcut handler behaves consistently.
 */

/**
 * True when the event target is a text-entry context where a bare letter
 * shortcut should be ignored: an `<input>`, `<textarea>`, `<select>`, any
 * `contenteditable` element, or anything inside an open dialog / menu / listbox
 * (Radix marks these with `role`). Returns `false` for `null`/non-element
 * targets so callers can pass `e.target` directly.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;

  // Inside a dialog, menu, or listbox a bare key is almost certainly meant for
  // that widget (type-ahead, etc.), not a page-level shortcut.
  const interactiveAncestor = target.closest(
    '[role="dialog"],[role="menu"],[role="listbox"],[contenteditable="true"]',
  );
  return interactiveAncestor !== null;
}

/**
 * True when the keyboard event carries a platform modifier (cmd/ctrl/alt/meta)
 * — used to let a bare-key shortcut ignore combos like cmd-K that belong to
 * other handlers.
 */
export function hasModifier(e: {
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): boolean {
  return Boolean(e.metaKey || e.ctrlKey || e.altKey);
}
