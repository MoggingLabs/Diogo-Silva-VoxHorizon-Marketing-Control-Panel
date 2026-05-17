/**
 * EkkoDraftModal runs a streamed brief-strategist interview with Ekko
 * and forwards a `propose_config` tool_call_result to the parent.
 *
 * Tests cover:
 *  - Modal seed message on open
 *  - Submit → SSE stream parses text + tool_call_result
 *  - propose_config result forwarded via onProposed
 *  - Stop button aborts mid-stream
 *  - Error path surfaces inline
 *  - propose_config shape coercion (rejects malformed payloads)
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, sseResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";

import { EkkoDraftModal } from "./EkkoDraftModal";

beforeEach(() => {
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
    cb(performance.now());
    return 1 as unknown as number;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EkkoDraftModal", () => {
  function renderModal(extra: Partial<React.ComponentProps<typeof EkkoDraftModal>> = {}) {
    return render(
      <EkkoDraftModal
        pipelineId="p1"
        open
        onOpenChange={() => {}}
        onProposed={() => {}}
        {...extra}
      />,
    );
  }

  it("renders nothing when open is false", () => {
    render(
      <EkkoDraftModal pipelineId="p1" open={false} onOpenChange={() => {}} onProposed={() => {}} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("seeds the transcript with Ekko's opening prompt on open", () => {
    renderModal();
    expect(screen.getByText(/Hi — I'm Ekko/)).toBeInTheDocument();
  });

  it("disables Send when input is empty", () => {
    renderModal();
    expect(screen.getByLabelText("Send to Ekko")).toBeDisabled();
  });

  it("submits a user message and streams text + propose_config", async () => {
    const proposed = vi.fn();
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([
        { type: "text_delta", delta: "Got it. Here's a draft" },
        {
          type: "tool_call_result",
          tool: "propose_config",
          result: {
            format_choice: "image",
            image_payload: { market: "Tampa", budget: 1000, service: "roofing" },
            notes: "Sketched it.",
          },
        },
        { type: "message_stop" },
      ]),
    );
    const user = userEvent.setup();
    renderModal({ onProposed: proposed });
    await user.type(screen.getByPlaceholderText(/Type your answer/), "roofing in Tampa");
    await user.click(screen.getByLabelText("Send to Ekko"));

    await waitFor(() => {
      expect(proposed).toHaveBeenCalledWith(
        expect.objectContaining({ format_choice: "image", notes: "Sketched it." }),
      );
    });
    expect(await screen.findByText(/Draft delivered/)).toBeInTheDocument();
  });

  it("does NOT call onProposed when the result is malformed", async () => {
    const proposed = vi.fn();
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([
        {
          type: "tool_call_result",
          tool: "propose_config",
          result: { format_choice: "garbage" },
        },
        { type: "message_stop" },
      ]),
    );
    const user = userEvent.setup();
    renderModal({ onProposed: proposed });
    await user.type(screen.getByPlaceholderText(/Type your answer/), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));

    await waitFor(() => {
      // The stream completed; onProposed must NOT have been called.
      expect(proposed).not.toHaveBeenCalled();
    });
  });

  it("forwards a video format_choice when proposed", async () => {
    const proposed = vi.fn();
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([
        {
          type: "tool_call_result",
          tool: "propose_config",
          result: { format_choice: "video", video_payload: {} },
        },
        { type: "message_stop" },
      ]),
    );
    const user = userEvent.setup();
    renderModal({ onProposed: proposed });
    await user.type(screen.getByPlaceholderText(/Type your answer/), "video");
    await user.click(screen.getByLabelText("Send to Ekko"));
    await waitFor(() => {
      expect(proposed).toHaveBeenCalledWith(expect.objectContaining({ format_choice: "video" }));
    });
  });

  it("renders the Stop button while streaming and stops on click", async () => {
    const fetchSpy = spyOnFetch();
    let resolveResp: (r: Response) => void = () => {};
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolveResp = r;
        }),
    );
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByPlaceholderText(/Type your answer/), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));

    const stop = await screen.findByLabelText("Stop Ekko");
    await user.click(stop);
    // Close out the request so cleanup runs.
    resolveResp(sseResponse([{ type: "message_stop" }]));
  });

  it("surfaces a non-OK chat response as an inline error", async () => {
    spyOnFetch().mockResolvedValueOnce(jsonResponse({ error: "rate limit" }, { status: 429 }));
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByPlaceholderText(/Type your answer/), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/rate limit/);
  });

  it("falls back to HTTP <status> when error body is unparsable", async () => {
    spyOnFetch().mockResolvedValueOnce(new Response("not json", { status: 500 }));
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByPlaceholderText(/Type your answer/), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/HTTP 500/);
  });

  it("renders a tool-call line for unknown tools", async () => {
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([
        { type: "tool_call_start", tool: "search_clip", input: { theme: "x" } },
        { type: "tool_call_result", tool: "search_clip", result: { clips: [] } },
        { type: "message_stop" },
      ]),
    );
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByPlaceholderText(/Type your answer/), "search");
    await user.click(screen.getByLabelText("Send to Ekko"));
    expect(await screen.findByText(/Tool: search_clip/)).toBeInTheDocument();
  });

  it("renders a 'Drafted a … brief' line for propose_config", async () => {
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([
        {
          type: "tool_call_result",
          tool: "propose_config",
          result: { format_choice: "both" },
        },
        { type: "message_stop" },
      ]),
    );
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByPlaceholderText(/Type your answer/), "both");
    await user.click(screen.getByLabelText("Send to Ekko"));
    expect(await screen.findByText(/Drafted a both brief/)).toBeInTheDocument();
  });

  it("Enter submits without Shift", async () => {
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([{ type: "text_delta", delta: "ack" }, { type: "message_stop" }]),
    );
    const user = userEvent.setup();
    renderModal();
    const textarea = screen.getByPlaceholderText(/Type your answer/);
    await user.type(textarea, "hi");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("hi")).toBeInTheDocument();
  });

  it("Shift+Enter inserts a newline instead of submitting", async () => {
    const fetchSpy = spyOnFetch();
    const user = userEvent.setup();
    renderModal();
    const textarea = screen.getByPlaceholderText(/Type your answer/) as HTMLTextAreaElement;
    await user.type(textarea, "line1");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(textarea.value).toContain("\n");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("closes the dialog when the operator clicks Cancel", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    renderModal({ onOpenChange: onOpen });
    await user.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onOpen).toHaveBeenCalledWith(false);
  });

  it("button label flips to 'Review draft' after propose", async () => {
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([
        {
          type: "tool_call_result",
          tool: "propose_config",
          result: { format_choice: "image", image_payload: {} },
        },
        { type: "message_stop" },
      ]),
    );
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByPlaceholderText(/Type your answer/), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));
    expect(await screen.findByRole("button", { name: /Review draft/i })).toBeInTheDocument();
  });

  it("survives an AbortError silently (no error banner)", async () => {
    spyOnFetch().mockImplementationOnce(() => {
      const err: Error & { name?: string } = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByPlaceholderText(/Type your answer/), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("synthesises a tool_call_result line when no start frame arrived", async () => {
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([
        {
          type: "tool_call_result",
          tool: "synthesised_tool",
          result: { ok: true },
        },
        { type: "message_stop" },
      ]),
    );
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByPlaceholderText(/Type your answer/), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));
    expect(await screen.findByText(/Tool: synthesised_tool/)).toBeInTheDocument();
  });

  it("ignores SSE error chunks without crashing the modal", async () => {
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([{ type: "error", message: "stream blew up" }, { type: "message_stop" }]),
    );
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByPlaceholderText(/Type your answer/), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/stream blew up/);
  });

  it("aborts when the modal is closed mid-stream", async () => {
    const fetchSpy = spyOnFetch();
    let resolveResp: (r: Response) => void = () => {};
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolveResp = r;
        }),
    );
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <EkkoDraftModal pipelineId="p1" open onOpenChange={onOpenChange} onProposed={() => {}} />,
    );
    await user.type(screen.getByPlaceholderText(/Type your answer/), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));
    rerender(
      <EkkoDraftModal
        pipelineId="p1"
        open={false}
        onOpenChange={onOpenChange}
        onProposed={() => {}}
      />,
    );
    // Resolve the dangling promise so the cleanup finally clause runs.
    act(() => resolveResp(sseResponse([{ type: "message_stop" }])));
  });

  it("merges duplicate tool_call_start frames for the same tool", async () => {
    spyOnFetch().mockResolvedValueOnce(
      sseResponse([
        { type: "tool_call_start", tool: "propose_config", input: { format_choice: "image" } },
        { type: "tool_call_start", tool: "propose_config", input: { format_choice: "video" } },
        {
          type: "tool_call_result",
          tool: "propose_config",
          result: { format_choice: "video" },
        },
        { type: "message_stop" },
      ]),
    );
    const onProposed = vi.fn();
    const user = userEvent.setup();
    renderModal({ onProposed });
    await user.type(screen.getByPlaceholderText(/Type your answer/), "go");
    await user.click(screen.getByLabelText("Send to Ekko"));
    await waitFor(() => expect(onProposed).toHaveBeenCalled());
  });
});
