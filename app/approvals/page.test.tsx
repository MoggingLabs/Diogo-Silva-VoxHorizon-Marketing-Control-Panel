/**
 * Server-rendered audit page test. We mock the admin Supabase client + the
 * ApprovalsTable client island (it ships its own test file), then render
 * the page as a normal React element. The page is `async` so we await the
 * JSX before passing to RTL.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Approval } from "@/lib/approvals/types";
import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

vi.mock("./ApprovalsTable", () => ({
  ApprovalsTable: ({ approvals }: { approvals: Approval[] }) => (
    <div data-testid="table-stub" data-count={approvals.length}>
      {approvals.map((a) => (
        <span key={a.id} data-testid={`row-${a.id}`}>
          {a.tool_name}
        </span>
      ))}
    </div>
  ),
}));

vi.mock("@/components/approvals/ApprovalModeBanner", () => ({
  ApprovalModeBanner: () => <div data-testid="approval-mode-banner-stub" />,
}));

import ApprovalsAuditPage from "./page";

function makeSearchParams(params: Record<string, string | undefined>) {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined) cleaned[k] = v;
  return Promise.resolve(cleaned);
}

beforeEach(() => {
  currentSupabase = mockSupabaseClient();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ApprovalsAuditPage", () => {
  it("renders the heading + filters", async () => {
    const element = await ApprovalsAuditPage({ searchParams: makeSearchParams({}) });
    render(element);
    expect(screen.getByRole("heading", { name: /Approvals/i })).toBeInTheDocument();
    expect(screen.getByTestId("approvals-filters")).toBeInTheDocument();
    expect(screen.getByTestId("filter-status")).toBeInTheDocument();
  });

  it("passes the loaded rows to the ApprovalsTable", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        select: {
          data: [
            { id: "x", tool_name: "read_file" },
            { id: "y", tool_name: "write_file" },
          ],
          error: null,
        },
      },
    });
    const element = await ApprovalsAuditPage({ searchParams: makeSearchParams({}) });
    render(element);
    expect(screen.getByTestId("table-stub").dataset.count).toBe("2");
    expect(screen.getByTestId("row-x")).toHaveTextContent("read_file");
  });

  it("renders an alert when the supabase fetch errors", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: { select: { data: null, error: { message: "DB unreachable" } } },
    });
    const element = await ApprovalsAuditPage({ searchParams: makeSearchParams({}) });
    render(element);
    expect(screen.getByRole("alert").textContent).toMatch(/DB unreachable/);
  });

  it("applies the status filter when provided", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: { select: { data: [], error: null } },
    });
    const element = await ApprovalsAuditPage({
      searchParams: makeSearchParams({ status: "decided" }),
    });
    render(element);
    const fromCall = currentSupabase._spies.from.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    const chain = fromCall!.select!.mock.results[0]?.value as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    expect(chain.eq).toHaveBeenCalledWith("status", "decided");
  });

  it("ignores invalid status values", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: { select: { data: [], error: null } },
    });
    const element = await ApprovalsAuditPage({
      searchParams: makeSearchParams({ status: "lol" }),
    });
    render(element);
    const fromCall = currentSupabase._spies.from.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    const chain = fromCall!.select!.mock.results[0]?.value as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    expect(chain.eq).not.toHaveBeenCalledWith("status", "lol");
  });

  it("applies the tool, session, decision filters when valid", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: { select: { data: [], error: null } },
    });
    const element = await ApprovalsAuditPage({
      searchParams: makeSearchParams({
        tool: "read_file",
        session: "sess1",
        decision: "approved",
      }),
    });
    render(element);
    const fromCall = currentSupabase._spies.from.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    const chain = fromCall!.select!.mock.results[0]?.value as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    expect(chain.eq).toHaveBeenCalledWith("tool_name", "read_file");
    expect(chain.eq).toHaveBeenCalledWith("ekko_session_id", "sess1");
    expect(chain.eq).toHaveBeenCalledWith("decision", "approved");
  });

  it("ignores invalid decision values", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: { select: { data: [], error: null } },
    });
    const element = await ApprovalsAuditPage({
      searchParams: makeSearchParams({ decision: "weird" }),
    });
    render(element);
    const fromCall = currentSupabase._spies.from.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    const chain = fromCall!.select!.mock.results[0]?.value as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    expect(chain.eq).not.toHaveBeenCalledWith("decision", "weird");
  });

  it("handles array search params by picking the first value", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: { select: { data: [], error: null } },
    });
    // Manually wrap the value in an array — Next can hand back string[] for
    // repeated query keys.
    const sp = Promise.resolve({ status: ["pending", "decided"] as string[] });
    const element = await ApprovalsAuditPage({ searchParams: sp });
    render(element);
    const fromCall = currentSupabase._spies.from.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    const chain = fromCall!.select!.mock.results[0]?.value as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    expect(chain.eq).toHaveBeenCalledWith("status", "pending");
  });
});
