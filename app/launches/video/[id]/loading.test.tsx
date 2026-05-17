import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Loading from "./loading";

describe("video launch detail loading", () => {
  it("renders skeleton placeholders", () => {
    const { container } = render(<Loading />);
    expect(container.querySelectorAll("[class*='bg-muted']").length).toBeGreaterThan(2);
  });
});
