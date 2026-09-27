"use client";

// Summarise the older part of a long thread before a send (bead ypo). Fails open: any
// failure keeps the previous summary (or none), and the turn goes on as before.

import { planCompaction, transcriptForSummary } from "@/lib/ai/assistant/compaction";
import type { AssistantGenerationPair } from "@/lib/ai/assistant/fence";
import { readThread, saveThreadSummary } from "@/lib/ai/assistant/history-repo";
import {
  isAssistantReady,
  type AssistantMessageV1,
  type ThreadSummaryV1,
} from "@/lib/ai/assistant/records";
import { readAssistantSettings } from "@/lib/ai/assistant/settings-repo";
import {
  AI_KEY_HEADER,
  AI_MODEL_HEADER,
  AI_SUMMARY_URL,
  SUMMARY_TIMEOUT_MS,
} from "@/lib/ai/protocol";

export interface CompactedHistory {
  summary: ThreadSummaryV1 | null;
  compactedNow: boolean;
}

export interface CompactHistoryDeps {
  readThread: typeof readThread;
  readSettings: typeof readAssistantSettings;
  saveThreadSummary: typeof saveThreadSummary;
  fetchImpl: typeof globalThis.fetch;
  now: () => Date;
  timeoutMs: number;
}

export async function compactHistory(
  input: {
    threadId: string;
    scenarioId: string;
    history: readonly AssistantMessageV1[];
    generations: AssistantGenerationPair;
    /** Aborted by an interruption (Stop, Clear, takeover...): the send then goes on without it. */
    signal?: AbortSignal;
    /** Called just before a summary request goes out, and only then. */
    onSummarising?: () => void;
  },
  overrides: Partial<CompactHistoryDeps> = {},
): Promise<CompactedHistory> {
  const deps: CompactHistoryDeps = {
    readThread,
    readSettings: readAssistantSettings,
    saveThreadSummary,
    fetchImpl: (...args) => globalThis.fetch(...args),
    now: () => new Date(),
    timeoutMs: SUMMARY_TIMEOUT_MS,
    ...overrides,
  };
  const previous = (await deps.readThread(input.threadId))?.summary ?? null;
  const kept: CompactedHistory = { summary: previous, compactedNow: false };
  const plan = planCompaction(input.history, previous);
  if (plan === null) return kept;
  const settings = await deps.readSettings();
  if (!isAssistantReady(settings)) return kept;
  if (input.signal?.aborted) return kept;
  // A stalled provider must not hold the send, or Stop: either ends the request here, and
  // the browser's abort reaches the route's own `request.signal`.
  const timeout = AbortSignal.timeout(deps.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  input.onSummarising?.();
  try {
    const response = await deps.fetchImpl(AI_SUMMARY_URL, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        [AI_KEY_HEADER]: settings.apiKey,
        [AI_MODEL_HEADER]: settings.modelId,
      },
      body: JSON.stringify({
        previousSummary: previous?.text ?? null,
        transcript: transcriptForSummary(plan.slice),
      }),
    });
    const body = (await response.json()) as { ok?: boolean; summary?: string };
    if (!body.ok || !body.summary || signal.aborted) return kept;
    const next: ThreadSummaryV1 = {
      text: body.summary,
      throughSeq: plan.throughSeq,
      createdAt: deps.now().toISOString(),
    };
    const outcome = await deps.saveThreadSummary(
      input.threadId,
      input.scenarioId,
      next,
      input.generations,
    );
    return outcome === "accepted" ? { summary: next, compactedNow: true } : kept;
  } catch {
    return kept;
  }
}
