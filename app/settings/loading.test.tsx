import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SettingsLoading from "./loading";

describe("SettingsLoading", () => {
  it("renders skeletons", () => {
    const { container } = render(<SettingsLoading />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(2);
  });
});
