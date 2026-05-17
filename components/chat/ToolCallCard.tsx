"use client";

import React from "react";

import type { ToolCallView } from "@/lib/chat";

import { FallbackCard } from "./cards/FallbackCard";
import { RecaptionCard } from "./cards/RecaptionCard";
import { RegenerateImageCard } from "./cards/RegenerateImageCard";
import { RegenerateVoiceoverCard } from "./cards/RegenerateVoiceoverCard";
import { RerenderVideoCard } from "./cards/RerenderVideoCard";
import { SwapBrollCard } from "./cards/SwapBrollCard";

/**
 * Inline card for one assistant tool call.
 *
 * Wave 6 rewrite: dispatch on `call.tool` through a `CARD_RENDERERS`
 * registry instead of a single component that switches on icons. Each
 * tool gets its own focused renderer in `./cards/*`, which surfaces
 * the most useful fields up-front so a thread is scannable without
 * needing to expand every row.
 *
 * Pattern lifted from forge `src/components/chat/structured-card.tsx`:
 *  - `CARD_RENDERERS` maps tool name → React component
 *  - Unknown tools fall back to `<FallbackCard />`
 *  - The whole render is wrapped in an error boundary so a malformed
 *    payload never takes down the chat panel
 */

export type ToolCallCardProps = {
  call: ToolCallView;
};

type ToolCardRenderer = React.FC<{ call: ToolCallView }>;

const CARD_RENDERERS: Record<string, ToolCardRenderer> = {
  regenerate_image: RegenerateImageCard,
  composite_image: RegenerateImageCard, // overlay/composite reads a prompt-like field too
  regenerate_voiceover: RegenerateVoiceoverCard,
  swap_broll: SwapBrollCard,
  rerender_video: RerenderVideoCard,
  recaption: RecaptionCard,
};

/**
 * Class-component error boundary. React still requires class syntax
 * for `componentDidCatch`; we keep it tiny so the cost is minimal.
 */
class ToolCallErrorBoundary extends React.Component<
  { children: React.ReactNode; tool: string },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    console.error(`[ToolCallCard] renderer for "${this.props.tool}" threw:`, error);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
          <span className="font-mono font-medium">{this.props.tool}</span>
          <span className="ml-1">· failed to render — payload was malformed.</span>
        </div>
      );
    }
    return this.props.children;
  }
}

export function ToolCallCard({ call }: ToolCallCardProps) {
  const Renderer = CARD_RENDERERS[call.tool] ?? FallbackCard;
  return (
    <ToolCallErrorBoundary tool={call.tool}>
      <Renderer call={call} />
    </ToolCallErrorBoundary>
  );
}
