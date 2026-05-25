/**
 * Tests for ProfileSection (1:1 profile summary + edit drawer).
 *
 * Covers: rendering the summary from an existing profile, the empty (no
 * profile) state, and the edit drawer save -> saveProfile with coerced body.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn() }),
}));

const saveProfile = vi.fn((...args: unknown[]) => {
  void args;
  return Promise.resolve({});
});
vi.mock("@/lib/clients/api", () => ({
  saveProfile: (...a: unknown[]) => saveProfile(...a),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProfileSection } from "./ProfileSection";
import type { ClientProfile } from "@/lib/clients/schemas";

const PROFILE = {
  client_id: "c1",
  tagline: "Roofs done right",
  tone: "confident",
  years_in_business: 12,
} as unknown as ClientProfile;

afterEach(() => vi.clearAllMocks());

describe("ProfileSection", () => {
  it("renders summary values from the profile", () => {
    render(<ProfileSection clientId="c1" profile={PROFILE} />);
    expect(screen.getByText("Roofs done right")).toBeInTheDocument();
    expect(screen.getByText("confident")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit profile/i })).toBeInTheDocument();
  });

  it("offers Add profile when none exists", () => {
    render(<ProfileSection clientId="c1" profile={null} />);
    expect(screen.getByRole("button", { name: /add profile/i })).toBeInTheDocument();
  });

  it("saves the profile with a coerced numeric field", async () => {
    render(<ProfileSection clientId="c1" profile={PROFILE} />);
    await userEvent.click(screen.getByRole("button", { name: /edit profile/i }));
    const drawer = await screen.findByRole("dialog");
    const tagline = within(drawer).getByLabelText("Tagline");
    await userEvent.clear(tagline);
    await userEvent.type(tagline, "New tagline");
    await userEvent.click(within(drawer).getByRole("button", { name: /save/i }));
    await waitFor(() => expect(saveProfile).toHaveBeenCalled());
    const [clientId, body] = saveProfile.mock.calls[0]! as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(clientId).toBe("c1");
    expect(body.tagline).toBe("New tagline");
    // years_in_business seeded from 12 and coerced back to a number.
    expect(body.years_in_business).toBe(12);
  });
});
