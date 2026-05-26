// @vitest-environment jsdom
/**
 * Unit tests for the keyboard-shortcut guard helpers (Makeover M7).
 *
 * `isTypingTarget` reads DOM element types + roles, so this file opts into the
 * jsdom environment (the rest of `lib/**` runs in node). Covers every branch:
 * input/textarea/select tags, contenteditable, interactive ancestors, plain
 * elements, and non-element targets; plus the modifier check.
 */
import { describe, expect, it } from "vitest";

import { hasModifier, isTypingTarget } from "./keyboard";

function el(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container.firstElementChild as HTMLElement;
}

describe("isTypingTarget", () => {
  it("returns false for null / non-element targets", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({} as EventTarget)).toBe(false);
  });

  it("returns true for input, textarea, and select", () => {
    expect(isTypingTarget(el("<input />"))).toBe(true);
    expect(isTypingTarget(el("<textarea></textarea>"))).toBe(true);
    expect(isTypingTarget(el("<select></select>"))).toBe(true);
  });

  it("returns true for a contenteditable element", () => {
    const node = el('<div contenteditable="true">x</div>');
    // jsdom doesn't auto-reflect the attribute to isContentEditable; set it.
    Object.defineProperty(node, "isContentEditable", { value: true });
    expect(isTypingTarget(node)).toBe(true);
  });

  it("returns true when inside a dialog / menu / listbox", () => {
    const dialog = el('<div role="dialog"><button>ok</button></div>');
    const btn = dialog.querySelector("button") as HTMLElement;
    expect(isTypingTarget(btn)).toBe(true);

    const menu = el('<div role="menu"><span>item</span></div>');
    expect(isTypingTarget(menu.querySelector("span") as HTMLElement)).toBe(true);
  });

  it("returns false for a plain, non-interactive element", () => {
    expect(isTypingTarget(el("<button>go</button>"))).toBe(false);
    expect(isTypingTarget(el("<div>text</div>"))).toBe(false);
  });
});

describe("hasModifier", () => {
  it("detects each platform modifier", () => {
    expect(hasModifier({ metaKey: true })).toBe(true);
    expect(hasModifier({ ctrlKey: true })).toBe(true);
    expect(hasModifier({ altKey: true })).toBe(true);
  });

  it("returns false when no modifier is held", () => {
    expect(hasModifier({})).toBe(false);
    expect(hasModifier({ metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
  });
});
