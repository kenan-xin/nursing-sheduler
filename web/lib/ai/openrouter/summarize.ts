// One summary of older conversation turns (bead ypo). Same containment as the probe:
// the key is used for this one request and dropped, and an upstream body is only
// ever classified, never forwarded.

import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, generateText } from "ai";
import { AI_SETUP_CODES, OPENROUTER_BASE_URL, type AiSetupCode } from "@/lib/ai/protocol";
import { classifyStatus } from "./probe";

export type SummaryResult = { ok: true; summary: string } | { ok: false; code: AiSetupCode };

const SYSTEM =
  "You summarise the earlier part of a conversation between a nurse manager and a " +
  "scheduling assistant, so the assistant can carry on without it. Keep: decisions the " +
  "user made, facts they stated (names, dates, shifts, leave, preferences), changes " +
  "proposed and whether they were applied, optimiser runs and their results, and open " +
  "questions. Drop small talk and tool payload detail: the current schedule is sent " +
  "separately. Plain sentences, at most 250 words.";

export async function summarizeConversation(input: {
  apiKey: string;
  model: string;
  previousSummary: string | null;
  transcript: string;
  fetchImpl?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<SummaryResult> {
  const openrouter = createOpenAI({
    apiKey: input.apiKey,
    baseURL: OPENROUTER_BASE_URL,
    ...(input.fetchImpl ? { fetch: input.fetchImpl } : {}),
  });
  const prompt =
    (input.previousSummary ? `Summary so far:\n${input.previousSummary}\n\n` : "") +
    `Conversation to add:\n${input.transcript}`;
  try {
    const { text } = await generateText({
      // `.chat()`: OpenRouter does not implement the Responses API (see openrouter-agent.ts).
      model: openrouter.chat(input.model),
      system: SYSTEM,
      prompt,
      maxOutputTokens: 700,
      maxRetries: 0,
      ...(input.signal ? { abortSignal: input.signal } : {}),
    });
    const summary = text.trim();
    return summary ? { ok: true, summary } : { ok: false, code: AI_SETUP_CODES.probeFailed };
  } catch (error) {
    if (APICallError.isInstance(error) && error.statusCode !== undefined) {
      return { ok: false, code: classifyStatus(error.statusCode, error.responseBody ?? "") };
    }
    return { ok: false, code: AI_SETUP_CODES.providerUnreachable };
  }
}
