import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AuditLoading from "./loading";

describe("AuditLoading", () => {
  it("renders skeleton sections", () => {
    const { container } = render(<AuditLoading />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(3);
  });
});
