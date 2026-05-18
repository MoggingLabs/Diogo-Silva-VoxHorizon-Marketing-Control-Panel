import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ApprovalsLoading from "./loading";

describe("ApprovalsLoading", () => {
  it("renders the skeleton container", () => {
    render(<ApprovalsLoading />);
    expect(screen.getByTestId("approvals-loading")).toBeInTheDocument();
  });
});
