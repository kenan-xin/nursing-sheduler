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
import {
  configurationIdentity,
  isAssistantReady,
  type AssistantSettingsV1,
  type AssistantThreadV1,
} from "./records";
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
  | "cleared"
  /**
   * The authority this send was prepared under no longer holds.
   *
   * Distinct from every refusal above because it is the only one that can be true
   * AFTER a send passed the gate: preparation awaits durable reads, and the
   * configuration, the scenario identity, the document revision, the lease or the
   * turn epoch can all change while it does. See {@link authorizeLaunchAuthority}.
   */
  | "revoked";

export interface SendPlan extends AssistantGenerationPair {
  threadId: string;
  scenarioId: string;
  documentRevision: number;
  leaseEpoch: number;
  modelId: string;
  /**
   * A non-secret fingerprint of the Ready configuration this turn was prepared
   * against (see `records.configurationIdentity`). Compared again at launch, so a key
   * or model replaced during preparation revokes the turn instead of running under a
   * configuration the user has already discarded.
   */
  configurationIdentity: string;
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
      configurationIdentity: configurationIdentity(settings),
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
    case "revoked":
      return (
        "That message was not sent: the assistant's setup, this schedule, or this tab's " +
        "editing access changed while it was being prepared. Nothing was sent — try again."
      );
    case "empty_message":
      return "Type a message first.";
  }
}

// ---------------------------------------------------------------------------
// The final launch authorization (step 8 of the send order)
// ---------------------------------------------------------------------------
//
// PREPARATION IS NOT AUTHORISATION. Steps 1-5 read durable state, and every one of
// those reads is an `await` -- a window in which the user can press Stop, turn AI
// off, Remove the key, Clear, switch schedule, lose the lease, or be taken over by
// another tab. A gate that only ran at the top would therefore let a revoked turn
// reach the provider, and no generation fence can recall a request already sent.
//
// So the launch is re-authorised against everything the turn CAPTURED, in three
// parts:
//
//   * {@link authorizeLaunchAuthority} rereads the durable facts -- configuration,
//     ownership, thread, turn -- and compares them to the plan;
//   * {@link claimLaunchAuthority} takes the actual LAUNCH CLAIM: the persisted
//     writer, lease epoch and revision, reread after the send's last durable write
//     so that write is not itself a window;
//   * {@link authorizeLaunchIdentity} is PURE and SYNCHRONOUS, so the caller can run
//     it as the last thing before `runAgent` with no `await` in between. It compares
//     BOTH that claim and the live authority projection. That is the atomicity that
//     matters: the interruption controller closes the gate synchronously and a
//     same-tab commit publishes to the projection synchronously, so a check with no
//     microtask boundary after it cannot be overtaken by either.
//
// The division is not decorative. A durable read is a moment in the PAST by the time
// its promise resolves, so a claim on its own can only say the basis was current when
// it was read; only the synchronous projection comparison can say it has not moved
// since. Neither half is sufficient: the projection is published by this tab, so a
// lease that advanced in another tab is visible only to the persisted claim.

export type LaunchAuthorization = { ok: true } | { ok: false; reason: SendRefusal };

/**
 * The authority facts the app can read WITHOUT an `await`.
 *
 * Deliberately structural rather than the store's own state shape: this module is
 * pure and injected, and what it needs is three comparisons, not a projection.
 */
export interface LiveAuthorityProjection {
  /** The scenario the projection currently describes, or `null` before selection. */
  scenarioId: string | null;
  /** That projection's committed document revision. */
  documentRevision: number;
  /** Whether the projection still reports this tab as the scenario's writer. */
  isOwner: boolean;
}

/** Everything about a launch that is sampled live, in one expression. */
export interface LaunchLiveInput {
  plan: SendPlan;
  /** The thread the panel making this send is bound to. */
  boundThreadId: string;
  /** The live turn epoch, read at the moment of the check. */
  liveTurnEpoch: number;
  /** Whether an interruption has been requested and has not settled. */
  interrupting: boolean;
  /** Whether the agent already has a run in flight. */
  busy: boolean;
  /** The run currently published for interruption to target, or `null`. */
  activeRunId: string | null;
  /** Scenario, revision and ownership as the app projects them right now. */
  live: LiveAuthorityProjection;
}

export interface LaunchIdentityInput extends LaunchLiveInput {
  /**
   * The persisted writer authority this launch claims under -- the result of the
   * final {@link claimLaunchAuthority}, never a remembered earlier read.
   */
  claim: WriterContext | null;
}

export interface LaunchAuthorityDeps {
  readSettings(): Promise<AssistantSettingsV1>;
  readWriterContext(): Promise<WriterContext | null>;
  readThread(threadId: string): Promise<AssistantThreadV1 | null>;
  readTurn(turnId: string): Promise<AssistantTurnV1 | null>;
}

export interface LaunchClaimDeps {
  readWriterContext(): Promise<WriterContext | null>;
}

export type LaunchClaim = { ok: true; writer: WriterContext } | { ok: false; reason: SendRefusal };

/** Compare persisted writer authority to the authority the turn was prepared under. */
function matchWriterAuthority(plan: SendPlan, writer: WriterContext | null): LaunchAuthorization {
  if (!writer) return { ok: false, reason: "not_writer" };
  if (writer.scenarioId !== plan.scenarioId) return { ok: false, reason: "not_writer" };
  // The lease EPOCH, not just ownership: a takeover followed by a takeover back would
  // leave this tab owning the scenario again under a fencing token the turn never saw.
  if (writer.leaseEpoch !== plan.leaseEpoch) return { ok: false, reason: "not_writer" };
  // The context this turn is about to send describes the document at the revision it
  // was read at. A commit landing during preparation makes that description stale.
  if (writer.documentRevision !== plan.documentRevision) return { ok: false, reason: "revoked" };
  return { ok: true };
}

/**
 * Take the launch claim: reread the persisted writer authority AFTER the send's last
 * durable write, and return it for the synchronous check to compare.
 *
 * Separate from {@link authorizeLaunchAuthority} because of WHEN it runs, not what it
 * checks. That function's writer read is followed by the thread read, the turn read
 * and the streaming-state write -- three awaits in which an ordinary same-tab commit
 * can publish a new revision or a peer's takeover can advance the lease, neither of
 * which disturbs the turn, the epoch or any interruption state. This is the reread
 * with nothing durable left after it.
 */
export async function claimLaunchAuthority(
  plan: SendPlan,
  deps: LaunchClaimDeps,
): Promise<LaunchClaim> {
  const writer = await deps.readWriterContext();
  if (!writer) return { ok: false, reason: "not_writer" };
  const matched = matchWriterAuthority(plan, writer);
  return matched.ok ? { ok: true, writer } : matched;
}

/**
 * Every identity fact a turn is bound to, compared in one place. No `await`, by
 * contract.
 *
 * SHARED BY THE LAUNCH AND EVERYTHING AFTER IT. The initial provider hop, each
 * follow-up hop CopilotKit drives after a tool, and every tool handler before and
 * after each of its awaits all ask the same question: "is this still the turn the app
 * authorised?" Splitting that into per-call-site checks is how the epoch-only tool
 * guards came to miss a lease takeover and a document revision, so there is exactly
 * one implementation and the launch simply adds its own race checks on top.
 */
export function authorizeBoundIdentity(input: LaunchIdentityInput): LaunchAuthorization {
  const { plan, live } = input;

  // The scenario can have changed under an open panel, in which case the gate
  // selected a different thread than this component is bound to. Sending this
  // document's question into the previous document's conversation is the one thing
  // the scenario boundary exists to prevent.
  if (plan.threadId !== input.boundThreadId) return { ok: false, reason: "not_writer" };

  // The claim is re-compared HERE rather than trusted from where it was read. This
  // function is the last thing that happens before the provider, so every durable fact
  // the run depends on has to be one of its own comparisons -- otherwise "the claim
  // passed" and "the launch is authorised" are two separate statements with an await
  // between them, which is exactly the window this exists to remove.
  const claimed = matchWriterAuthority(plan, input.claim);
  if (!claimed.ok) return claimed;

  // The same facts as the app projects them RIGHT NOW. A same-tab commit publishes
  // here the moment it lands, so this is the only comparison that can see a document
  // that moved after the claim's read resolved.
  if (!live.isOwner) return { ok: false, reason: "not_writer" };
  if (live.scenarioId !== plan.scenarioId) return { ok: false, reason: "not_writer" };
  if (live.documentRevision !== plan.documentRevision) return { ok: false, reason: "revoked" };

  if (input.interrupting) return { ok: false, reason: "interrupting" };
  // Any epoch movement -- an interruption that has already settled, or a competing
  // claim -- means this turn is no longer the live one.
  if (input.liveTurnEpoch !== plan.turnEpoch) return { ok: false, reason: "revoked" };
  // A published run that is not this one means another send won the race. True at
  // launch and equally true mid-turn, so it belongs to the shared identity rather
  // than to the launch-only checks below.
  if (input.activeRunId !== null && input.activeRunId !== plan.runId) {
    return { ok: false, reason: "busy" };
  }
  return { ok: true };
}

/**
 * The synchronous half of the FINAL LAUNCH authorization. No `await`, by contract.
 *
 * The bound identity plus the one check that is meaningful only before a run exists:
 * `busy` asks whether the agent is already running, which is a launch race. Asking it
 * of a follow-up hop or a tool handler would refuse every one of them, because by
 * then the agent is running THIS turn -- and "is it ours?" is already answered by the
 * `activeRunId` comparison above.
 */
export function authorizeLaunchIdentity(input: LaunchIdentityInput): LaunchAuthorization {
  const bound = authorizeBoundIdentity(input);
  if (!bound.ok) return bound;
  if (input.busy) return { ok: false, reason: "busy" };
  return { ok: true };
}

/**
 * Reread every durable fact the turn was bound to and compare it to the plan.
 *
 * Finishes with {@link authorizeLaunchIdentity} so a single call is a complete
 * answer; the caller still repeats the synchronous half immediately before the run,
 * because these rereads are themselves awaits.
 */
export async function authorizeLaunchAuthority(
  input: LaunchLiveInput,
  deps: LaunchAuthorityDeps,
): Promise<LaunchAuthorization> {
  const { plan } = input;

  const settings = await deps.readSettings();
  if (!isAssistantReady(settings)) return { ok: false, reason: "not_ready" };
  // Not just "still Ready": still the SAME Ready configuration. A replaced key or
  // model is a different configuration, and running under it would send this turn to
  // a provider account the user swapped out mid-preparation.
  if (configurationIdentity(settings) !== plan.configurationIdentity) {
    return { ok: false, reason: "revoked" };
  }

  const writer = await deps.readWriterContext();
  const claimed = matchWriterAuthority(plan, writer);
  if (!claimed.ok) return claimed;

  const thread = await deps.readThread(plan.threadId);
  if (!thread || thread.state !== "active") return { ok: false, reason: "cleared" };

  const turn = await deps.readTurn(plan.turn.turnId);
  // A missing turn means a clear's deletion pass already took it; an already-settled
  // one means an interruption owns its terminal story. Either way this send is over.
  if (!turn) return { ok: false, reason: "cleared" };
  if (turn.state !== "preparing") return { ok: false, reason: "revoked" };
  if (turn.turnEpoch !== plan.turnEpoch) return { ok: false, reason: "revoked" };

  return authorizeLaunchIdentity({ ...input, claim: writer });
}
