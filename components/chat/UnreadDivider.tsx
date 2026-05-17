"use client";

/**
 * Visual divider inserted in a chat thread above the first message
 * that arrived after the operator last viewed the creative.
 *
 * Pure presentational — the parent decides whether/where to render it
 * by calling `firstUnreadIndex(...)` from `lib/chat-read-status.ts`.
 *
 * The divider is centered horizontally with a thin rule on each side
 * and a "N new" pill in the middle. Tuned to be unobtrusive but
 * clearly visible against both light and chat-bubble backgrounds.
 */
export function UnreadDivider({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div
      role="separator"
      aria-label={`${count} new ${count === 1 ? "message" : "messages"}`}
      className="my-2 flex items-center gap-2 px-1"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-rose-300/70" />
      <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700">
        {count === 1 ? "1 new" : `${count} new`}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-rose-300/70" />
    </div>
  );
}
