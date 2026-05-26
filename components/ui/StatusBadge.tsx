import * as React from "react";
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  CircleDashed,
  Clock,
  FileText,
  Hammer,
  Image as ImageIcon,
  Layers,
  Lightbulb,
  Loader2,
  PenLine,
  Radio,
  Rocket,
  Send,
  ShieldAlert,
  ShieldCheck,
  SkipForward,
  Sparkles,
  TrendingDown,
  Video as VideoIcon,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The ONE canonical status badge for the whole app.
 *
 * Briefs, creatives, launches, pipelines, approvals, gates, QA, compliance
 * and spec checks all surface a status string; historically each surface
 * styled it ad-hoc. This maps every known status literal onto a single
 * semantic palette (success / warning / info / destructive / neutral) so the
 * operator reads the same colour for the same meaning everywhere.
 *
 * Semantics:
 *  - success  (emerald): terminal-good - approved, posted, live, pass, passed,
 *             completed, active, success
 *  - destructive (rose): terminal-bad - rejected, failed, fail, killed, error,
 *             cancelled, canceled, blocked
 *  - warning  (amber):  needs-attention / human-in-the-loop - pending,
 *             in_progress, running, queued, paused, overridden, warning, review
 *  - info     (sky):    informational neutral-positive - draft, queued-ish,
 *             scheduled, generating
 *  - muted    (grey):   inert - archived, skipped, unknown
 *
 * Unknown statuses fall back to a neutral outline badge with the humanized
 * label, so a new status string never crashes or looks alarming.
 */

export type StatusSemantic = "success" | "warning" | "info" | "destructive" | "muted";

type StatusSpec = {
  semantic: StatusSemantic;
  icon: LucideIcon;
  /** Optional explicit label override; otherwise the key is humanized. */
  label?: string;
  /** Spin the icon (for in-flight states). */
  spin?: boolean;
};

const SEMANTIC_VARIANT: Record<StatusSemantic, NonNullable<BadgeProps["variant"]>> = {
  success: "success",
  warning: "warning",
  info: "info",
  destructive: "destructive",
  muted: "muted",
};

/**
 * Status -> spec. Keys are normalized (lowercased, spaces/hyphens -> `_`)
 * before lookup, so "In Progress", "in-progress" and "in_progress" all match.
 */
const STATUS_MAP: Record<string, StatusSpec> = {
  // terminal-good
  approved: { semantic: "success", icon: CheckCircle2 },
  posted: { semantic: "success", icon: Send },
  live: { semantic: "success", icon: Radio },
  active: { semantic: "success", icon: Radio },
  pass: { semantic: "success", icon: Check },
  passed: { semantic: "success", icon: CheckCircle2 },
  completed: { semantic: "success", icon: CheckCircle2 },
  complete: { semantic: "success", icon: CheckCircle2 },
  done: { semantic: "success", icon: CheckCircle2 },
  success: { semantic: "success", icon: CheckCircle2 },
  cleared: { semantic: "success", icon: CheckCircle2 },

  // terminal-bad
  rejected: { semantic: "destructive", icon: XCircle },
  failed: { semantic: "destructive", icon: XCircle },
  fail: { semantic: "destructive", icon: XCircle },
  killed: { semantic: "destructive", icon: Ban },
  error: { semantic: "destructive", icon: AlertTriangle },
  cancelled: { semantic: "destructive", icon: Ban },
  canceled: { semantic: "destructive", icon: Ban },
  blocked: { semantic: "destructive", icon: Ban },

  // needs-attention / in-flight
  pending: { semantic: "warning", icon: Clock },
  in_progress: { semantic: "warning", icon: Loader2, label: "In progress", spin: true },
  running: { semantic: "warning", icon: Loader2, label: "Running", spin: true },
  generating: { semantic: "warning", icon: Loader2, label: "Generating", spin: true },
  processing: { semantic: "warning", icon: Loader2, label: "Processing", spin: true },
  paused: { semantic: "warning", icon: Clock },
  overridden: { semantic: "warning", icon: ShieldAlert },
  override: { semantic: "warning", icon: ShieldAlert },
  warning: { semantic: "warning", icon: AlertTriangle },
  review: { semantic: "warning", icon: AlertTriangle },
  needs_review: { semantic: "warning", icon: AlertTriangle, label: "Needs review" },

  // informational / neutral-positive
  draft: { semantic: "info", icon: FileText },
  queued: { semantic: "info", icon: Clock },
  scheduled: { semantic: "info", icon: Clock },
  ready: { semantic: "info", icon: Check },

  // inert
  archived: { semantic: "muted", icon: CircleDashed },
  skipped: { semantic: "muted", icon: SkipForward },
  inactive: { semantic: "muted", icon: CircleDashed },

  // Pipeline lifecycle stages (mapped onto the semantic palette so the
  // PipelineList + detail header + PhaseStepper + OperatorConsole all read
  // the same colour for the same stage). Each gets a stage-specific icon for
  // glanceable recognition; the underlying semantic is conservative:
  // mid-flow stages are "info", manager-gates are "warning", terminal-good
  // is "success", terminal-bad uses the existing destructive entries above.
  configuration: { semantic: "info", icon: FileText, label: "Configuration" },
  ideation: { semantic: "info", icon: Lightbulb, label: "Ideation" },
  // `review` is in needs-attention above; reuse the warning palette with the
  // happier-on-the-eye AlertTriangle so the brief-review gate still reads as
  // "operator action needed".
  generation: { semantic: "info", icon: Loader2, label: "Generation", spin: true },
  creative_qa: { semantic: "warning", icon: ShieldCheck, label: "Creative QA" },
  compliance_review: { semantic: "warning", icon: ShieldAlert, label: "Compliance" },
  copy: { semantic: "info", icon: PenLine, label: "Copy" },
  spec_validation: { semantic: "warning", icon: Hammer, label: "Spec validation" },
  variant_plan: { semantic: "warning", icon: Layers, label: "Variant plan" },
  finalize_assets: { semantic: "info", icon: Sparkles, label: "Finalize" },
  launch_handoff: { semantic: "warning", icon: Rocket, label: "Launch" },
  monitor: { semantic: "info", icon: Radio, label: "Monitor" },

  // Pipeline format chips share the badge surface so the operator reads the
  // same chip styling across the pipeline list, the detail header, and the
  // dashboard kanban kind pill. Image / Video / Both map to neutral-info /
  // info / success: image=default, video=accent, both=both-and-blessed.
  image: { semantic: "info", icon: ImageIcon, label: "Image" },
  video: { semantic: "info", icon: VideoIcon, label: "Video" },
  both: { semantic: "success", icon: Sparkles, label: "Image + Video" },

  // Monitor verdicts (kill / watch / keep). The decision palette mirrors the
  // traffic-light semantics already used elsewhere - keep=success,
  // watch=warning, kill=destructive - so the operator reads one consistent
  // colour for "good / attention / stop".
  keep: { semantic: "success", icon: CheckCircle2, label: "Keep" },
  watch: { semantic: "warning", icon: AlertTriangle, label: "Watch" },
  kill: { semantic: "destructive", icon: TrendingDown, label: "Kill" },
};

function normalize(status: string): string {
  return status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function humanize(status: string): string {
  const s = status.trim().replace(/[_-]+/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolve a raw status string to its semantic + display label. Exported for
 * callers (and tests) that need the semantic without rendering the badge.
 */
export function resolveStatus(status: string): {
  semantic: StatusSemantic;
  label: string;
  icon: LucideIcon;
  spin: boolean;
} {
  const spec = STATUS_MAP[normalize(status)];
  if (spec) {
    return {
      semantic: spec.semantic,
      label: spec.label ?? humanize(status),
      icon: spec.icon,
      spin: spec.spin ?? false,
    };
  }
  return { semantic: "muted", label: humanize(status), icon: CircleDashed, spin: false };
}

export interface StatusBadgeProps extends Omit<BadgeProps, "variant" | "children"> {
  /** Raw status string from the DB / API (any casing / separators). */
  status: string;
  /** Override the visible text (defaults to the humanized status). */
  label?: string;
  /** Hide the leading status icon. */
  hideIcon?: boolean;
}

/**
 * Render a status string as a consistent, accessible badge. The icon is
 * decorative (`aria-hidden`); the text label carries the meaning. A
 * `data-status` / `data-semantic` attribute pair makes it easy to assert in
 * tests and to target in e2e.
 */
export function StatusBadge({
  status,
  label,
  hideIcon = false,
  className,
  ...props
}: StatusBadgeProps) {
  const { semantic, label: resolvedLabel, icon: Icon, spin } = resolveStatus(status);
  return (
    <Badge
      variant={SEMANTIC_VARIANT[semantic]}
      data-status={normalize(status)}
      data-semantic={semantic}
      className={cn("font-medium", className)}
      {...props}
    >
      {hideIcon ? null : <Icon aria-hidden="true" className={cn(spin && "animate-spin")} />}
      <span>{label ?? resolvedLabel}</span>
    </Badge>
  );
}
