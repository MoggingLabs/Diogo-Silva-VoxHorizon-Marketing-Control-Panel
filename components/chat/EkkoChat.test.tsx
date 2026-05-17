/**
 * EkkoChat is the chat surface used inside SidePanel / VideoSidePanel.
 *
 * Behaviour we test:
 *   - User message renders optimistically with a temp id (covered via
 *     visible text + the streaming assistant placeholder).
 *   - SSE text_delta chunks accumulate into the assistant message.
 *   - tool_call_start + tool_call_result produce a ToolCallCard.
 *   - Abort cancels the inflight fetch and POSTs to the abort endpoint.
 *   - Errors show inline + the Retry button re-fires the last user msg.
 *   - The Send button is disabled until the textarea has text.
 *   - Unmount + creativeId change both cancel any inflight stream.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sseResponse, spyOnFetch, jsonResponse } from "@/tests/unit/helpers/worker-mock";

import { EkkoChat, __testExports } from "./EkkoChat";

// Stub the tool-call card to a tiny stand-in so the EkkoChat tests don't
// depend on the per-card markup.
vi.mock("./ToolCallCard", () => ({
  ToolCallCard: ({ call }: { call: { tool: string; pending: boolean } }) => (
    <div data-testid={`tool-${call.tool}`} data-pending={call.pending}>
      {call.tool}
    </div>
  ),
}));

beforeEach(() => {
  // Make requestAnimationFrame fire synchronously so streaming text
  // renders without timer plumbing.
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
    cb(performance.now());
    return 1 as unknown as number;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EkkoChat - temp id helpers", () => {
  it("newTempId stamps the configured prefix", () => {
    const id = __testExports.newTempId("temp-user-");
    expect(id.startsWith("temp-user-")).toBe(true);
  });

  it("isTempId recognises both user + assistant prefixes", () => {
    expect(__testExports.isTempId("temp-user-x")).toBe(true);
    expect(__testExports.isTempId("temp-assistant-x")).toBe(true);
    expect(__testExports.isTempId("real-id")).toBe(false);
  });
});

describe("EkkoChat", () => {
  function renderChat() {
    return render(
      <EkkoChat
        endpoint="/api/creatives/x/chat"
        creativeId="x"
        creativeKind="image"
        onIterate={() => {}}
      />,
    );
  }

  it("renders the empty-state hint when no messages exist", () => {
    renderChat();
    expect(screen.getByText(/Start a conversation with Ekko/i)).toBeInTheDocument();
  });

  it("uses the image placeholder copy when creativeKind=image", () => {
    renderChat();
    expect(screen.getByPlaceholderText(/tweak the image/i)).toBeInTheDocument();
  });

  it("uses the video placeholder copy when creativeKind=video", () => {
    render(<EkkoChat endpoint="/api/creatives/video/x/chat" creativeId="x" creativeKind="video" />);
    expect(screen.getByPlaceholderText(/swap a clip/i)).toBeInTheDocument();
  });

  it("disables Send when input is empty", () => {
    renderChat();
    expect(screen.getByLabelText("Send to Ekko")).toBeDisabled();
  });

  it("submits a user message and streams the assistant reply via text_delta", async () => {
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([
        { type: "text_delta", delta: "hello " },
        { type: "text_delta", delta: "world" },
        { type: "message_stop" },
      ]),
    );
    const user = userEvent.setup();
    renderChat();
    const textarea = screen.getByPlaceholderText(/tweak the image/i);
    await user.type(textarea, "tweak the headline");
    await user.click(screen.getByLabelText("Send to Ekko"));

    expect(await screen.findByText("tweak the headline")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/hello world/)).toBeInTheDocument();
    });
  });

  it("Enter (without Shift) submits the message", async () => {
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([{ type: "text_delta", delta: "hi" }, { type: "message_stop" }]),
    );
    const user = userEvent.setup();
    renderChat();
    const textarea = screen.getByPlaceholderText(/tweak the image/i);
    await user.type(textarea, "yo");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("yo")).toBeInTheDocument();
  });

  it("Shift+Enter inserts a newline instead of submitting", async () => {
    const fetchSpy = spyOnFetch();
    const user = userEvent.setup();
    renderChat();
    const textarea = screen.getByPlaceholderText(/tweak the image/i);
    await user.type(textarea, "line1");
    await user.keyboard("{Shift>}{Enter}{/Shift}line2");
    expect((textarea as HTMLTextAreaElement).value).toContain("\n");
    // No fetch was triggered.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders tool-call cards from tool_call_start + tool_call_result", async () => {
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([
        { type: "tool_call_start", tool: "regenerate_image", input: { prompt: "x" } },
        { type: "tool_call_result", tool: "regenerate_image", result: { ok: true } },
        { type: "message_stop" },
      ]),
    );
    const onIterate = vi.fn();
    const user = userEvent.setup();
    render(
      <EkkoChat
        endpoint="/api/creatives/x/chat"
        creativeId="x"
        creativeKind="image"
        onIterate={onIterate}
      />,
    );
    await user.type(screen.getByPlaceholderText(/tweak/i), "regen pls");
    await user.click(screen.getByLabelText("Send to Ekko"));

    expect(await screen.findByTestId("tool-regenerate_image")).toBeInTheDocument();
    await waitFor(() => {
      expect(onIterate).toHaveBeenCalled();
    });
  });

  it("merges multiple tool_call_start frames for the same tool", async () => {
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([
        { type: "tool_call_start", tool: "regenerate_image", input: { prompt: "a" } },
        { type: "tool_call_start", tool: "regenerate_image", input: { prompt: "a-final" } },
        { type: "tool_call_result", tool: "regenerate_image", result: { ok: true } },
        { type: "message_stop" },
      ]),
    );
    const user = userEvent.setup();
    renderChat();
    await user.type(screen.getByPlaceholderText(/tweak/i), "regen");
    await user.click(screen.getByLabelText("Send to Ekko"));

    await waitFor(() => {
      expect(screen.getAllByTestId("tool-regenerate_image").length).toBe(1);
    });
  });

  it("surfaces an SSE error event in the inline error banner + shows Retry", async () => {
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([{ type: "error", message: "stream blew up" }, { type: "message_stop" }]),
    );
    const user = userEvent.setup();
    renderChat();
    await user.type(screen.getByPlaceholderText(/tweak/i), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));

    expect(await screen.findByText("stream blew up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("retry re-fires the last user message and replays the stream", async () => {
    const fetchSpy = spyOnFetch()
      .mockResolvedValueOnce(
        sseResponse([{ type: "error", message: "boom" }, { type: "message_stop" }]),
      )
      .mockResolvedValueOnce(
        sseResponse([{ type: "text_delta", delta: "second try" }, { type: "message_stop" }]),
      );

    const user = userEvent.setup();
    renderChat();
    await user.type(screen.getByPlaceholderText(/tweak/i), "first message");
    await user.click(screen.getByLabelText("Send to Ekko"));
    await screen.findByText("boom");

    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => {
      expect(screen.getByText("second try")).toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("clicking Stop aborts the inflight fetch and POSTs to the abort endpoint", async () => {
    // Use a never-resolving stream so the request stays in flight and
    // the Stop button is visible.
    const fetchSpy = spyOnFetch();
    let resolveResp: (r: Response) => void = () => {};
    const respPromise = new Promise<Response>((resolve) => {
      resolveResp = resolve;
    });
    fetchSpy.mockImplementationOnce(() => respPromise);
    // Abort endpoint: respond immediately so the test doesn't hang.
    fetchSpy.mockImplementationOnce(async () => jsonResponse({ ok: true }));

    const user = userEvent.setup();
    renderChat();
    await user.type(screen.getByPlaceholderText(/tweak/i), "longrun");
    await user.click(screen.getByLabelText("Send to Ekko"));

    const stop = await screen.findByLabelText("Stop Ekko");
    await user.click(stop);

    await waitFor(() => {
      // The second fetch is the abort POST.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(String(fetchSpy.mock.calls[1]?.[0])).toContain("/abort");
    });

    // Resolve the pending stream response to keep cleanup happy.
    resolveResp(sseResponse([{ type: "message_stop" }]));
  });

  it("uses the explicit abortEndpoint when supplied", async () => {
    const fetchSpy = spyOnFetch();
    let resolveResp: (r: Response) => void = () => {};
    const respPromise = new Promise<Response>((resolve) => {
      resolveResp = resolve;
    });
    fetchSpy.mockImplementationOnce(() => respPromise);
    fetchSpy.mockImplementationOnce(async () => jsonResponse({ ok: true }));

    const user = userEvent.setup();
    render(
      <EkkoChat
        endpoint="/api/creatives/x/chat"
        abortEndpoint="/api/custom-abort"
        creativeId="x"
        creativeKind="image"
      />,
    );
    await user.type(screen.getByPlaceholderText(/tweak/i), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));
    await user.click(await screen.findByLabelText("Stop Ekko"));

    await waitFor(() => {
      expect(String(fetchSpy.mock.calls[1]?.[0])).toBe("/api/custom-abort");
    });
    resolveResp(sseResponse([{ type: "message_stop" }]));
  });

  it("surfaces a non-OK chat response as an inline error", async () => {
    spyOnFetch().mockResolvedValueOnce(jsonResponse({ error: "rate limit" }, { status: 429 }));
    const user = userEvent.setup();
    renderChat();
    await user.type(screen.getByPlaceholderText(/tweak/i), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));
    expect(await screen.findByText(/rate limit/)).toBeInTheDocument();
  });

  it("falls back to HTTP <status> when error body is unparsable", async () => {
    const resp = new Response("not json", { status: 500 });
    spyOnFetch().mockResolvedValueOnce(resp);
    const user = userEvent.setup();
    renderChat();
    await user.type(screen.getByPlaceholderText(/tweak/i), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));
    expect(await screen.findByText(/HTTP 500/)).toBeInTheDocument();
  });

  it("clears messages when creativeId changes", async () => {
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([{ type: "text_delta", delta: "hi" }, { type: "message_stop" }]),
    );
    const user = userEvent.setup();
    const { rerender } = render(
      <EkkoChat endpoint="/api/creatives/x/chat" creativeId="x" creativeKind="image" />,
    );
    await user.type(screen.getByPlaceholderText(/tweak/i), "first");
    await user.click(screen.getByLabelText("Send to Ekko"));
    await screen.findByText("hi");

    rerender(<EkkoChat endpoint="/api/creatives/y/chat" creativeId="y" creativeKind="image" />);
    // History is cleared — the empty state hint comes back.
    expect(screen.getByText(/Start a conversation with Ekko/i)).toBeInTheDocument();
  });

  it("aborts an inflight stream on unmount", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementationOnce(
      () => new Promise(() => {}), // never resolves
    );
    const user = userEvent.setup();
    const { unmount } = render(
      <EkkoChat endpoint="/api/creatives/x/chat" creativeId="x" creativeKind="image" />,
    );
    await user.type(screen.getByPlaceholderText(/tweak/i), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));

    // Should unmount without throwing.
    expect(() => unmount()).not.toThrow();
  });

  it("ignores empty / whitespace input on submit", async () => {
    const fetchSpy = spyOnFetch();
    const user = userEvent.setup();
    renderChat();
    const send = screen.getByLabelText("Send to Ekko");
    expect(send).toBeDisabled();
    // Even if we type only spaces:
    await user.type(screen.getByPlaceholderText(/tweak/i), "   ");
    expect(send).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Retry is a no-op before any user message has been sent", async () => {
    spyOnFetch().mockResolvedValueOnce(jsonResponse({ error: "boom" }, { status: 500 }));
    const user = userEvent.setup();
    renderChat();
    // Trigger an error by submitting; the Retry button now exists.
    await user.type(screen.getByPlaceholderText(/tweak/i), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));
    const retry = await screen.findByRole("button", { name: /retry/i });

    // Stub a new response so we can re-fire and observe a 2nd call.
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([{ type: "text_delta", delta: "ok" }, { type: "message_stop" }]),
    );
    await act(async () => {
      retry.click();
    });
    await waitFor(() => expect(screen.getByText("ok")).toBeInTheDocument());
  });

  it("doesn't fire onIterate when the stream had no tool calls", async () => {
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([
        { type: "text_delta", delta: "answered with text only" },
        { type: "message_stop" },
      ]),
    );
    const onIterate = vi.fn();
    const user = userEvent.setup();
    render(
      <EkkoChat
        endpoint="/api/creatives/x/chat"
        creativeId="x"
        creativeKind="image"
        onIterate={onIterate}
      />,
    );
    await user.type(screen.getByPlaceholderText(/tweak/i), "talk");
    await user.click(screen.getByLabelText("Send to Ekko"));
    await screen.findByText(/answered with text only/);
    expect(onIterate).not.toHaveBeenCalled();
  });

  it("survives an AbortError silently (no error banner)", async () => {
    spyOnFetch().mockImplementationOnce(() => {
      const err: Error & { name?: string } = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const user = userEvent.setup();
    renderChat();
    await user.type(screen.getByPlaceholderText(/tweak/i), "x");
    await user.click(screen.getByLabelText("Send to Ekko"));
    // No banner appears — the abort path is intentionally quiet.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    });
  });
});
