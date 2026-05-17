/**
 * StagePlaceholder is the "coming soon" body. Verifies the props thread
 * through to the rendered chrome.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StagePlaceholder } from "./StagePlaceholder";

describe("StagePlaceholder", () => {
  it("renders the stage label + upcoming wave in the title", () => {
    render(<StagePlaceholder stageLabel="Ideation" upcoming="PF-C" />);
    expect(screen.getByRole("heading", { name: /Ideation \(PF-C coming\)/ })).toBeInTheDocument();
  });

  it("uses the default subtitle when not provided", () => {
    render(<StagePlaceholder stageLabel="Stage X" upcoming="PF-Z" />);
    expect(screen.getByText(/Real implementation lands in a later wave/)).toBeInTheDocument();
  });

  it("uses the supplied subtitle when provided", () => {
    render(<StagePlaceholder stageLabel="Stage X" upcoming="PF-Z" subtitle="Custom subtitle" />);
    expect(screen.getByText("Custom subtitle")).toBeInTheDocument();
  });

  it("renders the 'this stage is a shell' body", () => {
    render(<StagePlaceholder stageLabel="X" upcoming="PF-Z" />);
    expect(screen.getByText(/This stage is a shell for now/)).toBeInTheDocument();
    expect(screen.getByText(/UI shipped in PF-Z/)).toBeInTheDocument();
  });

  it("has a disabled Continue CTA", () => {
    render(<StagePlaceholder stageLabel="X" upcoming="PF-Z" />);
    expect(screen.getByRole("button")).toBeDisabled();
  });
});
