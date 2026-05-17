import { Hourglass } from "lucide-react";

import { StageShell } from "@/components/pipeline/StageShell";

export type StagePlaceholderProps = {
  /** Pretty label for the stage. */
  stageLabel: string;
  /** Which downstream wave / agent will replace this placeholder. */
  upcoming: string;
  /** Optional one-line context for the operator. */
  subtitle?: string;
};

/**
 * Drop-in body for stages that haven't been implemented yet. Renders the
 * standard `StageShell` with a friendly "coming soon" tile so the page is
 * usable end-to-end while later waves land the real UI.
 *
 * Each upcoming wave (PF-B for configuration, PF-C for ideation, PF-D for
 * review, PF-E for generation, PF-F for done) replaces the matching
 * placeholder with the real stage component.
 */
export function StagePlaceholder({ stageLabel, upcoming, subtitle }: StagePlaceholderProps) {
  return (
    <StageShell
      title={`${stageLabel} (${upcoming} coming)`}
      subtitle={subtitle ?? "Real implementation lands in a later wave."}
      canContinue={false}
      body={
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/30 px-6 py-12 text-center">
          <Hourglass className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-sm font-medium">This stage is a shell for now.</p>
            <p className="text-xs text-muted-foreground">
              UI shipped in {upcoming}. Until then, advancing the pipeline requires the matching
              real implementation.
            </p>
          </div>
        </div>
      }
    />
  );
}
