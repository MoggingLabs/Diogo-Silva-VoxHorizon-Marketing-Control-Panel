/**
 * Message grouping for chat / iteration threads.
 *
 * Walks a sorted (oldest-first) list of messages and emits an interleaved
 * stream of `date-separator` items + `message` items annotated with
 * `isFirstInGroup` / `isLastInGroup` flags. Two messages from the same
 * sender within 5 minutes are part of the same visual group; messages
 * across a calendar-day boundary get a separator inserted in front.
 *
 * The util is intentionally schema-light: callers pass a sequence with
 * `id`, `createdAt`, and a stable `senderKey` string (e.g. the role or
 * `${role}:${userId}`). EkkoChat groups by role; the iteration threads
 * group by `author`. The util has no opinion on which.
 *
 * Pattern lifted from forge's `lib/message-grouping.ts` — pre-compute
 * Date objects once, walk neighbours, emit a single linear render list.
 */

export type Groupable = {
  /** Stable id for React keys. */
  id: string;
  /** ISO-8601 timestamp string. */
  createdAt: string;
  /** Stable key per sender; messages with the same key cluster together. */
  senderKey: string;
};

export type GroupingItem<M extends Groupable> =
  | { type: "date-separator"; key: string; label: string }
  | { type: "message"; message: M; isFirstInGroup: boolean; isLastInGroup: boolean };

const FIVE_MIN_MS = 5 * 60 * 1000;

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Format a date as a chat-style separator label:
 *   - "Today" / "Yesterday" when it falls on those calendar days
 *   - Otherwise the locale-formatted date (e.g. "May 17, 2026")
 *
 * `now` is a seam for tests; defaults to the current wall-clock time.
 */
export function formatDateSeparator(date: Date, now: Date = new Date()): string {
  if (isSameDay(date, now)) return "Today";
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (isSameDay(date, yesterday)) return "Yesterday";
  try {
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Group an oldest-first list of messages into a linear render list with
 * date separators + per-group bookends. Returns `[]` for an empty input.
 *
 * Complexity is O(n) — Date objects are computed once up front.
 */
export function groupMessages<M extends Groupable>(messages: M[]): GroupingItem<M>[] {
  if (messages.length === 0) return [];

  const dates = messages.map((m) => new Date(m.createdAt));
  const items: GroupingItem<M>[] = [];
  let currentDay: Date | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgDate = dates[i];
    // `noUncheckedIndexedAccess` makes these possibly-undefined; the
    // loop bound proves otherwise, but we guard explicitly so the
    // narrowing is in scope for the rest of the body.
    if (!msg || !msgDate) continue;

    if (!currentDay || !isSameDay(currentDay, msgDate)) {
      items.push({
        type: "date-separator",
        key: `sep-${msgDate.toISOString().slice(0, 10)}-${msg.id}`,
        label: formatDateSeparator(msgDate),
      });
      currentDay = msgDate;
    }

    const prev = messages[i - 1];
    const prevDate = dates[i - 1];
    const next = messages[i + 1];
    const nextDate = dates[i + 1];

    const sameSenderAsPrev =
      prev !== undefined &&
      prevDate !== undefined &&
      prev.senderKey === msg.senderKey &&
      isSameDay(prevDate, msgDate) &&
      msgDate.getTime() - prevDate.getTime() < FIVE_MIN_MS;

    const sameSenderAsNext =
      next !== undefined &&
      nextDate !== undefined &&
      next.senderKey === msg.senderKey &&
      isSameDay(nextDate, msgDate) &&
      nextDate.getTime() - msgDate.getTime() < FIVE_MIN_MS;

    items.push({
      type: "message",
      message: msg,
      isFirstInGroup: !sameSenderAsPrev,
      isLastInGroup: !sameSenderAsNext,
    });
  }

  return items;
}
