"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, ExternalLink, Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { EkkoChat } from "@/components/chat/EkkoChat";
import { ThreadSearch, useThreadSearchShortcut } from "@/components/chat/ThreadSearch";
import { UnreadDivider } from "@/components/chat/UnreadDivider";
import { countUnread, getLastSeen, markRead } from "@/lib/chat-read-status";
import { createClient } from "@/lib/supabase/browser";
import { STATUS_LABEL, STATUS_PILL, type Creative, type CreativeIteration } from "@/lib/creatives";
import { cn } from "@/lib/utils";

import { DecisionButtons } from "./DecisionButtons";
import { IterationThread } from "./IterationThread";

export type SidePanelProps = {
  creative: Creative | null;
  signedUrl: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Renders the `prompt_used` jsonb cell as a readable block. Strings get
 * shown raw; objects pretty-print with two-space indent.
 */
function formatPrompt(prompt: Creative["prompt_used"]): string {
  if (prompt === null || prompt === undefined) return "";
  if (typeof prompt === "string") return prompt;
  try {
    return JSON.stringify(prompt, null, 2);
  } catch {
    return String(prompt);
  }
}

/**
 * Slide-over panel that opens when the operator clicks a card in the
 * variants grid. Self-contained: fetches the latest signed URL and the
 * iteration history on mount, then hands those to `<IterationThread />`
 * which keeps them live via Realtime.
 *
 * The image-preview signed URL is passed in from the parent (the grid
 * resolves it server-side on the first paint). When the panel opens for
 * a different creative we re-fetch the iterations list so a long-lived
 * page session doesn't show stale history.
 */
export function SidePanel({ creative, signedUrl, open, onOpenChange }: SidePanelProps) {
  const [iterations, setIterations] = useState<CreativeIteration[]>([]);
  const [loadingIterations, setLoadingIterations] = useState(false);
  const [iterationsError, setIterationsError] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const sheetScopeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!creative) return;
    let cancelled = false;
    setLoadingIterations(true);
    setIterationsError(null);
    const supabase = createClient();
    void supabase
      .from("creative_iterations")
      .select("*")
      .eq("creative_id", creative.id)
      .order("created_at", { ascending: true })
      .limit(500)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setIterationsError(error.message);
          setIterations([]);
        } else {
          setIterations((data ?? []) as CreativeIteration[]);
        }
        setLoadingIterations(false);
      });
    return () => {
      cancelled = true;
    };
  }, [creative]);

  useEffect(() => {
    setPromptCopied(false);
    setSearchOpen(false);
  }, [creative?.id]);

  // Pull the last-seen marker for the current creative before
  // computing unread counts. We snapshot the value so subsequent
  // markRead calls (e.g. when the panel closes) don't make the divider
  // jump.
  useEffect(() => {
    if (!creative) {
      setLastSeen(null);
      return;
    }
    let cancelled = false;
    void getLastSeen(creative.id).then((iso) => {
      if (!cancelled) setLastSeen(iso);
    });
    return () => {
      cancelled = true;
    };
  }, [creative]);

  // Stamp "last read" when the panel closes — that mirrors how an
  // operator interacts with the side sheet (open, scan, close).
  useEffect(() => {
    if (!creative) return;
    if (open) return;
    void markRead(creative.id);
  }, [creative, open]);

  // Wire Cmd+F (Ctrl+F on Windows). The hook ignores the shortcut
  // when focus is outside the side-panel scope.
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useThreadSearchShortcut(sheetScopeRef, openSearch);

  const unreadCount = useMemo(
    () =>
      countUnread(
        lastSeen,
        iterations.map((i) => ({ createdAt: i.created_at })),
      ),
    [iterations, lastSeen],
  );

  if (!creative) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Creative not found</SheetTitle>
            <SheetDescription>
              The selected creative is no longer available. Close this panel and pick another
              variant.
            </SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    );
  }

  const status = creative.status;
  const pillClass = STATUS_PILL[status] ?? "bg-zinc-100 text-zinc-700";
  const pillLabel = STATUS_LABEL[status] ?? status;
  const concept = creative.concept?.trim() || "Untitled concept";
  const promptText = formatPrompt(creative.prompt_used);
  const decidedAt = formatDate(creative.approved_at);
  const createdAt = formatDate(creative.created_at);

  const copyPrompt = async () => {
    if (!promptText) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(promptText);
        setPromptCopied(true);
        setTimeout(() => setPromptCopied(false), 2000);
      }
    } catch {
      setPromptCopied(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent ref={sheetScopeRef}>
        <SheetHeader className="pr-8">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle className="truncate">{concept}</SheetTitle>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", pillClass)}>
              {pillLabel}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setSearchOpen((v) => !v)}
              className="ml-auto h-7 gap-1 text-xs"
              title="Search this thread (Cmd/Ctrl+F)"
              aria-label="Search this thread"
            >
              <Search aria-hidden="true" className="h-3.5 w-3.5" />
              Find
            </Button>
          </div>
          <SheetDescription className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span className="font-mono">{creative.version}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{creative.ratio ?? "—"}</span>
            {createdAt ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{createdAt}</span>
              </>
            ) : null}
          </SheetDescription>
          <ThreadSearch
            open={searchOpen}
            onClose={() => setSearchOpen(false)}
            searchScope={sheetScopeRef}
            label="Search iterations + chat"
          />
        </SheetHeader>

        <div className="mt-6 flex flex-col gap-6">
          <Section title="Preview">
            {signedUrl ? (
              <a
                href={signedUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="group block overflow-hidden rounded-md border bg-muted/40"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- signed URLs from Supabase Storage need a plain <img> */}
                <img
                  src={signedUrl}
                  alt={concept}
                  className="max-h-[480px] w-full object-contain transition-opacity group-hover:opacity-95"
                />
              </a>
            ) : (
              <div className="rounded-md border border-dashed bg-muted/30 px-3 py-8 text-center text-xs text-muted-foreground">
                No render yet. The worker hasn&apos;t produced this variant.
              </div>
            )}
          </Section>

          <Section
            title="Prompt"
            action={
              promptText ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={copyPrompt}
                  className="h-7 gap-1 text-xs"
                >
                  <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                  {promptCopied ? "Copied" : "Copy"}
                </Button>
              ) : null
            }
          >
            {promptText ? (
              <pre className="overflow-x-auto rounded-md border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
                {promptText}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">No prompt snapshot recorded.</p>
            )}
          </Section>

          <Section title="Metadata">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <Field label="Concept" value={creative.concept ?? "—"} />
              <Field label="Offer" value={creative.offer_text ?? "—"} />
              <Field label="Ratio" value={creative.ratio ?? "—"} mono />
              <Field label="Version" value={creative.version} mono />
              <Field label="Created" value={createdAt ?? "—"} />
              <Field
                label={creative.status === "approved" ? "Approved" : "Decided"}
                value={decidedAt ?? "—"}
              />
              <Field
                label="Drive"
                value={
                  creative.file_path_drive ? (
                    <a
                      href={creative.file_path_drive}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                    >
                      Open
                      <ExternalLink aria-hidden="true" className="h-3 w-3" />
                    </a>
                  ) : (
                    "—"
                  )
                }
              />
              <Field label="Type" value={creative.type} mono />
            </dl>
          </Section>

          <Section title="Iterations">
            {loadingIterations ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                Loading thread…
              </p>
            ) : iterationsError ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                Failed to load iterations: {iterationsError}
              </p>
            ) : (
              <>
                <UnreadDivider count={unreadCount} />
                <IterationThread creativeId={creative.id} initialIterations={iterations} />
              </>
            )}
          </Section>

          <Section title="Decision">
            {creative.status === "draft" ? (
              <DecisionButtons creativeId={creative.id} />
            ) : (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {decidedAt
                  ? `Decided ${decidedAt} · ${pillLabel}`
                  : `Status: ${pillLabel}. No further decision needed in review.`}
              </div>
            )}
          </Section>

          <Section title="Chat with Ekko">
            <EkkoChat
              endpoint={`/api/creatives/${creative.id}/chat`}
              creativeId={creative.id}
              creativeKind="image"
            />
          </Section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("break-words text-xs text-foreground", mono ? "font-mono" : undefined)}>
        {value}
      </dd>
    </div>
  );
}
