/**
 * Tests for POST /api/internal/approval-email (HI-17).
 *
 * Coverage targets:
 *   - 401 paths: missing header, wrong scheme, wrong token, blank env
 *   - 400 path: malformed JSON body
 *   - 422 path: invalid payload (zod schema fails)
 *   - 503 path: required runtime env vars unset (RESEND_API_KEY /
 *     OPERATOR_EMAIL)
 *   - 200 path: happy send returns `{ ok, id, subject }`
 *   - 502 paths: Resend SDK returns an error / throws
 *   - 500 path: react-email render() throws (rare but defended)
 *
 * Resend is mocked at the module boundary so no real network call ever
 * leaves the process — even on the happy path. The mock factory captures
 * each call so we can assert subject/body/recipient.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- module-level mocks -----------------------------------------------------
// Vitest hoists `vi.mock` calls above local declarations; we MUST keep the
// mock factories self-contained (no closures over outer variables). The
// hoisted factories register module replacements, and inside each test we
// retrieve the mock via `vi.mocked(...)`.

vi.mock("resend", () => {
  // The mock factory is hoisted, so it can't close over outer variables.
  // We attach the inner send mock to the module export so tests can grab
  // it back through `import * as resendModule`.
  const sendMock = vi.fn();
  class FakeResend {
    public emails = { send: sendMock };
    public lastApiKey: string;
    constructor(apiKey: string) {
      this.lastApiKey = apiKey;
      // Record the constructor call on the shared `vi.fn()` so tests
      // can assert against it like a regular mock.
      (FakeResend as unknown as { calls: string[] }).calls.push(apiKey);
    }
  }
  (FakeResend as unknown as { calls: string[] }).calls = [];
  return {
    Resend: FakeResend,
    __sendMock: sendMock,
    __resendCtorCalls: (FakeResend as unknown as { calls: string[] }).calls,
  };
});

vi.mock("@react-email/render", () => ({
  render: vi.fn(),
}));

// Route imports the React component but never renders it directly — we
// substitute a sentinel so the mocked `render()` receives a stable input.
vi.mock("@/lib/emails/HighUrgencyApprovalEmail", () => ({
  HighUrgencyApprovalEmail: vi.fn(() => "<!--mocked-tree-->"),
}));

import { HighUrgencyApprovalEmail } from "@/lib/emails/HighUrgencyApprovalEmail";
import { render as renderMockedFn } from "@react-email/render";
// We import the Resend module to read back the hoisted-factory exports.
import * as resendModule from "resend";

import { POST } from "./route";

// Convenience aliases so the rest of the test reads naturally.
const renderMock = vi.mocked(renderMockedFn);
const sendMock = (resendModule as unknown as { __sendMock: ReturnType<typeof vi.fn> }).__sendMock;
const resendCtorCalls = (resendModule as unknown as { __resendCtorCalls: string[] })
  .__resendCtorCalls;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN = "internal-test-token";

function authHeader(token: string = TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function makeReq(
  body: unknown,
  init: RequestInit & { headers?: Record<string, string> } = {},
): NextRequest {
  const headers = init.headers ?? authHeader();
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest("http://localhost/api/internal/approval-email", {
    method: "POST",
    headers,
    body: payload,
  });
}

function validBody() {
  return {
    approval_id: "ap-1",
    tool_name: "MetaAds.create_campaign",
    tool_args_preview: '{"budget":500}',
    risk_class: "external-write",
    estimated_cost: 75,
    context_summary: { pipeline_name: "Image v1" },
  };
}

describe("POST /api/internal/approval-email", () => {
  beforeEach(() => {
    vi.stubEnv("INTERNAL_API_TOKEN", TOKEN);
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("OPERATOR_EMAIL", "ops@voxhorizon.com");
    vi.stubEnv("NEXT_PUBLIC_DASHBOARD_URL", "https://dashboard.voxhorizon.com");
    vi.stubEnv("RESEND_FROM_ADDRESS", "");
    vi.stubEnv("VERCEL_URL", "");

    sendMock.mockReset();
    resendCtorCalls.length = 0;
    renderMock.mockReset();
    renderMock.mockResolvedValue("<html>email</html>");
    sendMock.mockResolvedValue({ data: { id: "email-id-1" }, error: null });
    (HighUrgencyApprovalEmail as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // --- auth ----------------------------------------------------------------

  it("returns 401 when the env token is unset", async () => {
    vi.stubEnv("INTERNAL_API_TOKEN", "");
    const res = await POST(makeReq(validBody()));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/not configured/i);
  });

  it("returns 401 when the env token is whitespace", async () => {
    vi.stubEnv("INTERNAL_API_TOKEN", "   ");
    const res = await POST(makeReq(validBody()));
    expect(res.status).toBe(401);
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const req = makeReq(validBody(), { headers: { "content-type": "application/json" } });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Missing or malformed/);
  });

  it("returns 401 when the Authorization header uses a wrong scheme", async () => {
    const req = makeReq(validBody(), {
      headers: { authorization: `Basic ${TOKEN}`, "content-type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the bearer token does not match", async () => {
    const res = await POST(makeReq(validBody(), { headers: authHeader("nope") }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid bearer/);
  });

  it("returns 401 when bearer token differs in length (constant-time short-circuit)", async () => {
    const res = await POST(makeReq(validBody(), { headers: authHeader("shorter") }));
    expect(res.status).toBe(401);
  });

  // --- body / validation ---------------------------------------------------

  it("returns 400 on invalid JSON body", async () => {
    const req = new NextRequest("http://localhost/api/internal/approval-email", {
      method: "POST",
      headers: authHeader(),
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid JSON/);
  });

  it("returns 422 when required fields are missing", async () => {
    const res = await POST(makeReq({ approval_id: "ap-1" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
    expect(body.issues).toBeInstanceOf(Array);
  });

  it("returns 422 when types are wrong", async () => {
    const res = await POST(makeReq({ ...validBody(), estimated_cost: "not-a-number" }));
    expect(res.status).toBe(422);
  });

  // --- config gates --------------------------------------------------------

  it("returns 503 when RESEND_API_KEY is missing", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const res = await POST(makeReq(validBody()));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("email_not_configured");
    expect(body.has_resend_key).toBe(false);
  });

  it("returns 503 when OPERATOR_EMAIL is missing", async () => {
    vi.stubEnv("OPERATOR_EMAIL", "");
    const res = await POST(makeReq(validBody()));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.has_operator_email).toBe(false);
  });

  // --- happy path ----------------------------------------------------------

  it("returns 200 and forwards a rendered email to Resend", async () => {
    const res = await POST(makeReq(validBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toBe("email-id-1");
    expect(body.subject).toBe("Approval needed: MetaAds.create_campaign ($75)");

    // Resend was instantiated with the API key.
    expect(resendCtorCalls).toContain("re_test");
    // The render input includes the dashboard URL we resolved.
    expect(HighUrgencyApprovalEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "ap-1",
        toolName: "MetaAds.create_campaign",
        dashboardUrl: "https://dashboard.voxhorizon.com",
      }),
    );
    // send() invoked with the right shape.
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ops@voxhorizon.com",
        from: "VoxHorizon Approvals <approvals@voxhorizon.com>",
        subject: "Approval needed: MetaAds.create_campaign ($75)",
        html: expect.any(String),
      }),
    );
  });

  it("uses RESEND_FROM_ADDRESS when set", async () => {
    vi.stubEnv("RESEND_FROM_ADDRESS", "custom@voxhorizon.com");
    await POST(makeReq(validBody()));
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: "custom@voxhorizon.com" }),
    );
  });

  it("omits the cost in the subject when estimated_cost is null", async () => {
    const res = await POST(makeReq({ ...validBody(), estimated_cost: null }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subject).toBe("Approval needed: MetaAds.create_campaign");
  });

  it("omits the cost in the subject when estimated_cost is NaN", async () => {
    const res = await POST(makeReq({ ...validBody(), estimated_cost: Number.NaN }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subject).toBe("Approval needed: MetaAds.create_campaign");
  });

  it("normalizes a non-primitive context_summary value to a string", async () => {
    // zod schema is z.record(z.unknown()), so booleans / objects pass parsing.
    await POST(makeReq({ ...validBody(), context_summary: { flag: true, count: 7 } }));
    expect(HighUrgencyApprovalEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        contextSummary: expect.objectContaining({ flag: "true", count: 7 }),
      }),
    );
  });

  it("drops null/undefined entries from context_summary", async () => {
    await POST(makeReq({ ...validBody(), context_summary: { kept: "x", dropped: null } }));
    const mockFn = HighUrgencyApprovalEmail as unknown as ReturnType<typeof vi.fn>;
    const firstCallArgs = mockFn.mock.calls[0];
    expect(firstCallArgs).toBeDefined();
    const props = firstCallArgs![0] as { contextSummary?: Record<string, unknown> };
    expect(props.contextSummary).toEqual({ kept: "x" });
  });

  it("falls back to VERCEL_URL when NEXT_PUBLIC_DASHBOARD_URL is empty", async () => {
    vi.stubEnv("NEXT_PUBLIC_DASHBOARD_URL", "");
    vi.stubEnv("VERCEL_URL", "preview.vercel.app");
    await POST(makeReq(validBody()));
    expect(HighUrgencyApprovalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ dashboardUrl: "https://preview.vercel.app" }),
    );
  });

  it("falls back to localhost when neither env var is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_DASHBOARD_URL", "");
    vi.stubEnv("VERCEL_URL", "");
    await POST(makeReq(validBody()));
    expect(HighUrgencyApprovalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ dashboardUrl: "http://localhost:3000" }),
    );
  });

  // --- failures ------------------------------------------------------------

  it("returns 502 when Resend returns an error object", async () => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { name: "validation_error", message: "bad to" },
    });
    const res = await POST(makeReq(validBody()));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("resend_failed");
    expect(body.detail.message).toBe("bad to");
  });

  it("returns 502 when Resend throws", async () => {
    sendMock.mockRejectedValueOnce(new Error("network blip"));
    const res = await POST(makeReq(validBody()));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("resend_threw");
    expect(body.message).toBe("network blip");
  });

  it("returns 502 with default message when Resend throws a non-Error value", async () => {
    sendMock.mockRejectedValueOnce("just a string");
    const res = await POST(makeReq(validBody()));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.message).toBe("resend_send_threw");
  });

  it("returns 500 when the React render fails", async () => {
    renderMock.mockRejectedValueOnce(new Error("render exploded"));
    const res = await POST(makeReq(validBody()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("render_failed");
    expect(body.message).toBe("render exploded");
  });

  it("returns 500 with default message when render throws non-Error", async () => {
    renderMock.mockRejectedValueOnce("not-an-error");
    const res = await POST(makeReq(validBody()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.message).toBe("render failed");
  });

  it("returns 200 even when Resend reports a null email id", async () => {
    sendMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(makeReq(validBody()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toBeNull();
  });
});
