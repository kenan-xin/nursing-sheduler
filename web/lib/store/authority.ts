// The repository/projection adapter (T03) — the ONE module that may bridge the
// transactional repository (T02) and the live Zustand projection.
//
// AUTHORITY DIRECTION. Before T03 the direction was inverted: a component called
// `mutateScenario`, Zustand `set` ran synchronously, and `persist` wrote behind
// it. The write could not report failure to the action that caused it, and its
// revision guard was process-local, so a second tab silently overwrote the first.
//
// Now every durable change is a typed repository command:
//
//     command → serialized queue → repository transaction (fenced) → projection
//
// The projection changes ONLY after the transaction commits. A validation,
// ownership, or IndexedDB failure therefore leaves the committed live state
// exactly as it was — there is no optimistic state to roll back, because none was
// ever published.
//
// WHY A QUEUE. Commands carry an `expectedDocumentRevision` compare-and-swap.
// Overlapping in-flight commits would all read the same revision and all but one
// would fail spuriously. Serializing them also fixes the updater form: a
// `(state) => patch` callback is resolved when its turn comes, against the state
// the PREVIOUS command committed, not against whatever was on screen when the
// user clicked.
//
// WHY NO ZUNDO. zundo's stack lives in one tab's process memory. It cannot be
// written in the same transaction as the change it reverses, cannot survive a
// reload, and cannot be checked against a durable revision — so "Undo available"
// could describe a stack another tab already invalidated. Undo/Redo are now
// repository commits (`repository.undo()` / `.redo()`), and availability is
// derived from persisted commit facts, which is what makes "you can no longer
// undo this" truthful after a reload or a history eviction.
//
// FORBIDDEN-SURFACE GATE. `forbidden-surface.test.ts` asserts that no module
// outside this one imports `@/lib/repository`, calls `useScenarioStore.setState`,
// or touches `.temporal`. That test is the enforcement; this comment is only its
// rationale.

import { create } from "zustand";
import {
  createScenarioRepository,
  GLOBAL_GENERATION_SCOPE,
  isRepositoryError,
  migrateLegacyScenarioRecord,
  NurseSchedulerDb,
  RepositoryError,
  type AssistantProposalV1,
  type AssistantReceiptV1,
  type CapturedGeneration,
  type DiagnosticSearchRecordV1,
  type GenerationScopeKey,
  type LeaseOwner,
  type ReceiptStanding,
  type RepositoryErrorCode,
  type ScenarioCommandV1,
  type ScenarioEnvelopeV3,
  type ScenarioRepository,
} from "@/lib/repository";
import {
  deriveIdempotencyKey,
  prepareProposal,
  type AssistantCommandV1,
  type CommandRejection,
  type EvidenceReference,
  type OperationalConfirmationV1,
  type ProposalOutcome,
} from "@/lib/proposal";
import type { CapabilityRegistryStamp } from "@/lib/capability/types";
import type { ScenarioUiState, UiRequestCell } from "@/lib/scenario";
// `planReap` is imported by its DEEP path, never through the `@/lib/optimize`
// barrel: the barrel pulls in the run controller, which imports `@/lib/store`, and
// that would close a require cycle. `basis/reaper` and `basis/basis-row` are pure
// leaves — no runtime imports at all — so this direction is safe.
import { planReap } from "@/lib/optimize/basis/reaper";
import {
  basisRowPayload,
  isOptimizeBasisRecordV2,
  withClearedBasisPayload,
  type OptimizeBasisRecordV2,
  type StoredOptimizeBasisRow,
} from "@/lib/optimize/basis/basis-row";
import type { ReapAction as OptimizeBasisReapAction } from "@/lib/optimize/basis/reaper";
import { pickScenario } from "./fingerprint";
import type { HotStore } from "./hot-store";
import type { ScenarioStore } from "./scenario-store";
import { shareStructure } from "./structural-share";

// ---------------------------------------------------------------------------
// Session-authority projection
// ---------------------------------------------------------------------------

/**
 * How this tab currently stands relative to the selected scenario's writer lease.
 *
 * The three non-owning states are deliberately distinct because they need
 * different recoveries and different honesty:
 *   • `read-only`  — someone else owns it; we never had it (or cleanly released).
 *   • `taken-over` — we DID own it and were superseded. In-flight work is dead.
 *   • `expired`    — our own lease lapsed (a frozen tab, a suspended machine).
 */
export type ScenarioOwnership = "unknown" | "owner" | "read-only" | "taken-over" | "expired";

/** The durable-write lifecycle, surfaced honestly instead of assumed successful. */
export type WriteStatus = "idle" | "writing" | "saved" | "error";

export interface AuthorityState {
  /** The scenario identity this tab has selected, once initialization resolves. */
  scenarioId: string | null;
  /** Content revision of the committed projection. Never moves backwards. */
  documentRevision: number;
  /** Envelope write revision — advances for metadata-only writes too. */
  recordRevision: number;
  ownership: ScenarioOwnership;
  /** The tab id currently holding the lease, when it is not us. */
  heldByTabId: string | null;
  /** Derived from persisted commit facts, never from a process-memory stack. */
  canUndo: boolean;
  canRedo: boolean;
  writeStatus: WriteStatus;
  lastErrorCode: RepositoryErrorCode | "unknown" | null;
  /**
   * Set when a durable commit succeeded but publishing to the projection failed.
   * The change IS saved; the view is not trustworthy until a reload. Reported as
   * "committed, reload required", never as a failed write.
   */
  reloadRequired: boolean;
}

const INITIAL_AUTHORITY_STATE: AuthorityState = {
  scenarioId: null,
  documentRevision: 0,
  recordRevision: 0,
  ownership: "unknown",
  heldByTabId: null,
  canUndo: false,
  canRedo: false,
  writeStatus: "idle",
  lastErrorCode: null,
  reloadRequired: false,
};

/**
 * Build a session-authority projection. A factory so a test can simulate a second
 * tab with its own view of ownership; the app uses the singleton below.
 */
export function createAuthorityStore() {
  return create<AuthorityState>()(() => ({ ...INITIAL_AUTHORITY_STATE }));
}

/**
 * The reactive session-authority projection: identity, revision, ownership, undo
 * availability, and write outcome. Separate from the scenario content store so an
 * ownership or heartbeat change does not re-render every editor bound to content.
 */
export const useAuthorityStore = createAuthorityStore();

/**
 * Whether this tab may currently issue a durable command.
 *
 * `reloadRequired` is a HARD FENCE, not a notice. It means a commit landed but the
 * projection could not be updated from it, so what is on screen no longer describes
 * the committed document. Every subsequent command would be computed from that
 * wrong view — an editor patch against stale cards, a whole-list replacement built
 * from a list that moved — and would commit successfully, quietly overwriting real
 * work. Nothing but an authoritative reload can clear it.
 */
export function canMutateScenario(state: AuthorityState = useAuthorityStore.getState()): boolean {
  return state.ownership === "owner" && state.scenarioId !== null && !state.reloadRequired;
}

// ---------------------------------------------------------------------------
// Failure surface
// ---------------------------------------------------------------------------

/** Why a command did not produce a durable commit. Every arm is actionable. */
export type CommandFailureReason =
  /** This tab does not (or no longer) holds the lease. Went read-only. */
  | "not-owner"
  /** The projection was behind the durable truth; it has been rereleased/reread. */
  | "stale"
  /** Nothing reversible/reapplyable remains — a reload or a history eviction. */
  | "history-unavailable"
  /** Authority is not initialized yet (pre-hydration). */
  | "not-ready"
  /** A commit landed but the view could not be updated; only a reload clears it. */
  | "reload-required"
  /** The caller's own baseline moved under it, so it withdrew its write. */
  | "superseded"
  /** The command's result was not a valid scenario document. */
  | "invalid"
  /** The persisted proposal is missing, settled, or not the one being applied. */
  | "proposal-conflict"
  /** An operational assumption has no confirmation for this proposal revision. */
  | "confirmation-missing"
  /** An assistant clear fenced the write. Not an error — the designed outcome. */
  | "fenced"
  /** The transaction itself failed (IndexedDB, quota). */
  | "write-failed";

/**
 * The result of a durable command.
 *
 * `committed` DISTINGUISHES A REAL WRITE FROM A NO-OP, and that distinction is
 * load-bearing for the caller. Previously both arrived as `{ok: true}`, so a card
 * editor could not tell "your duplicate was applied" from "your duplicate was
 * silently dropped because the list moved" — and reported success either way. A
 * caller that needs to know now branches on `committed`, and a genuinely empty
 * action (a drop back on the same slot) is still an honest success.
 */
export type CommandOutcome =
  | {
      ok: true;
      /** Whether a durable commit was actually written. */
      committed: boolean;
      documentRevision: number;
      commitId: string | null;
    }
  | { ok: false; reason: CommandFailureReason; code: RepositoryErrorCode | "unknown" };

// ---------------------------------------------------------------------------
// Assistant proposal surface (T07)
// ---------------------------------------------------------------------------

// Re-exported through the adapter so the command bus and the assistant surface can
// name these durable shapes without importing `@/lib/repository` themselves — which
// the authority boundary reserves for this module alone. A type-only re-export
// grants no runtime path to the repository.
export type { AssistantProposalV1, AssistantReceiptV1, ReceiptStanding };

/** The persisted basis a Preview binds to. Read from the envelope and the lease. */
export interface AssistantScenarioBasis {
  scenarioId: string;
  documentRevision: number;
  topCommitId: string | null;
  /** `null` when this tab does not currently own the scenario. */
  leaseEpoch: number | null;
  isOwner: boolean;
  scenario: ScenarioUiState;
}

export interface PrepareAssistantProposalInput {
  /** Used only for a first preparation; a revision keeps the previous identity. */
  proposalId: string;
  /** Set to re-prepare an existing proposal (Revise, regenerate, recover). */
  previousProposalId?: string;
  threadId: string | null;
  turnId: string | null;
  /**
   * The deployed registry's stamp, supplied by the caller.
   *
   * The adapter deliberately does not read the registry itself: `lib/capability`
   * reaches component modules, and pulling those into the scenario authority's graph
   * would put React in the durable path for no benefit. The stamp is opaque here --
   * it is stored, and later compared for equality.
   */
  registryStamp: CapabilityRegistryStamp;
  commands: readonly AssistantCommandV1[];
  rationale: string | null;
  evidence: readonly EvidenceReference[];
  outcome: ProposalOutcome;
}

export type PrepareAssistantProposalOutcome =
  | { ok: true; proposal: AssistantProposalV1 }
  /** The commands do not validate against the current document. A product answer. */
  | { ok: false; reason: "rejected"; rejection: CommandRejection }
  | { ok: false; reason: CommandFailureReason; code: RepositoryErrorCode | "unknown" };

export type ApplyAssistantProposalOutcome =
  | {
      ok: true;
      receipt: AssistantReceiptV1;
      proposal: AssistantProposalV1;
      commitId: string;
      documentRevision: number;
      /** True when this key had already been consumed; no second commit was written. */
      replayed: boolean;
      /** The commit landed but the view did not. Saved, and only a reload clears it. */
      reloadRequired: boolean;
    }
  | { ok: false; reason: CommandFailureReason; code: RepositoryErrorCode | "unknown" };

/** The captured fences in the shape a durable proposal row stores them. */
function generationPair(captured: readonly CapturedGeneration[]): {
  globalGeneration: number;
  scenarioGeneration: number;
} {
  const global = captured.find((entry) => entry.scopeKey === GLOBAL_GENERATION_SCOPE);
  const scenario = captured.find((entry) => entry.scopeKey !== GLOBAL_GENERATION_SCOPE);
  return {
    globalGeneration: global?.generation ?? 0,
    scenarioGeneration: scenario?.generation ?? 0,
  };
}

function classify(error: unknown): {
  reason: CommandFailureReason;
  code: RepositoryErrorCode | "unknown";
} {
  if (error instanceof RepositoryError) {
    switch (error.code) {
      case "not_owner":
      case "lease_expired":
      case "lease_epoch_stale":
      case "target_owned":
        return { reason: "not-owner", code: error.code };
      case "stale_revision":
      case "scenario_mismatch":
      case "scenario_not_found":
        return { reason: "stale", code: error.code };
      case "nothing_to_undo":
      case "nothing_to_redo":
      case "receipt_not_undoable":
        return { reason: "history-unavailable", code: error.code };
      case "invalid_document":
      case "proposal_rejected":
        return { reason: "invalid", code: error.code };
      case "proposal_conflict":
      case "idempotency_conflict":
        return { reason: "proposal-conflict", code: error.code };
      case "confirmation_missing":
        return { reason: "confirmation-missing", code: error.code };
      case "generation_fenced":
        return { reason: "fenced", code: error.code };
      default:
        return { reason: "write-failed", code: error.code };
    }
  }
  return { reason: "write-failed", code: "unknown" };
}

// ---------------------------------------------------------------------------
// Tab identity
// ---------------------------------------------------------------------------

const TAB_ID_KEY = "nurse-scheduler/tabId";

/** The identity-claim channel. Separate from the ownership hint channel. */
export const TAB_IDENTITY_CHANNEL_NAME = "nurse-scheduler/tab-identity";

/** How long to wait for a live peer to object to a reused tab id. */
const IDENTITY_PROBE_MS = 120;

/**
 * The per-tab UUID. `sessionStorage` is the right home because it is per-tab AND
 * survives a reload of that tab: a reloading owner keeps its identity, so it can
 * reclaim its own lease. It is not a user identity.
 *
 * Synchronous and UNVERIFIED — see {@link resolveTabIdentity} for why that is not
 * enough on its own.
 */
export function resolveTabId(): string {
  if (typeof sessionStorage === "undefined") return crypto.randomUUID();
  const existing = sessionStorage.getItem(TAB_ID_KEY);
  if (existing) return existing;
  const minted = crypto.randomUUID();
  sessionStorage.setItem(TAB_ID_KEY, minted);
  return minted;
}

/**
 * Resolve a tab id that no OTHER LIVE TAB is already using, minting a fresh one if
 * the stored id turns out to be a copy.
 *
 * WHY THIS IS NECESSARY. `sessionStorage` is per-tab, but it is COPIED into a tab
 * created by `window.open`/target=_blank or by "Duplicate tab". Two live controllers
 * then present the same tab id, and every mechanism that distinguishes tabs
 * collapses: acquisition renews the lease IN PLACE (same `ownerTabId`) instead of
 * refusing, cross-tab hints are self-filtered by tab id, and neither tab ever
 * becomes read-only — so both write to one scenario with one epoch, which is exactly
 * what the single-writer lease exists to prevent.
 *
 * Reload and duplication are indistinguishable from durable state alone: both
 * present a stored id whose previous page is gone or going. The discriminator is
 * whether the OTHER instance is still alive, so this asks. A live holder answers
 * within a frame and the newcomer re-mints; a reload has nobody to answer and keeps
 * its identity, which is what preserves lease reclamation across a refresh.
 *
 * The wait is bounded and one-off, at bring-up only. If `BroadcastChannel` is
 * unavailable the stored id is used as before: correctness of every WRITE still
 * rests on the persisted lease, and this protocol removes an identity collision
 * rather than being the fence itself.
 */
export async function resolveTabIdentity(): Promise<string> {
  const candidate = resolveTabId();
  if (typeof BroadcastChannel === "undefined" || typeof sessionStorage === "undefined") {
    return candidate;
  }

  // A per-INSTANCE nonce so a page never mistakes its own message for a peer's. A
  // BroadcastChannel does not deliver to the posting context, but a duplicated tab
  // and its opener ARE distinct contexts sharing one stored id — which is the whole
  // problem — so identity has to be compared at instance granularity.
  const instance = crypto.randomUUID();
  const probe = new BroadcastChannel(TAB_IDENTITY_CHANNEL_NAME);
  let collided = false;
  try {
    probe.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data as IdentityMessage | undefined;
      if (message?.tabId === candidate && message.instance !== instance) {
        if (message.kind === "claim") collided = true;
      }
    };
    probe.postMessage({ kind: "probe", tabId: candidate, instance });
    await new Promise((resolve) => setTimeout(resolve, IDENTITY_PROBE_MS));
  } finally {
    probe.close();
  }

  const tabId = collided ? crypto.randomUUID() : candidate;
  if (collided) sessionStorage.setItem(TAB_ID_KEY, tabId);
  // Answer for the REST OF THIS PAGE'S LIFE. A duplicate is usually created long
  // after this tab booted, so a responder that closed with the probe would never
  // hear it and the copy would keep the shared id.
  holdTabIdentity(tabId, instance);
  return tabId;
}

interface IdentityMessage {
  kind: "probe" | "claim";
  tabId: string;
  instance: string;
}

/** The long-lived responder, so this tab can be found by a later duplicate. */
let identityHolder: BroadcastChannel | null = null;

function holdTabIdentity(tabId: string, instance: string): void {
  identityHolder?.close();
  const channel = new BroadcastChannel(TAB_IDENTITY_CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as IdentityMessage | undefined;
    if (message?.kind !== "probe") return;
    if (message.tabId !== tabId || message.instance === instance) return;
    channel.postMessage({ kind: "claim", tabId, instance });
  };
  identityHolder = channel;
}

/** Drop the identity responder (page teardown, and test isolation). */
export function releaseTabIdentity(): void {
  identityHolder?.close();
  identityHolder = null;
}

// ---------------------------------------------------------------------------
// The authority controller
// ---------------------------------------------------------------------------

/** Any session-authority projection instance (the app singleton, or a test's). */
export type AuthorityStore = ReturnType<typeof createAuthorityStore>;

export interface ScenarioAuthorityConfig {
  db: NurseSchedulerDb;
  scenario: ScenarioStore;
  hot: HotStore;
  authority: AuthorityStore;
  tabId: string;
  now?: () => Date;
  newId?: () => string;
  leaseTtlMs?: number;
  /** Broadcast sink for cross-tab HINTS. Never an authority (see `ownership.ts`). */
  broadcast?: (message: OwnershipHint) => void;
  /**
   * Settle the tab's writer identity at bring-up, re-minting it when another live tab
   * already holds the stored id (a duplicated/opener-created tab). Defaults to
   * keeping `tabId` — the app wires {@link resolveTabIdentity}.
   */
  resolveTabIdentity?: () => Promise<string>;
}

/** A cross-tab notification. Advisory only: every write still rechecks IndexedDB. */
export interface OwnershipHint {
  kind: "acquired" | "released" | "committed";
  scenarioId: string;
  tabId: string;
  epoch: number;
}

export class ScenarioAuthority {
  readonly repository: ScenarioRepository;
  /**
   * This tab's writer identity.
   *
   * Provisional until {@link ScenarioAuthority.initialize} verifies it: the stored id
   * may be a COPY carried into a duplicated/opener-created tab, and that can only be
   * settled by asking whether another live tab is already using it. Nothing durable
   * is written before initialize, so adopting the verified id there is safe.
   */
  tabId: string;

  private readonly db: NurseSchedulerDb;
  private readonly scenario: ScenarioStore;
  private readonly hot: HotStore;
  private readonly authority: AuthorityStore;
  private readonly broadcast: (message: OwnershipHint) => void;
  /**
   * Settle this tab's writer identity. Injectable so a test can pin it; the app uses
   * the live-peer probe in {@link resolveTabIdentity}.
   */
  private readonly resolveIdentity: () => Promise<string>;

  /** The lease this tab presents on every write. `null` ⇒ read-only. */
  private owner: LeaseOwner | null = null;
  /** Monotonic ownership era — see {@link ScenarioAuthority.beginEra}. */
  private era = 0;
  /** Serializes commands so a compare-and-swap can never race a sibling. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Commands enqueued and not yet settled — the "a write is in flight" count. */
  private pending = 0;
  /** The outcome of the most recently settled durable command. */
  private lastSettled: "saved" | "error" = "saved";

  constructor(config: ScenarioAuthorityConfig) {
    this.db = config.db;
    this.scenario = config.scenario;
    this.hot = config.hot;
    this.authority = config.authority;
    this.tabId = config.tabId;
    this.broadcast = config.broadcast ?? (() => {});
    // A test that supplies an explicit `tabId` is simulating a specific tab, so it
    // keeps that identity; the app resolves its own through the collision probe.
    this.resolveIdentity = config.resolveTabIdentity ?? (async () => this.tabId);
    this.repository = createScenarioRepository({
      db: config.db,
      now: config.now,
      newId: config.newId,
      leaseTtlMs: config.leaseTtlMs,
    });
  }

  // -------------------------------------------------------------------------
  // Projection
  // -------------------------------------------------------------------------

  /**
   * Publish a committed envelope into the live projection. The ONLY writer of
   * scenario content in the application, and it only ever runs AFTER a durable
   * transaction returned.
   *
   * A throw here means the commit landed but the view did not: that is
   * "committed, reload required", not a failed write, so it is recorded as such
   * rather than swallowed or reported as an error the user could retry.
   *
   * Published through `shareStructure`: the durable round trip structured-clones
   * the whole document, so every slice comes back with a fresh identity even where
   * nothing changed. The app reads reference inequality as "this changed elsewhere"
   * — open-form staleness guards most of all — so republishing raw clones would
   * close every open editor on any unrelated commit. See `structural-share.ts`.
   */
  private publish(envelope: ScenarioEnvelopeV3, history?: { undo: boolean; redo: boolean }): void {
    try {
      this.scenario.setState(
        shareStructure(this.scenario.getState(), {
          ...pickScenario(envelope.scenario),
          backupFingerprint: envelope.backupFingerprint,
        }),
        true,
      );
    } catch {
      this.authority.setState({ reloadRequired: true });
      return;
    }
    this.authority.setState({
      scenarioId: envelope.scenarioId,
      documentRevision: envelope.documentRevision,
      recordRevision: envelope.recordRevision,
      ...(history ? { canUndo: history.undo, canRedo: history.redo } : {}),
    });
  }

  /**
   * Enter a new ownership era, invalidating every lifecycle continuation started in
   * the previous one.
   *
   * Lifecycle work is asynchronous and can be arbitrarily delayed — a heartbeat
   * rejection resolving after a takeover, a reconcile that read scenario A returning
   * after a switch to B. Acting on that stale result overwrote a NEWER owner: it
   * republished the old scenario, or called `loseOwnership` and cleared an ownership
   * this tab had legitimately just acquired. Every continuation therefore captures
   * the era it belongs to and drops itself if the era has moved on.
   */
  private beginEra(): number {
    this.era += 1;
    return this.era;
  }

  /** Whether a continuation from `era` may still act. */
  private isCurrentEra(era: number): boolean {
    return this.era === era;
  }

  /** Move this tab to a non-owning state and interrupt anything that assumed otherwise. */
  private loseOwnership(ownership: Exclude<ScenarioOwnership, "owner">, heldByTabId?: string) {
    const had = this.owner !== null;
    this.owner = null;
    this.beginEra();
    this.authority.setState({
      ownership,
      heldByTabId: heldByTabId ?? null,
      canUndo: false,
      canRedo: false,
    });
    if (!had) return;
    // Losing the lease invalidates every mutable in-flight surface. A staged paint
    // gesture would otherwise commit under an epoch we no longer hold, and an
    // attached Optimize run would keep painting a view whose authority is gone.
    // Bumping `runGeneration` is the existing revocation seam (T16a): late frames,
    // polls, and control responses from the prior attachment become inert.
    const hot = this.hot.getState();
    hot.cancelPaint();
    hot.resetRunView();
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Bring this tab up against durable truth: migrate the legacy record if it has
   * not been migrated, reread (never assume) this tab's persisted selection,
   * acquire the lease when it is free, start a fresh Undo session, and publish.
   *
   * A live foreign owner is NOT an error: the tab comes up read-only with an
   * explicit takeover available, which is the whole point of a per-scenario lease.
   */
  async initialize(): Promise<void> {
    // FIRST: settle this tab's identity, before anything presents it to the
    // repository. A duplicated tab starts with a copy of its opener's stored id; two
    // controllers under one id renew each other's lease in place instead of
    // contending, so neither ever becomes read-only.
    this.tabId = await this.resolveIdentity();

    const migrated = await migrateLegacyScenarioRecord({ db: this.db });

    if (migrated.status === "corrupt" || migrated.envelope === null) {
      // No authority exists, deliberately. The legacy bytes are intact but
      // undecodable, so there is nothing honest to publish — pretending it was an
      // empty workspace invited edits that the next boot would delete. Throwing
      // routes the shell to its existing `recoverable-error` surface, whose reset
      // affordance is the one path that can legitimately mint a replacement.
      throw new RepositoryError(
        "migration_corrupt",
        "the stored scenario record could not be read",
        { reason: migrated.reason },
      );
    }

    const era = this.beginEra();
    const context = await this.repository.readTabContext(this.tabId);
    const scenarioId = context.selection?.scenarioId ?? migrated.scenarioId;

    let envelope: ScenarioEnvelopeV3;
    try {
      const selection = await this.repository.selectOrSwitchScenario({
        tabId: this.tabId,
        target: { kind: "existing", scenarioId: scenarioId! },
        // A reload must not offer reversals whose payloads belong to a session that
        // no longer exists. The rollover happens INSIDE the fenced acquisition, so a
        // takeover that lands between acquiring and rolling cannot have its own
        // reversal material expired by this tab's follow-up transaction.
        rollHistorySession: true,
      });
      envelope = selection.envelope;
      this.owner = selection.owner;
      this.authority.setState({ ownership: "owner", heldByTabId: null });
    } catch (error) {
      if (!isRepositoryError(error, "target_owned")) throw error;
      // Another live tab owns this scenario. Select it WITHOUT acquiring, so this
      // tab can inspect the committed state and history but cannot write. The
      // repository writes no scenario-scoped fact for a non-acquiring selection.
      const selection = await this.repository.selectOrSwitchScenario({
        tabId: this.tabId,
        target: { kind: "existing", scenarioId: scenarioId! },
        acquire: false,
      });
      envelope = selection.envelope;
      const lease = await this.repository.readTabContext(this.tabId);
      this.owner = null;
      this.authority.setState({
        ownership: "read-only",
        heldByTabId: lease.lease?.ownerTabId ?? null,
      });
    }

    if (!this.isCurrentEra(era)) return;

    if (this.owner) {
      this.broadcast({
        kind: "acquired",
        scenarioId: envelope.scenarioId,
        tabId: this.tabId,
        epoch: this.owner.epoch,
      });
    }

    // Undo availability is gated on OWNERSHIP as well as on the persisted commit
    // facts. A read-only tab has reversible commits sitting in front of it that it
    // may not perform, and reporting them as available would be the same lie zundo
    // told across tabs — just from the other direction.
    const history = await this.repository.describeHistory(envelope.scenarioId);
    if (!this.isCurrentEra(era)) return;
    this.publish(
      envelope,
      this.owner
        ? { undo: history.undoAvailable, redo: history.redoAvailable }
        : { undo: false, redo: false },
    );
    this.settleWriteStatus();

    // The Optimize basis reaper's lifecycle caller (T08). Boot is the one moment
    // where the live reference set is empty BY CONSTRUCTION: no Preview is open,
    // no diagnostic candidate is in flight, and no receipt reconciliation is
    // running, because none of those survive a page load. That makes the sweep
    // deterministic rather than dependent on a timer nobody owns.
    //
    // Deliberately AFTER publish and NOT awaited into the boot path: retention
    // hygiene must never delay — or fail — bringing the tab up against durable
    // truth. `sweepOptimizeBases` swallows its own errors for the same reason.
    this.basisSweepSettled = this.sweepOptimizeBases();
  }

  /**
   * The boot sweep's settlement.
   *
   * Boot deliberately does not await the sweep, which would otherwise make it
   * unobservable. Exposing the promise lets a caller (and a test) await the pass
   * without turning retention hygiene into a boot dependency.
   */
  basisSweepSettled: Promise<OptimizeBasisReapAction[]> = Promise.resolve([]);

  /**
   * Run one expiry-indexed reaping pass over the retained basis rows.
   *
   * `referencedBasisIds` names rows something still needs (a non-terminal
   * candidate, an open Preview, a receipt reconciliation). A reference protects
   * only the RAW PAYLOAD, and only up to the advertised expiry — `planReap`
   * deletes an expired row regardless, so nothing here can extend the validity of
   * evidence the server has already released.
   *
   * Returns the actions applied, so a caller (and a test) can see what a pass did
   * rather than inferring it from surviving rows.
   */
  async sweepOptimizeBases(
    referencedBasisIds: ReadonlySet<string> = new Set(),
    now: Date = new Date(),
  ): Promise<OptimizeBasisReapAction[]> {
    try {
      const rows = await this.listOptimizeBases();
      if (rows.length === 0) return [];
      const actions = planReap({ rows, referencedBasisIds, now });
      await this.applyOptimizeBasisReap(actions);
      return actions;
    } catch {
      // Retention hygiene is never worth failing a boot over. The rows stay, and
      // the next pass re-evaluates them; an unreaped row is still classified as
      // expired by `classifyRecovery`, so nothing becomes trustworthy by surviving.
      return [];
    }
  }

  /**
   * Reread persisted selection, envelope, and lease, and reconcile this tab's
   * ownership with them. Called after a reload, a BFCache `pageshow`, a visibility
   * restore, a reconnect, or a long suspension — every point where process memory
   * may describe a world that no longer exists.
   */
  reconcile(): Promise<void> {
    // SERIALIZED with commands and with every other lifecycle transition. Run
    // loose, a reconcile that had already read scenario A could resolve after a
    // queued switch to B and republish A over it.
    return this.enqueueLifecycle(() => this.reconcileNow());
  }

  private async reconcileNow(): Promise<void> {
    const era = this.era;
    const context = await this.repository.readTabContext(this.tabId);
    if (!this.isCurrentEra(era)) return;
    if (!context.selection || !context.envelope) {
      // The selection was reaped (or never existed). Read-only until the tab
      // explicitly reselects — silently re-acquiring would make a stale tab a
      // writer again without anyone asking for it.
      this.loseOwnership("read-only");
      return;
    }

    if (context.isOwner && context.owner) {
      const heldEpoch = this.owner?.epoch;
      this.owner = context.owner;
      this.authority.setState({ ownership: "owner", heldByTabId: null });
      if (heldEpoch !== undefined && heldEpoch !== context.owner.epoch) {
        // Same tab id, newer epoch: someone took over and this tab reacquired.
        // Any state derived from the old epoch is void.
        this.hot.getState().cancelPaint();
      }
    } else if (this.owner !== null) {
      const takenOver = context.lease !== null && context.lease.ownerTabId !== this.tabId;
      this.loseOwnership(takenOver ? "taken-over" : "expired", context.lease?.ownerTabId);
    } else {
      this.authority.setState({
        ownership: "read-only",
        heldByTabId: context.lease?.ownerTabId ?? null,
      });
    }

    const history = context.history;
    this.publish(
      context.envelope,
      history && this.owner
        ? { undo: history.undoAvailable, redo: history.redoAvailable }
        : { undo: false, redo: false },
    );
  }

  // -------------------------------------------------------------------------
  // Lease lifecycle
  // -------------------------------------------------------------------------

  /** Renew the lease. A rejection is a real ownership loss, not a retryable blip. */
  heartbeat(): Promise<boolean> {
    return this.enqueueLifecycle(async () => {
      const era = this.era;
      const owner = this.owner;
      if (!owner) return false;
      try {
        await this.repository.heartbeat(owner);
        return true;
      } catch (error) {
        // The era guard is the point of this branch. A rejection means "the lease
        // this heartbeat presented is gone" — which is ALREADY TRUE AND HANDLED if
        // the tab has since taken over and holds a newer one. Acting on the stale
        // rejection would clear an ownership the tab legitimately has.
        if (!this.isCurrentEra(era)) return false;
        const { reason } = classify(error);
        if (reason === "not-owner") {
          const lease = await this.db.writerLeases.get(owner.scenarioId);
          if (!this.isCurrentEra(era)) return false;
          this.loseOwnership(
            lease && lease.ownerTabId !== this.tabId ? "taken-over" : "expired",
            lease?.ownerTabId,
          );
        }
        return false;
      }
    });
  }

  /**
   * Seize the selected scenario's lease. Explicit and immediate: it increments the
   * epoch without waiting for the old tab to cooperate, because the tab this
   * exists for is the one that cannot cooperate (frozen, crashed, or offline).
   */
  takeover(): Promise<CommandOutcome> {
    return this.enqueueLifecycle(async (): Promise<CommandOutcome> => {
      const scenarioId = this.authority.getState().scenarioId;
      if (!scenarioId) return { ok: false, reason: "not-ready", code: "unknown" };
      try {
        const result = await this.repository.acquireOrTakeover({
          scenarioId,
          tabId: this.tabId,
          mode: "takeover",
          // A new owner starts a new Undo session: the previous owner's reversal
          // payloads describe a history this tab never performed. Rolled INSIDE the
          // fenced takeover, so the session it invalidates is provably the one this
          // takeover superseded.
          rollHistorySession: true,
        });
        const era = this.beginEra();
        this.owner = result.owner;
        this.authority.setState({ ownership: "owner", heldByTabId: null, lastErrorCode: null });
        const history = await this.repository.describeHistory(scenarioId);
        if (!this.isCurrentEra(era)) {
          return { ok: false, reason: "not-owner", code: "not_owner" };
        }
        this.publish(result.envelope, {
          undo: history.undoAvailable,
          redo: history.redoAvailable,
        });
        this.broadcast({
          kind: "acquired",
          scenarioId,
          tabId: this.tabId,
          epoch: result.owner.epoch,
        });
        return {
          ok: true,
          committed: true,
          documentRevision: result.envelope.documentRevision,
          commitId: null,
        };
      } catch (error) {
        const classified = classify(error);
        this.authority.setState({ lastErrorCode: classified.code });
        return { ok: false, ...classified };
      }
    });
  }

  /** Clean release (an explicit close). Best-effort: expiry is the real backstop.
   *
   * Serialized like every other lifecycle transition: a release racing a queued
   * switch could otherwise delete the lease the switch had just acquired. */
  release(): Promise<void> {
    return this.enqueueLifecycle(() => this.releaseNow());
  }

  private async releaseNow(): Promise<void> {
    const owner = this.owner;
    if (!owner) return;
    try {
      await this.repository.release(owner);
      this.broadcast({
        kind: "released",
        scenarioId: owner.scenarioId,
        tabId: this.tabId,
        epoch: owner.epoch,
      });
    } catch {
      // A release that fails the fence means we no longer owned it anyway.
    }
    this.loseOwnership("read-only");
  }

  /** Note a hint from another tab. Advisory: it triggers a REREAD, never a decision. */
  async onHint(hint: OwnershipHint): Promise<void> {
    if (hint.tabId === this.tabId) return;
    const scenarioId = this.authority.getState().scenarioId;
    if (hint.scenarioId !== scenarioId) return; // a different scenario is none of our business
    await this.reconcile();
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** Resolve when every queued command has settled (the test/drain seam). */
  async drain(): Promise<void> {
    await this.queue.catch(() => {});
  }

  /**
   * Queue a LIFECYCLE transition on the same serial queue as commands.
   *
   * Ownership transitions and durable writes contend for the same durable state, so
   * running them on separate timelines was the race: a reconcile could republish the
   * scenario a queued switch had just left, and a release could delete the lease a
   * queued switch had just acquired. One queue makes the ordering the obvious one —
   * whatever the user asked for first.
   *
   * Deliberately NOT routed through {@link ScenarioAuthority.enqueue}: a heartbeat is
   * not a durable write, and arming the unload guard every five seconds would make
   * "Saving…" permanent and the beforeunload prompt unconditional.
   */
  private enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Publish the write status implied by the LATEST SETTLED command.
   *
   * Previously only a `writing` status could settle to `saved`, so one failed
   * command left `error` stuck forever: every later success settled into a status
   * that was already `error` and refused to move. The badge then reported a save
   * failure over work that had actually saved, and the unload guard stayed armed for
   * the rest of the session.
   */
  private settleWriteStatus(outcome?: "saved" | "error"): void {
    if (outcome) this.lastSettled = outcome;
    if (this.pending > 0) return;
    this.authority.setState({ writeStatus: this.lastSettled });
  }

  /**
   * Queue a command and own the write-status lifecycle around it.
   *
   * `writing` is published SYNCHRONOUSLY here, at enqueue, not when the
   * transaction starts. That is load-bearing rather than cosmetic: the shell's
   * unload guard arms on `saving`, and a command sitting in the queue is a durable
   * write the user has already asked for. Publishing `writing` only once the
   * transaction began would leave a window in which closing the tab silently threw
   * the edit away while the badge said "Saved".
   *
   * Symmetrically, only the LAST queued command may report `saved` — an earlier one
   * settling while another still waits would disarm the guard too early.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    this.authority.setState({ writeStatus: "writing" });
    const run = async () => {
      try {
        return await task();
      } finally {
        this.pending -= 1;
        // The LATEST settled command decides, which is what lets a success clear an
        // earlier failure instead of inheriting it.
        this.settleWriteStatus();
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Commit one typed command. `build` runs when the command reaches the head of
   * the queue, so an updater-form patch sees the state the previous command
   * committed — never the state the user was looking at two commits ago.
   *
   * `build` has THREE outcomes, and conflating two of them was a real defect:
   *   • a command      — commit it;
   *   • `"noop"`       — the action genuinely changes nothing. An honest success;
   *   • `"superseded"` — the caller's baseline moved, so it WITHDREW its write.
   *     That is a refusal the caller must hear about, because the user's action did
   *     not happen. Reported as `{ok: true}` it let a card editor close its form and
   *     say "saved" over an action that had been silently dropped.
   */
  private commitCommand(
    build: (current: ScenarioUiState) => ScenarioCommandV1 | "noop" | "superseded",
  ): Promise<CommandOutcome> {
    return this.enqueue(async () => {
      const owner = this.owner;
      const state = this.authority.getState();
      const scenarioId = state.scenarioId;
      if (state.reloadRequired) {
        // HARD FENCE. A commit landed whose result the view never received, so every
        // patch built from that view is computed against the wrong document. Only an
        // authoritative reload can clear this.
        return {
          ok: false as const,
          reason: "reload-required" as const,
          code: "unknown" as const,
        };
      }
      if (!owner || !scenarioId) {
        return { ok: false as const, reason: "not-owner" as const, code: "not_owner" as const };
      }
      const built = build(this.scenario.getState());
      if (built === "superseded") {
        return { ok: false as const, reason: "superseded" as const, code: "unknown" as const };
      }
      if (built === "noop") {
        return {
          ok: true as const,
          committed: false,
          documentRevision: this.authority.getState().documentRevision,
          commitId: null,
        };
      }
      const command = built;

      try {
        const result = await this.repository.commit({
          owner,
          expectedScenarioId: scenarioId,
          expectedDocumentRevision: this.authority.getState().documentRevision,
          command,
        });
        this.publish(result.envelope, {
          undo: result.history.undoAvailable,
          redo: result.history.redoAvailable,
        });
        this.authority.setState({ lastErrorCode: null });
        this.broadcast({
          kind: "committed",
          scenarioId,
          tabId: this.tabId,
          epoch: owner.epoch,
        });
        this.settleWriteStatus("saved");
        return {
          ok: true as const,
          // The repository suppresses a semantic no-op, so "a commit was written" is
          // its answer to report, not an assumption from having asked.
          committed: result.commit !== null,
          documentRevision: result.envelope.documentRevision,
          commitId: result.commit?.commitId ?? null,
        };
      } catch (error) {
        return this.handleCommandFailure(error, scenarioId);
      }
    });
  }

  /**
   * Turn a failed transaction into an honest projection state. The projection is
   * never left describing a change that did not commit: on a stale revision it is
   * refreshed from durable truth, and on an ownership loss the tab goes read-only.
   */
  private async handleCommandFailure(error: unknown, scenarioId: string): Promise<CommandOutcome> {
    const classified = classify(error);
    this.authority.setState({ lastErrorCode: classified.code });
    this.settleWriteStatus("error");

    if (classified.reason === "not-owner") {
      const lease = await this.db.writerLeases.get(scenarioId).catch(() => undefined);
      this.loseOwnership(
        lease && lease.ownerTabId !== this.tabId ? "taken-over" : "expired",
        lease?.ownerTabId,
      );
    }
    if (classified.reason === "stale") {
      // Our projection was behind durable truth. Refresh it rather than retrying
      // the command: the user's patch was computed against state that never was.
      try {
        const envelope = await this.repository.read(scenarioId);
        const history = await this.repository.describeHistory(scenarioId);
        this.publish(envelope, {
          undo: history.undoAvailable,
          redo: history.redoAvailable,
        });
      } catch {
        this.authority.setState({ reloadRequired: true });
      }
    }
    return { ok: false, ...classified };
  }

  /**
   * One tracked editor mutation. Accepts the patch or updater form unchanged.
   *
   * An updater may return `null` to ABORT: nothing is committed, no revision moves,
   * and no history entry appears. That arm exists because the updater is the only
   * place that can see the state the previous command committed — so a caller whose
   * patch was computed against a baseline that has since moved (an Undo, a Redo, a
   * cascade from elsewhere) can refuse its own write there rather than overwriting.
   */
  mutate(
    patch: Partial<ScenarioUiState> | ((state: ScenarioUiState) => Partial<ScenarioUiState> | null),
  ): Promise<CommandOutcome> {
    return this.commitCommand((current) => {
      const resolved = typeof patch === "function" ? patch(current) : patch;
      // A withdrawn patch is a REFUSAL, not a no-op: the updater looked at the state
      // the previous command committed, found its own baseline gone, and declined.
      // The user's action did not happen and the caller must be able to say so.
      if (resolved === null) return "superseded";
      // A patch that changes nothing is a NO-OP, not a commit: "zero changed
      // actions add zero history entries". The editor transforms are written to
      // return the SAME references when an operation is semantically empty (a
      // re-upload of identical people, a drop back on the same slot), precisely so
      // this is decidable — so per-key reference equality is both sufficient and
      // the exact rule the pre-cutover history used.
      const changed = Object.keys(resolved).some(
        (key) =>
          (resolved as Record<string, unknown>)[key] !==
          (current as unknown as Record<string, unknown>)[key],
      );
      return changed ? { type: "patch_scenario", patch: resolved } : "noop";
    });
  }

  /** The paint gesture's atomic matrix write — one drag, one commit. */
  setReqData(
    reqData: UiRequestCell[] | ((state: ScenarioUiState) => UiRequestCell[]),
  ): Promise<CommandOutcome> {
    // The matrix is rebuilt wholesale by every gesture, so its "nothing changed"
    // case is invisible to a reference test — the repository decides it by value
    // inside the transaction (`isSemanticNoOpCommand`) and reports `committed: false`.
    return this.commitCommand((current) => ({
      type: "set_req_data",
      reqData: typeof reqData === "function" ? reqData(current) : reqData,
    }));
  }

  /**
   * Record the emitted Workspace backup. Metadata only: it advances
   * `recordRevision` and writes no commit fact, so it cannot stale a
   * content-bound proposal and cannot become an undoable edit.
   *
   * The caller passes the fingerprint of the bytes it ACTUALLY EMITTED. It used to
   * be recomputed here, at the queue head, from whatever the projection held by
   * then — so a download of revision 5 followed by a queued edit to revision 6
   * recorded 6 as "backed up" and the badge reported a file that had never been
   * downloaded as current. Binding the fingerprint to the emitted snapshot is the
   * only way the claim can be true.
   */
  recordBackup(backupFingerprint: string): Promise<CommandOutcome> {
    return this.commitCommand(() => ({ type: "record_backup", backupFingerprint }));
  }

  /**
   * Undo/Redo as monotonic repository commits. Availability is rechecked inside
   * the transaction, so a stack another tab invalidated — or a payload a reload or
   * the 50-entry bound evicted — fails as `history-unavailable` instead of
   * silently restoring the wrong state.
   */
  undo(): Promise<CommandOutcome> {
    return this.historyCommand("undo");
  }

  redo(): Promise<CommandOutcome> {
    return this.historyCommand("redo");
  }

  private historyCommand(kind: "undo" | "redo"): Promise<CommandOutcome> {
    return this.enqueue(async () => {
      const owner = this.owner;
      const state = this.authority.getState();
      const scenarioId = state.scenarioId;
      if (state.reloadRequired) {
        return {
          ok: false as const,
          reason: "reload-required" as const,
          code: "unknown" as const,
        };
      }
      if (!owner || !scenarioId) {
        return { ok: false as const, reason: "not-owner" as const, code: "not_owner" as const };
      }
      try {
        const input = {
          owner,
          expectedDocumentRevision: this.authority.getState().documentRevision,
        };
        const result =
          kind === "undo" ? await this.repository.undo(input) : await this.repository.redo(input);
        this.publish(result.envelope, {
          undo: result.history.undoAvailable,
          redo: result.history.redoAvailable,
        });
        this.authority.setState({ lastErrorCode: null });
        this.broadcast({ kind: "committed", scenarioId, tabId: this.tabId, epoch: owner.epoch });
        this.settleWriteStatus("saved");
        return {
          ok: true as const,
          committed: true,
          documentRevision: result.envelope.documentRevision,
          commitId: result.commit?.commitId ?? null,
        };
      } catch (error) {
        const outcome = await this.handleCommandFailure(error, scenarioId);
        if (outcome.ok === false && outcome.reason === "history-unavailable") {
          // Truthfully disable the control rather than leaving it inviting a
          // reversal the repository cannot perform. Nothing was written, so the
          // write status settles clean rather than as a failure.
          const history = await this.repository.describeHistory(scenarioId).catch(() => null);
          this.authority.setState({
            canUndo: history?.undoAvailable ?? false,
            canRedo: history?.redoAvailable ?? false,
          });
          this.settleWriteStatus("saved");
        }
        return outcome;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Scenario switch (New / Load)
  // -------------------------------------------------------------------------

  /**
   * New and Load are ATOMIC SCENARIO SWITCHES, not edits of the current document:
   * one transaction validates the old owner, mints the new identity, acquires it,
   * records the switch, and releases the old lease. A refused target changes
   * nothing at all.
   *
   * Load always mints a fresh identity even when the bytes match a prior document,
   * so an imported file can never inherit another document's history or receipts.
   */
  private switchScenario(
    target: { kind: "new"; apiVersion?: string } | { kind: "load"; scenario: ScenarioUiState },
  ): Promise<CommandOutcome> {
    return this.enqueue(async () => {
      if (this.authority.getState().reloadRequired) {
        return {
          ok: false as const,
          reason: "reload-required" as const,
          code: "unknown" as const,
        };
      }
      try {
        const selection = await this.repository.selectOrSwitchScenario({
          tabId: this.tabId,
          target,
          ...(this.owner ? { currentOwner: this.owner } : {}),
        });
        // A switch is an ownership transition: everything the previous era started
        // is now describing a scenario this tab no longer has selected.
        this.beginEra();
        this.owner = selection.owner;
        this.authority.setState({
          ownership: selection.owner ? "owner" : "read-only",
          heldByTabId: null,
          lastErrorCode: null,
        });
        this.publish(selection.envelope, { undo: false, redo: false });
        // Scenario A's transient state must not leak into B.
        this.hot.getState().resetEphemeral();
        this.hot.getState().setHydrationStatus("ready");
        this.broadcast({
          kind: "acquired",
          scenarioId: selection.envelope.scenarioId,
          tabId: this.tabId,
          epoch: selection.owner?.epoch ?? 0,
        });
        return {
          ok: true as const,
          committed: true,
          documentRevision: selection.envelope.documentRevision,
          commitId: selection.commit?.commitId ?? null,
        };
      } catch (error) {
        const scenarioId = this.authority.getState().scenarioId;
        return scenarioId
          ? this.handleCommandFailure(error, scenarioId)
          : { ok: false as const, ...classify(error) };
      }
    });
  }

  newScenario(apiVersion?: string): Promise<CommandOutcome> {
    return this.switchScenario({ kind: "new", ...(apiVersion ? { apiVersion } : {}) });
  }

  loadScenario(scenario: ScenarioUiState): Promise<CommandOutcome> {
    return this.switchScenario({ kind: "load", scenario });
  }

  /**
   * How many reversals are currently applied — the durable history cursor. Read
   * for diagnostics and browser tests; the UI uses `canUndo`/`canRedo`, which
   * also account for whether the reversal MATERIAL still exists.
   *
   * Drains first. A depth read mid-queue would answer a question nobody is asking
   * ("how deep was the history before the write I just triggered?") and would make
   * any "this action added exactly one step" assertion a race. Safe because this is
   * never called from inside a queued command.
   */
  async readHistoryDepth(): Promise<number> {
    await this.drain();
    const scenarioId = this.authority.getState().scenarioId;
    if (!scenarioId) return 0;
    try {
      return (await this.repository.read(scenarioId)).historyCursor;
    } catch {
      return 0;
    }
  }

  /**
   * The authoritative identity/revision an ordinary Optimize preflight binds to.
   * Read from PERSISTED state, not from the projection, so a submission can never
   * be labelled with a revision this tab merely believed it had.
   */
  async readAuthoritativeIdentity(): Promise<{
    scenarioId: string;
    documentRevision: number;
    recordRevision: number;
  } | null> {
    const scenarioId = this.authority.getState().scenarioId;
    if (!scenarioId) return null;
    try {
      const envelope = await this.repository.read(scenarioId);
      return {
        scenarioId: envelope.scenarioId,
        documentRevision: envelope.documentRevision,
        recordRevision: envelope.recordRevision,
      };
    } catch {
      return null;
    }
  }

  /**
   * The authoritative ownership the final pre-submit Optimize gate requires.
   *
   * Reads the PERSISTED tab context — `readTabContext` — not the projection, so a
   * submission can never be prepared under an owner this tab merely believed it
   * still held. A peer takeover that changed nothing but the lease (and whose
   * BroadcastChannel hint was delayed or missed) leaves the projection's
   * `ownership` at `"owner"`; the persisted lease disagrees, and THIS read is what
   * catches it.
   *
   * Returns `null` when there is no selected scenario or no readable envelope.
   * `isOwner` is true ONLY when a live persisted lease on the EXACT selected
   * scenario names this tab — the same condition every durable command checks.
   */
  async readAuthoritativeOwnership(): Promise<{
    scenarioId: string;
    documentRevision: number;
    recordRevision: number;
    isOwner: boolean;
  } | null> {
    const scenarioId = this.authority.getState().scenarioId;
    if (!scenarioId) return null;
    try {
      const context = await this.repository.readTabContext(this.tabId);
      if (!context.selection || !context.envelope) return null;
      // The persisted selection must name the EXACT scenario the projection
      // believes is selected — a switch that landed between the projection update
      // and this read is a different document.
      if (context.selection.scenarioId !== scenarioId) return null;
      return {
        scenarioId: context.envelope.scenarioId,
        documentRevision: context.envelope.documentRevision,
        recordRevision: context.envelope.recordRevision,
        isOwner: context.isOwner,
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Optimize basis rows (T08)
  // -------------------------------------------------------------------------
  //
  // These live on the adapter because it is the ONE module allowed to reach the
  // durable repository graph (`authority-boundary.test.ts`). They are deliberately
  // thin: the basis SEMANTICS — what a valid basis is, when a row may be reaped,
  // whether a recovery is trusted — live in `@/lib/optimize/basis`, which imports
  // only erased types from here, so there is no runtime cycle between the store and
  // the Optimize feature.

  // -------------------------------------------------------------------------
  // Assistant proposals, Apply, receipts and Undo (T07)
  // -------------------------------------------------------------------------
  //
  // WHY THESE LIVE ON THE ADAPTER. The assistant may not reach the repository (the
  // authority boundary) and may not write a scenario table (`independence.test.ts`).
  // It is also the wrong place for these: publishing a committed document into the
  // projection, and recording "committed, reload required" when that publication
  // fails, is exactly this adapter's job and nobody else's. So the assistant names a
  // proposal and the host does the rest -- which is also what makes "Apply is not a
  // model tool" structurally true rather than a convention.
  //
  // EVERY ONE IS QUEUED on the same serial queue as manual edits, so a Preview
  // cannot be prepared against a document a queued manual commit is about to move.

  /**
   * The PERSISTED basis a Preview binds to and Apply is re-checked against.
   *
   * Read from the envelope and the lease rather than the projection, for the reason
   * the Optimize preflight reads them: a takeover whose BroadcastChannel hint was
   * delayed leaves the projection still claiming ownership, and only the lease row
   * disagrees.
   */
  async readAssistantScenarioBasis(): Promise<AssistantScenarioBasis | null> {
    const context = await this.repository.readTabContext(this.tabId);
    if (!context.envelope) return null;
    return {
      scenarioId: context.envelope.scenarioId,
      documentRevision: context.envelope.documentRevision,
      topCommitId: context.envelope.topCommitId,
      leaseEpoch: context.owner?.epoch ?? null,
      isOwner: context.isOwner,
      scenario: context.envelope.scenario,
    };
  }

  /**
   * Validate typed commands against the PERSISTED document and persist the result
   * as a proposal.
   *
   * Preparing is not mutating: nothing about the scenario changes here. What it does
   * is bind the change to a basis, so that everything afterwards -- the Preview's
   * staleness, the confirmations, the idempotency key, the Apply fences -- has one
   * agreed thing to compare against.
   */
  prepareAssistantProposal(
    input: PrepareAssistantProposalInput,
  ): Promise<PrepareAssistantProposalOutcome> {
    return this.enqueue(async () => {
      const owner = this.owner;
      if (this.authority.getState().reloadRequired) {
        return { ok: false as const, reason: "reload-required" as const, code: "unknown" as const };
      }
      if (!owner) {
        return { ok: false as const, reason: "not-owner" as const, code: "not_owner" as const };
      }

      try {
        // OWNERSHIP IS REREAD, not taken from `this.owner`. A peer takeover whose
        // BroadcastChannel hint has not landed leaves this tab's in-memory owner
        // token intact, and preparing under it would render a Preview -- with an
        // enabled Apply -- for a document this tab no longer owns. The Apply
        // transaction would refuse it, but only after the user pressed the button.
        const context = await this.repository.readTabContext(this.tabId);
        if (!context.isOwner || !context.owner || context.owner.epoch !== owner.epoch) {
          this.loseOwnership(
            context.lease && context.lease.ownerTabId !== this.tabId ? "taken-over" : "expired",
            context.lease?.ownerTabId,
          );
          return { ok: false as const, reason: "not-owner" as const, code: "not_owner" as const };
        }

        const envelope = await this.repository.read(owner.scenarioId);
        // A re-preparation of a LIVE proposal keeps its identity and moves its
        // revision. A settled one is deliberately not revised: bumping an applied or
        // cancelled row would rewrite the record of something that already happened,
        // and the receipt would then point at a proposal that no longer describes it.
        const candidate = input.previousProposalId
          ? ((await this.repository.getProposal(input.previousProposalId)) ?? null)
          : null;
        const previous =
          candidate && candidate.status !== "applied" && candidate.status !== "cancelled"
            ? candidate
            : null;
        const captured = await this.repository.captureGenerations(owner.scenarioId);
        const pair = generationPair(captured);

        const prepared = prepareProposal({
          proposalId: previous?.proposalId ?? input.proposalId,
          // A re-preparation keeps the identity and moves the revision, which is what
          // makes every confirmation and every idempotency key from the previous one
          // stop matching -- without anything having to remember to clear them.
          revision: (previous?.revision ?? 0) + 1,
          scenarioId: envelope.scenarioId,
          threadId: input.threadId,
          turnId: input.turnId,
          document: envelope.scenario,
          baseDocumentRevision: envelope.documentRevision,
          baseCommitId: envelope.topCommitId,
          leaseEpoch: owner.epoch,
          registryStamp: input.registryStamp,
          commands: input.commands,
          rationale: input.rationale,
          evidence: input.evidence,
          outcome: input.outcome,
          globalGeneration: pair.globalGeneration,
          scenarioGeneration: pair.scenarioGeneration,
          now: new Date(),
        });
        if (!prepared.ok) {
          return { ok: false as const, reason: "rejected" as const, rejection: prepared.rejection };
        }

        const row: AssistantProposalV1 = {
          ...prepared.proposal,
          appliedCommitId: null,
          receiptId: null,
          idempotencyKey: null,
        };
        // FENCED. A Clear that landed while the model was composing must not be able
        // to resurrect a proposal for a conversation the user just deleted.
        await this.repository.runGuarded(captured, async (db) => {
          await db.assistantProposals.put(row);
        });
        return { ok: true as const, proposal: row };
      } catch (error) {
        const classified = classify(error);
        this.authority.setState({ lastErrorCode: classified.code });
        return { ok: false as const, ...classified };
      }
    });
  }

  /**
   * Record one structured operational confirmation against the exact proposal
   * revision it answers.
   *
   * The assumption is re-derived from the STORED proposal rather than taken from the
   * caller: a confirmation for a question this proposal does not ask is not a
   * confirmation, and accepting one would be the mechanism by which an agreement
   * about a different change became authorisation for this one.
   */
  recordAssistantConfirmation(input: {
    proposalId: string;
    assumptionId: string;
    confirmedAt?: Date;
  }): Promise<PrepareAssistantProposalOutcome> {
    return this.updateProposal(input.proposalId, (proposal) => {
      const assumption = proposal.assumptions.find(
        (entry) => entry.assumptionId === input.assumptionId,
      );
      if (!assumption) return null;
      const confirmation: OperationalConfirmationV1 = {
        assumptionId: assumption.assumptionId,
        type: assumption.type,
        person: assumption.person,
        date: assumption.date,
        toDate: assumption.toDate,
        proposalRevision: proposal.revision,
        confirmedAt: (input.confirmedAt ?? new Date()).toISOString(),
      };
      const confirmations = [
        ...proposal.confirmations.filter(
          (entry) =>
            entry.assumptionId !== confirmation.assumptionId ||
            entry.proposalRevision !== proposal.revision,
        ),
        confirmation,
      ];
      return { ...proposal, confirmations };
    });
  }

  /** Withdraw a confirmation. Apply closes again immediately; nothing is “almost” agreed. */
  withdrawAssistantConfirmation(input: {
    proposalId: string;
    assumptionId: string;
  }): Promise<PrepareAssistantProposalOutcome> {
    return this.updateProposal(input.proposalId, (proposal) => ({
      ...proposal,
      confirmations: proposal.confirmations.filter(
        (entry) =>
          entry.assumptionId !== input.assumptionId || entry.proposalRevision !== proposal.revision,
      ),
    }));
  }

  /** Cancel a proposal. Terminal: a cancelled proposal can never be applied. */
  cancelAssistantProposal(proposalId: string): Promise<PrepareAssistantProposalOutcome> {
    return this.updateProposal(proposalId, (proposal) =>
      proposal.status === "applied" ? null : { ...proposal, status: "cancelled" },
    );
  }

  /** Mark a proposal out of date, so a reopened panel never shows it as live. */
  markAssistantProposalStale(proposalId: string): Promise<PrepareAssistantProposalOutcome> {
    return this.updateProposal(proposalId, (proposal) =>
      proposal.status === "applied" || proposal.status === "cancelled"
        ? null
        : { ...proposal, status: "stale" },
    );
  }

  /** The fenced read-modify-write every non-Apply proposal transition shares. */
  private updateProposal(
    proposalId: string,
    transform: (proposal: AssistantProposalV1) => AssistantProposalV1 | null,
  ): Promise<PrepareAssistantProposalOutcome> {
    return this.enqueue(async () => {
      const scenarioId = this.authority.getState().scenarioId;
      if (!scenarioId) {
        return { ok: false as const, reason: "not-ready" as const, code: "unknown" as const };
      }
      try {
        const captured = await this.repository.captureGenerations(scenarioId);
        const updated = await this.repository.runGuarded(captured, async (db) => {
          const current = await db.assistantProposals.get(proposalId);
          if (!current) return null;
          const next = transform(current);
          if (!next) return null;
          const row: AssistantProposalV1 = { ...next, updatedAt: new Date().toISOString() };
          await db.assistantProposals.put(row);
          return row;
        });
        if (!updated) {
          return {
            ok: false as const,
            reason: "proposal-conflict" as const,
            code: "proposal_conflict" as const,
          };
        }
        return { ok: true as const, proposal: updated };
      } catch (error) {
        return { ok: false as const, ...classify(error) };
      }
    });
  }

  /**
   * THE Apply. One durable transaction, then — and only then — publication.
   *
   * Success is never rendered before durability, and a publication failure is
   * reported as `committed, reload required` rather than as a failed Apply: the
   * change IS saved, and telling the user otherwise would invite them to do it twice.
   */
  applyAssistantProposal(input: {
    proposalId: string;
    receiptId: string;
  }): Promise<ApplyAssistantProposalOutcome> {
    return this.enqueue(async () => {
      const owner = this.owner;
      const state = this.authority.getState();
      if (state.reloadRequired) {
        return { ok: false as const, reason: "reload-required" as const, code: "unknown" as const };
      }
      if (!owner || !state.scenarioId) {
        return { ok: false as const, reason: "not-owner" as const, code: "not_owner" as const };
      }

      try {
        const proposal = await this.repository.getProposal(input.proposalId);
        if (!proposal) {
          return {
            ok: false as const,
            reason: "proposal-conflict" as const,
            code: "proposal_conflict" as const,
          };
        }
        const captured = await this.repository.captureGenerations(proposal.scenarioId);
        const committed = await this.repository.commitAssistantProposal({
          owner,
          proposal,
          // Derived from the STORED proposal, so a retry after a lost acknowledgement
          // reproduces the same key and replays the same commit.
          idempotencyKey: deriveIdempotencyKey(proposal),
          receiptId: proposal.receiptId ?? input.receiptId,
          guardGenerations: captured,
        });

        this.publish(committed.envelope, {
          undo: committed.history.undoAvailable,
          redo: committed.history.redoAvailable,
        });
        this.authority.setState({ lastErrorCode: null });
        this.broadcast({
          kind: "committed",
          scenarioId: proposal.scenarioId,
          tabId: this.tabId,
          epoch: owner.epoch,
        });
        this.settleWriteStatus("saved");
        return {
          ok: true as const,
          receipt: committed.receipt,
          proposal: committed.proposal,
          commitId: committed.commit.commitId,
          documentRevision: committed.envelope.documentRevision,
          replayed: committed.replayed,
          // A durable commit whose publication threw is still a durable commit.
          reloadRequired: this.authority.getState().reloadRequired,
        };
      } catch (error) {
        const failure = await this.handleCommandFailure(error, state.scenarioId);
        return failure as ApplyAssistantProposalOutcome;
      }
    });
  }

  /**
   * Undo one receipt's change, as a new atomic commit.
   *
   * Availability is decided by the REPOSITORY inside the transaction, never by the
   * receipt's existence and never by an in-memory stack: a receipt is a durable
   * record that something happened, which is a different fact from whether it can
   * still be reversed.
   */
  undoAssistantReceipt(receiptId: string): Promise<CommandOutcome> {
    return this.enqueue(async () => {
      const owner = this.owner;
      const scenarioId = this.authority.getState().scenarioId;
      if (this.authority.getState().reloadRequired) {
        return { ok: false as const, reason: "reload-required" as const, code: "unknown" as const };
      }
      if (!owner || !scenarioId) {
        return { ok: false as const, reason: "not-owner" as const, code: "not_owner" as const };
      }
      try {
        const result = await this.repository.undoAssistantReceipt({ owner, receiptId });
        this.publish(result.envelope, {
          undo: result.history.undoAvailable,
          redo: result.history.redoAvailable,
        });
        this.broadcast({
          kind: "committed",
          scenarioId,
          tabId: this.tabId,
          epoch: owner.epoch,
        });
        this.settleWriteStatus("saved");
        return {
          ok: true as const,
          committed: true,
          documentRevision: result.envelope.documentRevision,
          commitId: result.commit?.commitId ?? null,
        };
      } catch (error) {
        return this.handleCommandFailure(error, scenarioId);
      }
    });
  }

  /** One proposal, as persisted. */
  async readAssistantProposal(proposalId: string): Promise<AssistantProposalV1 | null> {
    return (await this.repository.getProposal(proposalId)) ?? null;
  }

  /** This scenario's receipts, newest first, each with its CURRENT Undo standing. */
  async describeAssistantReceipts(): Promise<ReceiptStanding[]> {
    const scenarioId = this.authority.getState().scenarioId;
    if (!scenarioId) return [];
    try {
      return await this.repository.describeReceipts(scenarioId);
    } catch (error) {
      // A scenario the repository has never seen simply has no receipts. The
      // repository is right to fail closed on a missing envelope -- every WRITE
      // depends on that -- but a panel asking "what has been applied here?" during
      // bring-up, before the envelope exists, is asking an answerable question.
      if (isRepositoryError(error, "scenario_not_found")) return [];
      throw error;
    }
  }

  /** Write a newly built, not-yet-accepted basis row. */
  async putOptimizeBasis(record: OptimizeBasisRecordV2): Promise<void> {
    await this.db.optimizeBases.put(record);
  }

  /**
   * Read one basis row, or `null` when it was never written or has been reaped.
   *
   * Returns the DURABLE UNION. A browser that ran a pre-T08 build still holds
   * schema-V1 rows, and handing one back as an `OptimizeBasisRecordV2` was an
   * unchecked cast that let a row with no `ownerKind` reach readers that partition
   * on it. The caller discriminates with `isOptimizeBasisRecordV2` and fails
   * closed — `classifyRecovery` does exactly that.
   */
  async readOptimizeBasis(basisId: string): Promise<StoredOptimizeBasisRow | null> {
    return (await this.db.optimizeBases.get(basisId)) ?? null;
  }

  /** Every retained basis row, for an expiry pass. Both schema versions. */
  async listOptimizeBases(): Promise<StoredOptimizeBasisRow[]> {
    return this.db.optimizeBases.toArray();
  }

  /**
   * Bind an accepted job to a basis row inside ONE transaction.
   *
   * `verify` is the caller's identity check (`bindAcceptedJob`), applied to the
   * row as re-read INSIDE the transaction rather than to whatever the caller held
   * beforehand. That is what makes the binding safe against a concurrent write:
   * a row that changed under the caller fails verification here instead of being
   * overwritten with a decision made about a stale snapshot.
   *
   * Returns the bound row, or `null` when the row is gone or verification refuses.
   */
  async bindOptimizeBasisJob(
    basisId: string,
    verify: (row: OptimizeBasisRecordV2) => OptimizeBasisRecordV2 | null,
  ): Promise<OptimizeBasisRecordV2 | null> {
    return this.db.transaction("rw", this.db.optimizeBases, async () => {
      const current = await this.db.optimizeBases.get(basisId);
      if (current === undefined) return null;
      // A legacy row can never be bound to an accepted job: nothing about it can be
      // verified against the response, so binding would attribute a real run's
      // evidence to a submission this build cannot describe.
      if (!isOptimizeBasisRecordV2(current)) return null;
      const bound = verify(current);
      if (bound === null) return null;
      await this.db.optimizeBases.put(bound);
      return bound;
    });
  }

  /**
   * Apply an ORDERED reap plan (`planReap`) in one transaction.
   *
   * The order is the correctness property, so the actions are applied strictly in
   * sequence rather than partitioned and batched: payload clears before deletes,
   * children before parents. Running them inside one transaction additionally means
   * a failure mid-plan leaves the previous consistent state rather than a half-reaped
   * set where a parent outlived its child's removal.
   */
  async applyOptimizeBasisReap(actions: readonly OptimizeBasisReapAction[]): Promise<void> {
    if (actions.length === 0) return;
    await this.db.transaction("rw", this.db.optimizeBases, async () => {
      for (const action of actions) {
        if (action.kind === "delete-row") {
          await this.db.optimizeBases.delete(action.basisId);
          continue;
        }
        const row = await this.db.optimizeBases.get(action.basisId);
        // Clearing the raw payload while KEEPING the row is what lets history stay
        // readable after the submitted document itself is gone. Guarded on the row
        // ACTUALLY holding material, so a legacy row that never had a
        // `submittedYaml` field is not rewritten to grow one.
        if (row !== undefined && basisRowPayload(row) !== null) {
          await this.db.optimizeBases.put(withClearedBasisPayload(row));
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // T10 — diagnostic search ownership
  // -------------------------------------------------------------------------
  //
  // The diagnostic search row is scenario-bound assistant state, like a proposal.
  // It is written through the SAME generation fence so a Clear that lands while
  // the orchestrator is settling a candidate cannot resurrect a search for a
  // conversation the user just deleted.

  /**
   * Capture the current generation fence for a scenario (T10 diagnostic runtime).
   *
   * Delegates to the repository's `captureGenerations`, which reads both the global
   * and the scenario generation rows. The diagnostic runtime threads this guard
   * through to `putDiagnosticSearch` so a Clear that lands mid-search cannot
   * resurrect the search row.
   */
  async captureGenerationsForDiagnostics(
    scenarioId: string,
  ): Promise<readonly CapturedGeneration[]> {
    return this.repository.captureGenerations(scenarioId);
  }

  /**
   * Narrow a caller-supplied guard back to the repository's scope-key union.
   *
   * The diagnostic orchestrator declares its guard structurally (a plain
   * `{ scopeKey: string }`) so it never has to import the repository graph. This
   * adapter is the boundary, so it is where the string is checked rather than
   * asserted: a scope key that is neither `global` nor `scenario:<id>` names no fence
   * this repository keeps, and a write guarded by it would be guarded by nothing.
   */
  private narrowGuard(
    guard: readonly { scopeKey: string; generation: number }[],
  ): readonly CapturedGeneration[] {
    return guard.map((entry) => {
      if (entry.scopeKey !== GLOBAL_GENERATION_SCOPE && !entry.scopeKey.startsWith("scenario:")) {
        throw new Error(`unknown generation scope: ${entry.scopeKey}`);
      }
      return { scopeKey: entry.scopeKey as GenerationScopeKey, generation: entry.generation };
    });
  }

  /**
   * Write a diagnostic search row inside the generation fence.
   *
   * `guard` is the captured generation pair the orchestrator took when it opened
   * the search. `runGuarded` rereads both rows inside the transaction and drops
   * the write when either moved — so a Clear-all → detach → late-orchestrator-write
   * cannot recreate the search row.
   */
  async putDiagnosticSearch(
    record: DiagnosticSearchRecordV1,
    guard: readonly { scopeKey: string; generation: number }[],
  ): Promise<void> {
    await this.repository.runGuarded(this.narrowGuard(guard), async (db) => {
      await db.diagnosticSearches.put(record);
    });
  }

  /**
   * The most recent ORDINARY basis this browser submitted for a scenario revision.
   *
   * This is how a diagnostic search finds its parent: from the browser's own durable
   * record of what it submitted, never from anything the model said. A search that
   * had to be told which run to diagnose could be pointed at someone else's run, or
   * at a run that never happened.
   *
   * Candidate rows are excluded by `ownerKind`, and an unbound row (no accepted job)
   * is excluded because there is no server-side run to recover against.
   */
  async readLatestOrdinaryBasis(
    scenarioId: string,
    documentRevision: number,
  ): Promise<OptimizeBasisRecordV2 | null> {
    const rows = await this.db.optimizeBases
      .where("[scenarioId+documentRevision]")
      .equals([scenarioId, documentRevision])
      .toArray();
    const ordinary = rows
      .filter(isOptimizeBasisRecordV2)
      .filter((row) => row.ownerKind === "ordinary" && row.jobId !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return ordinary.length > 0 ? ordinary[ordinary.length - 1]! : null;
  }

  /** Read one diagnostic search row, or `null`. */
  async readDiagnosticSearch(searchId: string): Promise<DiagnosticSearchRecordV1 | null> {
    return (await this.db.diagnosticSearches.get(searchId)) ?? null;
  }

  /** The most recent search for a scenario (open or settled), for the panel card. */
  async readLatestDiagnosticSearch(scenarioId: string): Promise<DiagnosticSearchRecordV1 | null> {
    const rows = await this.db.diagnosticSearches
      .where("scenarioId")
      .equals(scenarioId)
      .sortBy("createdAt");
    return rows.length > 0 ? rows[rows.length - 1] : null;
  }
}
