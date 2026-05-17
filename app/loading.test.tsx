import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import DashboardLoading from "./loading";

describe("DashboardLoading", () => {
  it("renders skeleton placeholders inside an aria-busy region", () => {
    const { container } = render(<DashboardLoading />);
    const root = container.firstElementChild;
    expect(root?.getAttribute("aria-busy")).toBe("true");
    // A handful of skeleton tiles + columns should render.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(5);
  });
});
