"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Controller, useFieldArray, useForm, type SubmitHandler } from "react-hook-form";

import {
  BrollSelectionMode,
  CaptionsStyle,
  HookStyle,
  Ratio,
  VideoBriefInput,
  type VideoBriefInputT,
  type VideoBriefParsedT,
  totalSegmentDuration,
} from "@/lib/video-briefs";
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

/**
 * Client option shape passed in from the server component. We accept a thin
 * tuple instead of the full client row so server pages can re-query just the
 * minimum fields (id, name, slug) and avoid leaking unrelated columns.
 */
export interface VideoBriefFormClientOption {
  id: string;
  name: string;
  slug: string;
}

export interface VideoBriefFormProps {
  clients: VideoBriefFormClientOption[];
  defaults?: Partial<VideoBriefInputT>;
}

const HOOK_STYLE_OPTIONS = HookStyle.options;
const CAPTIONS_STYLE_OPTIONS = CaptionsStyle.options;
const RATIO_OPTIONS = Ratio.options;
const BROLL_MODE_OPTIONS = BrollSelectionMode.options;

const EMPTY_SEGMENT = { topic: "", duration_s: 15, broll_theme: "" } as const;

/**
 * Video brief editor form.
 *
 * Renders a `react-hook-form` form bound to the `VideoBriefInput` zod schema.
 * The form supports two submit actions:
 *
 *   * "Save draft"        → POST /api/briefs/video           (status=draft)
 *   * "Post for approval" → POST /api/briefs/video?post=1   (status=posted)
 *
 * Sum-of-segments validation runs live to surface mismatches before submit;
 * zod re-validates on the server.
 */
export function VideoBriefForm({ clients, defaults }: VideoBriefFormProps) {
  const router = useRouter();
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState<"draft" | "post" | null>(null);

  // Three-generic form: input (pre-parse, includes optionals on
  // defaulted fields), context (unused), output (post-parse, defaults
  // applied). Aligns with zodResolver in @hookform/resolvers >= 3.
  const {
    control,
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<VideoBriefInputT, unknown, VideoBriefParsedT>({
    resolver: zodResolver(VideoBriefInput),
    defaultValues: {
      client_id: defaults?.client_id ?? clients[0]?.id ?? "",
      script_outline: defaults?.script_outline ?? {
        hook: "",
        segments: [{ ...EMPTY_SEGMENT }],
      },
      target_duration_s: defaults?.target_duration_s ?? 30,
      voice_id: defaults?.voice_id ?? "",
      music_track: defaults?.music_track ?? "",
      hook_style: defaults?.hook_style,
      dimensions: defaults?.dimensions ?? "9x16",
      captions_style: defaults?.captions_style,
      broll_selection_mode: defaults?.broll_selection_mode ?? "review_each",
      notes: defaults?.notes ?? "",
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "script_outline.segments",
  });

  // Live preview of the segment-sum vs target-duration check. We watch
  // explicitly so the preview re-renders on each segment edit; cheap given
  // small array sizes.
  const segments = watch("script_outline.segments");
  const target = watch("target_duration_s");
  const segmentSum = totalSegmentDuration(segments ?? []);
  const durationMismatch = Math.abs(segmentSum - (target ?? 0)) >= 1;

  const submit = React.useCallback(
    (mode: "draft" | "post"): SubmitHandler<VideoBriefParsedT> =>
      async (values) => {
        setSubmitError(null);
        setSubmitting(mode);
        try {
          const url = mode === "post" ? "/api/briefs/video?post=1" : "/api/briefs/video";
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(values),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(body.error ?? `Request failed (${res.status})`);
          }
          const created = (await res.json()) as { id: string };
          router.push(`/briefs/video/${created.id}`);
          router.refresh();
        } catch (err) {
          setSubmitError(err instanceof Error ? err.message : String(err));
        } finally {
          setSubmitting(null);
        }
      },
    [router],
  );

  return (
    <form className="flex flex-col gap-8" noValidate>
      {/* Client + voice / track ------------------------------------------- */}
      <section className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="client_id">Client</Label>
          <Controller
            control={control}
            name="client_id"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="client_id">
                  <SelectValue placeholder="Select a client" />
                </SelectTrigger>
                <SelectContent>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} ({c.slug})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          {errors.client_id && (
            <p className="text-sm text-destructive">{errors.client_id.message}</p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="voice_id">Voice ID</Label>
          <Input id="voice_id" placeholder="e.g. 21m00Tcm4TlvDq8ikWAM" {...register("voice_id")} />
          <p className="text-xs text-muted-foreground">
            ElevenLabs voice ID. (Voice picker UI lands in a follow-up — paste the ID for now.)
          </p>
          {errors.voice_id && <p className="text-sm text-destructive">{errors.voice_id.message}</p>}
        </div>
      </section>

      {/* Script outline --------------------------------------------------- */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="hook">Hook</Label>
          <Textarea
            id="hook"
            rows={2}
            placeholder="What grabs attention in the first 3 seconds?"
            {...register("script_outline.hook")}
          />
          {errors.script_outline?.hook && (
            <p className="text-sm text-destructive">{errors.script_outline.hook.message}</p>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Label>Script segments</Label>
            <span className="text-xs text-muted-foreground">
              Sum: <strong>{segmentSum.toFixed(0)}s</strong> / target{" "}
              <strong>{target ?? 0}s</strong>
              {durationMismatch && <span className="ml-2 text-destructive">mismatch</span>}
            </span>
          </div>

          <ul className="flex flex-col gap-3">
            {fields.map((field, idx) => (
              <li key={field.id} className="rounded-md border border-input bg-background p-3">
                <div className="grid gap-3 md:grid-cols-[2fr_1fr_2fr_auto]">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`segments.${idx}.topic`} className="text-xs">
                      Topic
                    </Label>
                    <Input
                      id={`segments.${idx}.topic`}
                      placeholder="What's covered in this beat?"
                      {...register(`script_outline.segments.${idx}.topic`)}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`segments.${idx}.duration_s`} className="text-xs">
                      Duration (s)
                    </Label>
                    <Input
                      id={`segments.${idx}.duration_s`}
                      type="number"
                      min={1}
                      step={1}
                      {...register(`script_outline.segments.${idx}.duration_s`, {
                        valueAsNumber: true,
                      })}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`segments.${idx}.broll_theme`} className="text-xs">
                      B-roll theme (optional)
                    </Label>
                    <Input
                      id={`segments.${idx}.broll_theme`}
                      placeholder="e.g. drone roof shots"
                      {...register(`script_outline.segments.${idx}.broll_theme`)}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(idx)}
                      disabled={fields.length === 1}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                {errors.script_outline?.segments?.[idx] && (
                  <p className="mt-2 text-sm text-destructive">
                    {errors.script_outline.segments[idx]?.topic?.message ??
                      errors.script_outline.segments[idx]?.duration_s?.message ??
                      "Invalid segment"}
                  </p>
                )}
              </li>
            ))}
          </ul>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => append({ ...EMPTY_SEGMENT })}
          >
            Add segment
          </Button>
        </div>
      </section>

      {/* Duration + style ------------------------------------------------ */}
      <section className="grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="target_duration_s">Target duration (s)</Label>
          <Input
            id="target_duration_s"
            type="number"
            min={1}
            max={180}
            step={1}
            {...register("target_duration_s", { valueAsNumber: true })}
          />
          {errors.target_duration_s && (
            <p className="text-sm text-destructive">{errors.target_duration_s.message}</p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="hook_style">Hook style</Label>
          <Controller
            control={control}
            name="hook_style"
            render={({ field }) => (
              <Select
                value={field.value ?? ""}
                onValueChange={(v) => field.onChange(v || undefined)}
              >
                <SelectTrigger id="hook_style">
                  <SelectValue placeholder="(optional)" />
                </SelectTrigger>
                <SelectContent>
                  {HOOK_STYLE_OPTIONS.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="captions_style">Captions style</Label>
          <Controller
            control={control}
            name="captions_style"
            render={({ field }) => (
              <Select
                value={field.value ?? ""}
                onValueChange={(v) => field.onChange(v || undefined)}
              >
                <SelectTrigger id="captions_style">
                  <SelectValue placeholder="(optional)" />
                </SelectTrigger>
                <SelectContent>
                  {CAPTIONS_STYLE_OPTIONS.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
      </section>

      {/* Dimensions + b-roll mode --------------------------------------- */}
      <section className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label>Dimensions</Label>
          <Controller
            control={control}
            name="dimensions"
            render={({ field }) => (
              <RadioGroup value={field.value} onValueChange={field.onChange} className="flex gap-4">
                {RATIO_OPTIONS.map((opt) => (
                  <div key={opt} className="flex items-center gap-2">
                    <RadioGroupItem id={`dimensions-${opt}`} value={opt} />
                    <Label htmlFor={`dimensions-${opt}`}>{opt}</Label>
                  </div>
                ))}
              </RadioGroup>
            )}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>B-roll selection mode</Label>
          <Controller
            control={control}
            name="broll_selection_mode"
            render={({ field }) => (
              <RadioGroup value={field.value} onValueChange={field.onChange} className="grid gap-2">
                {BROLL_MODE_OPTIONS.map((opt) => (
                  <div key={opt} className="flex items-center gap-2">
                    <RadioGroupItem id={`broll-${opt}`} value={opt} />
                    <Label htmlFor={`broll-${opt}`} className="font-normal">
                      {opt.replace(/_/g, " ")}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            )}
          />
        </div>
      </section>

      {/* Music + notes --------------------------------------------------- */}
      <section className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="music_track">Music track (optional)</Label>
          <Input
            id="music_track"
            placeholder="Track name or asset id"
            {...register("music_track")}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="notes">Notes (optional)</Label>
          <Textarea id="notes" rows={3} {...register("notes")} />
        </div>
      </section>

      {/* Actions --------------------------------------------------------- */}
      {submitError && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {submitError}
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={submitting !== null}
          onClick={handleSubmit(submit("draft"))}
        >
          {submitting === "draft" ? "Saving…" : "Save draft"}
        </Button>
        <Button type="button" disabled={submitting !== null} onClick={handleSubmit(submit("post"))}>
          {submitting === "post" ? "Posting…" : "Post for approval"}
        </Button>
      </div>
    </form>
  );
}
