// The pre-send gate (T04, tech-plan "CopilotKit UI and browser controller").
//
// This is the reason the app composes CopilotKit's prebuilt view primitives
// instead of using the high-level `CopilotChat`: that component owns submission,
// and submission is precisely where this ordered set of checks has to happen.
//
// The order is load-bearing, not stylistic:
//
//   1. READY first, so a disabled or keyless app never reaches the network at all.
//   2. OWNERSHIP from persisted state, so a taken-over tab cannot send.
//   3. THREAD selected by the envelope's scenario id, so the conversation cannot
//      be the previous document's.
//   4. HYDRATE from canonical local messages, so what the model sees is what the
//      user sees after a reload -- not an empty agent instance.
//   5. TURN persisted as `preparing` BEFORE the run, so a send that dies between
//      here and the runtime is a visible unsettled fact rather than nothing.
//   6. CONTEXT attached from the reread envelope.
//   7. USER MESSAGE added locally, so it survives a failed start.
//   8. RUN, and only then `streaming`.
//
// Steps 1-5 are this module (pure, injected, no React and no agent). Steps 6-8 are
// the hook that owns the agent instance, which cannot be exercised without one.
// Splitting there is what makes the refusal matrix unit-testable.

import type { ScenarioUiState } from "@/lib/scenario";
import type { AssistantGenerationPair } from "./fence";
import { isAssistantReady, type AssistantSettingsV1, type AssistantThreadV1 } from "./records";
import type { AssistantMessageV1, AssistantTurnV1 } from "./records";
import type { WriterContext } from "./writer-context";

/** Why a send was refused. Each maps to one piece of user-facing guidance. */
export type SendRefusal =
  /** AI is off, or no probe-passed key/model is stored. */
  | "not_ready"
  /** No scenario is selected, or this tab does not own scenario editing. */
  | "not_writer"
  /** The typed text was empty or whitespace. */
  | "empty_message"
  /** A turn is already in flight on this thread. */
  | "busy"
  /** An interruption has closed the gate and has not finished settling. */
  | "interrupting"
  /** The thread this send would append to has been cleared. */
  | "cleared";

export interface SendPlan extends AssistantGenerationPair {
  threadId: string;
  scenarioId: string;
  documentRevision: number;
  leaseEpoch: number;
  modelId: string;
  runId: string;
  turnEpoch: number;
  turn: AssistantTurnV1;
  /** Canonical history to hydrate the agent with BEFORE the user's message. */
  history: AssistantMessageV1[];
  /** The reread persisted scenario this turn's context is built from. */
  scenario: ScenarioUiState;
  /** The trimmed text to add locally and send. */
  text: string;
}

export type SendPreparation = { ok: true; plan: SendPlan } | { ok: false; reason: SendRefusal };

export interface PrepareSendDeps {
  readSettings(): Promise<AssistantSettingsV1>;
  readWriterContext(): Promise<WriterContext | null>;
  selectActiveThread(scenarioId: string): Promise<AssistantThreadV1>;
  readThreadMessages(threadId: string): Promise<AssistantMessageV1[]>;
  recordPreparingTurn(input: {
    threadId: string;
    scenarioId: string;
    basisDocumentRevision: number;
    leaseEpoch: number;
    modelId: string;
    runId: string;
    turnEpoch: number;
    runtimeInstanceId: string | null;
  }): Promise<AssistantTurnV1 | null>;
  newRunId(): string;
  /** The launch-scoped runtime instance, when `/info` has already reported one. */
  runtimeInstanceId(): string | null;
}

export interface PrepareSendInput {
  text: string;
  /** The next monotonic turn epoch for this thread. */
  turnEpoch: number;
  /** Whether a turn is already streaming on this thread. */
  busy: boolean;
  /**
   * Whether an interruption has closed the gate and not yet settled.
   *
   * Checked HERE rather than left to readiness, because the two most important
   * interruptions -- Stop and Clear history -- leave a perfectly Ready configuration
   * behind. Without this a user could re-send into a thread that is mid-settlement or
   * mid-deletion.
   */
  interrupting: boolean;
}

/**
 * Steps 1-5 of the send order. Performs no network call and touches no agent, so a
 * refusal is provably free of provider contact.
 */
export async function prepareSend(
  input: PrepareSendInput,
  deps: PrepareSendDeps,
): Promise<SendPreparation> {
  const text = input.text.trim();
  if (text.length === 0) return { ok: false, reason: "empty_message" };
  if (input.busy) return { ok: false, reason: "busy" };
  if (input.interrupting) return { ok: false, reason: "interrupting" };

  const settings = await deps.readSettings();
  if (!isAssistantReady(settings)) return { ok: false, reason: "not_ready" };

  const writer = await deps.readWriterContext();
  if (!writer) return { ok: false, reason: "not_writer" };

  // The thread is chosen by the envelope's identity, never by a remembered id: if
  // the scenario changed under an open panel, this is where the conversation
  // switches with it instead of continuing the previous document's thread.
  const thread = await deps.selectActiveThread(writer.scenarioId);
  const history = await deps.readThreadMessages(thread.threadId);

  const runId = deps.newRunId();
  const turn = await deps.recordPreparingTurn({
    threadId: thread.threadId,
    scenarioId: writer.scenarioId,
    basisDocumentRevision: writer.documentRevision,
    leaseEpoch: writer.leaseEpoch,
    modelId: settings.modelId,
    runId,
    turnEpoch: input.turnEpoch,
    runtimeInstanceId: deps.runtimeInstanceId(),
  });
  // `null` means the thread was cleared between selection and the turn write. The
  // send is refused rather than resurrecting a doomed thread -- and, critically, no
  // provider contact has happened yet at this point in the order.
  if (!turn) return { ok: false, reason: "cleared" };

  return {
    ok: true,
    plan: {
      threadId: thread.threadId,
      scenarioId: writer.scenarioId,
      documentRevision: writer.documentRevision,
      leaseEpoch: writer.leaseEpoch,
      modelId: settings.modelId,
      runId,
      turnEpoch: input.turnEpoch,
      turn,
      history,
      scenario: writer.scenario,
      // Taken from the TURN row, which captured them inside its own write
      // transaction. Every message and turn-state write for this send carries these
      // exact values, so a clear that lands mid-turn fences all of them.
      globalGeneration: turn.globalGeneration,
      scenarioGeneration: turn.scenarioGeneration,
      text,
    },
  };
}

/** User-facing guidance for a refusal. Never mentions the credential. */
export function describeRefusal(reason: SendRefusal): string {
  switch (reason) {
    case "not_ready":
      return "Turn on AI features and save a tested OpenRouter key in Settings before sending.";
    case "not_writer":
      return "This tab is not editing the schedule. Take over editing in this tab to use the assistant.";
    case "busy":
      return "The assistant is still answering. Stop the current reply before sending another message.";
    case "interrupting":
      return "The assistant is still stopping the previous reply. Wait for it to settle, then send again.";
    case "cleared":
      return "This conversation was cleared. Reopen the assistant to start a new one.";
    case "empty_message":
      return "Type a message first.";
  }
}
