"use client";

// F2 — the roster capture state machine.
//
// This replaces the old boolean terminal gate. The previous shape hid the
// restored blob in a tab-ref, deleted the server job immediately after the
// download, and guarded only the AUTO effect (`autoDoneRef`) — so a manual
// Download could run a second, concurrent chain, and cleanup could DELETE with
// no candidate authority at all. Here the whole terminal capture for one job is
// ONE coalesced promise that the auto effect and the manual download both await,
// and a server DELETE is authorized only by a cleanup TOKEN this machine issues.
//
// The invariants worth stating, because the tests exist to break them:
//
//   • FETCH BEFORE DELETE. `/roster` is fetched before any DELETE can be
//     authorized; the server artifact is the only copy until a candidate is
//     durably committed.
//   • ONE TOKEN, TWO KINDS. `committed(jobId, candidateVersion)` or an EXPLICIT
//     `dismissed(jobId, reason)`. Nothing else authorizes a DELETE, and an
//     unresolved capture (`fetch-failed` / `commit-failed`) issues no token at
//     all, so the job and its artifact survive for a retry.
//   • NEVER A FALSE COMMIT. An older submission completing late makes F1 return
//     `superseded` — nothing stored, pointer unmoved. That locally proven outcome
//     becomes `dismissed(reason: "superseded")`, never a `committed` token.
//   • THE WORKING SLOT IS F1'S CALL, ONCE. A commit either filled a PROVEN-empty
//     working slot or preserved what was there; F1 decides that inside the same
//     transaction and returns a closed disposition, which is passed through on the
//     `committed` state verbatim. F2 never re-reads `working` to infer it — that
//     read races every other tab and cannot attribute the slot's contents to THIS
//     commit.
//   • RETRY BY FAILURE MODE. `fetch-failed` retries the SERVER fetch (the job must
//     still exist); `commit-failed` retries the LOCAL write with the container and
//     bytes already in hand and never refetches.
//   • DISMISS SERIALIZES WITH THE FLIGHT. `dismiss()` marks the entry invalidated,
//     then AWAITS the in-flight capture before acting. A dismissal that lost the
//     race to a successful commit is applied afterwards through F1's EXACT
//     `{jobId, candidateVersion}` authority, so it can never delete a same-job
//     retry that replaced the candidate it was decided against.
//   • DEGRADED IS NOT BLOCKED. A run with no durable exact-submission authority
//     (snapshot persistence denied, or a crash-cut record whose snapshot is gone)
//     resolves to `unavailable` WITH a dismissal token: there was never a
//     candidate to lose, so standard parity cleanup stays authorized while roster
//     Load/Retry stays hidden.

import { isExactJobGoneError } from "@/lib/bff/errors";
import { fetchOptimizeRoster } from "@/lib/query/optimize";
import {
  rosterStorage,
  type CandidateWorkingDisposition,
  type CurrentCandidatePointer,
  type RosterStorage,
} from "@/lib/store";
import type { SessionCaptureState } from "./session-transaction";
import {
  purgeSubmissionSnapshot,
  readStagedSubmissionSnapshot,
  type StagedSubmission,
  type SubmissionSnapshotStore,
} from "./submission-snapshot";

// ---------------------------------------------------------------------------
// The F3 boundary
// ---------------------------------------------------------------------------

/**
 * Everything F2 can hand a document builder. F2 owns orchestration, durability,
 * and cleanup authority; it deliberately does NOT know the roster document
 * schema, the baseline hash, overlay normalization, or the file codec — those are
 * F3's. Keeping the seam this narrow is what lets capture be tested against a
 * stub without duplicating (or drifting from) F3's validation.
 */
export interface CandidateBuildInput {
  jobId: string;
  /** The origin-wide ordering authority allocated with the snapshot. */
  submissionOrdinal: number;
  /** The raw parsed `/roster` container body (the B2/B3 wire shape). */
  container: unknown;
  /** The immutable exact submission — the ONLY de-anonymization authority. */
  snapshot: StagedSubmission;
  /** The already-restored, de-anonymized workbook: the frozen render input. */
  frozenXlsx: Blob;
}
/**
 * A validated document, or the reason it could not be assembled.
 *
 * `retryable` is the builder's own verdict on whether repeating the SAME inputs
 * could ever succeed, and it decides the capture outcome:
 *
 *   • `true`  — a transient local failure (storage hiccup, transient assembler
 *     error). The container and frozen bytes stay in hand and the run parks in
 *     `commit-failed` with a Retry that can actually work. No DELETE token.
 *   • `false` — structurally impossible from these inputs: a container F3 rejects,
 *     a submission envelope version F3 does not own, an unavailable assembler.
 *     Retrying is pure noise, so the run resolves to `unavailable` and IS eligible
 *     for cleanup — the `/roster` fetch already happened and there is no candidate
 *     to preserve.
 */
export type CandidateBuildResult =
  | { ok: true; document: unknown }
  | { ok: false; retryable: boolean; reason: string };

export type BuildCandidateDocument = (
  input: CandidateBuildInput,
) => Promise<CandidateBuildResult> | CandidateBuildResult;

// ---------------------------------------------------------------------------
// States and tokens
// ---------------------------------------------------------------------------

/**
 * The causes that are knowable BEFORE any `/roster` fetch. These are the ONLY
 * cases where the roster-attempt fence is vacuous rather than skipped: there is no
 * roster to fetch and no candidate to lose, so cleanup is authorized without one.
 * Kept as its own type because the cleanup-token union narrows on it — that is
 * what makes `rosterAttempted: false` unreachable anywhere else.
 */
export type PreFetchUnavailableCause =
  /** The pre-POST snapshot transaction failed; the run was staged degraded. */
  | "snapshot_persist_failed"
  /**
   * A staged authority's snapshot is provably gone: a successful read returned
   * absent or structurally unusable. This is the ONLY way this cause is reached
   * — a null authority (recovery handoff) defers rather than claiming it, so a
   * transiently-unattached activation can never manufacture proven absence.
   */
  | "snapshot_missing"
  /**
   * Recovery's boot inspection PROVED that no durable session record can attach
   * for this job — the slot is empty, holds an orphan provisional, or holds a
   * record naming a different job. No authority will ever arrive, so unlike a
   * transient null this is a DURABLE outcome that settles rather than defers.
   *
   * Deliberately distinct from `snapshot_missing`: that one means a STAGED
   * authority was found and a successful read proved its snapshot gone. Here no
   * authority was ever found. Different situations, different user guidance.
   */
  | "session_record_absent"
  /** The job completed with no downloadable artifact — nothing to capture. */
  | "no-artifact";

/** Why a run can never offer roster capture. */
export type CaptureUnavailableCause =
  | PreFetchUnavailableCause
  /**
   * The `/roster` fetch SUCCEEDED but the document could not be assembled from
   * it, non-retryably (see `CandidateBuildResult.retryable`). Unlike the pre-fetch
   * causes this one is reached only after a real fetch, so its token is a normal
   * post-fence dismissal.
   */
  | "assembly-rejected";

/** Terminal unavailable causes the user is told about (see `CaptureNotice`). */
export const TERMINAL_UNAVAILABLE_CAUSES = [
  "snapshot_persist_failed",
  "snapshot_missing",
  "session_record_absent",
  "assembly-rejected",
] as const satisfies readonly CaptureUnavailableCause[];

export type CaptureDismissalReason =
  /** The user explicitly declined the candidate. */
  | "user"
  /** F1 proved this submission older than the current pointer. */
  | "superseded"
  /** A verified Clear invalidated the epoch this capture started under. */
  | "cleared"
  /** The fetched roster could not be assembled into a loadable document. */
  | "assembly-rejected";

export type RosterCaptureState =
  | { status: "idle" }
  | { status: "unavailable"; cause: CaptureUnavailableCause }
  | { status: "fetching-roster" }
  | { status: "committing" }
  | {
      status: "committed";
      pointer: CurrentCandidatePointer;
      /**
       * What the SAME commit transaction did with the working slot — F1's closed
       * disposition, passed through verbatim. Callers read this instead of doing
       * their own follow-up read of `working`: that read races every other tab
       * and cannot say whether THIS commit filled the slot.
       */
      working: CandidateWorkingDisposition;
    }
  | {
      status: "fetch-failed";
      message: string;
      /**
       * The job is provably gone (server retention is best-effort, not a
       * guaranteed window). A server retry is impossible; Load is permanently
       * unavailable for this run.
       */
      jobGone: boolean;
    }
  | { status: "commit-failed"; message: string }
  /**
   * The user's dismissal could not be honoured LOCALLY: the exact-version
   * candidate deletion threw, hit a version conflict, or reported a stale epoch
   * whose purge could not be verified. No dismissal is claimed and no cleanup
   * token is issued — the candidate is still durable, so the server job must not
   * be deleted. Retried by calling `dismiss` again.
   */
  | { status: "dismiss-failed"; message: string }
  | { status: "dismissed"; reason: CaptureDismissalReason };

/**
 * The ONLY authority for a terminal server DELETE. Every DELETE assertion in the
 * tests proves a matching token existed first.
 */
export type CaptureCleanupToken =
  | {
      kind: "committed";
      jobId: string;
      candidateVersion: number;
      submissionOrdinal: number;
      /** A commit is unreachable without a fetch, so this is structurally `true`. */
      rosterAttempted: true;
    }
  | {
      kind: "dismissed";
      jobId: string;
      reason: CaptureDismissalReason;
      /**
       * Every dismissal — user, superseded, cleared, assembly-rejected — is issued
       * only after the fence has run, so this is structurally `true`. A dismissal
       * that has NOT reached `/roster` yet cannot produce a token at all: it
       * becomes a retryable `dismiss-failed` instead, because a local failure must
       * never manufacture DELETE authority.
       */
      rosterAttempted: true;
    }
  | {
      kind: "unavailable";
      jobId: string;
      /**
       * Restricted to `PreFetchUnavailableCause`. This variant is the ONE place
       * `rosterAttempted: false` is representable, and the narrowed `cause` is what
       * makes the exception provable at the type level rather than asserted in a
       * comment: there is no roster to fetch and no candidate to lose, so the fence
       * is vacuous. `assembly-rejected` is deliberately NOT here — it happens after
       * a real fetch and issues a `dismissed` token.
       */
      cause: PreFetchUnavailableCause;
      rosterAttempted: false;
    };

export interface CaptureOutcome {
  state: RosterCaptureState;
  /** Non-null exactly when a terminal DELETE is authorized for this job. */
  token: CaptureCleanupToken | null;
}

/**
 * The result of an explicit dismissal. `failed` means the local candidate could
 * NOT be proven removed — no dismissal is claimed and no DELETE is authorized,
 * because deleting the server job while the real-identity candidate is still
 * durable would strand it with no way to reach it.
 */
export type DismissOutcome =
  | { status: "dismissed"; token: CaptureCleanupToken }
  | { status: "failed"; message: string };

/**
 * The outcome of dismissing a candidate identified only by what is displayed.
 *
 * Deliberately NOT `DismissOutcome`. That type guarantees a cleanup token,
 * because every path reaching it has proven the roster-attempt fence in this
 * process. A durable candidate found on disk after a reload has not — and cannot
 * — so its token is genuinely optional. Sharing one type would have forced the
 * in-session guarantee to be weakened to `| null` everywhere it is relied on.
 */
export type DurableDismissOutcome =
  | { status: "dismissed"; token: CaptureCleanupToken | null }
  | { status: "failed"; message: string };

/**
 * The exact candidate a durable surface is displaying.
 *
 * Both fields are required because a job id alone does not identify a capture:
 * a retry commits a NEW `candidateVersion` for the same job, and a decision made
 * about the old one must not silently apply to the new one.
 */
export interface DurableCandidateRef {
  jobId: string;
  candidateVersion: number;
}

/** What the terminal orchestration knows about one completed job. */
export interface CaptureRequest {
  jobId: string;
  /**
   * What the caller can PROVE about this job's capture authority.
   *
   *   • `SessionCaptureState` — the exact authority the session record carried
   *     from before the POST (staged, or a degraded `unavailable`).
   *   • `{ status: "absent" }` — recovery's boot inspection PROVED that no
   *     durable record can attach for this job. Nothing will ever arrive, so the
   *     gate settles it instead of waiting forever.
   *   • `null` — nothing is proven yet.
   *
   * Null is NOT proof of absence: a remount starts with component-local
   * activation null and recovery attaches the durable record from a later
   * passive effect. The gate therefore defers on null — no token, no settle,
   * and (critically) no FLIGHT, so a later exact request cannot join it —
   * rather than manufacturing a `snapshot_missing` outcome, so the intact
   * snapshot remains usable once recovery exposes it.
   */
  capture: SessionCaptureState | { status: "absent" } | null;
  /**
   * The restored (de-anonymized) workbook bytes already in hand from the parity
   * download, or null when the run produced no artifact. Capture NEVER refetches
   * the workbook — it reuses exactly the bytes the user downloaded.
   */
  frozenXlsx: Blob | null;
}

const IDLE: RosterCaptureState = { status: "idle" };

/**
 * Whether a staging snapshot is PROVEN gone.
 *
 * Unproven is not an error to swallow. The row holds the exact canonical YAML and
 * the real-identity reverse map, so a dismissal that reports the saved roster was
 * discarded while that row survives is a false privacy claim — and under the
 * no-GC/no-expiry policy nothing else will ever collect it.
 */
type SnapshotPurgeProof = { proven: true } | { proven: false; message: string };

const SNAPSHOT_UNPROVEN =
  "The saved roster could not be verified as removed. Try discarding it again.";

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export interface RosterCaptureGate {
  /** The current state for a job (referentially stable until it changes). */
  getState(jobId: string): RosterCaptureState;
  /** The DELETE authority for a job, or null when none has been issued. */
  getToken(jobId: string): CaptureCleanupToken | null;
  /**
   * The jobs still holding raw `/roster` bytes, in insertion order.
   *
   * A retention diagnostic, not orchestration: the gate is app-lifetime, so which
   * entries keep large payloads is a property worth asserting directly rather than
   * inferring. Only an unresolved retryable `commit-failed` should ever appear.
   */
  retainedContainers(): string[];
  /**
   * Run (or join) the capture for one job. Concurrent callers — a StrictMode
   * effect replay and a simultaneous manual Download — receive the SAME promise,
   * so one `/roster` fetch and one commit happen no matter how many entered.
   * A settled job returns its settled outcome without re-running.
   */
  capture(request: CaptureRequest): Promise<CaptureOutcome>;
  /** Explicit retry after `fetch-failed` (refetches) or `commit-failed` (does not). */
  retry(request: CaptureRequest): Promise<CaptureOutcome>;
  /**
   * The user declines this candidate.
   *
   * Takes the full request, not just a job id, because a dismissal arriving
   * BEFORE the automatic capture must still honour the roster-attempt fence: it
   * marks the entry invalidated and then starts or joins the per-job flight, so
   * the `/roster` fetch happens (and the commit does not) before any token can
   * authorize deleting the server job.
   */
  dismiss(request: CaptureRequest): Promise<DismissOutcome>;
  /**
   * The user declines a candidate identified ONLY by what is on screen.
   *
   * This exists for the durable-pointer surface, which knows a
   * `{jobId, candidateVersion}` read out of F1 but holds no `CaptureRequest`:
   * after a reload there is no session record, no snapshot ref and no workbook
   * in hand. Routing that surface through the current run's unkeyed dismissal
   * instead is exactly how a durable candidate A gets "dismissed" by acting on a
   * later run B — B's authority consumed, A's payload untouched.
   *
   * The version is load-bearing, not decoration. The user decided against the
   * capture they were looking at; if a newer capture for the same job has landed
   * since, this must refuse rather than delete a candidate nobody declined.
   *
   * Server DELETE authority is issued only when this process can still prove the
   * roster-attempt fence for the job — i.e. when a live entry committed it. A
   * candidate found on disk after a fresh start is removed locally and yields NO
   * token: this process never fetched `/roster` for that job, and the session
   * that did already consumed its cleanup authority at commit time.
   */
  dismissDurableCandidate(request: DurableCandidateRef): Promise<DurableDismissOutcome>;
  /** A verified Clear happened: invalidate every entry it could still affect. */
  notifyCleared(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

type CaptureStore = SubmissionSnapshotStore &
  Pick<
    RosterStorage,
    "commitCandidate" | "dismissCandidate" | "readCandidate" | "readCurrentCandidate"
  >;

export interface RosterCaptureDeps {
  /** The F3-owned document builder. Required — F2 never invents a schema. */
  buildCandidate: BuildCandidateDocument;
  /** Defaults to the app-wide F1 repositories. */
  store?: CaptureStore;
  /** Defaults to the B3 `/roster` proxy client. */
  fetchRoster?: (jobId: string) => Promise<unknown>;
}

interface JobEntry {
  jobId: string;
  state: RosterCaptureState;
  token: CaptureCleanupToken | null;
  /**
   * The container retained across a failed commit. `hasFetched` is separate from
   * `container` because a container may legitimately be any JSON value, including
   * null — conflating the two would silently refetch on a `commit-failed` retry.
   */
  hasFetched: boolean;
  container: unknown;
  inFlight: Promise<CaptureOutcome> | null;
  /** Set by dismiss/Clear; checked at every suspension boundary before commit. */
  invalidated: CaptureDismissalReason | null;
  /** The clear epoch the current flight started under; -1 until one is read. */
  epoch: number;
  /** The staging snapshot owner, remembered so a later dismissal can purge it. */
  ownerId: string | null;
  /**
   * Whether a `/roster` fetch was attempted for this job (regardless of outcome).
   * This is the roster-attempt-before-DELETE evidence stamped onto every token.
   */
  rosterAttempted: boolean;
  /**
   * What a successful commit produced, retained across a failed dismissal so the
   * retry can present the SAME exact version rather than re-reading a pointer
   * that may since have moved — and so a resumed settle reports the working-slot
   * disposition THAT transaction decided rather than one re-derived from a later
   * read (which would describe the slot's state now, after another tab or an
   * import may have filled it).
   *
   * One field, not two: the pointer and the disposition are one commit's result,
   * so a state where only one of them is known is not representable.
   */
  committed: {
    pointer: CurrentCandidatePointer;
    working: CandidateWorkingDisposition;
  } | null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export function createRosterCapture(deps: RosterCaptureDeps): RosterCaptureGate {
  const store: CaptureStore = deps.store ?? rosterStorage;
  const fetchRoster = deps.fetchRoster ?? fetchOptimizeRoster;
  const entries = new Map<string, JobEntry>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function ensure(jobId: string): JobEntry {
    const existing = entries.get(jobId);
    if (existing) return existing;
    const entry: JobEntry = {
      jobId,
      state: IDLE,
      token: null,
      hasFetched: false,
      container: null,
      inFlight: null,
      invalidated: null,
      epoch: -1,
      ownerId: null,
      rosterAttempted: false,
      committed: null,
    };
    entries.set(jobId, entry);
    return entry;
  }

  function setState(entry: JobEntry, state: RosterCaptureState): void {
    entry.state = state;
    notify();
  }

  /** Read the token through a call so control-flow narrowing never survives an
   *  `await` — the entry is mutable and a flight may have settled meanwhile. */
  function readToken(entry: JobEntry): CaptureCleanupToken | null {
    return entry.token;
  }

  /**
   * A post-fence dismissal token. Callable ONLY once the roster attempt has
   * happened — every call site is downstream of the fetch, and the one path that
   * could reach it early (`dismiss` on a pre-fetch local failure) is refused there
   * instead. Throws rather than emitting a token that would silently claim a fence
   * that never ran.
   */
  function dismissalToken(entry: JobEntry, reason: CaptureDismissalReason): CaptureCleanupToken {
    if (!entry.rosterAttempted) {
      throw new Error(
        `roster capture: refusing a ${reason} cleanup token for ${entry.jobId} before any /roster attempt`,
      );
    }
    return { kind: "dismissed", jobId: entry.jobId, reason, rosterAttempted: true };
  }

  /**
   * The vacuous-fence token: the run was never capture-capable, so there is no
   * roster to fetch. The narrowed `cause` is the whole exception, stated once.
   */
  function unavailableToken(entry: JobEntry, cause: PreFetchUnavailableCause): CaptureCleanupToken {
    return { kind: "unavailable", jobId: entry.jobId, cause, rosterAttempted: false };
  }

  function outcomeOf(entry: JobEntry): CaptureOutcome {
    return { state: entry.state, token: entry.token };
  }

  /**
   * Drop the fetched roster container.
   *
   * Containers are the only large thing a job entry holds, and the entry itself
   * lives for the tab's lifetime (the gate is app-lifetime so tokens cannot be
   * re-issued after a remount). Retaining bytes is justified ONLY while a
   * retryable `commit-failed` could still reuse them; every terminal outcome
   * releases them and keeps just the small authority tombstone — state, token, and
   * the exact-version pointer a later dismissal needs.
   */
  function releaseContainer(entry: JobEntry): void {
    entry.container = null;
    entry.hasFetched = false;
  }

  function settle(
    entry: JobEntry,
    state: RosterCaptureState,
    token: CaptureCleanupToken | null,
  ): CaptureOutcome {
    // `commit-failed` is the one non-terminal settlement: its retry is purely local
    // and must not spend a second `/roster` fetch, so its bytes stay in hand.
    if (state.status !== "commit-failed") releaseContainer(entry);
    entry.state = state;
    entry.token = token;
    notify();
    return outcomeOf(entry);
  }

  /**
   * Settle an outcome whose staging purge could not be proven.
   *
   * NO TOKEN, so no server DELETE and no session-record removal: the exact canonical
   * YAML and real-identity reverse map are still stored, and the only durable handle
   * to them is the session record's `capture.snapshotRef`. Consuming that authority
   * now would leave the row unreachable by anything but a full Clear. `commit-failed`
   * is the existing retryable local-failure surface — it keeps the fetched container
   * in hand, so the retry costs no second `/roster` call.
   */
  function settleUnproven(entry: JobEntry, message: string): CaptureOutcome {
    return settle(entry, { status: "commit-failed", message }, null);
  }

  /**
   * Purge a staging snapshot; failure is reported by the helper, never thrown.
   * The epoch is read on demand when no flight has established one, so a dismissal
   * that arrives before any capture is still fenced against the CURRENT epoch
   * rather than silently presenting a fresh-database 0.
   */
  async function purge(
    entry: JobEntry,
    ownerId: string,
    authority: Parameters<typeof purgeSubmissionSnapshot>[0]["authority"],
  ): Promise<SnapshotPurgeProof> {
    if (entry.epoch < 0) {
      try {
        entry.epoch = await store.getClearEpoch();
      } catch (error) {
        // Storage is unreachable; the snapshot stays until Clear, which is the safe
        // direction (a retained snapshot is harmless, a wrong delete is not). It is
        // still UNPROVEN, so a caller that must claim removal has to say so.
        return { proven: false, message: errorMessage(error, SNAPSHOT_UNPROVEN) };
      }
    }
    const result = await purgeSubmissionSnapshot({
      ownerId,
      expectedClearEpoch: entry.epoch,
      authority,
      store,
    });
    const outcome = result.outcome;
    if (outcome.status === "deleted" || outcome.status === "already-absent") {
      return { proven: true };
    }
    if (outcome.status === "stale-epoch") {
      // A verified Clear advanced the epoch. Clear purges every snapshot, but the
      // refusal says the WRITE was declined, not that the payload went with it — so
      // absence is read back rather than inferred.
      const read = await readStagedSubmissionSnapshot(ownerId, store);
      if (read.status === "absent") return { proven: true };
      return { proven: false, message: SNAPSHOT_UNPROVEN };
    }
    return { proven: false, message: outcome.message };
  }

  /**
   * A dismissal or Clear landed while the capture was in flight. Nothing has been
   * committed at this point (the caller checks BEFORE the commit), so the only
   * work is purging the staging snapshot and issuing the explicit token.
   */
  async function finalizeInvalidated(
    entry: JobEntry,
    ownerId: string,
    reason: CaptureDismissalReason,
  ): Promise<CaptureOutcome> {
    if (reason !== "cleared") {
      // A verified Clear has already purged the stores AND advanced the epoch, so
      // an epoch-fenced delete would only report `stale-epoch`.
      const purged = await purge(entry, ownerId, "candidate-dismissed");
      if (!purged.proven) {
        // The user declined this candidate, but its exact submission is still stored.
        // Claiming `dismissed` would both tell them it is gone and hand out a token
        // authorizing the server copy's deletion — leaving the identity bytes as the
        // only surviving copy, unreachable by anything but Clear. Stay retryable.
        setState(entry, { status: "dismiss-failed", message: purged.message });
        return outcomeOf(entry);
      }
    }
    return settle(entry, { status: "dismissed", reason }, dismissalToken(entry, reason));
  }

  async function runCapture(entry: JobEntry, request: CaptureRequest): Promise<CaptureOutcome> {
    const authority = request.capture;

    // --- 1. Runs that can never capture ------------------------------------
    // Degraded is explicitly NOT a failure: no candidate was ever at stake, so a
    // dismissal token is issued immediately and parity cleanup stays authorized.
    if (authority !== null && authority.status === "unavailable") {
      return settle(
        entry,
        { status: "unavailable", cause: "snapshot_persist_failed" },
        unavailableToken(entry, "snapshot_persist_failed"),
      );
    }

    // Recovery PROVED no record can attach for this job. Unlike a transient null
    // this is durable, so waiting would strand the run with no token and no
    // cleanup forever. There is no snapshot ref to reach and no reverse map to
    // de-anonymize with, so nothing was ever capturable and the fence is vacuous.
    if (authority !== null && authority.status === "absent") {
      return settle(
        entry,
        { status: "unavailable", cause: "session_record_absent" },
        unavailableToken(entry, "session_record_absent"),
      );
    }

    // Authority not attached yet. The terminal hook starts every mount with
    // component-local activation null, and recovery exposes the durable record
    // from a passive effect that runs AFTER the terminal hook's own
    // completed-job effect. A null authority here proves only that this tab has
    // not attached the session record yet — NOT that the staged snapshot is
    // absent. Settling it as `snapshot_missing` would hand the gate a
    // vacuous-fence DELETE token from a transient read of the controller,
    // destroy the server job before capture can save the candidate, and make
    // the later-recovered snapshot unusable because the gate now replays its
    // token. Defer instead: leave the entry unsettled and issue no token, so
    // the next capture call (once recovery has attached the real authority)
    // runs against the intact snapshot. `snapshot_missing` is reachable ONLY
    // past a staged authority whose snapshot a successful read proves absent.
    if (authority === null) {
      return outcomeOf(entry);
    }

    const ownerId = authority.snapshotRef;
    entry.ownerId = ownerId;

    let epoch: number;
    try {
      epoch = await store.getClearEpoch();
    } catch (error) {
      // Local storage is unreachable. This is a LOCAL failure with the bytes still
      // on the server, so it is a retryable commit failure — never a token.
      return settle(
        entry,
        { status: "commit-failed", message: errorMessage(error, "Roster storage is unavailable.") },
        null,
      );
    }
    entry.epoch = epoch;

    // RESUME A PROVEN COMMIT WHOSE PURGE WAS NOT. The candidate is already durable,
    // so the only work left is the staging purge; re-assembling and re-committing
    // would spend a second candidate version to reach the same place. This is what
    // makes withholding the token above safe rather than terminal.
    if (entry.committed !== null) {
      const purged = await purge(entry, ownerId, "candidate-committed");
      if (!purged.proven) return settleUnproven(entry, purged.message);
      const { pointer, working } = entry.committed;
      return settle(
        entry,
        { status: "committed", pointer, working },
        {
          kind: "committed",
          jobId: entry.jobId,
          candidateVersion: pointer.candidateVersion,
          submissionOrdinal: pointer.submissionOrdinal,
          rosterAttempted: true,
        },
      );
    }

    // The snapshot is the only de-anonymization authority. A record whose snapshot
    // is absent (crash cut, or already consumed) is capture-unavailable — it is
    // never a reason to block the parity download, and never grounds to fabricate
    // context by reparsing the backend's roster coordinates.
    const read = await readStagedSubmissionSnapshot(ownerId, store);
    if (read.status === "unavailable") {
      // The read FAILED — that proves nothing about the snapshot, which may still be
      // intact. Treating it as absence would hand out a vacuous-fence token and let
      // a transient storage hiccup authorize deleting the only server-side copy.
      // It is a retryable local failure with no token, exactly like the epoch read.
      return settle(entry, { status: "commit-failed", message: read.message }, null);
    }
    if (read.status !== "found") {
      // PROVEN: the read succeeded and there is nothing consumable.
      return settle(
        entry,
        { status: "unavailable", cause: "snapshot_missing" },
        unavailableToken(entry, "snapshot_missing"),
      );
    }
    const snapshot = read.snapshot;

    if (request.frozenXlsx === null) {
      // Completed with no artifact: there is nothing to freeze, so the staging
      // snapshot is now provably useless. No candidate exists to hold a second copy
      // of it, so cleanup may only be authorized once the row is PROVEN gone.
      const purged = await purge(entry, ownerId, "candidate-dismissed");
      if (!purged.proven) return settleUnproven(entry, purged.message);
      return settle(
        entry,
        { status: "unavailable", cause: "no-artifact" },
        unavailableToken(entry, "no-artifact"),
      );
    }

    // --- 2. Fetch `/roster` (always before any DELETE authority) ------------
    // From here on the job is capture-CAPABLE, so every token it can reach carries
    // `rosterAttempted: true`.
    if (!entry.hasFetched) {
      setState(entry, { status: "fetching-roster" });
      entry.rosterAttempted = true;
      try {
        entry.container = await fetchRoster(entry.jobId);
        entry.hasFetched = true;
      } catch (error) {
        return settle(
          entry,
          {
            status: "fetch-failed",
            message: errorMessage(error, "Unable to fetch the roster for this run."),
            jobGone: isExactJobGoneError(error),
          },
          null,
        );
      }
    }

    if (entry.invalidated !== null) {
      return finalizeInvalidated(entry, ownerId, entry.invalidated);
    }

    // --- 3. Assemble ---------------------------------------------------------
    setState(entry, { status: "committing" });
    let built: CandidateBuildResult;
    try {
      built = await deps.buildCandidate({
        jobId: entry.jobId,
        submissionOrdinal: snapshot.submissionOrdinal,
        container: entry.container,
        snapshot: snapshot.payload,
        frozenXlsx: request.frozenXlsx,
      });
    } catch (error) {
      // A THROWN builder is treated as retryable: an exception carries no verdict
      // about whether the inputs are structurally usable, and parking a possibly
      // recoverable run in a terminal state would discard a real candidate.
      built = {
        ok: false,
        retryable: true,
        reason: errorMessage(error, "Unable to assemble the roster."),
      };
    }
    if (!built.ok) {
      if (!built.retryable) {
        // Structurally impossible from these inputs — the container or submission
        // envelope is one F3 does not accept, or no assembler exists. The `/roster`
        // fetch DID happen and no candidate can ever exist, so cleanup is authorized
        // rather than offering a Retry that cannot succeed — but only once the
        // staging row it would strand is PROVEN gone.
        const purged = await purge(entry, ownerId, "candidate-dismissed");
        if (!purged.proven) return settleUnproven(entry, purged.message);
        // A real fetch DID happen, so this is a normal post-fence dismissal — not a
        // vacuous-fence `unavailable` token.
        return settle(
          entry,
          { status: "unavailable", cause: "assembly-rejected" },
          dismissalToken(entry, "assembly-rejected"),
        );
      }
      // The container stays in hand: this is a local failure and its retry must not
      // spend another server fetch.
      return settle(entry, { status: "commit-failed", message: built.reason }, null);
    }

    if (entry.invalidated !== null) {
      return finalizeInvalidated(entry, ownerId, entry.invalidated);
    }

    // --- 4. Commit -----------------------------------------------------------
    let outcome;
    try {
      outcome = await store.commitCandidate({
        jobId: entry.jobId,
        submissionOrdinal: snapshot.submissionOrdinal,
        document: built.document,
        expectedClearEpoch: epoch,
      });
    } catch (error) {
      return settle(
        entry,
        { status: "commit-failed", message: errorMessage(error, "Unable to save the roster.") },
        null,
      );
    }

    if (outcome.status === "committed") {
      // The candidate is durable now, so it is kept whatever happens next. But the
      // token it would carry authorizes destroying the SERVER copy and consuming the
      // session authority, and the staging row is the only durable handle to
      // `snapshot:<ownerId>` — the pointer records job/version/ordinal, not the
      // owner. Issuing the token before the purge is proven would leave a reload
      // with a loadable candidate it can never finish retiring.
      entry.committed = { pointer: outcome.pointer, working: outcome.working };
      const purged = await purge(entry, ownerId, "candidate-committed");
      if (!purged.proven) return settleUnproven(entry, purged.message);
      return settle(
        entry,
        { status: "committed", pointer: outcome.pointer, working: outcome.working },
        {
          kind: "committed",
          jobId: entry.jobId,
          candidateVersion: outcome.pointer.candidateVersion,
          submissionOrdinal: outcome.pointer.submissionOrdinal,
          rosterAttempted: true,
        },
      );
    }

    if (outcome.status === "superseded") {
      // Locally PROVEN: this submission is older than the current pointer, F1 stored
      // nothing and moved nothing. That is an explicit dismissal — mislabelling it
      // `committed` would hand out a token claiming a candidate that does not exist.
      const purged = await purge(entry, ownerId, "candidate-superseded");
      if (!purged.proven) return settleUnproven(entry, purged.message);
      return settle(
        entry,
        { status: "dismissed", reason: "superseded" },
        dismissalToken(entry, "superseded"),
      );
    }

    // `stale-epoch`: a verified Clear committed mid-capture. Nothing was stored.
    return settle(
      entry,
      { status: "dismissed", reason: "cleared" },
      dismissalToken(entry, "cleared"),
    );
  }

  /**
   * Remove the EXACT candidate version a dismissal was decided against, and report
   * whether the removal is PROVEN. Nothing here may report success on a guess: the
   * caller turns success into a server DELETE, and deleting the job while the
   * real-identity candidate is still durable would strand it unreachable.
   */
  async function removeCommittedCandidate(
    entry: JobEntry,
    pointer: CurrentCandidatePointer,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    let outcome;
    try {
      outcome = await store.dismissCandidate({
        jobId: entry.jobId,
        candidateVersion: pointer.candidateVersion,
        expectedClearEpoch: entry.epoch,
      });
    } catch (error) {
      return { ok: false, message: errorMessage(error, "Unable to discard the saved roster.") };
    }

    // The candidate is provably gone: either this call deleted it, or it was
    // already absent.
    if (outcome.status === "dismissed" || outcome.status === "already-absent") return { ok: true };

    if (outcome.status === "stale-epoch") {
      // A Clear advanced the epoch under us. Clear OWNS this purge, but only
      // verified evidence may settle the dismissal — a `stale-epoch` reply on its
      // own says the write was refused, not that the payload is gone.
      try {
        const row = await store.readCandidate(entry.jobId);
        const current = await store.readCurrentCandidate();
        const pointerMoved = !(
          current?.jobId === entry.jobId && current.candidateVersion === pointer.candidateVersion
        );
        if (row === null && pointerMoved) return { ok: true };
      } catch (error) {
        return { ok: false, message: errorMessage(error, "Unable to verify the roster purge.") };
      }
      return {
        ok: false,
        message: "The saved roster could not be verified as removed. Try dismissing again.",
      };
    }

    // `version-conflict`: a DIFFERENT version is stored for this job, so this
    // dismissal deleted nothing. Never claim removal — that would authorize
    // deleting the server job for a candidate the user never decided about.
    return {
      ok: false,
      message: `A newer saved roster (version ${outcome.currentVersion}) replaced the one being dismissed.`,
    };
  }

  /** Whether an entry has reached a state that a fresh flight must not restart. */
  function isSettled(entry: JobEntry): boolean {
    const status = entry.state.status;
    return (
      status === "committed" ||
      status === "dismissed" ||
      status === "unavailable" ||
      status === "fetch-failed" ||
      status === "commit-failed" ||
      status === "dismiss-failed"
    );
  }

  function start(entry: JobEntry, request: CaptureRequest): Promise<CaptureOutcome> {
    const flight = (async () => {
      try {
        return await runCapture(entry, request);
      } finally {
        entry.inFlight = null;
      }
    })();
    entry.inFlight = flight;
    return flight;
  }

  return {
    getState(jobId) {
      return entries.get(jobId)?.state ?? IDLE;
    },

    getToken(jobId) {
      return entries.get(jobId)?.token ?? null;
    },

    retainedContainers() {
      return [...entries.values()].filter((entry) => entry.hasFetched).map((entry) => entry.jobId);
    },

    capture(request) {
      const entry = ensure(request.jobId);
      // A settled job (token issued) or a failed one never re-runs implicitly: the
      // auto effect replaying must not spend a second fetch, and a failure needs an
      // explicit `retry` so the once-guard is re-armed deliberately.
      if (entry.token !== null) return Promise.resolve(outcomeOf(entry));
      if (entry.inFlight !== null) return entry.inFlight;
      if (isSettled(entry)) return Promise.resolve(outcomeOf(entry));
      // An UNPROVEN authority must never occupy `inFlight`. It cannot make any
      // progress anyway, and a flight is JOINABLE: an exact activation arriving
      // before this promise's `finally` cleared would be handed this call's
      // tokenless outcome while arming its own once-guard, stranding the job with
      // no dependency left to change. Report the current state; start nothing.
      if (request.capture === null) return Promise.resolve(outcomeOf(entry));
      return start(entry, request);
    },

    retry(request) {
      const entry = ensure(request.jobId);
      if (entry.token !== null) return Promise.resolve(outcomeOf(entry));
      if (entry.inFlight !== null) return entry.inFlight;
      // A failed DISMISSAL is retried through `dismiss`, not by re-running capture:
      // the candidate is still durable and re-capturing it is not the repair.
      if (entry.state.status === "dismiss-failed") return Promise.resolve(outcomeOf(entry));
      // The same unproven-authority rule as `capture`: never open a joinable
      // flight that cannot progress. Checked BEFORE the `fetch-failed` reset below
      // so an authority-less retry cannot discard a retained container either.
      if (request.capture === null) return Promise.resolve(outcomeOf(entry));
      if (entry.state.status === "fetch-failed") {
        // The server fetch is what failed; discard the (absent) container and refetch.
        entry.hasFetched = false;
        entry.container = null;
      }
      // `commit-failed` deliberately keeps `hasFetched`: the container and the frozen
      // bytes are already in hand and the retry is purely local.
      return start(entry, request);
    },

    async dismiss(request): Promise<DismissOutcome> {
      const entry = ensure(request.jobId);
      const already = readToken(entry);
      if (already !== null && already.kind !== "committed") {
        return { status: "dismissed", token: already };
      }
      if (entry.ownerId === null && request.capture?.status === "staged") {
        entry.ownerId = request.capture.snapshotRef;
      }

      // Mark BEFORE the flight so a capture that has not yet committed observes the
      // dismissal at its next checkpoint and finalizes instead of storing a
      // candidate the user has already declined.
      entry.invalidated = "user";

      if (entry.inFlight !== null) {
        // Serialize with the flight rather than racing it: a dismissal decided during
        // `fetching-roster` or `committing` must never let a stale commit land behind
        // it, and must never authorize a DELETE before the fetch has resolved.
        await entry.inFlight;
      } else if (request.capture === null) {
        // The SAME no-unproven-authority rule `capture`/`retry` enforce, and for the
        // same reason: a tokenless dismissal flight is joinable, so an exact
        // activation attaching before it cleared would be handed its tokenless
        // outcome while arming its own once-guard, stranding the chain.
        //
        // The intent is NOT lost — `entry.invalidated` was recorded above, so the
        // ordinary capture that runs once authority attaches fetches `/roster` (the
        // fence) and finalizes at its existing invalidation checkpoint as this same
        // user dismissal: one fence, one settle, one DELETE, no second user action.
        //
        // The state is deliberately left untouched. `dismiss-failed` would tell the
        // user the roster is "still saved in this browser", which is false here:
        // capture has not run, so there is nothing saved to be discarded yet.
        return {
          status: "failed",
          message:
            "This run's saved data is still being restored, so it cannot be discarded yet. Try again in a moment.",
        };
      } else if (readToken(entry) === null && (!isSettled(entry) || !entry.rosterAttempted)) {
        // ROSTER-ATTEMPT FENCE. A manual dismissal that arrives before the automatic
        // capture ever ran must still reach `/roster` before its token can authorize
        // deleting the sole server artifact. Starting the flight here (already
        // invalidated) performs exactly the fetch and then finalizes without
        // committing.
        //
        // `!entry.rosterAttempted` is deliberately checked ALONGSIDE `isSettled`: a
        // LOCAL failure before the fetch — `getClearEpoch()` rejecting settles
        // `commit-failed` — leaves the entry "settled" while the fence is still
        // owed. Treating that as settled is exactly how a storage hiccup could have
        // manufactured DELETE authority for a job whose roster was never requested.
        await start(entry, request);
      }

      // `finalizeInvalidated` (or a short-circuit inside `runCapture`) already issued
      // the token; anything still outstanding is handled once, here.
      const settled = readToken(entry);
      if (settled !== null && settled.kind !== "committed") {
        return { status: "dismissed", token: settled };
      }

      if (!entry.rosterAttempted) {
        // The fence is still owed and re-running it did not help — the local failure
        // persists. Report a retryable dismissal failure rather than a token: a
        // capture-capable job's only server-side copy must not be deleted because
        // this browser could not read its own storage.
        const message =
          "The roster for this run could not be reached, so it cannot be discarded yet. Try again.";
        setState(entry, { status: "dismiss-failed", message });
        return { status: "failed", message };
      }

      const pointer = entry.committed?.pointer ?? null;
      if (pointer !== null) {
        // The dismissal lost the race to the commit (or a previous dismissal failed
        // locally and is being retried). Apply it against the EXACT
        // `{jobId, candidateVersion}` this capture produced, and only claim the
        // dismissal when the removal is PROVEN.
        const removal = await removeCommittedCandidate(entry, pointer);
        if (!removal.ok) {
          setState(entry, { status: "dismiss-failed", message: removal.message });
          return { status: "failed", message: removal.message };
        }
      }

      // BOTH local payload forms must be proven gone before this claims a dismissal.
      // The candidate row above is one; a staging snapshot that a commit's own purge
      // could not prove removed is the other, and it holds the same canonical YAML
      // and real-identity map. Retrying it here is what stops "discarded" from being
      // a claim about only half the data.
      if (entry.ownerId !== null) {
        const purged = await purge(entry, entry.ownerId, "candidate-dismissed");
        if (!purged.proven) {
          setState(entry, { status: "dismiss-failed", message: purged.message });
          return { status: "failed", message: purged.message };
        }
      }

      const token = dismissalToken(entry, "user");
      settle(entry, { status: "dismissed", reason: "user" }, token);
      return { status: "dismissed", token };
    },

    async dismissDurableCandidate({ jobId, candidateVersion }): Promise<DurableDismissOutcome> {
      const entry = ensure(jobId);

      // Idempotent: an entry already settled as dismissed keeps its token.
      const already = readToken(entry);
      if (already !== null && already.kind !== "committed") {
        return { status: "dismissed", token: already };
      }

      // IN-SESSION. A live committed entry knows the exact version it produced.
      // A mismatch means the surface is displaying a capture this gate has since
      // replaced, so the decision does not transfer — refuse rather than delete
      // the newer one.
      const pointer = entry.committed?.pointer ?? null;
      if (pointer !== null && pointer.candidateVersion !== candidateVersion) {
        return {
          status: "failed",
          message: `A newer saved roster (version ${pointer.candidateVersion}) replaced the one being dismissed.`,
        };
      }

      // A flight in progress owns the entry; serialize behind it so a commit
      // cannot land after this claims the candidate is gone.
      entry.invalidated = "user";
      if (entry.inFlight !== null) await entry.inFlight;

      const settledToken = readToken(entry);
      if (settledToken !== null && settledToken.kind !== "committed") {
        return { status: "dismissed", token: settledToken };
      }

      // The epoch fences the removal. A fresh process has none, so read it now:
      // an unfenced delete could act on a store a Clear has already replaced.
      if (entry.epoch < 0) {
        try {
          entry.epoch = await store.getClearEpoch();
        } catch (error) {
          const message = errorMessage(error, "Unable to discard the saved roster.");
          setState(entry, { status: "dismiss-failed", message });
          return { status: "failed", message };
        }
      }

      // Remove the EXACT version the surface displayed. F1 reports
      // `version-conflict` if a different one is stored, which `removeCommittedCandidate`
      // turns into a refusal rather than a claimed removal.
      const removal = await removeCommittedCandidate(entry, {
        ...(pointer ?? ({} as CurrentCandidatePointer)),
        jobId,
        candidateVersion,
      });
      if (!removal.ok) {
        setState(entry, { status: "dismiss-failed", message: removal.message });
        return { status: "failed", message: removal.message };
      }

      // A staging snapshot this process knows about holds the same canonical YAML
      // and real-identity map, so "discarded" is only true once it is gone too.
      if (entry.ownerId !== null) {
        const purged = await purge(entry, entry.ownerId, "candidate-dismissed");
        if (!purged.proven) {
          setState(entry, { status: "dismiss-failed", message: purged.message });
          return { status: "failed", message: purged.message };
        }
      }

      // THE AUTHORITY RULE. A token authorizes deleting the server job, and the
      // standing invariant is that no token may issue before this process has
      // attempted `/roster` for that job. After a reload it has not — and it does
      // not need to: the session that committed this candidate already consumed
      // its cleanup authority. So the local removal is real and the token is null.
      const token = entry.rosterAttempted ? dismissalToken(entry, "user") : null;
      settle(entry, { status: "dismissed", reason: "user" }, token);
      return { status: "dismissed", token };
    },

    async notifyCleared() {
      const flights: Promise<unknown>[] = [];
      for (const entry of entries.values()) {
        if (entry.token !== null) continue;
        entry.invalidated = "cleared";
        if (entry.inFlight !== null) flights.push(entry.inFlight);
      }
      await Promise.all(flights);
      for (const entry of entries.values()) {
        if (entry.state.status === "dismissed" && entry.state.reason === "cleared") continue;

        // A COMMITTED entry must not keep claiming "saved in this browser" once F1
        // has purged the candidate — the UI would be telling the user a roster is
        // available that Clear just destroyed. Its DELETE authority is still needed
        // for the server job, so the token is REPLACED with an equivalent cleared
        // dismissal (a commit implies the fetch happened) rather than dropped, and
        // the exact-version pointer is forgotten because that candidate is gone.
        if (entry.token !== null) {
          if (entry.state.status === "committed") {
            entry.committed = null;
            settle(
              entry,
              { status: "dismissed", reason: "cleared" },
              dismissalToken(entry, "cleared"),
            );
          }
          continue;
        }

        // An entry that never reached `/roster` gets the settled STATE but no token:
        // Clear proves the local stores are empty, not that this job's roster was
        // ever requested. Its server job stays deletable through an explicit Dismiss,
        // which runs the fence.
        const token = entry.rosterAttempted ? dismissalToken(entry, "cleared") : null;
        settle(entry, { status: "dismissed", reason: "cleared" }, token);
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
