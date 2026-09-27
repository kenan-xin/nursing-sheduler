// When a long conversation is summarised, and where it is cut (bead ypo).
//
// Pure. The cut is always just before a user message, so an assistant tool call and
// its result are never split. Only what the provider receives changes: the panel,
// the durable history and the transcript keep every message.

import type { AssistantMessageV1, ThreadSummaryV1 } from "./records";

export const COMPACT_AT_CHARS = 60_000;
export const KEEP_RECENT_USER_TURNS = 4;
export const MAX_SUMMARY_INPUT_CHARS = 120_000;
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
  return { throughSeq: slice[slice.length - 1].seq, slice };
}

export function omittedMessageIds(
  records: readonly AssistantMessageV1[],
  summary: ThreadSummaryV1 | null,
): Set<string> {
  if (summary === null) return new Set();
  return new Set(records.filter((r) => r.seq <= summary.throughSeq).map((r) => r.messageId));
}

export function transcriptForSummary(slice: readonly AssistantMessageV1[]): string {
  const lines = bySeq(slice).flatMap((r): string[] => {
    switch (r.role) {
      case "user":
        return [`User: ${r.content}`];
      case "assistant":
        return [
          ...(r.content ? [`Assistant: ${r.content}`] : []),
          ...(r.toolCalls ?? []).map((call) => `Assistant used ${call.name}.`),
        ];
      case "tool":
        return [
          `Result: ${r.content.length > TOOL_RESULT_CHARS ? `${r.content.slice(0, TOOL_RESULT_CHARS)}…` : r.content}`,
        ];
      case "reasoning":
        return [];
    }
  });
  const text = lines.join("\n");
  return text.length > MAX_SUMMARY_INPUT_CHARS ? text.slice(-MAX_SUMMARY_INPUT_CHARS) : text;
}
