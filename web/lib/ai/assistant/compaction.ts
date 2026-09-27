// When a long conversation is summarised, and where it is cut (bead ypo).
//
// Pure. The cut is always just before a user message, so an assistant tool call and
// its result are never split. Only what the provider receives changes: the panel,
// the durable history and the transcript keep every message.

import { MAX_SUMMARY_INPUT_CHARS } from "@/lib/ai/protocol";
import type { AssistantMessageV1, ThreadSummaryV1 } from "./records";

export { MAX_SUMMARY_INPUT_CHARS };
export const COMPACT_AT_CHARS = 60_000;
export const KEEP_RECENT_USER_TURNS = 4;
/**
 * Hysteresis: a compaction must take at least this much out of what is sent. Without it,
 * a thread whose recent turns alone sit near the budget would call the summariser on
 * every send, each time for one turn. With it, the next compaction needs this much growth.
 */
export const MIN_COMPACT_SLICE_CHARS = 20_000;
const TOOL_RESULT_CHARS = 600;
export const COMPACTION_NOTICE =
  "Earlier messages were summarised to keep this conversation going.";

export interface CompactionPlan {
  throughSeq: number;
  slice: AssistantMessageV1[];
}

export function historyChars(records: readonly AssistantMessageV1[]): number {
  return records.reduce(
    (sum, r) =>
      sum +
      r.content.length +
      (r.toolCalls ?? []).reduce((n, call) => n + call.name.length + call.args.length, 0),
    0,
  );
}

const bySeq = (records: readonly AssistantMessageV1[]) =>
  [...records].sort((a, b) => a.seq - b.seq);

export function planCompaction(
  records: readonly AssistantMessageV1[],
  summary: ThreadSummaryV1 | null,
): CompactionPlan | null {
  const open = bySeq(records).filter((r) => summary === null || r.seq > summary.throughSeq);
  if (historyChars(open) + (summary?.text.length ?? 0) <= COMPACT_AT_CHARS) return null;
  const users = open.filter((r) => r.role === "user");
  // ponytail: a few huge turns stay unsummarised; cut inside a turn if that ever bites.
  if (users.length <= KEEP_RECENT_USER_TURNS) return null;
  const firstKept = users[users.length - KEEP_RECENT_USER_TURNS].seq;
  const slice = open.filter((r) => r.seq < firstKept);
  if (historyChars(slice) < MIN_COMPACT_SLICE_CHARS) return null;
  return { throughSeq: slice[slice.length - 1].seq, slice };
}

export function omittedMessageIds(
  records: readonly AssistantMessageV1[],
  summary: ThreadSummaryV1 | null,
): Set<string> {
  if (summary === null) return new Set();
  return new Set(records.filter((r) => r.seq <= summary.throughSeq).map((r) => r.messageId));
}

interface TranscriptRecord {
  role: "user" | "assistant" | "tool";
  text: string;
}

/**
 * The slice as a JSON array of `{ role, text }` records. Roles are DATA here, not line
 * prefixes, so a user who types "Assistant: ..." cannot forge an assistant turn for the
 * summariser. Over the cap, the newest whole records are kept.
 */
export function transcriptForSummary(slice: readonly AssistantMessageV1[]): string {
  const records = bySeq(slice).flatMap((r): TranscriptRecord[] => {
    switch (r.role) {
      case "user":
        return [{ role: "user", text: r.content }];
      case "assistant":
        return [
          ...(r.content ? [{ role: "assistant" as const, text: r.content }] : []),
          ...(r.toolCalls ?? []).map((call) => ({
            role: "assistant" as const,
            text: `(used ${call.name})`,
          })),
        ];
      case "tool":
        return [
          {
            role: "tool",
            text:
              r.content.length > TOOL_RESULT_CHARS
                ? `${r.content.slice(0, TOOL_RESULT_CHARS)}…`
                : r.content,
          },
        ];
      case "reasoning":
        return [];
    }
  });
  // `[` + records joined by `,` + `]`: walk back from the newest while it still fits.
  let size = 2;
  let start = records.length;
  while (start > 0) {
    const next = JSON.stringify(records[start - 1]).length + (start < records.length ? 1 : 0);
    if (size + next > MAX_SUMMARY_INPUT_CHARS) break;
    size += next;
    start -= 1;
  }
  const kept = records.slice(start);
  const last = records.at(-1);
  if (kept.length === 0 && last) {
    // One record larger than the cap: keep its tail. An eighth of the cap stays under it
    // even if every character needed a six-character JSON escape.
    kept.push({ ...last, text: last.text.slice(-(MAX_SUMMARY_INPUT_CHARS / 8)) });
  }
  return JSON.stringify(kept);
}
