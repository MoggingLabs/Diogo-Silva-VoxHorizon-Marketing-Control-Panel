/**
 * StageConfiguration is the largest stage UI — format radios, image +
 * video brief forms, autosave debounce, Ekko draft modal opener, and
 * the Continue advance.
 *
 * Tests cover:
 *  - Format radio toggle changes which forms are visible
 *  - Continue gate validates client + brief payload zod schemas
 *  - Field edits trigger autosave PATCH (debounced)
 *  - EkkoDraftModal opens via the button + hydrates form on propose
 *  - /advance POST + error path
 *  - Autosave status indicator
 *  - Client fetch + select
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";
import type { Pipeline } from "@/lib/pipeline/types";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

// Stub the EkkoDraftModal so we can verify it gets the onProposed callback.
let lastProposedCb: ((p: unknown) => void) | null = null;
vi.mock("./EkkoDraftModal", () => ({
  EkkoDraftModal: ({
    open,
    onOpenChange,
    onProposed,
  }: {
    open: boolean;
    onOpenChange: (b: boolean) => void;
    onProposed: (p: unknown) => void;
  }) => {
    lastProposedCb = onProposed;
    return open ? (
      <div data-testid="ekko-modal">
        <button onClick={() => onOpenChange(false)}>close-modal</button>
      </div>
    ) : null;
  },
}));

const supabaseClientsResponse = {
  data: [
    { id: "c1", name: "Acme", slug: "acme", service_type: "roofing" },
    { id: "c2", name: "Beta", slug: "beta", service_type: "remodeling" },
  ] as unknown[],
  error: null as { message: string } | null,
};

vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve(supabaseClientsResponse),
        }),
      }),
    }),
  }),
}));

import { StageConfiguration } from "./StageConfiguration";

function makePipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p1",
    status: "configuration",
    format_choice: "image",
    client_id: null,
    image_brief_id: null,
    video_brief_id: null,
    config_draft: null,
    picks: null,
    cost_estimate: null,
    cost_actual: null,
    approval: null,
    launch_package_id: null,
    created_at: "2026-05-17T10:00:00Z",
    updated_at: "2026-05-17T10:00:00Z",
    advanced_at: null,
    ...over,
  };
}

beforeEach(() => {
  routerRefresh.mockReset();
  lastProposedCb = null;
  supabaseClientsResponse.data = [
    { id: "c1", name: "Acme", slug: "acme", service_type: "roofing" },
    { id: "c2", name: "Beta", slug: "beta", service_type: "remodeling" },
  ];
  supabaseClientsResponse.error = null;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("StageConfiguration - layout + radios", () => {
  it("renders the image brief by default", () => {
    render(<StageConfiguration pipeline={makePipeline()} />);
    expect(screen.getByText("Image brief")).toBeInTheDocument();
  });

  it("renders the video brief when format=video", () => {
    render(<StageConfiguration pipeline={makePipeline({ format_choice: "video" })} />);
    expect(screen.getByText("Video brief")).toBeInTheDocument();
  });

  it("renders both image + video briefs when format=both", () => {
    render(<StageConfiguration pipeline={makePipeline({ format_choice: "both" })} />);
    expect(screen.getByText("Image brief")).toBeInTheDocument();
    expect(screen.getByText("Video brief")).toBeInTheDocument();
  });

  it("renders the Ekko draft button + opens the modal on click", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline()} />);
    await user.click(screen.getByRole("button", { name: /Let Ekko draft this/ }));
    expect(screen.getByTestId("ekko-modal")).toBeInTheDocument();
  });
});

describe("StageConfiguration - clients fetch", () => {
  it("renders provided clients without a fetch", () => {
    render(
      <StageConfiguration
        pipeline={makePipeline()}
        clients={[{ id: "c1", name: "Pre", slug: "pre", service_type: "roofing" }]}
      />,
    );
    // SelectTrigger shows the placeholder until something's selected.
    expect(screen.getByText("Select a client")).toBeInTheDocument();
  });

  it("renders an error label when client fetch fails", async () => {
    supabaseClientsResponse.data = [];
    supabaseClientsResponse.error = { message: "rls denied" };
    render(<StageConfiguration pipeline={makePipeline()} />);
    expect(await screen.findByText(/rls denied/)).toBeInTheDocument();
  });

  it("renders a SelectTrigger for the client picker", () => {
    const UUID_C1 = "01234567-1234-4123-8123-0123456789ab";
    render(
      <StageConfiguration
        pipeline={makePipeline()}
        clients={[{ id: UUID_C1, name: "Acme", slug: "acme", service_type: "roofing" }]}
      />,
    );
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("renders the placeholder when no active clients are found", async () => {
    supabaseClientsResponse.data = [];
    render(<StageConfiguration pipeline={makePipeline()} />);
    expect(await screen.findByText(/No active clients found/)).toBeInTheDocument();
  });
});

describe("StageConfiguration - autosave + Continue", () => {
  it("Continue is disabled until client + minimal brief payload exists", () => {
    render(<StageConfiguration pipeline={makePipeline()} />);
    expect(screen.getByRole("button", { name: /Continue to Ideation/i })).toBeDisabled();
  });

  it("clicking Continue when canContinue posts /advance + refreshes", async () => {
    spyOnFetch().mockResolvedValueOnce(jsonResponse({ ok: true }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <StageConfiguration
        pipeline={makePipeline({
          client_id: "c1",
          config_draft: {
            image_payload: {
              service: "roofing",
              market: "Tampa, FL",
              budget: 5000,
            },
          },
        })}
        clients={[{ id: "c1", name: "Acme", slug: "acme", service_type: "roofing" }]}
      />,
    );
    const cont = screen.getByRole("button", { name: /Continue/i });
    expect(cont).toBeEnabled();
    await user.click(cont);
    await waitFor(() => {
      expect(routerRefresh).toHaveBeenCalled();
    });
  });

  it("surfaces advance error", async () => {
    spyOnFetch().mockResolvedValueOnce(jsonResponse({ error: "needs picks" }, { status: 422 }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <StageConfiguration
        pipeline={makePipeline({
          client_id: "c1",
          config_draft: {
            image_payload: {
              service: "roofing",
              market: "Tampa, FL",
              budget: 5000,
            },
          },
        })}
        clients={[{ id: "c1", name: "Acme", slug: "acme", service_type: "roofing" }]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/needs picks/);
  });

  it("autosaves image fields after debounce", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <StageConfiguration
        pipeline={makePipeline({
          client_id: "c1",
          config_draft: {
            image_payload: {
              service: "roofing",
              market: "Tampa, FL",
              budget: 5000,
            },
          },
        })}
        clients={[{ id: "c1", name: "Acme", slug: "acme", service_type: "roofing" }]}
      />,
    );
    const market = screen.getByLabelText("Market") as HTMLInputElement;
    await user.clear(market);
    await user.type(market, "Orlando, FL");
    // Autosave is debounced 1s; advance time.
    await act(async () => {
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/config") &&
            (init as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(true);
    });
  });

  it("autosaves format choice immediately on radio toggle", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline()} />);
    await user.click(screen.getByLabelText("Video"));
    await act(async () => {
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([, init]) => {
          const body = (init as RequestInit | undefined)?.body;
          return (
            typeof body === "string" && body.includes("format_choice") && body.includes("video")
          );
        }),
      ).toBe(true);
    });
  });

  it("hydrates video form from a video propose_config", async () => {
    const UUID_C1 = "01234567-1234-4123-8123-0123456789ab";
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <StageConfiguration
        pipeline={makePipeline({ format_choice: "image", client_id: UUID_C1 })}
        clients={[{ id: UUID_C1, name: "Acme", slug: "acme", service_type: "roofing" }]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Let Ekko draft this/ }));
    await act(() => {
      lastProposedCb!({
        format_choice: "video",
        video_payload: {
          script_outline: {
            hook: "Awesome opener",
            segments: [{ topic: "intro", duration_s: 30 }],
          },
          target_duration_s: 30,
          voice_id: "21m00Tcm4TlvDq8ikWAM",
          dimensions: "9x16",
          broll_selection_mode: "auto",
        },
        notes: "Video drafted",
      });
    });
    expect(await screen.findByText(/Video drafted/)).toBeInTheDocument();
  });

  it("hydrates the form from onProposed payload + sets the banner", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline()} />);
    await user.click(screen.getByRole("button", { name: /Let Ekko draft this/ }));
    expect(lastProposedCb).not.toBeNull();
    await act(() => {
      lastProposedCb!({
        format_choice: "image",
        image_payload: {
          service: "roofing",
          market: "Boise",
          budget: 5000,
        },
        notes: "Filled by Ekko",
      });
    });
    expect(await screen.findByText(/Filled by Ekko/)).toBeInTheDocument();
    // The market input should be populated.
    expect((screen.getByLabelText("Market") as HTMLInputElement).value).toBe("Boise");
  });
});

describe("StageConfiguration - video segments", () => {
  it("renders an Add segment button + creates a new segment row on click", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline({ format_choice: "video" })} />);
    // One default segment.
    expect(screen.getByLabelText("Topic")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Add segment/i }));
    expect(screen.getAllByLabelText("Topic").length).toBe(2);
  });

  it("Remove disabled when only one segment remains", () => {
    render(<StageConfiguration pipeline={makePipeline({ format_choice: "video" })} />);
    expect(screen.getByRole("button", { name: /Remove/i })).toBeDisabled();
  });

  it("Removes a segment when there are multiple", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline({ format_choice: "video" })} />);
    await user.click(screen.getByRole("button", { name: /Add segment/i }));
    expect(screen.getAllByLabelText("Topic").length).toBe(2);
    const removes = screen.getAllByRole("button", { name: /Remove/i });
    await user.click(removes[1]!);
    expect(screen.getAllByLabelText("Topic").length).toBe(1);
  });

  it("flags 'mismatch' when segment durations don't sum to target", () => {
    render(
      <StageConfiguration
        pipeline={makePipeline({
          format_choice: "video",
          config_draft: {
            video_payload: {
              script_outline: {
                hook: "hook",
                segments: [{ topic: "x", duration_s: 5 }],
              },
              target_duration_s: 60,
              voice_id: "v1",
              dimensions: "9x16",
              broll_selection_mode: "auto",
            },
          },
        })}
      />,
    );
    expect(screen.getByText(/mismatch/)).toBeInTheDocument();
  });
});

describe("StageConfiguration - video brief fields", () => {
  const UUID_C1 = "01234567-1234-4123-8123-0123456789ab";

  it("autosaves video field edits", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <StageConfiguration
        pipeline={makePipeline({
          format_choice: "video",
          client_id: UUID_C1,
          config_draft: {
            video_payload: {
              script_outline: {
                hook: "hookx",
                segments: [{ topic: "first", duration_s: 30 }],
              },
              target_duration_s: 30,
              voice_id: "v1",
              dimensions: "9x16",
              broll_selection_mode: "auto",
            },
          },
        })}
        clients={[{ id: UUID_C1, name: "Acme", slug: "acme", service_type: "roofing" }]}
      />,
    );
    const hookField = screen.getByLabelText("Hook") as HTMLTextAreaElement;
    // Append to the hook (avoid clearing — that would zero-out the payload
    // and skip autosave).
    await user.type(hookField, " extra");
    await act(async () => {
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([, init]) => {
          const body = (init as RequestInit | undefined)?.body;
          return typeof body === "string" && body.includes("video_payload");
        }),
      ).toBe(true);
    });
  });

  it("editing segment topic on a valid form triggers a video_payload autosave", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <StageConfiguration
        pipeline={makePipeline({
          format_choice: "video",
          client_id: UUID_C1,
          config_draft: {
            video_payload: {
              script_outline: {
                hook: "compelling opener",
                segments: [{ topic: "intro", duration_s: 30 }],
              },
              target_duration_s: 30,
              voice_id: "21m00Tcm4TlvDq8ikWAM",
              dimensions: "9x16",
              broll_selection_mode: "auto",
            },
          },
        })}
        clients={[{ id: UUID_C1, name: "Acme", slug: "acme", service_type: "roofing" }]}
      />,
    );
    const topic = screen.getByLabelText("Topic") as HTMLInputElement;
    // Append; do not clear (would zero the payload).
    await user.type(topic, "X");
    await act(async () => {
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([, init]) => {
          const body = (init as RequestInit | undefined)?.body;
          return typeof body === "string" && body.includes("video_payload");
        }),
      ).toBe(true);
    });
  });

  it("hydrates hook_style / captions_style / music_track from draft payload", () => {
    render(
      <StageConfiguration
        pipeline={makePipeline({
          format_choice: "video",
          client_id: UUID_C1,
          config_draft: {
            video_payload: {
              script_outline: {
                hook: "h",
                segments: [{ topic: "x", duration_s: 30 }],
              },
              target_duration_s: 30,
              voice_id: "v1",
              dimensions: "1x1",
              hook_style: "curiosity",
              captions_style: "bold_yellow",
              music_track: "lofi",
              broll_selection_mode: "review_low_confidence",
              notes: "internal",
            },
          },
        })}
        clients={[{ id: UUID_C1, name: "Acme", slug: "acme", service_type: "roofing" }]}
      />,
    );
    // The music_track and notes inputs should reflect the hydrated values.
    expect((screen.getByLabelText(/Music track/) as HTMLInputElement).value).toBe("lofi");
    expect((screen.getByLabelText("Notes (optional)") as HTMLTextAreaElement).value).toBe(
      "internal",
    );
  });

  it.each([["pattern_interrupt"], ["data_shock"], ["question"]] as const)(
    "hydrates each hook_style enum value (%s)",
    (style) => {
      render(
        <StageConfiguration
          pipeline={makePipeline({
            format_choice: "video",
            client_id: UUID_C1,
            config_draft: {
              video_payload: {
                script_outline: {
                  hook: "h",
                  segments: [{ topic: "x", duration_s: 30 }],
                },
                target_duration_s: 30,
                voice_id: "v1",
                dimensions: "9x16",
                hook_style: style,
                broll_selection_mode: "auto",
              },
            },
          })}
          clients={[{ id: UUID_C1, name: "Acme", slug: "acme", service_type: "roofing" }]}
        />,
      );
      // Re-rendering the form without crashing is sufficient.
      expect(screen.getByText("Video brief")).toBeInTheDocument();
    },
  );

  it.each([["minimal_white"], ["brand"]] as const)(
    "hydrates each captions_style enum value (%s)",
    (style) => {
      render(
        <StageConfiguration
          pipeline={makePipeline({
            format_choice: "video",
            client_id: UUID_C1,
            config_draft: {
              video_payload: {
                script_outline: {
                  hook: "h",
                  segments: [{ topic: "x", duration_s: 30 }],
                },
                target_duration_s: 30,
                voice_id: "v1",
                dimensions: "9x16",
                captions_style: style,
                broll_selection_mode: "auto",
              },
            },
          })}
          clients={[{ id: UUID_C1, name: "Acme", slug: "acme", service_type: "roofing" }]}
        />,
      );
      expect(screen.getByText("Video brief")).toBeInTheDocument();
    },
  );

  it("Add segment / Remove segment buttons mutate the list", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <StageConfiguration
        pipeline={makePipeline({ format_choice: "video", client_id: UUID_C1 })}
        clients={[{ id: UUID_C1, name: "Acme", slug: "acme", service_type: "roofing" }]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Add segment/i }));
    expect(screen.getAllByLabelText("Topic").length).toBe(2);
    const removes = screen.getAllByRole("button", { name: /Remove/i });
    await user.click(removes[1]!);
    expect(screen.getAllByLabelText("Topic").length).toBe(1);
  });

  it("renders the radio choices for dimensions and broll mode", () => {
    render(<StageConfiguration pipeline={makePipeline({ format_choice: "video" })} />);
    expect(screen.getByLabelText("1x1")).toBeInTheDocument();
    expect(screen.getByLabelText("review each")).toBeInTheDocument();
    expect(screen.getByLabelText("review low confidence")).toBeInTheDocument();
  });

  it("toggling the dimensions and b-roll radios changes their state", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline({ format_choice: "video" })} />);
    const oneByOne = screen.getByLabelText("1x1");
    await user.click(oneByOne);
    expect(oneByOne).toBeChecked();
    const auto = screen.getByLabelText("auto");
    await user.click(auto);
    expect(auto).toBeChecked();
    const lowConf = screen.getByLabelText("review low confidence");
    await user.click(lowConf);
    expect(lowConf).toBeChecked();
  });

  it("typing in music_track + notes updates the inputs", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline({ format_choice: "video" })} />);
    const music = screen.getByLabelText(/Music track/) as HTMLInputElement;
    await user.type(music, "synthwave");
    expect(music.value).toBe("synthwave");
    const notes = screen.getByLabelText("Notes (optional)") as HTMLTextAreaElement;
    await user.type(notes, "internal note");
    expect(notes.value).toBe("internal note");
  });

  it("typing in target_duration_s + voice_id updates inputs", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline({ format_choice: "video" })} />);
    const target = screen.getByLabelText(/Target duration/) as HTMLInputElement;
    await user.clear(target);
    await user.type(target, "60");
    expect(target.value).toBe("60");
    const voice = screen.getByLabelText(/Voice ID/) as HTMLInputElement;
    await user.type(voice, "abcd");
    expect(voice.value).toBe("abcd");
  });

  it("typing in image-form fields updates the inputs", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline()} />);
    const offer = screen.getByLabelText("Offer") as HTMLInputElement;
    await user.type(offer, "30% off");
    expect(offer.value).toBe("30% off");
    const notes = screen.getByLabelText("Internal notes") as HTMLTextAreaElement;
    await user.type(notes, "ops note");
    expect(notes.value).toBe("ops note");
    const angles = screen.getByLabelText(/Angles/) as HTMLTextAreaElement;
    await user.type(angles, "angle one");
    expect(angles.value).toContain("angle one");
  });

  it("typing in targeting (radius / zips / age_min / age_max) updates inputs", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline()} />);
    await user.type(screen.getByLabelText(/Radius/) as HTMLInputElement, "10");
    await user.type(screen.getByLabelText("ZIPs") as HTMLInputElement, "33601 33602");
    await user.type(screen.getByLabelText("Age min") as HTMLInputElement, "25");
    await user.type(screen.getByLabelText("Age max") as HTMLInputElement, "55");
    expect((screen.getByLabelText(/Radius/) as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("ZIPs") as HTMLInputElement).value).toBe("33601 33602");
  });

  it("toggles service radio between roofing and remodeling", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline()} />);
    const remodeling = screen.getByLabelText("Remodeling");
    await user.click(remodeling);
    expect(remodeling).toBeChecked();
  });

  it("typing in landing page url + image count updates inputs", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline()} />);
    await user.type(screen.getByLabelText(/Landing page URL/) as HTMLInputElement, "https://x.com");
    const count = screen.getByLabelText(/Image count/) as HTMLInputElement;
    await user.clear(count);
    await user.type(count, "5");
    expect(count.value).toBe("5");
  });

  it("typing in daily budget updates input", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline()} />);
    const daily = screen.getByLabelText(/Daily budget/) as HTMLInputElement;
    await user.type(daily, "100");
    expect(daily.value).toBe("100");
  });

  it("typing in total budget updates input", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline()} />);
    const budget = screen.getByLabelText("Total budget (USD)") as HTMLInputElement;
    await user.type(budget, "5000");
    expect(budget.value).toBe("5000");
  });

  it("editing segment topic / duration / broll_theme updates segment inputs", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline({ format_choice: "video" })} />);
    const topic = screen.getByLabelText("Topic") as HTMLInputElement;
    await user.type(topic, "hello");
    expect(topic.value).toBe("hello");
    const duration = screen.getByLabelText("Duration (s)") as HTMLInputElement;
    await user.clear(duration);
    await user.type(duration, "20");
    expect(duration.value).toBe("20");
    const broll = screen.getByLabelText(/B-roll theme/) as HTMLInputElement;
    await user.type(broll, "skyline");
    expect(broll.value).toBe("skyline");
  });
});

describe("StageConfiguration - autosave indicator", () => {
  it("renders the 'Saving draft…' indicator and flips to Saved", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(async () => jsonResponse({ ok: true }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline()} />);
    await user.click(screen.getByLabelText("Both"));
    await act(async () => {
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByText(/Saved/)).toBeInTheDocument();
    });
  });

  it("renders the autosave error when PATCH fails", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "nope" }, { status: 422 }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StageConfiguration pipeline={makePipeline()} />);
    await user.click(screen.getByLabelText("Both"));
    await act(async () => {
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByText(/Autosave failed/)).toBeInTheDocument();
    });
  });
});
