/**
 * UnreadDivider is pure presentational — renders a "N new" pill above
 * the first unread message. Empty count hides the divider entirely.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UnreadDivider } from "./UnreadDivider";

describe("UnreadDivider", () => {
  it("renders nothing when count is 0 or negative", () => {
    const { container } = render(<UnreadDivider count={0} />);
    expect(container.firstChild).toBeNull();
    const { container: c2 } = render(<UnreadDivider count={-3} />);
    expect(c2.firstChild).toBeNull();
  });

  it("uses singular 'new' when count is 1", () => {
    render(<UnreadDivider count={1} />);
    expect(screen.getByText("1 new")).toBeInTheDocument();
    expect(screen.getByRole("separator")).toHaveAttribute("aria-label", "1 new message");
  });

  it("uses plural 'new' and includes the count for >1", () => {
    render(<UnreadDivider count={4} />);
    expect(screen.getByText("4 new")).toBeInTheDocument();
    expect(screen.getByRole("separator")).toHaveAttribute("aria-label", "4 new messages");
  });
});
