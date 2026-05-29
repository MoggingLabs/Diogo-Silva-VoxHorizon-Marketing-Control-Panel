/**
 * Tests for the single-operator login screen.
 *
 * Mocks `next/navigation` (router + search params) and the global `fetch` so
 * we exercise the submit -> response -> redirect / error-message branches
 * without a network or a real session.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
const refresh = vi.fn();
const searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
  useSearchParams: () => searchParams,
}));

import LoginPage from "./page";

function mockFetch(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: status === 200 }), { status })),
  );
}

beforeEach(() => {
  replace.mockReset();
  refresh.mockReset();
  searchParams.forEach((_v, k) => searchParams.delete(k));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fillAndSubmit(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/email/i), "operator@example.com");
  await user.type(screen.getByLabelText(/password/i), "hunter2");
  await user.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("LoginPage", () => {
  it("renders the email + password fields and a submit button", () => {
    render(<LoginPage />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("on success redirects to the sanitised `next` and refreshes", async () => {
    searchParams.set("next", "/pipeline");
    mockFetch(200);
    render(<LoginPage />);
    await fillAndSubmit();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/pipeline"));
    expect(refresh).toHaveBeenCalled();
  });

  it("ignores an off-site `next` and falls back to /", async () => {
    searchParams.set("next", "//evil.com/phish");
    mockFetch(200);
    render(<LoginPage />);
    await fillAndSubmit();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("shows an incorrect-credentials message on 401", async () => {
    mockFetch(401);
    render(<LoginPage />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/incorrect email or password/i);
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows a not-configured message on 503", async () => {
    mockFetch(503);
    render(<LoginPage />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/not configured/i);
  });

  it("shows a generic message on an unexpected status", async () => {
    mockFetch(500);
    render(<LoginPage />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/something went wrong/i);
  });

  it("shows a connectivity message when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    render(<LoginPage />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach the server/i);
  });
});
