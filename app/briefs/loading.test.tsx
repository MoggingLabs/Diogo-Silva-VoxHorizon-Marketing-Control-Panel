import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import BriefsListLoading from "./loading";

describe("BriefsListLoading", () => {
  it("renders skeletons with aria-busy", () => {
    const { container } = render(<BriefsListLoading />);
    expect(container.firstElementChild?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(5);
  });
});
