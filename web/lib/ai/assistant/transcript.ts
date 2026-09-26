// The conversation transcript file (bead 2by.9).
//
// A portable Markdown record of ONE thread: the build version, the export stamp,
// each turn's own timestamp, the user and assistant text, the tool calls and their
// results, and the receipts an Apply produced.
//
// IT CANNOT CARRY THE CREDENTIAL, BY CONSTRUCTION. The API key lives only on the
// assistant-settings row (`records.ts`); it is not an input here, and the path that
// calls this reads messages, receipts, the build version and a clock -- nothing else.
// So the file is secret-free because the secret never reaches it, not because a
// redaction pass might catch it.
//
// The message and receipt shapes below are NARROWED to the fields a transcript
// renders. Canonical `AssistantMessageV1` / `AssistantReceiptV1` records are
// structurally assignable, so callers pass their durable rows unchanged.

import { SCOPE_LABEL, type ProposalDiffEntry } from "@/lib/proposal";
import type { AssistantMessageRole, AssistantToolCallV1 } from "./records";

/** The message fields a transcript renders. `AssistantMessageV1` is assignable. */
export interface TranscriptMessage {
  role: AssistantMessageRole;
  content: string;
  toolCalls: readonly AssistantToolCallV1[] | null;
  createdAt: string;
}

/** The receipt fields a transcript renders. `AssistantReceiptV1` is assignable. */
export interface TranscriptReceipt {
  createdAt: string;
  summary: readonly ProposalDiffEntry[];
}

export interface TranscriptInput {
  messages: readonly TranscriptMessage[];
  receipts: readonly TranscriptReceipt[];
  /** `currentAppVersion()` at the moment of export. */
  appVersion: string;
  exportedAt: Date;
  /** The schedule's own name, when one is known. */
  scenarioName?: string | null;
}

const ROLE_HEADING: Readonly<Record<AssistantMessageRole, string>> = {
  user: "You",
  assistant: "Assistant",
  tool: "Tool result",
  reasoning: "Reasoning",
};

/**
 * A fenced block whose delimiter is wider than any backtick run inside it.
 *
 * A tool result is arbitrary text -- a model answer that itself contains a fenced
 * code sample is ordinary -- and a bare ``` fence around it would close early and
 * spill the rest of the transcript into prose. Opening wider than the longest run
 * in the content is what keeps the block closed.
 */
function fenced(text: string, language = ""): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${language}\n${text}\n${ticks}`;
}

/** One receipt line: what changed, in what, and between which values. */
function receiptLine(entry: ProposalDiffEntry): string {
  const scope = SCOPE_LABEL[entry.scope];
  return `- **${entry.label}** (${scope}) — ${entry.before ?? "Nothing"} → ${entry.after ?? "Removed"}`;
}

/**
 * Build the whole Markdown transcript. Deterministic for a given input: the only
 * clock it reads is `exportedAt`.
 */
export function buildTranscriptMarkdown(input: TranscriptInput): string {
  const lines = ["# Schedule assistant transcript", ""];
  lines.push(`- App version: ${input.appVersion}`);
  lines.push(`- Exported: ${input.exportedAt.toISOString()}`);
  const scenarioName = input.scenarioName?.trim();
  if (scenarioName) lines.push(`- Schedule: ${scenarioName}`);

  for (const message of input.messages) {
    // A user or assistant message is a TURN; a tool result or a reasoning trace is a
    // sub-section of the turn it belongs to, not a turn of its own.
    const depth = message.role === "user" || message.role === "assistant" ? "##" : "###";
    lines.push("", `${depth} ${ROLE_HEADING[message.role]} · ${message.createdAt}`, "");
    // Assistant and user content is prose the reader wants as prose. A tool result is
    // raw payload (usually JSON), so it goes in a fence -- which also stops it being
    // read as Markdown.
    if (message.content) {
      lines.push(message.role === "tool" ? fenced(message.content, "text") : message.content);
    }
    // A tool call is a sub-section of the assistant turn that made it.
    for (const call of message.toolCalls ?? []) {
      lines.push("", `### Tool: ${call.name}`, "", fenced(call.args, "json"));
    }
  }

  if (input.receipts.length > 0) {
    lines.push("", "## Changes applied");
    for (const receipt of input.receipts) {
      lines.push("", `### ${receipt.createdAt}`, "");
      for (const entry of receipt.summary) lines.push(receiptLine(entry));
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** The download's filename: date-stamped, and Markdown. */
export function transcriptFilename(exportedAt: Date): string {
  return `schedule-assistant-transcript-${exportedAt.toISOString().slice(0, 10)}.md`;
}
