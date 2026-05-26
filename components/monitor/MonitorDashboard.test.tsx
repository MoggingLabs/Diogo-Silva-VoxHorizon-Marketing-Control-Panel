/**
 * MonitorDashboard (#362): KPI cards, GHL-truth banner, threshold-coloured
 * verdict pills, kill/scale POSTs.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

// EditableValue posts operator corrections through `overrideClient` (a module
// singleton bound to the global fetch at import time, so a fetch spy can't
// intercept it). Mock the client so the overlay edits are observable.
const overrideSetMock =
  vi.fn<(input: unknown) => Promise<{ ok: true } | { ok: false; error: string }>>();
vi.mock("@/lib/overrides", () => ({
  overrideClient: { set: (input: unknown) => overrideSetMock(input) },
}));

import { MonitorDashboard } from "./MonitorDashboard";
import type { PerfRowWithId } from "@/lib/monitor/fetch";

const rows: PerfRowWithId[] = [
  {
    id: "perf-keep1",
    campaign_id: "keep1",
    spend: 100,
    leads_ghl: 2,
    leads_meta: 4,
    ctr: 0.02,
    freq: 1.2,
    cpl_real: null,
  },
  {
    id: "perf-kill1",
    campaign_id: "kill1",
    spend: 320,
    leads_ghl: 2,
    leads_meta: 2,
    ctr: 0.01,
    freq: 1.5,
    cpl_real: null,
  },
];

beforeEach(() => {
  routerRefresh.mockReset();
  overrideSetMock.mockClear().mockResolvedValue({ ok: true } as const);
});
afterEach(() => vi.restoreAllMocks());

describe("MonitorDashboard", () => {
  it("renders the permanent GHL-truth banner with the lead gap", () => {
    render(<MonitorDashboard pipelineId="p1" rows={rows} />);
    const banner = screen.getByTestId("ghl-truth-banner");
    expect(banner).toHaveTextContent("GHL is lead truth");
    // Meta 6 vs GHL 4 → gap 2.
    expect(banner).toHaveTextContent("gap of 2");
  });

  it("shows the blended GHL-truth CPL in the KPI card", () => {
    render(<MonitorDashboard pipelineId="p1" rows={rows} />);
    // spend 420 / ghl leads 4 = 105
    expect(screen.getByTestId("kpi-cpl")).toHaveTextContent("$105");
  });

  it("colours verdict pills per the decision thresholds", () => {
    render(<MonitorDashboard pipelineId="p1" rows={rows} />);
    expect(screen.getByTestId("verdict-keep1")).toHaveAttribute("data-verdict", "keep");
    expect(screen.getByTestId("verdict-kill1")).toHaveAttribute("data-verdict", "kill");
  });

  it("applies a client CPL target override", () => {
    render(<MonitorDashboard pipelineId="p1" rows={rows} cplTarget={30} />);
    // keep1 CPL 50 vs target 30 → kill band (>45). Now kill.
    expect(screen.getByTestId("verdict-keep1")).toHaveAttribute("data-verdict", "kill");
  });

  it("POSTs a kill decision and refreshes", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ pipeline: { status: "done" } }));
    const user = userEvent.setup();
    render(<MonitorDashboard pipelineId="p1" rows={rows} />);
    await user.click(screen.getByTestId("kill-button"));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/pipelines/p1/monitor/decision",
        expect.objectContaining({ method: "POST" }),
      );
      expect(routerRefresh).toHaveBeenCalled();
    });
  });

  it("POSTs a scale decision", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ pipeline: { status: "done" } }));
    const user = userEvent.setup();
    render(<MonitorDashboard pipelineId="p1" rows={rows} />);
    await user.click(screen.getByTestId("scale-button"));
    await waitFor(() => {
      const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.decision).toBe("scale");
    });
  });

  it("surfaces a decision error inline", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, { status: 500 }));
    const user = userEvent.setup();
    render(<MonitorDashboard pipelineId="p1" rows={rows} />);
    await user.click(screen.getByTestId("kill-button"));
    await waitFor(() => expect(screen.getByTestId("monitor-error")).toHaveTextContent("boom"));
  });

  it("surfaces a network error inline", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<MonitorDashboard pipelineId="p1" rows={rows} />);
    await user.click(screen.getByTestId("kill-button"));
    await waitFor(() => expect(screen.getByTestId("monitor-error")).toHaveTextContent("offline"));
  });

  it("falls back to a status message when the error body is empty", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({}, { status: 503 }));
    const user = userEvent.setup();
    render(<MonitorDashboard pipelineId="p1" rows={rows} />);
    await user.click(screen.getByTestId("scale-button"));
    await waitFor(() => expect(screen.getByTestId("monitor-error")).toHaveTextContent("503"));
  });

  it("renders an empty state with no perf rows", () => {
    render(<MonitorDashboard pipelineId="p1" rows={[]} />);
    expect(screen.getByText(/No performance data/)).toBeInTheDocument();
  });

  it("shows the worker-owned overlay hint", () => {
    render(<MonitorDashboard pipelineId="p1" rows={rows} />);
    expect(screen.getByTestId("monitor-overlay-hint")).toHaveTextContent(
      /never edits the source perf row/i,
    );
  });

  it("records a spend correction via the overrides overlay (never the source row)", async () => {
    const user = userEvent.setup();
    render(<MonitorDashboard pipelineId="p1" rows={rows} />);

    // The spend cell is an EditableValue keyed on the perf row id.
    await user.click(screen.getByRole("button", { name: /correct spend for keep1/i }));
    const input = screen.getByDisplayValue("100");
    await user.clear(input);
    await user.type(input, "150");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(overrideSetMock).toHaveBeenCalledWith({
        table_name: "campaign_perf_image",
        row_id: "perf-keep1",
        field_name: "spend",
        corrected_value: 150,
      });
    });
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("records a GHL-leads correction via the overrides overlay", async () => {
    const user = userEvent.setup();
    render(<MonitorDashboard pipelineId="p1" rows={rows} />);

    await user.click(screen.getByRole("button", { name: /correct ghl leads for kill1/i }));
    const input = screen.getByDisplayValue("2");
    await user.clear(input);
    await user.type(input, "5");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(overrideSetMock).toHaveBeenCalledWith({
        table_name: "campaign_perf_image",
        row_id: "perf-kill1",
        field_name: "leads_ghl",
        corrected_value: 5,
      });
    });
  });
});
