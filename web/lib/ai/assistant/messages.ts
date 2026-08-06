// The ONE adapter between canonical assistant records and the transport's message
// type (T04, tech-plan "Browser durable model").
//
// Nothing else in the app converts between the two. That is the whole point: a
// CopilotKit/AG-UI upgrade that changes `Message` changes this file and no other,
// and no private library class is ever persisted.
//
// The mapping is deliberately LOSSY in one direction and total in the other:
//   * `toCanonical` keeps exactly the fields the product promises to restore --
//     role, text, tool calls, and the tool result each call produced. Attachments,
//     activity messages and provider-internal encrypted payloads are NOT
//     persisted, so a reload cannot resurrect material the app never claimed to
//     keep.
//   * `toTransport` reconstructs a message the transport accepts from those fields
//     alone, so hydration can never depend on something only a live run had.

import type { Message } from "@ag-ui/client";
import type { AssistantMessageRole, AssistantMessageV1, AssistantToolCallV1 } from "./records";

/** The transport roles this app persists. Anything else is dropped on capture. */
const PERSISTED_ROLES: readonly string[] = ["user", "assistant", "tool", "reasoning"];

export function isPersistedRole(role: string): role is AssistantMessageRole {
  return PERSISTED_ROLES.includes(role);
}

/** Flatten the transport's string-or-parts content down to the persisted text. */
function readText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && (part as { type?: string }).type === "text"
        ? ((part as { text?: string }).text ?? "")
        : "",
    )
    .join("");
}

function readToolCalls(message: Message): AssistantToolCallV1[] | null {
  const calls = (message as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(calls) || calls.length === 0) return null;
  return calls.map((call) => {
    const raw = call as { id?: string; function?: { name?: string; arguments?: string } };
    return {
      toolCallId: raw.id ?? "",
      name: raw.function?.name ?? "",
      args: raw.function?.arguments ?? "",
    };
  });
}

export interface CanonicalizeContext {
  threadId: string;
  scenarioId: string;
  /** The model that produced the turn, recorded per message. */
  modelId: string | null;
  turnId: string | null;
  createdAt: string;
}

/**
 * Project one transport message onto a canonical record, or `null` when the role
 * is not one this app persists.
 *
 * `seq` is assigned by the history repository inside its write transaction, not
 * here: only the transaction can allocate an ordering that two concurrent appends
 * cannot both claim.
 */
export function toCanonical(
  message: Message,
  context: CanonicalizeContext,
): Omit<AssistantMessageV1, "seq"> | null {
  if (!isPersistedRole(message.role)) return null;
  return {
    messageId: message.id,
    schemaVersion: 1,
    threadId: context.threadId,
    scenarioId: context.scenarioId,
    role: message.role,
    content: readText((message as { content?: unknown }).content),
    toolCalls: readToolCalls(message),
    toolCallId: (message as { toolCallId?: string }).toolCallId ?? null,
    modelId: context.modelId,
    turnId: context.turnId,
    createdAt: context.createdAt,
  };
}

/** Rebuild the transport message a hydrated thread replays. */
export function toTransport(record: AssistantMessageV1): Message {
  switch (record.role) {
    case "user":
      return { id: record.messageId, role: "user", content: record.content };
    case "tool":
      return {
        id: record.messageId,
        role: "tool",
        content: record.content,
        toolCallId: record.toolCallId ?? "",
      };
    case "reasoning":
      return { id: record.messageId, role: "reasoning", content: record.content };
    case "assistant":
      return {
        id: record.messageId,
        role: "assistant",
        content: record.content,
        ...(record.toolCalls
          ? {
              toolCalls: record.toolCalls.map((call) => ({
                id: call.toolCallId,
                type: "function" as const,
                function: { name: call.name, arguments: call.args },
              })),
            }
          : {}),
      };
  }
}

/** Hydration input for the agent: canonical order, transport shape. */
export function toTransportThread(records: readonly AssistantMessageV1[]): Message[] {
  return [...records].sort((a, b) => a.seq - b.seq).map(toTransport);
}
