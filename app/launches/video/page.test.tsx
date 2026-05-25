import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

import { redirect } from "next/navigation";

import VideoLaunchesIndexPage from "./page";

describe("VideoLaunchesIndexPage", () => {
  it("redirects to the unified /launches surface", () => {
    expect(() => VideoLaunchesIndexPage()).toThrow(/NEXT_REDIRECT:\/launches/);
    expect(redirect).toHaveBeenCalledWith("/launches");
  });
});
