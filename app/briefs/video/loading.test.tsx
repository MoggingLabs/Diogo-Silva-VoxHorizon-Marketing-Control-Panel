import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Loading from "./loading";

describe("video briefs loading", () => {
  it("renders skeleton placeholders", () => {
    const { container } = render(<Loading />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(2);
  });
});
