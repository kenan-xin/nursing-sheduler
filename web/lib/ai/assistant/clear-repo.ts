// Clear history and Clear all AI data (T05).
//
// TWO TRANSACTIONS, IN THIS ORDER, AND THE ORDER IS THE FEATURE.
//
//   1. {@link beginClear} -- BEFORE any cancellation is requested. It increments the
//      affected write generations, stamps `clearedAt`, marks the affected threads
//      `cleared`, and (for Clear all) deletes the configuration row outright. From
//      the moment this commits, every in-flight assistant write is already fenced.
//
//   2. {@link finishClear} -- AFTER settlement or detachment. It rereads the exact
//      generations step 1 produced and deletes the scoped user content.
//
// WHAT IS NEVER DELETED: the `assistantGenerations` rows. They are non-content
// monotonic counters and the ONLY thing standing between a detached callback and
// recreating deleted data after a reload.

import Dexie from "dexie";

import type { AssistantClearOperationV1 } from "@/lib/repository/types";
import { isAssistantSettlement, type AssistantSettlement } from "./lifecycle";
import {
  GLOBAL_GENERATION_SCOPE,
  scenarioGenerationScope,
  type CapturedGeneration,
  type GenerationScopeKey,
  type NurseSchedulerDb,
} from "@/lib/repository";
import { getAssistantDb } from "./db";
import { bumpAssistantGeneration, readAllGenerationScopes, runFenced } from "./fence";
import { ASSISTANT_SETTINGS_KEY } from "./records";

export const ASSISTANT_CLEAR_TABLES = [
  "assistantThreads",
  "assistantTurns",
  "assistantMessages",
  "assistantGenerations",
  "assistantSettings",
  "assistantProposals",
  "assistantReceipts",
  "diagnosticSearches",
  "assistantClearOperations",
] as const;

export type ClearScope = "history" | "all";

export interface ClearRepoConfig {
  db?: NurseSchedulerDb;
  now?: () => Date;
  newId?: () => string;
  barrier?: (point: "after-delete") => Promise<void> | void;
}

function resolve(config: ClearRepoConfig = {}) {
  return {
    db: config.db ?? getAssistantDb(),
    now: config.now ?? (() => new Date()),
    newId: config.newId ?? (() => crypto.randomUUID()),
    barrier: config.barrier,
  };
}

interface CapturedScope {
  scopeKey: GenerationScopeKey;
  generation: number;
}

function isKnownScope(scopeKey: unknown): scopeKey is GenerationScopeKey {
  if (typeof scopeKey !== "string" || scopeKey === "") return false;
  if (scopeKey === GLOBAL_GENERATION_SCOPE) return true;
  if (!scopeKey.startsWith("scenario:")) return false;
  const suffix = scopeKey.slice("scenario:".length);
  return suffix.length > 0 && suffix.trim().length === suffix.length;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isExactPlainObject(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const present = Object.keys(value);
  if (present.length !== keys.length) return false;
  return keys.every((key) => present.includes(key));
}

function normalizeCaptured(entries: unknown): CapturedScope[] | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const seen = new Set<string>();
  const normalized: CapturedScope[] = [];
  for (const entry of entries) {
    if (!isExactPlainObject(entry, ["scopeKey", "generation"])) return null;
    const { scopeKey, generation } = entry as { scopeKey: unknown; generation: unknown };
    if (!isKnownScope(scopeKey)) return null;
    if (typeof generation !== "number") return null;
    if (!Number.isInteger(generation) || generation < 0) return null;
    if (!Number.isFinite(generation)) return null;
    if (seen.has(scopeKey)) return null;
    seen.add(scopeKey);
    normalized.push({ scopeKey, generation });
  }
  return normalized.sort((left, right) => compareCodeUnits(left.scopeKey, right.scopeKey));
}

function commitmentFor(captured: readonly CapturedScope[]): { count: number; canonical: string } {
  return {
    count: captured.length,
    canonical: JSON.stringify(captured.map((entry) => [entry.scopeKey, entry.generation])),
  };
}

interface ValidatedOperation {
  operationId: string;
  scope: ClearScope;
  scenarioId: string | null;
  captured: CapturedScope[];
}

/**
 * The record version this build writes, for pending authority and for terminal facts
 * alike. See {@link AssistantClearOperationV1.version} for the version history.
 */
export const CLEAR_OPERATION_VERSION = 5;

/**
 * What this operation proved about the stored configuration -- the credential, the
 * model preference and the enabled flag.
 *
 * A SEPARATE FACT FROM THE SCOPE, because the scope is what was ASKED FOR and this is
 * what actually happened. `beginClear` deletes the settings row inside its own
 * transaction, so a committed global begin PROVES deletion; a global clear that failed
 * before that transaction committed proves the opposite; and a failure that could not
 * even read an identity proves nothing. Settings copy and the hydrated projection both
 * read this rather than inferring deletion from "the user asked for Clear all", which
 * is how the surface came to say "Your API key was removed" over a key still on disk.
 */
export type ClearConfigurationOutcome =
  /** A committed Clear-all begin deleted the configuration row. */
  | "deleted"
  /** The configuration row was not touched: any history clear, or a pre-begin failure. */
  | "retained"
  /** Storage could not say. Never claim either way. */
  | "unknown";

const CLEAR_CONFIGURATION_OUTCOMES: readonly ClearConfigurationOutcome[] = [
  "deleted",
  "retained",
  "unknown",
];

/**
 * A bounded, secret-safe reason a Clear did not complete.
 *
 * Lives here rather than in the store because it is a DURABLE vocabulary: the record
 * on disk carries it, so the parser that reads that record has to own the list. Never
 * a raw error, a storage message, or anything that could carry prompt, scenario, tool
 * or credential content.
 */
export type ClearFailureReason =
  /** The deletion was refused for safety (a scope appeared after authorization). */
  | "superseded"
  /** The bounded Clear-all recapture loop exhausted without a stable capture. */
  | "recapture_exhausted"
  /** A storage or runtime failure prevented the deletion transaction from committing. */
  | "storage";

const CLEAR_FAILURE_REASONS: readonly ClearFailureReason[] = [
  "superseded",
  "recapture_exhausted",
  "storage",
];

/** The exact key set of a version-5 record -- the canonical Clear fact record. */
const CANONICAL_KEYS = [
  "operationId",
  "version",
  "requestId",
  "scope",
  "scenarioId",
  "captured",
  "commitment",
  "startedAt",
  "outcome",
  "reason",
  "settlement",
  "deletionOutcome",
  "configurationOutcome",
] as const;

/** The exact key set of a version-4 record: version 5 without the configuration fact. */
const V4_KEYS = [
  "operationId",
  "version",
  "requestId",
  "scope",
  "scenarioId",
  "captured",
  "commitment",
  "startedAt",
  "outcome",
  "reason",
  "settlement",
  "deletionOutcome",
] as const;

/** The exact key set of a version-3 record, and of a version-2 terminal record. */
const OUTCOME_BEARING_KEYS = [
  "operationId",
  "version",
  "scope",
  "scenarioId",
  "captured",
  "commitment",
  "startedAt",
  "outcome",
] as const;

/** The exact key set of the shipped pre-outcome version-2 pending record. */
const LEGACY_PENDING_KEYS = [
  "operationId",
  "version",
  "scope",
  "scenarioId",
  "captured",
  "commitment",
  "startedAt",
] as const;

/**
 * Everything about a record except which version it is and what its outcome says.
 *
 * Split out so the version-3 reader, the legacy version-2 reader and the stranded-row
 * normaliser all validate identity, timestamp, scope, captured set and commitment by
 * the SAME code. A second copy of these rules is how one of them ends up laxer than
 * the others.
 */
function readOperationBody(record: unknown, keys: readonly string[]): ValidatedOperation | null {
  if (!isExactPlainObject(record, keys)) return null;
  const candidate = record as AssistantClearOperationV1;
  if (
    typeof candidate.operationId !== "string" ||
    candidate.operationId === "" ||
    candidate.operationId !== candidate.operationId.trim()
  )
    return null;
  if (typeof candidate.startedAt !== "string" || Number.isNaN(Date.parse(candidate.startedAt)))
    return null;
  const captured = readScopeContract(candidate.scope, candidate.scenarioId, candidate.captured);
  if (!captured) return null;
  const expected = commitmentFor(captured);
  const commitment = candidate.commitment;
  if (!isExactPlainObject(commitment, ["count", "canonical"])) return null;
  if (commitment.count !== expected.count) return null;
  if (commitment.canonical !== expected.canonical) return null;
  return {
    operationId: candidate.operationId,
    scope: candidate.scope as ClearScope,
    scenarioId: candidate.scenarioId,
    captured,
  };
}

/**
 * THE ONE scope/capture contract, shared by deletion authority and product outcomes.
 *
 * A record does not merely have to carry a well-formed captured set -- the set has to
 * AGREE with the scope and scenario the record claims. A history record captures
 * exactly `scenario:<scenarioId>` and nothing else; an all record has a null scenario
 * and includes `global`. Without this, a terminal row could name scenario A while
 * committing to scenario B's fence and still render an actionable retry for A.
 *
 * Returns the normalized captured set so the caller can check the commitment against
 * the same value this validated.
 */
function readScopeContract(
  scope: unknown,
  scenarioId: unknown,
  entries: unknown,
): CapturedScope[] | null {
  if (scope !== "history" && scope !== "all") return null;
  const captured = normalizeCaptured(entries);
  if (!captured) return null;
  if (scope === "history") {
    if (typeof scenarioId !== "string" || scenarioId === "" || scenarioId !== scenarioId.trim())
      return null;
    const own = scenarioGenerationScope(scenarioId);
    if (captured.length !== 1 || captured[0]!.scopeKey !== own) return null;
  } else {
    if (scenarioId !== null) return null;
    if (!captured.some((entry) => entry.scopeKey === GLOBAL_GENERATION_SCOPE)) return null;
  }
  return captured;
}

/**
 * A record that may authorise deletion RIGHT NOW.
 *
 * Exactly two shapes qualify, and both are pending:
 *   * version 3 with `outcome: "pending"` -- what this build writes;
 *   * version 2 with NO `outcome` -- the shipped pre-outcome shape, read so a clear
 *     interrupted by an upgrade still completes instead of stranding its fence.
 *
 * A version-2 record that DOES carry `outcome` is refused here whatever it says. That
 * shape was written by an in-place change to version 2, so its layout is ambiguous by
 * construction; it is read as product state only, and a `pending` one is normalised
 * into a visible failure by {@link resumePendingClears} rather than left silently
 * stranded.
 */
function readOperation(record: AssistantClearOperationV1 | undefined): ValidatedOperation | null {
  if (!record) return null;
  if (record.version === 5 || record.version === 4) {
    const parsed = readOperationBody(record, record.version === 5 ? CANONICAL_KEYS : V4_KEYS);
    return parsed && readCanonicalTail(record, parsed.scope, "pending") ? parsed : null;
  }
  if (record.version === 3) {
    const parsed = readOperationBody(record, OUTCOME_BEARING_KEYS);
    return parsed && record.outcome === "pending" ? parsed : null;
  }
  if (record.version === 2) return readOperationBody(record, LEGACY_PENDING_KEYS);
  return null;
}

/**
 * The version-4 fields beyond the shape every version shares: the request identity and
 * the three bounded fact fields.
 *
 * BOUNDED BY ENUMERATION, not by type alone. `settlement` and `reason` come off disk,
 * so a value this build does not recognise is refused rather than passed through into
 * product state -- the same rule the scope and outcome fields already follow.
 */
function readCanonicalTail(
  record: unknown,
  scope: ClearScope,
  expectedOutcome?: "pending" | "incomplete" | "failed",
): { requestId: string; facts: CanonicalTail } | null {
  const r = record as Record<string, unknown>;
  const version = typeof r.version === "number" ? r.version : 0;
  if (typeof r.requestId !== "string" || r.requestId === "" || r.requestId !== r.requestId.trim())
    return null;
  const outcome = r.outcome;
  if (outcome !== "pending" && outcome !== "incomplete" && outcome !== "failed") return null;
  if (expectedOutcome !== undefined && outcome !== expectedOutcome) return null;
  if (r.reason !== null && !CLEAR_FAILURE_REASONS.includes(r.reason as ClearFailureReason))
    return null;
  if (r.settlement !== null && !isAssistantSettlement(r.settlement)) return null;
  if (
    r.deletionOutcome !== null &&
    r.deletionOutcome !== "deleted" &&
    r.deletionOutcome !== "superseded"
  )
    return null;
  const hasConfiguration = "configurationOutcome" in r;
  if (
    hasConfiguration &&
    !CLEAR_CONFIGURATION_OUTCOMES.includes(r.configurationOutcome as ClearConfigurationOutcome)
  )
    return null;
  const facts: CanonicalTail = {
    reason: r.reason as ClearFailureReason | null,
    settlement: r.settlement as AssistantSettlement | null,
    deletionOutcome: r.deletionOutcome as "deleted" | "superseded" | null,
    configurationOutcome: hasConfiguration
      ? (r.configurationOutcome as ClearConfigurationOutcome)
      : provenConfiguration(scope, outcome),
  };
  // AND THE COMBINATION HAS TO BE ONE THAT COULD ACTUALLY HAPPEN, for a writer of the
  // version this row declares.
  if (!isReachableClearState(scope, outcome, facts, version)) return null;
  return { requestId: r.requestId, facts };
}

interface CanonicalTail {
  reason: ClearFailureReason | null;
  settlement: AssistantSettlement | null;
  deletionOutcome: "deleted" | "superseded" | null;
  configurationOutcome: ClearConfigurationOutcome;
}

/**
 * Whether these fields describe a state a Clear invocation can actually be in.
 *
 * ENUM MEMBERSHIP IS NOT VALIDATION. Every field below can hold a value this build
 * recognises while the COMBINATION describes something that never happened -- and the
 * two that mattered were not hypothetical:
 *
 *   * a `pending` row carrying `deletionOutcome: "deleted"` was accepted as live
 *     deletion authority, so a row claiming its own deletion had already committed
 *     could authorize a second one;
 *   * a `failed` row carrying `deletionOutcome: "deleted"` rendered a retry, which is
 *     the reach-forward the committed-deletion contract exists to prevent.
 *
 * So this is the state table, written out. It is deliberately the mirror of what
 * `assembleClearFacts` can produce: if the assembler gains a state, this gains a row,
 * and a combination no assembler path produces is not a Clear state at all.
 */
function isReachableClearState(
  scope: ClearScope,
  outcome: "pending" | "incomplete" | "failed",
  facts: CanonicalTail,
  /** The record's declared version: what a writer of that vintage could produce. */
  version: number,
): boolean {
  // A COMMITTED DELETION IS NEVER A TOMBSTONE. `deleted` is reported directly and
  // leaves no terminal row, so no durable record may claim it in any state.
  if (facts.deletionOutcome === "deleted") return false;

  if (outcome === "pending") {
    // Nothing has happened yet beyond the fence, so the whole tail is null. The
    // configuration fact is the one exception: the fence itself proved it.
    return (
      facts.reason === null &&
      facts.settlement === null &&
      facts.deletionOutcome === null &&
      facts.configurationOutcome === provenConfiguration(scope, "pending")
    );
  }

  if (outcome === "incomplete") {
    // The interruption ran to completion and the deletion pass refused, so settlement
    // is a known class and the deletion is `superseded` -- never absent, never
    // committed. The reason is the one this scope's refusal produces.
    return (
      facts.deletionOutcome === "superseded" &&
      facts.settlement !== null &&
      facts.reason === (scope === "all" ? "recapture_exhausted" : "superseded") &&
      // An incomplete global clear got as far as the deletion pass, so its begin
      // committed and the configuration really is gone.
      facts.configurationOutcome === (scope === "all" ? "deleted" : "retained")
    );
  }

  // `failed`: a storage or runtime failure. Settlement may be null (it failed before
  // the window closed) or a real class (it failed afterwards). No deletion outcome, in
  // either direction: the pass either never ran or rolled back.
  if (facts.reason !== "storage" || facts.deletionOutcome !== null) return false;
  // History never touches the configuration, at any version.
  if (scope === "history") return facts.configurationOutcome === "retained";

  // A GLOBAL FAILURE, AND THE WRITER'S OWN ORDER DECIDES WHAT IS POSSIBLE. The fence is
  // step 1 of the interruption and the bounded settlement is step 4, so a non-null
  // settlement proves `beginClear` returned -- and that transaction is what deletes the
  // configuration row. A version-5 row therefore cannot truthfully pair a real
  // settlement class with `retained` or `unknown`: the first would render a retry from
  // a row whose own facts say the credential is already gone, and the second would
  // claim ignorance the writer did not have.
  //
  // VERSION-AWARE, because version 4 never recorded the fact at all. Its
  // configuration outcome is derived rather than stored, and the derivation is
  // deliberately no narrower than "unknown" for a global failure -- tightening it here
  // would reject rows the previous build legitimately wrote.
  if (version >= 5 && facts.settlement !== null) return facts.configurationOutcome === "deleted";
  return true;
}

/**
 * What a record's own state proves about the configuration, for records written before
 * the fact was stored.
 *
 * DERIVED, NOT GUESSED. `beginClear` deletes the settings row inside the transaction
 * that writes a pending record, so any pending global row proves deletion; so does a
 * global row that reached the deletion pass. A global FAILURE could have happened on
 * either side of that transaction and the older shapes cannot say which, so it is
 * `unknown` -- which the surface renders as "could not confirm", not as a claim.
 */
function provenConfiguration(
  scope: ClearScope,
  outcome: "pending" | "incomplete" | "failed",
): ClearConfigurationOutcome {
  if (scope === "history") return "retained";
  return outcome === "failed" ? "unknown" : "deleted";
}

/**
 * A shipped version-2 record that carries `outcome: "pending"` and is therefore
 * neither authority (the reader above refuses it) nor a product outcome (the reader
 * below accepts only terminal outcomes). Left alone it would be invisible forever.
 */
function readStrandedLegacyPending(record: unknown): ValidatedOperation | null {
  if (!record || typeof record !== "object") return null;
  const r = record as { version?: unknown; outcome?: unknown };
  if (r.version !== 2 || r.outcome !== "pending") return null;
  return readOperationBody(record, OUTCOME_BEARING_KEYS);
}

type Claim = { owns: true; record: ValidatedOperation } | { owns: false; retire: boolean };

async function claimOperation(db: NurseSchedulerDb, operationId: string): Promise<Claim> {
  const stored = await db.assistantClearOperations.get(operationId);
  if (!stored) return { owns: false, retire: false };
  const record = readOperation(stored);
  if (!record) return { owns: false, retire: false };
  for (const entry of record.captured) {
    const row = await db.assistantGenerations.get(entry.scopeKey);
    if (!row || row.generation !== entry.generation) return { owns: false, retire: true };
  }
  if (record.scope === "all") {
    const owned = new Set(record.captured.map((entry) => entry.scopeKey));
    for (const row of await db.assistantGenerations.toArray()) {
      if (!owned.has(row.scopeKey)) return { owns: false, retire: true };
    }
  }
  return { owns: true, record };
}

export interface ClearFence {
  scope: ClearScope;
  scenarioId: string | null;
  operationId: string;
  captured: CapturedGeneration[];
  threadIds: string[];
  configurationDeleted: boolean;
}

export async function beginClear(
  scope: ClearScope,
  scenarioId: string | null,
  /**
   * `operationId` and `requestId` are MINTED BY THE CALLER, before any I/O. That is
   * what lets a failure anywhere -- including inside this transaction -- still report
   * the identity the invocation has had since before it touched storage, instead of
   * correlating a durable row to a result by luck.
   */
  config: ClearRepoConfig & { operationId?: string; requestId?: string } = {},
): Promise<ClearFence> {
  const { db, now, newId } = resolve(config);
  const target = scope === "history" ? (scenarioId ?? "").trim() : null;
  if (scope === "history" && !target) throw new Error("clear history requires a scenario identity");

  return db.transaction("rw", ASSISTANT_CLEAR_TABLES, async () => {
    const at = now();
    const captured: CapturedGeneration[] = [];
    if (scope === "all") {
      const scopes = new Set<GenerationScopeKey>([
        GLOBAL_GENERATION_SCOPE,
        ...(await readAllGenerationScopes(db)),
      ]);
      if (scenarioId) scopes.add(scenarioGenerationScope(scenarioId));
      for (const scopeKey of scopes) captured.push(await bumpAssistantGeneration(db, scopeKey, at));
    } else if (target) {
      captured.push(await bumpAssistantGeneration(db, scenarioGenerationScope(target), at));
    }

    const operationId = config.operationId ?? newId();
    const normalized = normalizeCaptured(captured.map((entry) => ({ ...entry })));
    if (!normalized) throw new Error("clear captured an unusable generation set");
    const candidate: AssistantClearOperationV1 = {
      operationId,
      version: CLEAR_OPERATION_VERSION,
      requestId: config.requestId ?? operationId,
      scope,
      scenarioId: target,
      captured: normalized,
      commitment: commitmentFor(normalized),
      startedAt: at.toISOString(),
      outcome: "pending",
      reason: null,
      settlement: null,
      deletionOutcome: null,
      // THE FENCE ITSELF IS THE PROOF: this transaction deletes the settings row for a
      // global clear, and touches it for no other scope.
      configurationOutcome: scope === "all" ? "deleted" : "retained",
    };
    if (!readOperation(candidate))
      throw new Error("clear produced an operation record this build would refuse");
    await db.assistantClearOperations.put(candidate);

    const threads =
      scope === "all"
        ? await db.assistantThreads.toArray()
        : await db.assistantThreads.where("scenarioId").equals(target!).toArray();
    for (const thread of threads)
      await db.assistantThreads.put({ ...thread, state: "cleared", updatedAt: at.toISOString() });

    let configurationDeleted = false;
    if (scope === "all") {
      await db.assistantSettings.delete(ASSISTANT_SETTINGS_KEY);
      configurationDeleted = true;
    }

    return {
      scope,
      scenarioId: target,
      operationId,
      captured,
      threadIds: threads.map((t) => t.threadId),
      configurationDeleted,
    };
  });
}

export interface ClearDeletion {
  outcome: "deleted" | "superseded";
  threads: number;
  messages: number;
  turns: number;
  proposals: number;
  receipts: number;
  searches: number;
}

const NOTHING_DELETED: Omit<ClearDeletion, "outcome"> = {
  threads: 0,
  messages: 0,
  turns: 0,
  proposals: 0,
  receipts: 0,
  searches: 0,
};

export async function finishClear(
  fence: ClearFence,
  config: ClearRepoConfig = {},
): Promise<ClearDeletion> {
  const { db, barrier } = resolve(config);
  const result = await runFenced(db, ASSISTANT_CLEAR_TABLES, fence.captured, () =>
    runOwnedClear(db, fence.operationId, barrier),
  );
  return result.outcome === "fenced" || result.value === null
    ? { outcome: "superseded", ...NOTHING_DELETED }
    : { outcome: "deleted", ...result.value };
}

async function runOwnedClear(
  db: NurseSchedulerDb,
  operationId: string,
  barrier: ClearRepoConfig["barrier"],
): Promise<Omit<ClearDeletion, "outcome"> | null> {
  const claim = await claimOperation(db, operationId);
  if (!claim.owns) {
    if (claim.retire) await db.assistantClearOperations.delete(operationId);
    return null;
  }
  const deleted = await deleteClearedContent(db, claim.record.scope, claim.record.scenarioId);
  if (barrier) await Dexie.waitFor(barrier("after-delete"));
  if (claim.record.scope === "all") {
    await db.assistantClearOperations.clear();
  } else {
    await db.assistantClearOperations.delete(operationId);
  }
  return deleted;
}

/**
 * The EXACT pending row recovery validated, not a summary of it.
 *
 * A reduced identity (id, scope, scenario) forced the terminalizing writer to
 * reconstruct everything else -- request id became the operation id, the captured set
 * became generation zero, the start time became "now" -- so a recovery failure
 * rewrote facts that were sitting on disk intact. It also had nothing to compare
 * against, which is what let a stale report overwrite a newer row with the same key.
 * This carries the whole record so the write can preserve it and prove it.
 */
export interface ClearCandidate extends DeepReadonly<ClearCandidateFields> {}

/**
 * The whole candidate is immutable, not only its raw snapshot.
 *
 * `raw` being frozen stopped the stored bytes being rewritten, but `requestId` and
 * `configurationOutcome` are SYNTHESIZED here for legacy layouts that never carried
 * them -- and they were writable. A caller could take a genuine version-2 global
 * candidate, rewrite those two fields, and terminalization would persist the injected
 * facts into a valid version-5 record whose raw bytes it had never touched.
 *
 * `terminalizeRecoveryFailure` now derives them from its own in-transaction re-read as
 * well, so the two defences are independent: the type and the freeze stop the mutation
 * being expressible, and the re-read means it would not matter if it were.
 */
interface ClearCandidateFields {
  /**
   * THE STORED ROW, EXACTLY AS IT WAS, and the only thing CAS identity is allowed to
   * compare.
   *
   * SEMANTIC EQUIVALENCE IS NOT IDENTITY. The normalized fields below are the strict
   * parser's view: `captured` is sorted, the commitment is recomputed, and a version-2
   * row's `outcome` key is read through a compatibility branch. Two genuinely
   * different stored rows can share all of that -- a reordered `captured` array is
   * semantically the same set, and version 2's two historical layouts (absent
   * `outcome` authority, and present `outcome: "pending"` non-authority) are one
   * discriminator apart. Comparing the normalized view accepted both as "unchanged"
   * and rewrote them.
   *
   * Structured-cloned at observation time so nothing downstream can mutate the thing
   * the comparison is against.
   */
  readonly raw: DeepReadonly<AssistantClearOperationV1>;
  operationId: string;
  requestId: string;
  scope: ClearScope;
  scenarioId: string | null;
  captured: CapturedScope[];
  commitment: { count: number; canonical: string };
  startedAt: string;
  configurationOutcome: ClearConfigurationOutcome;
  /** The version the row carried, so a legacy row is normalised rather than faked. */
  version: number;
}

/**
 * What recovery did, and what it knows about what it could not do.
 *
 * A TYPED REPORT RATHER THAN A THROW. Recovery runs at hydration, where the caller
 * cannot afford an exception -- but it also cannot afford to lose the identity of a
 * pending operation it had already read. Throwing discards exactly that, which is how
 * a failed recovery of one scenario's history ends up offering to delete everything.
 * `candidates` is what was validated before anything went wrong; `failed` says the
 * deletion pass did not complete.
 */
export interface ClearRecoveryReport extends ClearDeletion {
  candidates: ClearCandidate[];
  failed: boolean;
}

export async function resumePendingClears(
  config: ClearRepoConfig = {},
): Promise<ClearRecoveryReport> {
  const { db, barrier } = resolve(config);
  // READ THE IDENTITIES FIRST, outside the transaction that may fail. A pending row
  // this build can validate is a fact about what the user asked for, and losing it
  // because a later write failed is exactly what forced the caller to guess a scope.
  let candidates: ClearCandidate[] = [];
  try {
    candidates = await readClearCandidates(config);
  } catch {
    // No identity could be read at all. The caller must not invent one.
  }
  try {
    return { ...(await runRecovery(db, barrier)), candidates, failed: false };
  } catch {
    return { outcome: "deleted", ...NOTHING_DELETED, candidates, failed: true };
  }
}

/**
 * A TEST-ONLY seam onto the comparator above, and deliberately named so that using it
 * anywhere else reads as a mistake.
 *
 * The comparator is not a general structured-clone equality routine and must not become
 * one -- it is fail-closed for the accepted Clear-operation row domain specifically.
 * But the strict parser guards every production path that reaches it, so its handling of
 * values outside that domain cannot be observed through `terminalizeRecoveryFailure`;
 * left unpinned, it is free to rot into a hazard the day an accepted layout carries a
 * `Date`. This exists so that contract has a home, and no other reason.
 */
export const exactClearRowEqualityForTest = isExactSameRow;

/** Recursively `readonly`, so the snapshot is immutable to the type system too. */
type DeepReadonly<T> = T extends (infer Element)[]
  ? readonly DeepReadonly<Element>[]
  : T extends readonly (infer Element)[]
    ? readonly DeepReadonly<Element>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

/** Freeze a structured-cloned row and everything reachable from it. */
function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value as DeepReadonly<T>;
}

/** Every pending operation this build can validate, as exact candidates. */
export async function readClearCandidates(config: ClearRepoConfig = {}): Promise<ClearCandidate[]> {
  const { db } = resolve(config);
  return (await db.assistantClearOperations.toArray())
    .map((row) => toCandidate(row))
    .filter((candidate): candidate is ClearCandidate => candidate !== null);
}

/**
 * Build an exact candidate from a durable row, preserving every field it really has.
 *
 * A field is SYNTHESIZED only where the row's historical shape never contained one:
 * a pre-version-4 row has no request id, so the operation id stands in, and its
 * configuration fact is derived from what its own state proves. Nothing already
 * present is replaced.
 */
function toCandidate(row: AssistantClearOperationV1): ClearCandidate | null {
  const parsed = readOperation(row) ?? readStrandedLegacyPending(row);
  if (!parsed) return null;
  const version = typeof row.version === "number" ? row.version : 0;
  const tail = version === 5 || version === 4 ? readCanonicalTail(row, parsed.scope) : null;
  return deepFreeze({
    // CLONED AND FROZEN. The clone stops the snapshot drifting with the caller's copy
    // of the row; the freeze stops anyone holding a candidate from editing the thing
    // the comparison is against. A snapshot that can be edited after capture is not a
    // snapshot, and `terminalizeRecoveryFailure` is exported -- it takes this object
    // from callers this module does not control.
    raw: deepFreeze(structuredClone(row)),
    operationId: parsed.operationId,
    requestId: tail?.requestId ?? parsed.operationId,
    scope: parsed.scope,
    scenarioId: parsed.scenarioId,
    captured: parsed.captured,
    commitment: commitmentFor(parsed.captured),
    startedAt: row.startedAt,
    configurationOutcome:
      tail?.facts.configurationOutcome ?? provenConfiguration(parsed.scope, "pending"),
    version,
  }) as ClearCandidate;
}

/**
 * What one terminalization attempt did.
 *
 * `no_op` IS NOT AN ERROR: the observed operation was consumed, completed by another
 * tab, or replaced. There is nothing to report and nothing to warn about.
 */
export type ClearTerminalizeResult = "terminalized" | "no_op" | "transaction_failed";

/**
 * Turn ONE observed pending operation into a failed terminal record, and only if it is
 * still exactly the row that was observed.
 *
 * COMPARE-AND-SWAP, inside a single read-write transaction. Recovery reads its
 * candidates, then does work that can fail; by the time this runs, another tab may
 * have completed that operation, a newer invocation may have written a terminal row at
 * the same key, or the row may be gone. An unconditional `put` would resurrect or
 * clobber any of those with a stale snapshot. So the row is re-read here, re-validated
 * as the SAME strict pending candidate, and replaced only then.
 *
 * Everything durable is carried across: request id, captured set, commitment, start
 * time and the configuration fact. Only the state transition fields change.
 */
export async function terminalizeRecoveryFailure(
  candidate: ClearCandidate,
  config: ClearRepoConfig = {},
): Promise<ClearTerminalizeResult> {
  const { db } = resolve(config);
  try {
    return await db.transaction("rw", ["assistantClearOperations"], async () => {
      const current = await db.assistantClearOperations.get(candidate.operationId);
      if (!current) return "no_op";
      // EXACT STORED ROW, not the parsed view of it. Missing, consumed, already
      // terminal, malformed, future, reordered, relayered, or simply not the same row
      // any more: every one of those is a no-op, not a write.
      if (!isExactSameRow(current, candidate.raw)) return "no_op";
      // The semantic parse is still required -- exact equality proves the row did not
      // change, not that it was ever a legitimate pending operation. Its result is also
      // what the terminal record below is built from.
      const observed = toCandidate(current);
      if (!observed) return "no_op";
      // BUILT FROM THE ROW JUST READ AND JUST VALIDATED -- never from the candidate the
      // caller handed in. Exact equality has already proved the two describe the same
      // row, so this is equivalent for a well-behaved caller and immune to a badly
      // behaved one: `requestId` and `configurationOutcome` are SYNTHESIZED for legacy
      // layouts that lack them, and taking those from the argument would let a caller
      // inject facts into a durable record whose raw bytes it never touched.
      const raw = current;
      const record: AssistantClearOperationV1 = {
        operationId: raw.operationId,
        version: CLEAR_OPERATION_VERSION,
        requestId: raw.requestId ?? observed.requestId,
        scope: raw.scope,
        scenarioId: raw.scenarioId,
        captured: raw.captured,
        commitment: raw.commitment,
        startedAt: raw.startedAt,
        outcome: "failed",
        reason: "storage",
        settlement: null,
        deletionOutcome: null,
        configurationOutcome: raw.configurationOutcome ?? observed.configurationOutcome,
      };
      await db.assistantClearOperations.put(record);
      return "terminalized";
    });
  } catch {
    // DISTINCT FROM `no_op`. A no-op means the world moved on and there is nothing to
    // say; a transaction failure means storage itself did not answer, which the caller
    // may surface as a bounded storage state. Collapsing the two let a perfectly
    // ordinary ABA no-op raise a warning.
    return "transaction_failed";
  }
}

/**
 * Exact structural equality of two stored rows -- the CAS identity test.
 *
 * KEY-FOR-KEY AND ORDER-SENSITIVE, deliberately, and in both respects stricter than
 * the semantic parser it sits beside:
 *
 *   * the KEY SET is part of the row's layout, so a version-2 record that gained or
 *     lost its `outcome` key is a different record even though both layouts parse;
 *   * ARRAY ORDER is part of the stored bytes, so a reordered `captured` is a
 *     different row even though the commitment normalizes order away.
 *
 * `undefined` is compared as a present value rather than an absent key, so an
 * explicitly-undefined field cannot masquerade as a missing one.
 *
 */
function isExactSameRow(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((entry, index) => isExactSameRow(entry, right[index]));
  }
  if (typeof left !== "object") return false;
  // A DATE HAS NO ENUMERABLE KEYS, so the generic object path below would compare two
  // different instants as equal -- an "exact" comparator quietly agreeing that two
  // different values are the same. No accepted row layout carries one today; this is
  // here so the helper stays safe if one ever does.
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  // FAIL CLOSED OUTSIDE THE DURABLE VALUE DOMAIN. Structured clone can carry Map, Set,
  // RegExp, typed arrays and more, and each of those would also fall through the
  // key-walk below as an indistinguishable empty object. A value this comparator
  // cannot reason about is treated as "not provably identical", which costs at most a
  // spurious no-op and never authorizes a write.
  if (
    Object.getPrototypeOf(left) !== Object.prototype ||
    Object.getPrototypeOf(right) !== Object.prototype
  )
    return false;
  const leftKeys = Object.keys(left as object);
  const rightKeys = Object.keys(right as object);
  if (leftKeys.length !== rightKeys.length) return false;
  // Presence, not order: a JS object's key order is not part of what IndexedDB stores,
  // but which keys exist certainly is.
  if (!leftKeys.every((key) => rightKeys.includes(key))) return false;
  return leftKeys.every((key) =>
    isExactSameRow((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}

async function runRecovery(
  db: NurseSchedulerDb,
  barrier: ClearRepoConfig["barrier"],
): Promise<ClearDeletion> {
  const deleted = await db.transaction("rw", ASSISTANT_CLEAR_TABLES, async () => {
    const totals = { ...NOTHING_DELETED };
    const add = (part: Omit<ClearDeletion, "outcome"> | null) => {
      if (part)
        for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += part[key];
    };
    const records = await db.assistantClearOperations.toArray();
    for (const record of records) add(await runOwnedClear(db, record.operationId, barrier));
    await normalizeStrandedLegacyPending(db);
    add(await deleteOrphanClearedThreads(db));
    return totals;
  });
  return { outcome: "deleted", ...deleted };
}

/**
 * Turn every shipped version-2 `pending` row into a visible canonical `failed` record.
 *
 * DETERMINISTIC, AND IT DELETES NOTHING. Identity, scope, scenario, captured set,
 * commitment and `startedAt` are carried across unchanged, so the tombstone still
 * sorts by the moment the original clear actually began and a later outcome still
 * wins the notice. What changes is only what the record CLAIMS: no longer authority
 * (this build will not delete on a shape whose layout is ambiguous), but a failure the
 * user can see and retry -- which is the alternative to leaving a fenced, undeleted
 * clear invisible forever.
 *
 * Runs AFTER the recovery loop, so a row this build can genuinely claim has already
 * had its chance, and inside the same transaction, so an interrupted upgrade is never
 * half applied.
 */
async function normalizeStrandedLegacyPending(db: NurseSchedulerDb): Promise<number> {
  let normalized = 0;
  for (const row of await db.assistantClearOperations.toArray()) {
    if (!readStrandedLegacyPending(row)) continue;
    // Carried across UNCHANGED: identity, scope, scenario, captured set, commitment
    // and `startedAt`. What is added is the canonical tail this build's readers
    // require -- a request id (the operation's own, since the original invocation's
    // was never recorded) and the three fact fields, honestly null.
    await db.assistantClearOperations.put({
      operationId: row.operationId,
      version: CLEAR_OPERATION_VERSION,
      requestId: row.operationId,
      scope: row.scope,
      scenarioId: row.scenarioId,
      captured: row.captured,
      commitment: row.commitment,
      startedAt: row.startedAt,
      outcome: "failed",
      reason: "storage",
      settlement: null,
      deletionOutcome: null,
      // The legacy shape never recorded this; derive what its own state proves.
      configurationOutcome: provenConfiguration(row.scope, "failed"),
    });
    normalized += 1;
  }
  return normalized;
}

async function deleteOrphanClearedThreads(
  db: NurseSchedulerDb,
): Promise<Omit<ClearDeletion, "outcome">> {
  const threads = await db.assistantThreads.where("state").equals("cleared").toArray();
  if (threads.length === 0) return { ...NOTHING_DELETED };
  const threadIds = new Set(threads.map((t) => t.threadId));
  const doomedMessages = (await db.assistantMessages.toArray()).filter((m) =>
    threadIds.has(m.threadId),
  );
  for (const m of doomedMessages) await db.assistantMessages.delete(m.messageId);
  const doomedTurns = (await db.assistantTurns.toArray()).filter((t) => threadIds.has(t.threadId));
  for (const t of doomedTurns) await db.assistantTurns.delete(t.turnId);
  for (const threadId of threadIds) await db.assistantThreads.delete(threadId);
  return {
    ...NOTHING_DELETED,
    threads: threadIds.size,
    messages: doomedMessages.length,
    turns: doomedTurns.length,
  };
}

async function deleteClearedContent(
  db: NurseSchedulerDb,
  scope: ClearScope,
  scenarioId: string | null,
): Promise<Omit<ClearDeletion, "outcome">> {
  if (scope === "history" && !scenarioId)
    throw new Error("clear history requires a scenario identity");
  const allCleared = await db.assistantThreads.where("state").equals("cleared").toArray();
  const threads =
    scope === "all" ? allCleared : allCleared.filter((t) => t.scenarioId === scenarioId);
  const threadIds = new Set(threads.map((t) => t.threadId));
  const scenarioIds = new Set(scope === "all" ? [] : [scenarioId!]);
  const everyScenario = scope === "all";

  const messages = await db.assistantMessages.toArray();
  for (const m of messages.filter((m) => threadIds.has(m.threadId)))
    await db.assistantMessages.delete(m.messageId);
  const turns = await db.assistantTurns.toArray();
  for (const t of turns.filter((t) => threadIds.has(t.threadId)))
    await db.assistantTurns.delete(t.turnId);
  const proposals = (await db.assistantProposals.toArray()).filter(
    (p) => everyScenario || scenarioIds.has(p.scenarioId),
  );
  for (const p of proposals) await db.assistantProposals.delete(p.proposalId);
  const receipts = (await db.assistantReceipts.toArray()).filter(
    (r) => everyScenario || scenarioIds.has(r.scenarioId),
  );
  for (const r of receipts) await db.assistantReceipts.delete(r.receiptId);
  const allSearches = await db.diagnosticSearches.toArray();
  const searches = allSearches.filter((s) => everyScenario || scenarioIds.has(s.scenarioId));
  for (const s of searches) await db.diagnosticSearches.delete(s.searchId);
  for (const threadId of threadIds) await db.assistantThreads.delete(threadId);
  if (scope === "all") await db.assistantSettings.delete(ASSISTANT_SETTINGS_KEY);

  return {
    threads: threadIds.size,
    messages: messages.filter((m) => threadIds.has(m.threadId)).length,
    turns: turns.filter((t) => threadIds.has(t.threadId)).length,
    proposals: proposals.length,
    receipts: receipts.length,
    searches: searches.length,
  };
}

// --- The canonical Clear fact record ---

/**
 * THE fact model. One shape for the direct return value, the durable terminal record,
 * the bridge and the hydrated projection, so those four can be compared field by field
 * instead of being reconciled by hand at each boundary.
 *
 * Every member is bounded and secret-safe: two ids, an enumerated scope and scenario
 * identity, an enumerated status and reason, and the two facts the interruption
 * actually established. No raw error, no message, no payload.
 */
export interface ClearFacts {
  /** The UI invocation's own id, minted before any I/O. Distinguishes repeats. */
  requestId: string;
  /** The operation identity, also minted before any I/O. */
  operationId: string;
  scope: ClearScope;
  scenarioId: string | null;
  status: "deleted" | "incomplete" | "failed";
  reason: ClearFailureReason | null;
  /** The real bounded settlement class, or `null` if settlement never ran. */
  settlement: AssistantSettlement | null;
  /** The real deletion outcome, or `null` if the deletion pass never ran. */
  deletionOutcome: "deleted" | "superseded" | null;
  /** What this invocation proved about the stored configuration. */
  configurationOutcome: ClearConfigurationOutcome;
}

/** A durable terminal record, as read back off disk. */
export interface PersistedClearOutcome extends ClearFacts {
  status: "incomplete" | "failed";
  at: string;
}

/**
 * Write the terminal facts of one operation under ITS OWN identity.
 *
 * Never mints an id: the operation id belongs to the invocation and was minted before
 * begin, so the row a caller can find later is the row its result names. The captured
 * stub satisfies the same scope contract the reader enforces, which is what stops a
 * terminal record from claiming a scenario its capture does not support.
 */
export async function persistClearFacts(
  facts: ClearFacts & { status: "incomplete" | "failed" },
  config: ClearRepoConfig = {},
): Promise<string | null> {
  const { db, now } = resolve(config);
  const at = now();
  const stub = facts.scope === "history" ? (facts.scenarioId ?? "").trim() : null;
  if (facts.scope === "history" && !stub) return null;
  if (!facts.operationId || facts.operationId !== facts.operationId.trim()) return null;
  const captured = normalizeCaptured([
    {
      scopeKey: facts.scope === "all" ? GLOBAL_GENERATION_SCOPE : scenarioGenerationScope(stub!),
      generation: 0,
    },
  ]);
  if (!captured) return null;
  const record: AssistantClearOperationV1 = {
    operationId: facts.operationId,
    version: CLEAR_OPERATION_VERSION,
    requestId: facts.requestId,
    scope: facts.scope,
    scenarioId: stub,
    captured,
    commitment: commitmentFor(captured),
    startedAt: at.toISOString(),
    outcome: facts.status,
    reason: facts.reason,
    settlement: facts.settlement,
    deletionOutcome: facts.deletionOutcome,
    configurationOutcome: facts.configurationOutcome,
  };
  try {
    await db.assistantClearOperations.put(record);
    return facts.operationId;
  } catch {
    return null;
  }
}

/**
 * Read a durable TERMINAL record: a product outcome, never deletion authority.
 *
 * AS STRICT AS THE AUTHORITY PARSER, and strict in the same places -- it shares
 * `readOperationBody`, which owns the identity, timestamp, scope/capture contract and
 * commitment rules. The extra work here is only the version dispatch and, for version
 * 4, the bounded fact tail. A record that names one scenario while committing to
 * another's fence is refused for the same reason a pending one would be: it cannot be
 * both, so it is neither.
 *
 * VERSIONS 4, 3 AND 2 ARE ALL READ. The older two carry no settlement or deletion
 * facts, which is reported honestly as `null` rather than guessed at -- and reading
 * them at all is what stops an upgrade from silently swallowing a notice the user had
 * already been shown.
 */
function readOutcomeRecord(record: unknown): PersistedClearOutcome | null {
  const r = record as Record<string, unknown> | null;
  if (!r) return null;
  const version = r.version;
  if (version !== 5 && version !== 4 && version !== 3 && version !== 2) return null;
  const keys = version === 5 ? CANONICAL_KEYS : version === 4 ? V4_KEYS : OUTCOME_BEARING_KEYS;
  const parsed = readOperationBody(record, keys);
  if (!parsed) return null;
  if (r.outcome !== "incomplete" && r.outcome !== "failed") return null;
  const tail =
    version === 5 || version === 4
      ? readCanonicalTail(record, parsed.scope)
      : {
          requestId: parsed.operationId,
          facts: {
            ...LEGACY_FACTS,
            configurationOutcome: provenConfiguration(parsed.scope, r.outcome),
          },
        };
  if (!tail) return null;
  return {
    requestId: tail.requestId,
    operationId: parsed.operationId,
    scope: parsed.scope,
    scenarioId: parsed.scenarioId,
    status: r.outcome,
    reason: tail.facts.reason,
    settlement: tail.facts.settlement,
    deletionOutcome: tail.facts.deletionOutcome,
    configurationOutcome: tail.facts.configurationOutcome,
    at: r.startedAt as string,
  };
}

/**
 * What a pre-version-4 terminal record knows about settlement and deletion: nothing.
 *
 * Stated as explicit nulls rather than reconstructed, because a guess here would be
 * indistinguishable from a fact at every surface that reads it.
 */
const LEGACY_FACTS: Omit<CanonicalTail, "configurationOutcome"> = {
  reason: null,
  settlement: null,
  deletionOutcome: null,
};

/** Every durable terminal record the strict parser accepts, newest first. */
export async function readClearFacts(
  config: ClearRepoConfig = {},
): Promise<PersistedClearOutcome[]> {
  const { db } = resolve(config);
  const validated: PersistedClearOutcome[] = [];
  for (const row of await db.assistantClearOperations.toArray()) {
    const parsed = readOutcomeRecord(row);
    if (parsed) validated.push(parsed);
  }
  return validated.sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0));
}

export async function readClearOutcome(
  config: ClearRepoConfig = {},
): Promise<PersistedClearOutcome | null> {
  return (await readClearFacts(config))[0] ?? null;
}

/**
 * The product-outcome identities a scoped invocation may later retire.
 *
 * READ BEFORE THE INVOCATION FENCES, so the set is causally its PREDECESSORS: a
 * tombstone written by a later or concurrent call is not in it and therefore cannot be
 * consumed by this call's success. Malformed and future rows are never listed, so they
 * are never retired either.
 */
export async function readClearOutcomeIds(
  scope: ClearScope,
  scenarioId: string | null,
  config: ClearRepoConfig = {},
): Promise<string[]> {
  const { db } = resolve(config);
  const rows = await db.assistantClearOperations.toArray();
  const ids: string[] = [];
  for (const row of rows) {
    const parsed = readOutcomeRecord(row);
    if (!parsed) continue;
    if (parsed.scope !== scope || parsed.scenarioId !== scenarioId) continue;
    ids.push(parsed.operationId);
  }
  return ids;
}

/**
 * Retire the outcome tombstones a successful scoped clear causally owns.
 *
 * NOT A SCAN-AND-DELETE. `predecessorOperationIds` is the exact set captured before
 * this invocation began; anything outside it -- a queued call's tombstone, another
 * tab's, a later failure -- survives byte for byte. The scope/scenario check stays as
 * a second gate so a captured id from one scenario can never retire another's, and the
 * strict parser stays as a third so malformed or future rows are preserved.
 */
export async function clearOutcomes(
  scope: ClearScope,
  scenarioId: string | null,
  config: ClearRepoConfig & {
    predecessorStartedAt?: string;
    predecessorOperationIds?: readonly string[];
  } = {},
): Promise<void> {
  if (scope === "all") return;
  const { db } = resolve(config);
  const cutoff = config.predecessorStartedAt;
  const allowed = config.predecessorOperationIds ? new Set(config.predecessorOperationIds) : null;
  const rows = await db.assistantClearOperations.toArray();
  for (const row of rows) {
    // VALIDATE THROUGH THE STRICT PARSER: only rows readOutcomeRecord accepts may be
    // retired. A malformed or future-version row must survive.
    const parsed = readOutcomeRecord(row);
    if (!parsed) continue;
    if (parsed.scope !== scope || parsed.scenarioId !== scenarioId) continue;
    if (allowed && !allowed.has(parsed.operationId)) continue;
    if (cutoff && parsed.at > cutoff) continue;
    await db.assistantClearOperations.delete(parsed.operationId);
  }
}
