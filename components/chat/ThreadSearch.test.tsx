/**
 * ThreadSearch is a Cmd+F-style find bar scoped to a panel. Tests cover:
 *  - Opening / closing via the `open` prop and the close button
 *  - Counting + cycling matches via Enter / arrow keys
 *  - DOM mutation: <mark data-thread-search-mark> insertion + cleanup
 *  - The `data-thread-searchable` opt-in filter for highlight scope
 *  - Cmd+F shortcut delegate via `useThreadSearchShortcut`
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThreadSearch, useThreadSearchShortcut } from "./ThreadSearch";

afterEach(() => {
  vi.restoreAllMocks();
});

function Harness({
  initialOpen = false,
  contents = ["the quick brown fox", "another the fox tale"],
}: {
  initialOpen?: boolean;
  contents?: string[];
}) {
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(initialOpen);
  return (
    <div ref={scopeRef}>
      <button type="button" onClick={() => setOpen(true)}>
        open-bar
      </button>
      <ThreadSearch open={open} onClose={() => setOpen(false)} searchScope={scopeRef} />
      <div data-thread-searchable>
        {contents.map((c, i) => (
          <p key={i}>{c}</p>
        ))}
      </div>
      <div>
        <p>outside scope: the</p>
      </div>
    </div>
  );
}

describe("ThreadSearch UI", () => {
  it("does not render when open=false", () => {
    render(<Harness />);
    expect(screen.queryByPlaceholderText(/Search thread/i)).not.toBeInTheDocument();
  });

  it("renders the input when open", () => {
    render(<Harness initialOpen />);
    expect(screen.getByPlaceholderText(/Search thread/i)).toBeInTheDocument();
  });

  it("counts matches and announces N of M for the active match", async () => {
    const user = userEvent.setup();
    render(<Harness initialOpen />);
    const input = screen.getByPlaceholderText(/Search thread/i);
    await user.type(input, "the");
    // 3 occurrences of "the" inside `data-thread-searchable` scope:
    //   "the quick brown fox" → 1
    //   "another the fox tale" → 2 (another, the)
    // "outside scope: the" is excluded.
    expect(screen.getByText(/of 3/)).toBeInTheDocument();
    expect(screen.getByText(/1 of/)).toBeInTheDocument();
  });

  it("renders 'No matches' when the query has no hits", async () => {
    const user = userEvent.setup();
    render(<Harness initialOpen />);
    await user.type(screen.getByPlaceholderText(/Search thread/i), "zzz");
    expect(screen.getByText(/No matches/)).toBeInTheDocument();
  });

  it("Enter cycles to the next match, Shift+Enter to the previous", async () => {
    const user = userEvent.setup();
    render(<Harness initialOpen />);
    const input = screen.getByPlaceholderText(/Search thread/i);
    await user.type(input, "fox");
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.getByText(/2 of 2/)).toBeInTheDocument();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
  });

  it("ArrowDown / ArrowUp cycle and wrap around", async () => {
    const user = userEvent.setup();
    render(<Harness initialOpen />);
    await user.type(screen.getByPlaceholderText(/Search thread/i), "fox");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByText(/2 of 2/)).toBeInTheDocument();
    await user.keyboard("{ArrowDown}"); // wrap to 1
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
    await user.keyboard("{ArrowUp}"); // back to 2
    expect(screen.getByText(/2 of 2/)).toBeInTheDocument();
  });

  it("Escape closes the bar", async () => {
    const user = userEvent.setup();
    render(<Harness initialOpen />);
    await user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText(/Search thread/i)).not.toBeInTheDocument();
  });

  it("clicking the close button closes the bar", async () => {
    const user = userEvent.setup();
    render(<Harness initialOpen />);
    await user.click(screen.getByLabelText("Close search"));
    expect(screen.queryByPlaceholderText(/Search thread/i)).not.toBeInTheDocument();
  });

  it("Previous/Next buttons are disabled when there are zero matches", async () => {
    const user = userEvent.setup();
    render(<Harness initialOpen />);
    await user.type(screen.getByPlaceholderText(/Search thread/i), "zzz");
    expect(screen.getByLabelText("Previous match")).toBeDisabled();
    expect(screen.getByLabelText("Next match")).toBeDisabled();
  });

  it("Previous / Next click handlers cycle when there are matches", async () => {
    const user = userEvent.setup();
    render(<Harness initialOpen />);
    await user.type(screen.getByPlaceholderText(/Search thread/i), "fox");
    await user.click(screen.getByLabelText("Next match"));
    expect(screen.getByText(/2 of 2/)).toBeInTheDocument();
    await user.click(screen.getByLabelText("Previous match"));
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
  });

  it("inserts <mark data-thread-search-mark> spans into the searchable scope only", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initialOpen />);
    await user.type(screen.getByPlaceholderText(/Search thread/i), "fox");
    const marks = container.querySelectorAll("mark[data-thread-search-mark]");
    expect(marks.length).toBe(2);
    // None should be inside the "outside scope" paragraph.
    for (const m of marks) {
      expect(m.textContent?.toLowerCase()).toBe("fox");
    }
  });

  it("active match gets a special data attribute", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initialOpen />);
    await user.type(screen.getByPlaceholderText(/Search thread/i), "fox");
    expect(container.querySelector("mark[data-thread-search-active='1']")).not.toBeNull();
  });

  it("resets state and removes highlights when the bar closes", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initialOpen />);
    await user.type(screen.getByPlaceholderText(/Search thread/i), "fox");
    expect(container.querySelectorAll("mark[data-thread-search-mark]").length).toBeGreaterThan(0);
    await user.keyboard("{Escape}");
    expect(container.querySelectorAll("mark[data-thread-search-mark]").length).toBe(0);
  });

  it("re-querying replaces highlights instead of stacking", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initialOpen />);
    const input = screen.getByPlaceholderText(/Search thread/i);
    await user.type(input, "fox");
    expect(container.querySelectorAll("mark[data-thread-search-mark]").length).toBe(2);
    await user.clear(input);
    await user.type(input, "tale");
    expect(container.querySelectorAll("mark[data-thread-search-mark]").length).toBe(1);
  });

  it("empty / whitespace-only queries clear matches without highlighting", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initialOpen />);
    const input = screen.getByPlaceholderText(/Search thread/i);
    await user.type(input, "fox");
    await user.clear(input);
    expect(container.querySelectorAll("mark[data-thread-search-mark]").length).toBe(0);
  });

  it("uses the custom `label` prop for placeholder and aria-label", () => {
    function CustomLabel() {
      const scopeRef = useRef<HTMLDivElement | null>(null);
      return (
        <div ref={scopeRef}>
          <ThreadSearch open onClose={() => {}} searchScope={scopeRef} label="Custom label" />
        </div>
      );
    }
    render(<CustomLabel />);
    expect(screen.getByPlaceholderText("Custom label")).toBeInTheDocument();
    expect(screen.getByLabelText("Custom label")).toBeInTheDocument();
  });
});

describe("useThreadSearchShortcut", () => {
  function Surface({ onTrigger }: { onTrigger: () => void }) {
    const ref = useRef<HTMLDivElement | null>(null);
    useThreadSearchShortcut(ref, onTrigger);
    return (
      <div ref={ref} data-testid="surface">
        <button type="button">in-scope</button>
      </div>
    );
  }

  it("fires onTrigger when Cmd+F is pressed with focus inside the scope", () => {
    const onTrigger = vi.fn();
    render(<Surface onTrigger={onTrigger} />);
    const btn = screen.getByText("in-scope");
    btn.focus();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(onTrigger).toHaveBeenCalled();
  });

  it("fires on Ctrl+F too", () => {
    const onTrigger = vi.fn();
    render(<Surface onTrigger={onTrigger} />);
    screen.getByText("in-scope").focus();
    fireEvent.keyDown(window, { key: "F", ctrlKey: true });
    expect(onTrigger).toHaveBeenCalled();
  });

  it("does NOT fire when focus is outside the scope", () => {
    const onTrigger = vi.fn();
    render(
      <>
        <Surface onTrigger={onTrigger} />
        <button type="button" data-testid="outside">
          outside
        </button>
      </>,
    );
    const outside = screen.getByTestId("outside") as HTMLButtonElement;
    outside.focus();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("does fire when no element is focused (body)", () => {
    const onTrigger = vi.fn();
    render(<Surface onTrigger={onTrigger} />);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(onTrigger).toHaveBeenCalled();
  });

  it("does NOT fire when the modifier keys are absent", () => {
    const onTrigger = vi.fn();
    render(<Surface onTrigger={onTrigger} />);
    screen.getByText("in-scope").focus();
    fireEvent.keyDown(window, { key: "f" });
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("removes its listener on unmount", () => {
    const onTrigger = vi.fn();
    const { unmount } = render(<Surface onTrigger={onTrigger} />);
    unmount();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(onTrigger).not.toHaveBeenCalled();
  });
});
