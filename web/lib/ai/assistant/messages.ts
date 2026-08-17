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
import type { AssistantGenerationPair } from "./fence";
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

export interface CanonicalizeContext extends AssistantGenerationPair {
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
    // Stamped from the turn's capture, not reread here: the point of the fence is
    // that a record carries the generations its TURN was authorised under, so a
    // late write cannot re-capture a generation a clear has since moved.
    globalGeneration: context.globalGeneration,
    scenarioGeneration: context.scenarioGeneration,
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

/**
 * A deep, immutable copy of a message list.
 *
 * The persistence queue captures what a boundary authorized and may not run for some
 * time, and the objects it captures belong to the live agent -- CopilotKit grows a
 * message's content, a tool call's arguments and a result's payload in place as a run
 * proceeds. Copying the array alone leaves every one of those reachable, so the bytes
 * committed would be the bytes at write time rather than at authorization time.
 *
 * Cloned first so the freeze cannot reach the agent's own objects -- freezing those
 * would break the transport -- then frozen, so a later mutation of the captured copy
 * fails loudly in the suites instead of silently rewriting a queued payload.
 */
export function freezeMessages(messages: readonly Message[]): readonly Message[] {
  return Object.freeze(structuredClone(messages as Message[]).map(deepFreeze));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/**
 * Only the messages that form COMPLETE tool call/result pairs.
 *
 * WHY PUBLICATION NEEDS THIS. CopilotKit emits `TOOL_CALL_END` when the model has
 * finished ASKING for a tool -- before the frontend handler runs, and therefore long
 * before a result exists. That boundary is the right moment to persist a settled
 * message, but the list at that instant contains an assistant message whose tool call
 * has no answer. Writing it makes an incomplete call canonical: the panel shows a
 * question with no reply, and -- far worse -- the NEXT turn hydrates it and sends a
 * dangling call back to the provider as though the model had already asked it.
 *
 * A turn that is stopped mid-tool is exactly when that happens, so the incompleteness
 * is not a transient the next boundary tidies up: it is what a stopped turn leaves
 * behind permanently.
 *
 * SANITIZATION RATHER THAN A TIMING GUARD, deliberately. A check before the write
 * cannot retract a write already in flight, and the window is real. Filtering the
 * PAYLOAD means an incomplete pair is never in a write at all -- there is no ordering
 * in which one can commit, so no race to lose.
 *
 * The clone keeps everything: CopilotKit's own in-turn processing and streaming see
 * the unfiltered list, and a call still waiting for its handler is perfectly valid
 * mid-turn. This governs only what becomes canonical or visible.
 */
export function completeToolPairs(messages: readonly Message[]): Message[] {
  type Call = { id: string; owner: number; valid: boolean; resultAt: number | null };

  // --- Pass 1: declare calls, IN ORDER, claiming each id exactly once ------
  //
  // A second message declaring an id an earlier one already used is not a second
  // question -- there is no way to tell which of them a single answer belongs to, so
  // the later declaration is unusable.
  const declared = new Map<string, Call>();
  const callsOf = new Map<number, Call[]>();
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    const raw = (message as { toolCalls?: { id?: string }[] }).toolCalls;
    if (!raw || raw.length === 0) return;
    const mine: Call[] = [];
    for (const call of raw) {
      const id = call.id ?? "";
      // An empty id can never be matched to a result, and a duplicate cannot be
      // matched unambiguously. Both are recorded as unusable rather than skipped, so
      // the message that owns them is stripped rather than silently kept.
      if (id === "" || declared.has(id)) {
        mine.push({ id, owner: index, valid: false, resultAt: null });
        continue;
      }
      const entry: Call = { id, owner: index, valid: true, resultAt: null };
      declared.set(id, entry);
      mine.push(entry);
    }
    callsOf.set(index, mine);
  });

  // --- Pass 2: match results, IN ORDER, one per call ----------------------
  //
  // A result only answers a call that came BEFORE it: a provider replaying history
  // reads an answer preceding its question as malformed, and so should we. The first
  // eligible result claims the call; any later one is a duplicate.
  const matcher = new Map<number, Call>();
  messages.forEach((message, index) => {
    if (message.role !== "tool") return;
    const id = (message as { toolCallId?: string }).toolCallId ?? "";
    const call = id === "" ? undefined : declared.get(id);
    if (!call || !call.valid || call.owner >= index || call.resultAt !== null) return;
    call.resultAt = index;
    matcher.set(index, call);
  });

  // --- Emit, preserving order --------------------------------------------
  const complete: Message[] = [];
  messages.forEach((message, index) => {
    if (message.role === "tool") {
      // Kept only if it is THE matcher for a call whose message survives below.
      const call = matcher.get(index);
      const owner = call ? callsOf.get(call.owner) : undefined;
      if (call && owner && owner.every((entry) => entry.valid && entry.resultAt !== null)) {
        complete.push(message);
      }
      return;
    }

    const mine = message.role === "assistant" ? callsOf.get(index) : undefined;
    if (!mine) {
      complete.push(message);
      return;
    }

    // All or nothing per message: a message carrying two calls of which one is
    // unanswered is as unusable to a provider as one carrying a single unanswered call.
    if (mine.every((call) => call.valid && call.resultAt !== null)) {
      complete.push(message);
      return;
    }

    // AG-UI permits `content` alongside `toolCalls`, so an unusable call must not cost
    // the user the sentence the assistant actually said. Cloned without the tool
    // metadata rather than mutated -- the clone's own list is CopilotKit's.
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string" && content.trim() !== "") {
      const { toolCalls: _dropped, ...rest } = message as Message & { toolCalls?: unknown };
      complete.push(rest as Message);
    }
  });

  return complete;
}

/** Hydration input for the agent: canonical order, transport shape. */
export function toTransportThread(records: readonly AssistantMessageV1[]): Message[] {
  return [...records].sort((a, b) => a.seq - b.seq).map(toTransport);
}
