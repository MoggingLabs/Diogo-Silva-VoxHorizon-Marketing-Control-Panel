"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { EkkoDraftModal, type ProposedConfig } from "./EkkoDraftModal";
import { OperatorBriefReview } from "./OperatorBriefReview";
import { StageShell } from "./StageShell";
import { BriefPayload, type BriefPayloadT } from "@/lib/briefs";
import { activeTracksLocal } from "@/lib/pipeline/transitions";
import type { Pipeline, PipelineFormat } from "@/lib/pipeline/types";
import { fetchClients } from "@/lib/realtime/client-data";
import { cn } from "@/lib/utils";
import { Ratio, VideoBriefInput, type VideoBriefInputT } from "@/lib/video-briefs";

/**
 * Configuration-stage UI (PF-B-1).
 *
 * Renders:
 *   - A format radio (Image / Video / Both) — drives which brief form is shown.
 *   - The matching brief form(s): an inline ImageBriefFields when the image
 *     track is active, an inline VideoBriefFields when the video track is.
 *     For format='both' the two forms render side-by-side at `lg`+ and stack
 *     vertically below.
 *   - A "Let Ekko draft this" trigger at the top that opens
 *     `<EkkoDraftModal />`. On a successful tool call we hydrate the form
 *     state and surface a banner so the operator knows the values were
 *     AI-proposed and should be reviewed.
 *
 * State management:
 *   The Continue gate runs the canonical zod schemas (BriefPayload /
 *   VideoBriefInput) against the current form state; if either active
 *   track fails, Continue is disabled. The forms keep their own *form*
 *   state (mostly strings, because that's what `<input>` emits) and
 *   `toImagePayload` / `toVideoPayload` round-trip into the typed
 *   payloads before save / advance.
 *
 * Autosave:
 *   A 1s debounce wraps every field change. On debounce, we PATCH
 *   `/api/pipelines/[id]/config` with the changed payload(s). The PATCH
 *   route merges into `pipelines.config_draft` jsonb so successive
 *   autosaves don't obliterate each other. The status guard on the route
 *   protects against late autosaves after the operator advances.
 */
export type StageConfigurationProps = {
  pipeline: Pipeline;
  /** Optional client list — server-fetched. Falls back to a browser query when omitted. */
  clients?: ClientOption[];
};

export type ClientOption = {
  id: string;
  name: string;
  slug: string;
  service_type: "roofing" | "remodeling";
};

// Stringy form-state shape — matches BriefForm's convention (HTML inputs
// always emit strings; we round-trip into the typed payload on submit).
type ImageFormValues = {
  service: "roofing" | "remodeling";
  market: string;
  budget: string;
  budget_daily: string;
  landing_page_url: string;
  image_count: string;
  radius_km: string;
  zips: string;
  age_min: string;
  age_max: string;
  angles: string;
  offer_text: string;
  notes: string;
};

const IMAGE_DEFAULTS: ImageFormValues = {
  service: "roofing",
  market: "",
  budget: "",
  budget_daily: "",
  landing_page_url: "",
  image_count: "3",
  radius_km: "",
  zips: "",
  age_min: "",
  age_max: "",
  angles: "",
  offer_text: "",
  notes: "",
};

type VideoSegmentFV = {
  topic: string;
  duration_s: string;
  broll_theme: string;
};

type VideoFormValues = {
  hook: string;
  segments: VideoSegmentFV[];
  target_duration_s: string;
  voice_id: string;
  music_track: string;
  hook_style: "" | "curiosity" | "pattern_interrupt" | "data_shock" | "question";
  dimensions: "1x1" | "9x16" | "16x9";
  captions_style: "" | "bold_yellow" | "minimal_white" | "brand";
  broll_selection_mode: "auto" | "review_each" | "review_low_confidence";
  notes: string;
};

const VIDEO_DEFAULTS: VideoFormValues = {
  hook: "",
  segments: [{ topic: "", duration_s: "15", broll_theme: "" }],
  target_duration_s: "30",
  voice_id: "",
  music_track: "",
  hook_style: "",
  dimensions: "9x16",
  captions_style: "",
  broll_selection_mode: "review_each",
  notes: "",
};

const RATIO_OPTIONS = Ratio.options;

/**
 * Whether this pipeline is operator-driven. Mirrors `isOperatorDriven` in
 * `lib/operator/dispatch.ts`, re-implemented here because that module is
 * `server-only` and this is a client component. Kept in sync deliberately:
 * `config_draft.operator_driven === true` is the canonical marker, with a
 * stored `operator_instruction` as the legacy fallback for rows created before
 * the explicit flag existed.
 */
function isOperatorDrivenDraft(configDraft: Record<string, unknown> | null): boolean {
  if (!configDraft) return false;
  if (configDraft.operator_driven === true) return true;
  return (
    typeof configDraft.operator_instruction === "string" &&
    configDraft.operator_instruction.trim().length > 0
  );
}

// ---------------------------------------------------------------------------
// Form-state <-> payload codecs
// ---------------------------------------------------------------------------

function toImagePayload(v: ImageFormValues): BriefPayloadT | null {
  if (!v.market.trim() || !v.budget) return null;
  const budget = Number(v.budget);
  if (Number.isNaN(budget) || budget <= 0) return null;
  const angles = v.angles
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const zips = v.zips
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const targeting: NonNullable<BriefPayloadT["targeting"]> = {};
  if (v.radius_km) targeting.radius_km = Number(v.radius_km);
  if (zips.length > 0) targeting.zips = zips;
  if (v.age_min) targeting.age_min = Number(v.age_min);
  if (v.age_max) targeting.age_max = Number(v.age_max);
  const hasTargeting = Object.keys(targeting).length > 0;

  const payload: BriefPayloadT = {
    service: v.service,
    market: v.market.trim(),
    budget,
  };
  if (v.budget_daily) payload.budget_daily = Number(v.budget_daily);
  if (v.landing_page_url.trim()) payload.landing_page_url = v.landing_page_url.trim();
  if (v.image_count) {
    payload.creative_plan = { image_count: Number(v.image_count) || 3 };
  }
  if (angles.length > 0) payload.angles = angles;
  if (v.offer_text.trim()) payload.offer_text = v.offer_text.trim();
  if (v.notes.trim()) payload.notes = v.notes.trim();
  if (hasTargeting) payload.targeting = targeting;
  return payload;
}

function fromImagePayload(raw: unknown): Partial<ImageFormValues> {
  if (!raw || typeof raw !== "object") return {};
  const p = raw as Record<string, unknown>;
  const out: Partial<ImageFormValues> = {};
  if (p.service === "roofing" || p.service === "remodeling") out.service = p.service;
  if (typeof p.market === "string") out.market = p.market;
  if (typeof p.budget === "number") out.budget = String(p.budget);
  if (typeof p.budget_daily === "number") out.budget_daily = String(p.budget_daily);
  if (typeof p.landing_page_url === "string") out.landing_page_url = p.landing_page_url;
  const cp = p.creative_plan as { image_count?: number } | undefined;
  if (cp?.image_count !== undefined) out.image_count = String(cp.image_count);
  const t = p.targeting as Record<string, unknown> | undefined;
  if (t) {
    if (typeof t.radius_km === "number") out.radius_km = String(t.radius_km);
    if (Array.isArray(t.zips)) out.zips = t.zips.join(" ");
    if (typeof t.age_min === "number") out.age_min = String(t.age_min);
    if (typeof t.age_max === "number") out.age_max = String(t.age_max);
  }
  if (Array.isArray(p.angles)) out.angles = (p.angles as string[]).join("\n");
  if (typeof p.offer_text === "string") out.offer_text = p.offer_text;
  if (typeof p.notes === "string") out.notes = p.notes;
  return out;
}

function toVideoPayload(v: VideoFormValues, clientId: string | null): VideoBriefInputT | null {
  if (!clientId) return null;
  if (!v.hook.trim() || v.segments.length === 0) return null;
  const segments = v.segments
    .filter((s) => s.topic.trim())
    .map((s) => ({
      topic: s.topic.trim(),
      duration_s: Number(s.duration_s),
      broll_theme: s.broll_theme.trim() || undefined,
    }));
  if (segments.length === 0) return null;
  if (segments.some((s) => Number.isNaN(s.duration_s) || s.duration_s <= 0)) return null;
  const target = Number(v.target_duration_s);
  if (Number.isNaN(target) || target <= 0) return null;
  if (!v.voice_id.trim()) return null;
  return {
    client_id: clientId,
    script_outline: { hook: v.hook.trim(), segments },
    target_duration_s: target,
    voice_id: v.voice_id.trim(),
    music_track: v.music_track.trim() || undefined,
    hook_style: v.hook_style || undefined,
    dimensions: v.dimensions,
    captions_style: v.captions_style || undefined,
    broll_selection_mode: v.broll_selection_mode,
    notes: v.notes.trim() || undefined,
  };
}

function fromVideoPayload(raw: unknown): Partial<VideoFormValues> {
  if (!raw || typeof raw !== "object") return {};
  const p = raw as Record<string, unknown>;
  const out: Partial<VideoFormValues> = {};
  const so = p.script_outline as Record<string, unknown> | undefined;
  if (so) {
    if (typeof so.hook === "string") out.hook = so.hook;
    if (Array.isArray(so.segments)) {
      out.segments = (so.segments as Record<string, unknown>[]).map((s) => ({
        topic: typeof s.topic === "string" ? s.topic : "",
        duration_s: typeof s.duration_s === "number" ? String(s.duration_s) : "15",
        broll_theme: typeof s.broll_theme === "string" ? s.broll_theme : "",
      }));
    }
  }
  if (typeof p.target_duration_s === "number") {
    out.target_duration_s = String(p.target_duration_s);
  }
  if (typeof p.voice_id === "string") out.voice_id = p.voice_id;
  if (typeof p.music_track === "string") out.music_track = p.music_track;
  if (
    p.hook_style === "curiosity" ||
    p.hook_style === "pattern_interrupt" ||
    p.hook_style === "data_shock" ||
    p.hook_style === "question"
  ) {
    out.hook_style = p.hook_style;
  }
  if (p.dimensions === "1x1" || p.dimensions === "9x16" || p.dimensions === "16x9") {
    out.dimensions = p.dimensions;
  }
  if (
    p.captions_style === "bold_yellow" ||
    p.captions_style === "minimal_white" ||
    p.captions_style === "brand"
  ) {
    out.captions_style = p.captions_style;
  }
  if (
    p.broll_selection_mode === "auto" ||
    p.broll_selection_mode === "review_each" ||
    p.broll_selection_mode === "review_low_confidence"
  ) {
    out.broll_selection_mode = p.broll_selection_mode;
  }
  if (typeof p.notes === "string") out.notes = p.notes;
  return out;
}

// ---------------------------------------------------------------------------
// Autosave hook
// ---------------------------------------------------------------------------

/**
 * Generic 1-second debounced autosave. The hook owns its own AbortController
 * so a rapid edit cancels the still-inflight previous PATCH — the latest
 * payload always wins.
 */
function useAutosave(pipelineId: string) {
  const inflightRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      inflightRef.current?.abort();
    };
  }, []);

  const flush = useCallback(
    async (patch: Record<string, unknown>, { immediate }: { immediate?: boolean } = {}) => {
      const run = async () => {
        if (Object.keys(patch).length === 0) return;
        inflightRef.current?.abort();
        const controller = new AbortController();
        inflightRef.current = controller;
        setStatus("saving");
        setError(null);
        try {
          const res = await fetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
            signal: controller.signal,
            cache: "no-store",
          });
          if (!res.ok) {
            let detail = "";
            try {
              const body = (await res.json()) as { error?: string };
              detail = body.error ?? "";
            } catch {
              /* ignore */
            }
            throw new Error(detail || `autosave failed (${res.status})`);
          }
          setStatus("saved");
        } catch (e) {
          if ((e as { name?: string }).name === "AbortError") return;
          setStatus("error");
          setError(e instanceof Error ? e.message : String(e));
        }
      };
      if (timerRef.current) clearTimeout(timerRef.current);
      if (immediate) {
        await run();
      } else {
        timerRef.current = setTimeout(() => void run(), 1000);
      }
    },
    [pipelineId],
  );

  return { flush, status, error };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Configuration-stage dispatcher.
 *
 * Operator-driven pipelines DON'T use the manual brief form — the operator
 * authors the brief and the manager reviews + approves it:
 *   - brief authored (`image_brief_id` set) → render `<OperatorBriefReview />`;
 *   - operator still drafting (`image_brief_id` null) → a waiting state (live
 *     progress shows in the OperatorNarration sidebar).
 * Everything else falls through to the existing manual form unchanged, so the
 * deterministic flow does not regress.
 */
export function StageConfiguration(props: StageConfigurationProps) {
  const { pipeline } = props;
  const operatorDriven = isOperatorDrivenDraft(pipeline.config_draft);

  if (operatorDriven) {
    if (pipeline.image_brief_id) {
      return <OperatorBriefReview pipeline={pipeline} />;
    }
    return <OperatorDraftingWaiting />;
  }

  return <ManualConfiguration {...props} />;
}

/**
 * Waiting state shown while an operator-driven pipeline's brief is still being
 * authored. Live progress streams into the OperatorNarration sidebar; this
 * panel just reassures the manager there's nothing to do yet.
 */
function OperatorDraftingWaiting() {
  return (
    <StageShell
      title="The operator is drafting the brief…"
      subtitle="Hang tight — the operator is authoring the image brief. Live progress shows in the Operator panel."
      canContinue={false}
      continueLabel="Waiting for the brief…"
      body={
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/30 px-6 py-12 text-center"
        >
          <Loader2 aria-hidden="true" className="h-6 w-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            The operator hasn&apos;t finished the brief yet. You&apos;ll be able to review and
            approve it here once it&apos;s ready.
          </p>
        </div>
      }
    />
  );
}

function ManualConfiguration({ pipeline, clients: initialClients }: StageConfigurationProps) {
  const router = useRouter();

  const [format, setFormat] = useState<PipelineFormat>(pipeline.format_choice);
  const [clientId, setClientId] = useState<string | null>(pipeline.client_id);
  const [clients, setClients] = useState<ClientOption[]>(initialClients ?? []);
  const [clientsLoading, setClientsLoading] = useState(!initialClients);
  const [clientsError, setClientsError] = useState<string | null>(null);

  // Image + video form states. We hydrate from `pipeline.config_draft` on
  // first mount so the operator's autosaved values come back after a reload.
  const draftImage = useMemo(() => {
    const d = pipeline.config_draft as { image_payload?: unknown } | null;
    return d?.image_payload;
  }, [pipeline.config_draft]);
  const draftVideo = useMemo(() => {
    const d = pipeline.config_draft as { video_payload?: unknown } | null;
    return d?.video_payload;
  }, [pipeline.config_draft]);
  const draftNotes = useMemo(() => {
    const d = pipeline.config_draft as { notes?: unknown } | null;
    return typeof d?.notes === "string" ? d.notes : null;
  }, [pipeline.config_draft]);

  const [imageValues, setImageValues] = useState<ImageFormValues>({
    ...IMAGE_DEFAULTS,
    ...fromImagePayload(draftImage),
  });
  const [videoValues, setVideoValues] = useState<VideoFormValues>({
    ...VIDEO_DEFAULTS,
    ...fromVideoPayload(draftVideo),
  });

  const [draftBanner, setDraftBanner] = useState<string | null>(draftNotes);
  const [modalOpen, setModalOpen] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);

  const { flush: autosave, status: saveStatus, error: saveError } = useAutosave(pipeline.id);

  // Fetch clients via the service-role API route when the parent didn't pass
  // them in. Phase 2 of the RLS lockdown means the anon browser key can't read
  // `clients` directly, so this goes through `/api/clients`.
  useEffect(() => {
    if (initialClients) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchClients();
        if (cancelled) return;
        setClients(data as ClientOption[]);
      } catch (e) {
        if (cancelled) return;
        setClientsError(e instanceof Error ? e.message : "Failed to load clients");
      } finally {
        if (!cancelled) setClientsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialClients]);

  const tracks = useMemo(() => activeTracksLocal(format), [format]);

  // Derived validity for each active track.
  const imageValid = useMemo(() => {
    if (!tracks.image) return true;
    const payload = toImagePayload(imageValues);
    if (!payload) return false;
    return BriefPayload.safeParse(payload).success;
  }, [tracks.image, imageValues]);

  const videoValid = useMemo(() => {
    if (!tracks.video) return true;
    const payload = toVideoPayload(videoValues, clientId);
    if (!payload) return false;
    return VideoBriefInput.safeParse(payload).success;
  }, [tracks.video, videoValues, clientId]);

  const canContinue = Boolean(clientId) && imageValid && videoValid && !advancing;

  // ----- field handlers (each one autosaves) ----------------------------

  const setImageField = useCallback(
    <K extends keyof ImageFormValues>(key: K, value: ImageFormValues[K]) => {
      setImageValues((prev) => {
        const next = { ...prev, [key]: value };
        const payload = toImagePayload(next);
        if (payload && BriefPayload.safeParse(payload).success) {
          void autosave({ image_payload: payload });
        }
        return next;
      });
    },
    [autosave],
  );

  const setVideoField = useCallback(
    <K extends keyof VideoFormValues>(key: K, value: VideoFormValues[K]) => {
      setVideoValues((prev) => {
        const next = { ...prev, [key]: value };
        const payload = toVideoPayload(next, clientId);
        if (payload && VideoBriefInput.safeParse(payload).success) {
          void autosave({ video_payload: payload });
        }
        return next;
      });
    },
    [autosave, clientId],
  );

  const setSegmentField = useCallback(
    <K extends keyof VideoSegmentFV>(idx: number, key: K, value: VideoSegmentFV[K]) => {
      setVideoValues((prev) => {
        const segments = prev.segments.map((s, i) => (i === idx ? { ...s, [key]: value } : s));
        const next = { ...prev, segments };
        const payload = toVideoPayload(next, clientId);
        if (payload && VideoBriefInput.safeParse(payload).success) {
          void autosave({ video_payload: payload });
        }
        return next;
      });
    },
    [autosave, clientId],
  );

  const addSegment = useCallback(() => {
    setVideoValues((prev) => ({
      ...prev,
      segments: [...prev.segments, { topic: "", duration_s: "15", broll_theme: "" }],
    }));
  }, []);

  const removeSegment = useCallback((idx: number) => {
    setVideoValues((prev) => {
      if (prev.segments.length <= 1) return prev;
      return { ...prev, segments: prev.segments.filter((_, i) => i !== idx) };
    });
  }, []);

  const onFormatChange = useCallback(
    (next: PipelineFormat) => {
      setFormat(next);
      void autosave({ format_choice: next });
    },
    [autosave],
  );

  const onClientChange = useCallback(
    (next: string) => {
      setClientId(next);
      void autosave({ client_id: next });
    },
    [autosave],
  );

  // ----- Ekko proposal hydration ----------------------------------------

  const onProposed = useCallback(
    (proposal: ProposedConfig) => {
      // Set the format radio first; this also triggers an autosave PATCH for
      // format_choice so the server sees the change.
      onFormatChange(proposal.format_choice);
      if (proposal.image_payload) {
        const hydrated = { ...IMAGE_DEFAULTS, ...fromImagePayload(proposal.image_payload) };
        setImageValues(hydrated);
        const payload = toImagePayload(hydrated);
        if (payload && BriefPayload.safeParse(payload).success) {
          void autosave({ image_payload: payload }, { immediate: true });
        }
      }
      if (proposal.video_payload) {
        const hydrated = { ...VIDEO_DEFAULTS, ...fromVideoPayload(proposal.video_payload) };
        setVideoValues(hydrated);
        const payload = toVideoPayload(hydrated, clientId);
        if (payload && VideoBriefInput.safeParse(payload).success) {
          void autosave({ video_payload: payload }, { immediate: true });
        }
      }
      setDraftBanner(proposal.notes ?? "Filled by Ekko — review and edit before continuing.");
    },
    [autosave, clientId, onFormatChange],
  );

  // ----- Advance --------------------------------------------------------

  const onContinue = useCallback(async () => {
    if (!canContinue) return;
    setAdvancing(true);
    setAdvanceError(null);
    try {
      const res = await fetch(`/api/pipelines/${encodeURIComponent(pipeline.id)}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
      });
      if (!res.ok) {
        let detail = "";
        try {
          const body = (await res.json()) as { error?: string };
          detail = body.error ?? "";
        } catch {
          /* ignore */
        }
        throw new Error(detail || `advance failed (${res.status})`);
      }
      // Server-side update fires a realtime event that PipelineDetailRealtime
      // will pick up; we also refresh proactively in case realtime is slow.
      router.refresh();
    } catch (e) {
      setAdvanceError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdvancing(false);
    }
  }, [canContinue, pipeline.id, router]);

  // ----- Render ---------------------------------------------------------

  const clientPlaceholder = clientsLoading
    ? "Loading clients…"
    : clientsError
      ? "Failed to load clients"
      : clients.length === 0
        ? "No active clients found"
        : "Select a client";

  return (
    <>
      <StageShell
        title="Configuration"
        subtitle="Pick the format and fill the brief(s). Autosaves as you go."
        canContinue={canContinue}
        onContinue={() => void onContinue()}
        continueLabel={advancing ? "Advancing…" : "Continue to Ideation"}
        secondaryAction={<AutosaveIndicator status={saveStatus} error={saveError} />}
        body={
          <div className="flex flex-col gap-6">
            {/* Ekko draft + banner */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Button
                type="button"
                variant="outline"
                onClick={() => setModalOpen(true)}
                className="gap-2"
              >
                <Sparkles className="h-4 w-4 text-violet-600" aria-hidden="true" />
                Let Ekko draft this
              </Button>
              {draftBanner ? (
                <p className="rounded-md border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-900">
                  {draftBanner}
                </p>
              ) : null}
            </div>

            {/* Client + format */}
            <section className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="stage-config-client">Client</Label>
                <Select
                  value={clientId ?? undefined}
                  onValueChange={onClientChange}
                  disabled={clientsLoading || clients.length === 0}
                >
                  <SelectTrigger id="stage-config-client">
                    <SelectValue placeholder={clientPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name} <span className="text-muted-foreground">({c.slug})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {clientsError ? <p className="text-xs text-destructive">{clientsError}</p> : null}
              </div>
              <div className="grid gap-2">
                <Label>Format</Label>
                <RadioGroup
                  value={format}
                  onValueChange={(v) => onFormatChange(v as PipelineFormat)}
                  className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-4"
                >
                  <FormatRadio id="fmt-image" value="image" label="Image" />
                  <FormatRadio id="fmt-video" value="video" label="Video" />
                  <FormatRadio id="fmt-both" value="both" label="Both" />
                </RadioGroup>
              </div>
            </section>

            {/* Forms */}
            <div
              className={cn(
                "flex flex-col gap-6",
                format === "both" && "lg:grid lg:grid-cols-2 lg:gap-6",
              )}
            >
              {tracks.image ? (
                <ImageBriefFields
                  values={imageValues}
                  onField={setImageField}
                  isValid={imageValid}
                />
              ) : null}
              {tracks.video ? (
                <VideoBriefFields
                  values={videoValues}
                  onField={setVideoField}
                  onSegmentField={setSegmentField}
                  onAddSegment={addSegment}
                  onRemoveSegment={removeSegment}
                  isValid={videoValid}
                />
              ) : null}
            </div>

            {advanceError ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {advanceError}
              </div>
            ) : null}
          </div>
        }
      />

      <EkkoDraftModal
        pipelineId={pipeline.id}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onProposed={onProposed}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function FormatRadio({ id, value, label }: { id: string; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <RadioGroupItem id={id} value={value} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}

function AutosaveIndicator({
  status,
  error,
}: {
  status: "idle" | "saving" | "saved" | "error";
  error: string | null;
}) {
  if (status === "saving") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Saving draft…
      </span>
    );
  }
  if (status === "saved") {
    return <span className="text-xs text-muted-foreground">Saved</span>;
  }
  if (status === "error") {
    return (
      <span className="text-xs text-destructive" role="alert">
        Autosave failed{error ? `: ${error}` : ""}
      </span>
    );
  }
  return null;
}

function ImageBriefFields({
  values,
  onField,
  isValid,
}: {
  values: ImageFormValues;
  onField: <K extends keyof ImageFormValues>(key: K, value: ImageFormValues[K]) => void;
  isValid: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-4 rounded-md border p-4">
      <legend className="px-2 text-sm font-medium">
        Image brief {isValid ? null : <span className="text-destructive">— incomplete</span>}
      </legend>

      <div className="grid gap-2">
        <Label>Service</Label>
        <RadioGroup
          value={values.service}
          onValueChange={(v) => onField("service", v as ImageFormValues["service"])}
          className="flex flex-col gap-2 sm:flex-row sm:gap-6"
        >
          <FormatRadio id="img-service-roofing" value="roofing" label="Roofing" />
          <FormatRadio id="img-service-remodeling" value="remodeling" label="Remodeling" />
        </RadioGroup>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="img-market">Market</Label>
        <Input
          id="img-market"
          placeholder="e.g. Tampa, FL"
          value={values.market}
          onChange={(e) => onField("market", e.target.value)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="img-budget">Total budget (USD)</Label>
          <Input
            id="img-budget"
            type="number"
            min={1}
            step="0.01"
            placeholder="5000"
            value={values.budget}
            onChange={(e) => onField("budget", e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="img-budget-daily">Daily budget (USD)</Label>
          <Input
            id="img-budget-daily"
            type="number"
            min={1}
            step="0.01"
            placeholder="100"
            value={values.budget_daily}
            onChange={(e) => onField("budget_daily", e.target.value)}
          />
        </div>
      </div>

      <fieldset className="rounded-md border p-3">
        <legend className="px-2 text-xs font-medium">Targeting (optional)</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="img-radius">Radius (km)</Label>
            <Input
              id="img-radius"
              type="number"
              min={1}
              value={values.radius_km}
              onChange={(e) => onField("radius_km", e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="img-zips">ZIPs</Label>
            <Input
              id="img-zips"
              placeholder="33601 33602 33603"
              value={values.zips}
              onChange={(e) => onField("zips", e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="img-age-min">Age min</Label>
            <Input
              id="img-age-min"
              type="number"
              min={13}
              max={90}
              value={values.age_min}
              onChange={(e) => onField("age_min", e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="img-age-max">Age max</Label>
            <Input
              id="img-age-max"
              type="number"
              min={13}
              max={90}
              value={values.age_max}
              onChange={(e) => onField("age_max", e.target.value)}
            />
          </div>
        </div>
      </fieldset>

      <div className="grid gap-2">
        <Label htmlFor="img-lp">Landing page URL</Label>
        <Input
          id="img-lp"
          type="url"
          placeholder="https://example.com/lp"
          value={values.landing_page_url}
          onChange={(e) => onField("landing_page_url", e.target.value)}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="img-count">Image count</Label>
        <Input
          id="img-count"
          type="number"
          min={1}
          max={20}
          value={values.image_count}
          onChange={(e) => onField("image_count", e.target.value)}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="img-angles">Angles (one per line)</Label>
        <Textarea
          id="img-angles"
          rows={3}
          placeholder={"Free roof inspection\nHurricane-ready in 48 hours\nLifetime warranty"}
          value={values.angles}
          onChange={(e) => onField("angles", e.target.value)}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="img-offer">Offer</Label>
        <Input
          id="img-offer"
          placeholder="Limited time: 0% financing for 24 months"
          value={values.offer_text}
          onChange={(e) => onField("offer_text", e.target.value)}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="img-notes">Internal notes</Label>
        <Textarea
          id="img-notes"
          rows={2}
          value={values.notes}
          onChange={(e) => onField("notes", e.target.value)}
        />
      </div>
    </fieldset>
  );
}

function VideoBriefFields({
  values,
  onField,
  onSegmentField,
  onAddSegment,
  onRemoveSegment,
  isValid,
}: {
  values: VideoFormValues;
  onField: <K extends keyof VideoFormValues>(key: K, value: VideoFormValues[K]) => void;
  onSegmentField: <K extends keyof VideoSegmentFV>(
    idx: number,
    key: K,
    value: VideoSegmentFV[K],
  ) => void;
  onAddSegment: () => void;
  onRemoveSegment: (idx: number) => void;
  isValid: boolean;
}) {
  const segmentSum = values.segments.reduce((acc, s) => acc + Number(s.duration_s || 0), 0);
  const targetN = Number(values.target_duration_s || 0);
  const durationMismatch = Math.abs(segmentSum - targetN) >= 1;

  return (
    <fieldset className="flex flex-col gap-4 rounded-md border p-4">
      <legend className="px-2 text-sm font-medium">
        Video brief {isValid ? null : <span className="text-destructive">— incomplete</span>}
      </legend>

      <div className="grid gap-2">
        <Label htmlFor="vid-hook">Hook</Label>
        <Textarea
          id="vid-hook"
          rows={2}
          placeholder="What grabs attention in the first 3 seconds?"
          value={values.hook}
          onChange={(e) => onField("hook", e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Label>Script segments</Label>
          <span className="text-xs text-muted-foreground">
            Sum <strong>{segmentSum.toFixed(0)}s</strong> / target <strong>{targetN}s</strong>
            {durationMismatch ? <span className="ml-2 text-destructive">mismatch</span> : null}
          </span>
        </div>
        <ul className="flex flex-col gap-2">
          {values.segments.map((seg, idx) => (
            <li
              key={`seg-${idx}`}
              className="grid items-end gap-2 rounded-md border bg-background p-2 sm:grid-cols-[2fr_1fr_2fr_auto]"
            >
              <div className="grid gap-1">
                <Label htmlFor={`vid-seg-${idx}-topic`} className="text-xs">
                  Topic
                </Label>
                <Input
                  id={`vid-seg-${idx}-topic`}
                  value={seg.topic}
                  onChange={(e) => onSegmentField(idx, "topic", e.target.value)}
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`vid-seg-${idx}-duration`} className="text-xs">
                  Duration (s)
                </Label>
                <Input
                  id={`vid-seg-${idx}-duration`}
                  type="number"
                  min={1}
                  value={seg.duration_s}
                  onChange={(e) => onSegmentField(idx, "duration_s", e.target.value)}
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`vid-seg-${idx}-broll`} className="text-xs">
                  B-roll theme (optional)
                </Label>
                <Input
                  id={`vid-seg-${idx}-broll`}
                  value={seg.broll_theme}
                  onChange={(e) => onSegmentField(idx, "broll_theme", e.target.value)}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRemoveSegment(idx)}
                disabled={values.segments.length === 1}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={onAddSegment}
        >
          Add segment
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="vid-target-duration">Target duration (s)</Label>
          <Input
            id="vid-target-duration"
            type="number"
            min={1}
            max={180}
            value={values.target_duration_s}
            onChange={(e) => onField("target_duration_s", e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="vid-voice">Voice ID (ElevenLabs)</Label>
          <Input
            id="vid-voice"
            placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
            value={values.voice_id}
            onChange={(e) => onField("voice_id", e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label>Dimensions</Label>
          <RadioGroup
            value={values.dimensions}
            onValueChange={(v) => onField("dimensions", v as VideoFormValues["dimensions"])}
            className="flex flex-col gap-2 sm:flex-row sm:gap-4"
          >
            {RATIO_OPTIONS.map((r) => (
              <FormatRadio key={r} id={`vid-ratio-${r}`} value={r} label={r} />
            ))}
          </RadioGroup>
        </div>
        <div className="grid gap-2">
          <Label>B-roll selection</Label>
          <RadioGroup
            value={values.broll_selection_mode}
            onValueChange={(v) =>
              onField("broll_selection_mode", v as VideoFormValues["broll_selection_mode"])
            }
            className="grid gap-1"
          >
            <FormatRadio id="vid-broll-auto" value="auto" label="auto" />
            <FormatRadio id="vid-broll-review-each" value="review_each" label="review each" />
            <FormatRadio
              id="vid-broll-low-conf"
              value="review_low_confidence"
              label="review low confidence"
            />
          </RadioGroup>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="vid-music">Music track (optional)</Label>
          <Input
            id="vid-music"
            value={values.music_track}
            onChange={(e) => onField("music_track", e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="vid-notes">Notes (optional)</Label>
          <Textarea
            id="vid-notes"
            rows={2}
            value={values.notes}
            onChange={(e) => onField("notes", e.target.value)}
          />
        </div>
      </div>
    </fieldset>
  );
}
