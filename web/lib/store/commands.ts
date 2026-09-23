// The scenario command bus (T03) — the ONLY mutation surface the application has.
//
// Every durable scenario change in the app calls one of these. There is no store
// setter to reach for instead: the projection is actions-free, and the adapter
// that publishes into it is private to `authority.ts`.
//
// SHAPE. Each command returns a promise, but call sites are free to ignore it:
// the UI reacts to the projection, which changes when (and only when) the commit
// lands. Tests await `drainScenarioCommands()` — or the returned promise — to
// observe a settled durable state.
//
// ORDERING. Commands are serialized by the controller, so an updater-form patch is
// resolved against the state the previous command committed. Two rapid edits can
// therefore never both read the same revision and race their compare-and-swap.

import type { ScenarioUiState, UiRequestCell } from "@/lib/scenario";
// The durable DTO types come through the ADAPTER, not from `@/lib/repository`:
// only the adapter may name that module (`authority-boundary.test.ts`), and a
// type-only re-export through it keeps the command bus on the right side of the
// boundary without anybody having to widen the allow-list.
import type {
  ApplyAssistantProposalOutcome,
  AssistantProposalV1,
  AssistantScenarioBasis,
  CommandOutcome,
  PrepareAssistantProposalInput,
  PrepareAssistantProposalOutcome,
  ReceiptStanding,
} from "./authority";
import { getScenarioAuthority, useHotStore } from "./spine";

/**
 * The typed scenario command surface. Named for the manual operations they
 * replace, so the cutover is legible at every call site that used to hold a
 * store setter.
 */
export const scenarioCommands = {
  /**
   * One tracked editor mutation — the former `mutateScenario`.
   *
   * The updater form runs when the command reaches the head of the queue, against
   * the state the previous command committed. Returning `null` from it ABORTS the
   * write (no commit, no revision, no history entry) — which is how a caller
   * refuses a patch whose baseline moved under it.
   */
  mutate(
    patch: Partial<ScenarioUiState> | ((state: ScenarioUiState) => Partial<ScenarioUiState> | null),
  ): Promise<CommandOutcome> {
    return getScenarioAuthority().mutate(patch);
  },

  /** The atomic person×date matrix write — the former `setReqData`. */
  setReqData(
    reqData: UiRequestCell[] | ((state: ScenarioUiState) => UiRequestCell[]),
  ): Promise<CommandOutcome> {
    return getScenarioAuthority().setReqData(reqData);
  },

  /**
   * Record the emitted Workspace backup — the former `recordBackup`. Metadata
   * only: it advances `recordRevision`, writes no commit fact, and is not undoable.
   *
   * Takes the fingerprint of the bytes the caller EMITTED, so backup currentness
   * describes the document the user actually downloaded rather than whatever the
   * projection holds by the time the command reaches the queue head.
   */
  recordBackup(backupFingerprint: string): Promise<CommandOutcome> {
    return getScenarioAuthority().recordBackup(backupFingerprint);
  },

  /** Undo/Redo as monotonic repository commits (the former zundo `temporal`). */
  undo(): Promise<CommandOutcome> {
    return getScenarioAuthority().undo();
  },

  redo(): Promise<CommandOutcome> {
    return getScenarioAuthority().redo();
  },

  /** Seize the selected scenario's lease after an explicit user confirmation. */
  takeover(): Promise<CommandOutcome> {
    return getScenarioAuthority().takeover();
  },

  /** Release the lease so a peer tab need not wait out the expiry. */
  release(): Promise<void> {
    return getScenarioAuthority().release();
  },

  /** Reread persisted selection/envelope/lease and reconcile ownership. */
  reconcile(): Promise<void> {
    return getScenarioAuthority().reconcile();
  },
} as const;

/**
 * The assistant's ENTIRE durable surface (T07).
 *
 * Deliberately separate from `scenarioCommands`, and deliberately not a superset of
 * it: there is no `mutate`, no `setReqData`, no generic `undo`/`redo` here, so an
 * assistant module cannot reach the arbitrary mutation primitives even by accident.
 * `lib/ai/independence.test.ts` pins that -- it forbids the assistant from naming
 * `scenarioCommands.mutate|setReqData|undo|redo`, and these named operations are
 * what it may use instead.
 *
 * Every one goes through the same adapter, the same serial queue and the same
 * fences as a manual edit. Apply is on this list because it is a HOST action the
 * user takes; it is not, and cannot become, a model tool.
 */
export const assistantProposalCommands = {
  /** The persisted basis a Preview binds to and Apply is re-checked against. */
  readScenarioBasis(): Promise<AssistantScenarioBasis | null> {
    return getScenarioAuthority().readAssistantScenarioBasis();
  },

  /** Validate typed commands against the persisted document and persist a proposal. */
  prepare(input: PrepareAssistantProposalInput): Promise<PrepareAssistantProposalOutcome> {
    return getScenarioAuthority().prepareAssistantProposal(input);
  },

  confirm(input: {
    proposalId: string;
    assumptionId: string;
  }): Promise<PrepareAssistantProposalOutcome> {
    return getScenarioAuthority().recordAssistantConfirmation(input);
  },

  withdrawConfirmation(input: {
    proposalId: string;
    assumptionId: string;
  }): Promise<PrepareAssistantProposalOutcome> {
    return getScenarioAuthority().withdrawAssistantConfirmation(input);
  },

  cancel(proposalId: string): Promise<PrepareAssistantProposalOutcome> {
    return getScenarioAuthority().cancelAssistantProposal(proposalId);
  },

  markStale(proposalId: string): Promise<PrepareAssistantProposalOutcome> {
    return getScenarioAuthority().markAssistantProposalStale(proposalId);
  },

  /** THE Apply. One durable transaction; publication only after it commits. */
  apply(input: { proposalId: string; receiptId: string }): Promise<ApplyAssistantProposalOutcome> {
    return getScenarioAuthority().applyAssistantProposal(input);
  },

  /** Undo one receipt's change, as a new atomic commit. */
  undoReceipt(receiptId: string): Promise<CommandOutcome> {
    return getScenarioAuthority().undoAssistantReceipt(receiptId);
  },

  read(proposalId: string): Promise<AssistantProposalV1 | null> {
    return getScenarioAuthority().readAssistantProposal(proposalId);
  },

  /** Receipts for the selected scenario, newest first, with current Undo standing. */
  describeReceipts(): Promise<ReceiptStanding[]> {
    return getScenarioAuthority().describeAssistantReceipts();
  },
} as const;

/**
 * The open editor draft that blocks Apply, or `null`.
 *
 * An unsaved form draft over the same document is a change the user has started and
 * not committed; applying over it would either lose it or produce a document neither
 * the form nor the Preview describes. The panel names it and asks for a decision --
 * which is why this returns the draft's key rather than a boolean.
 */
export function readConflictingEditorDraft(): string | null {
  const drafts = Object.keys(useHotStore.getState().drafts);
  return drafts.length > 0 ? drafts[0] : null;
}

/** Resolve once every queued command has settled. */
export function drainScenarioCommands(): Promise<void> {
  return getScenarioAuthority().drain();
}

/**
 * The durable Undo depth. Exposed for the browser test bridge, where a spec
 * asserts "this action added exactly one Undo step" — a count the boolean
 * `canUndo` cannot express.
 */
export function readScenarioHistoryDepth(): Promise<number> {
  return getScenarioAuthority().readHistoryDepth();
}

/**
 * The authoritative scenario identity/revision for an ordinary Optimize preflight.
 * Read from PERSISTED state rather than the projection, so a submission can never
 * be labelled with a revision this tab merely believed it held.
 */
export function readAuthoritativeScenarioIdentity(): Promise<{
  scenarioId: string;
  documentRevision: number;
  recordRevision: number;
} | null> {
  return getScenarioAuthority().readAuthoritativeIdentity();
}

/**
 * The authoritative ownership the final pre-submit Optimize gate binds to.
 *
 * Reads the persisted tab context — the live lease — rather than the projected
 * `ownership`, so a takeover whose hint was missed cannot let a former owner
 * submit. `isOwner` is true ONLY when a live persisted lease on the exact
 * selected scenario names this tab.
 */
export function readAuthoritativeScenarioOwnership(): Promise<{
  scenarioId: string;
  documentRevision: number;
  recordRevision: number;
  isOwner: boolean;
} | null> {
  return getScenarioAuthority().readAuthoritativeOwnership();
}
