import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import NotFoundPage from "./not-found";

describe("NotFoundPage", () => {
  it("renders the 404 chrome with both fallback links", () => {
    render(<NotFoundPage />);
    expect(screen.getByText(/page not found/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to dashboard/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /view briefs/i })).toHaveAttribute("href", "/briefs");
  });
});
