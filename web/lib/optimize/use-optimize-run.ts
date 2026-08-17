"use client";

// T16a — the single feature-local orchestration boundary from a strict Workspace
// projection to a durable optimize run. It stitches together, without duplicating
// any of their internals:
//   • T16q preparation (`prepareOptimizeSubmission`) — co-derived strict YAML +
//     people reverse map; anonymization is NEVER rebuilt here.
//   • T16q's durable session transaction (`runSubmissionTransaction`) over the real
//     `sessionStorage`, with the closed accepted/rejected/unknown submit outcome.
//   • The landed T06 hooks — submit, poll, the T16p-seamed durable event stream, and
//     cancel / finish-now — as the only transport/protocol machinery.
//   • The pure run reducer (`reduceRunView`), whose output lives in the T04 hot store
//     as the typed feature run view.
//
// It owns NO protocol loop, cursor fence, XLSX transform, chart, page, or DELETE: it
// projects those subsystems' authoritative outputs into one typed model and drives
// the server-authoritative controls. There is deliberately no client heartbeat.
//
// Attachment authority (P1): one controller-owned immutable AttachmentToken
// containing (generation, attemptId, jobId). The hot-store `runGeneration` is the
// canonical revocation authority — New/Load/reset bump it, and a `useSyncExternalStore`
// subscription observes the change and immediately clears private attachment,
// submitting state, and cursor callbacks BEFORE React effect cleanup runs. Every
// async completion — submit outcome, poll snapshot, stream frame, control response,
// cursor commit/reset — compares the exact token; a late result from a prior
// attachment is inert and can never repopulate a different scenario's view or
// persist/clear a later job's cursor.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  OptimizeApiError,
  useCancelOptimize,
  useFinishNowOptimize,
  useOptimizeEventStream,
  useOptimizeJobScoped,
  useSubmitOptimize,
} from "@/lib/query/optimize";
import { optimizeKeys } from "@/lib/query/keys";
import { getScenarioAuthority, readAuthoritativeScenarioIdentity, useHotStore } from "@/lib/store";
import type { OptimizeBasisDegradation, OptimizeObservability } from "./optimize-observability";
import { bindAcceptedJob, buildOptimizeBasis, type BuiltBasis } from "./basis/basis-record";
import type { OptimizeBasisRecordV2 } from "./basis/basis-row";
import type { InfoSemanticProfile } from "@/app/api/info/types";
import {
  prepareOptimizeSubmission,
  type PrepareOptimizeSubmissionOptions,
  type PrepareOptimizeSubmissionResult,
  type ScenarioValidationIssue,
} from "@/lib/scenario";
import type { CanonicalScenarioDocument } from "@/lib/scenario/types";
import {
  buildProvisionalSession,
  removeOwnerSession,
  runSubmissionTransaction,
  type OptimizeRunOptions,
  type RemoveOwnerSessionOutcome,
  type SessionCaptureState,
  type SessionTransactionStorage,
} from "./session-transaction";
import {
  buildStagedSubmission,
  purgeSubmissionSnapshot,
  stageSubmissionSnapshot,
} from "./submission-snapshot";
import { ROSTER_SUBMISSION_VERSION } from "./roster-candidate-builder";
import { rosterStorage } from "@/lib/store";
import { acquireSessionStorage } from "./session-storage";
import type { PeopleReverseMap } from "@/lib/scenario";
import { isExactJobGoneError, type OptimizeErrorInfo } from "@/lib/bff/errors";
import type { JobResponse } from "@/lib/bff/types";
import { parseJobResponse, type StrictTerminalFrame } from "@/lib/query/event-payloads";
import {
  isActiveLifecycle,
  isSettledLifecycle,
  reduceRunView,
  type OptimizeRunView,
  type RunLogEntry,
  type RunSignal,
} from "./run-view";
import { buildStreamCallbacks, classifySubmitError, outcomeToSignals } from "./submission";

/** Fallback authoritative poll cadence while a job is active (SSE is primary). */
export const OPTIMIZE_POLL_INTERVAL_MS = 4000;

// ---------------------------------------------------------------------------
// Immutable attachment token (P1 #1)
// ---------------------------------------------------------------------------

/**
 * The immutable attachment token. Captured at attach/submit time, it fences every
 * async completion. The hot-store `runGeneration` is the canonical revocation
 * authority — New/Load/reset bump it. Each callback (poll snapshot, stream frame,
 * cancel/finish response, cursor commit/reset) closes over the EXACT token that
 * created it; at call time the controller compares the captured token to the
 * current `tokenRef.current` by reference equality. A mismatch on ANY field
 * (generation, attemptId, jobId) drops the dispatch, so a late result from a
 * superseded attachment — same-generation overlap, same-job reattach, or a
 * generation-bumped reset — can never repopulate the view or persist/clear a
 * later cursor.
 *
 * `null` means no attachment is active (idle/reset).
 */
export interface AttachmentToken {
  readonly attachmentId: number;
  readonly generation: number;
  readonly attemptId: string;
  readonly jobId: string;
}

let nextAttachmentId = 1;

/** Create a fresh immutable token. */
function makeToken(generation: number, attemptId: string, jobId: string): AttachmentToken {
  const attachmentId = nextAttachmentId;
  nextAttachmentId += 1;
  return { attachmentId, generation, attemptId, jobId } as const;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What the caller passes to start a run. */
export interface OptimizeRunSubmitInput {
  /** The strict Workspace V1 projection to optimize (T17). */
  document: CanonicalScenarioDocument;
  /** Apply T16's fixed people-only anonymization + description removal. */
  anonymize: boolean;
  prettify?: boolean;
  timeout?: number;
  /**
   * The backend semantic profile just read from `/api/info` (T08).
   *
   * Supplying it makes the run claim an immutable submission basis. OMITTING it is
   * a fully supported ordinary run: the app must stay usable when the profile is
   * unreadable, Web Crypto is unavailable (an insecure origin), or the scenario
   * identity is unknown — the run simply carries no basis and cannot later be
   * diagnosed against.
   */
  semanticProfile?: InfoSemanticProfile | null;
}

/** The closed result of a `submit()` call. */
export type OptimizeRunSubmitOutcome =
  | { status: "invalid"; issues: ScenarioValidationIssue[] }
  | { status: "blocked-before-post"; reason: string }
  | { status: "submit-rejected" }
  | { status: "acceptance-unknown" }
  | { status: "activated"; jobId: string }
  | { status: "activation-persistence-failed"; jobId: string }
  | { status: "activation-unverified"; jobId: string; reason: string }
  // The POST landed after reset/New/Load revoked its view attachment. Its one
  // durable session record is deliberately retained for the retirement lane.
  | { status: "stale-accepted"; jobId: string }
  /**
   * The visit was revoked BEFORE the request was sent, so no job exists.
   *
   * Distinct from `stale-accepted` in the only way that matters: there is nothing
   * on the server to cancel or retire. The exact snapshot this attempt staged is
   * purged and its record (if one was written) is rolled back owner-scoped.
   */
  | { status: "revoked-before-post" };

/**
 * How a visit tells the controller that its submission is still wanted.
 *
 * The controller already fences on the hot-store generation, which New/Load/reset
 * bump. Visit revocation is a DIFFERENT event: the user navigated away, or clicked
 * Optimize again. Nothing about the scenario changed, so no generation moves — and
 * without this seam a POST that returns after the visit ended would still attach,
 * dispatch, and start a terminal chain for a run nobody is watching.
 */
export interface OptimizeSubmitOptions {
  /**
   * The owner id this submission staged, reported as soon as it exists — BEFORE
   * the POST, so a visit that is revoked mid-flight can still name the exact
   * record and snapshot it has to retire.
   */
  onOwnerId?: (ownerId: string) => void;
  /**
   * Whether the visit that started this submission is still current. Consulted
   * once, at the same point the generation fence is, so a late `202` is inert:
   * its record still activates under its own owner key (the job id must be
   * durable for the retirement lane to name it), but nothing attaches, dispatches,
   * polls, downloads, or captures.
   */
  isCurrent?: () => boolean;
}

/** The job + people reverse map retained for T16c XLSX restoration and T16e. */
export interface RunActivation {
  jobId: string;
  /**
   * The transaction owner that staged this run's session record and snapshot.
   *
   * Exposed because owner-keyed cleanup needs it: "retire the record for job X"
   * is only expressible as "remove the record at owner O's key", and O is knowable
   * solely from the submission that created it.
   */
  ownerId: string;
  anonymized: boolean;
  peopleCount: number;
  reverseMap: PeopleReverseMap;
  /**
   * The F2 roster-capture authority staged before the POST. `unavailable` runs
   * still optimize and download identically — they simply expose no roster
   * Load/Retry, because no durable exact-submission authority exists to
   * de-anonymize a result against.
   */
  capture: SessionCaptureState;
}

/**
 * Build the immutable basis for a submission, or return `null` when a verifiable
 * one cannot be produced.
 *
 * Every `null` here is a DEGRADATION TO AN ORDINARY RUN, never a rejection: a run
 * without a basis is a supported first-class case (the assistant is off by
 * default), so an unreadable profile, an insecure origin without Web Crypto, an
 * unknown scenario identity, or implicit options must not block Optimize.
 */
async function buildBasisForSubmission(
  input: OptimizeRunSubmitInput,
  prep: { yaml: string; anonymized: boolean },
  basisStore: OptimizeBasisStore | null,
  note: (reason: OptimizeBasisDegradation, jobId?: string | null) => void,
): Promise<BuiltBasis | null> {
  // Each guard reports the FIRST condition that stopped the claim, so the reason names
  // the layer that actually broke. Ordering is therefore load-bearing: an absent
  // profile is reported as `profile-unavailable` even when the store is also missing.
  const profile = input.semanticProfile ?? null;
  if (profile === null) {
    note("profile-unavailable");
    return null;
  }
  if (basisStore === null) {
    note("authority-unavailable");
    return null;
  }
  // Both options must be EXPLICIT: the backend binds its RESOLVED values, so a
  // guessed default would fail verification and reject an otherwise valid run.
  if (typeof input.prettify !== "boolean" || typeof input.timeout !== "number") {
    note("options-implicit");
    return null;
  }

  // A REJECTION IS THE SAME DEGRADATION AS A NULL, and this read can genuinely reject:
  // it reaches Dexie-backed repository authority, which throws outright when IndexedDB
  // is unavailable. Awaiting it OUTSIDE the boundary let that rejection escape
  // `buildBasisForSubmission` entirely -- no reason was emitted, the ordinary POST never
  // happened, and `submitAttemptRef` stayed occupied so the very next submit was refused
  // as `submission-in-progress`. Losing a basis claim is diagnostic degradation, never
  // enforcement, so the rejection is folded into the same `null` the guard below already
  // handles. The exception value is deliberately NOT recorded: the finite reason code is
  // the entire payload this surface may carry.
  const identity = await readAuthoritativeScenarioIdentity().catch(() => null);
  if (identity === null) {
    note("scenario-identity-unavailable");
    return null;
  }

  // BUILD and WRITE are separated so the reason can tell them apart. One try around
  // both would have to report a single combined code, which would leave "Web Crypto is
  // missing" and "IndexedDB refused the write" indistinguishable -- the two most
  // different causes on this path.
  let built: BuiltBasis;
  try {
    built = await buildOptimizeBasis({
      yaml: prep.yaml,
      anonymized: prep.anonymized,
      profile,
      options: { prettify: input.prettify, timeoutSeconds: input.timeout },
      scenarioId: identity.scenarioId,
      documentRevision: identity.documentRevision,
      // T08 submits ordinary runs only; T10 owns candidate submission.
      ownerKind: "ordinary",
      attemptId: crypto.randomUUID(),
      now: new Date(),
    });
  } catch {
    // Web Crypto absent (an insecure origin), or the encoder refused. Not a reason to
    // block an ordinary run; it proceeds without a basis claim.
    note("basis-build-failed");
    return null;
  }

  try {
    // Persisted BEFORE the POST, so an accepted job whose response never reaches
    // us still has a durable local row to recover against.
    await basisStore.putOptimizeBasis(built.record);
  } catch {
    note("basis-write-failed");
    return null;
  }
  return built;
}

/**
 * Bind an accepted job to its basis row, or leave the row unbound.
 *
 * Verification runs INSIDE the store transaction against the row as re-read there,
 * so a row that changed underneath cannot be overwritten from a stale snapshot.
 */
async function bindBasisToAcceptedJob(
  built: BuiltBasis,
  job: JobResponse,
  basisStore: OptimizeBasisStore,
  note: (reason: OptimizeBasisDegradation, jobId?: string | null) => void,
): Promise<void> {
  try {
    // A REFUSAL IS NOT A THROW. `bindOptimizeBasisJob` resolves `null` when the row is
    // gone or the echoed identity disagrees -- which is the likelier failure and was
    // just as silent as the exception path.
    const bound = await basisStore.bindOptimizeBasisJob(built.basisId, (row) =>
      bindAcceptedJob(row, {
        jobId: job.id,
        basisId: job.request.basis?.basis_id ?? null,
        inputSha256: job.request.basis?.input_sha256 ?? null,
        expiresAt: job.expires_at,
      }),
    );
    if (bound === null) note("basis-bind-failed", job.id);
  } catch {
    // A failed binding leaves the row unbound, which the recovery classifier
    // already reads as "no trustworthy identity" — the safe direction. The job DOES
    // exist here, unlike every other degradation, so its id is reportable.
    note("basis-bind-failed", job.id);
  }
}

/** Injectable seams (dependency injection for testability). */
export interface UseOptimizeRunDeps {
  /** Defaults to the real `sessionStorage` (acquired through a guarded seam). */
  storage?: SessionTransactionStorage;
  /** Defaults to a random UUID owner id per submission. */
  createOwnerId?: () => string;
  /** Defaults to T16q's `prepareOptimizeSubmission`; overridable in tests. */
  prepare?: (
    document: CanonicalScenarioDocument,
    options: PrepareOptimizeSubmissionOptions,
  ) => PrepareOptimizeSubmissionResult;
  /**
   * The F2 write-ahead snapshot seam. Defaults to `stageSubmissionSnapshot` over
   * the real Dexie repositories. It is REQUIRED to be total: any rejection would
   * gate the POST, which the non-gating contract forbids — the default implements
   * that by returning a degraded capture state instead of throwing.
   */
  stageSnapshot?: (input: {
    ownerId: string;
    canonicalYaml: string;
    reverseMap: PeopleReverseMap;
  }) => Promise<SessionCaptureState>;
  /**
   * Retire a staged snapshot once this submission is LOCALLY PROVEN to have
   * created no server job. Total like the staging seam — a failed purge is
   * reported by the helper, never thrown, because it can only leave a harmless
   * retained row.
   */
  purgeSnapshot?: (ownerId: string) => Promise<void>;
  /**
   * The durable basis seam (T08). Defaults to the authority adapter, which is the
   * only module allowed to reach the repository graph. Injectable so the basis path
   * is testable without IndexedDB.
   *
   * OMITTED IS NOT THE SAME AS `null`. Leaving this out selects the real adapter;
   * only an explicit injection replaces it. For a long time this doc described a
   * default the code did not have (`depsRef.current?.basisStore ?? null`), so every
   * production mount ran with no store at all and silently recorded no basis --
   * see `resolveBasisStore` below.
   *
   * `null` is therefore a MEANINGFUL injection, not a type-level accident: it says
   * "this run has no basis authority", which is what a test needs to reach the
   * `authority-unavailable` degradation without breaking IndexedDB globally.
   */
  basisStore?: OptimizeBasisStore | null;
  /**
   * The bounded observability surface degradations are reported through.
   *
   * Optional, and absence is silent by design: this hook has non-screen callers, and
   * observability is a diagnostic surface, never a precondition for running. The
   * screen passes the same instance it gives the terminal orchestration, so a run's
   * basis, queue, duration and cleanup events share one bounded buffer.
   */
  observability?: OptimizeObservability;
}

/** The durable operations the basis path needs from the authority adapter. */
export interface OptimizeBasisStore {
  putOptimizeBasis(record: OptimizeBasisRecordV2): Promise<void>;
  bindOptimizeBasisJob(
    basisId: string,
    verify: (row: OptimizeBasisRecordV2) => OptimizeBasisRecordV2 | null,
  ): Promise<OptimizeBasisRecordV2 | null>;
}

/** The controller surface consumed by the screen (T16e). */
export interface OptimizeRunController {
  /** The typed run view (read from the hot store; re-renders on change). */
  view: OptimizeRunView;
  /** Whether a submission POST is currently in flight (masked by live authority). */
  isSubmitting: boolean;
  /** The active/volatile job + reverse map, or null before a job exists (masked by
   *  live authority so a superseded attachment never appears attached). */
  activation: RunActivation | null;
  submit(
    input: OptimizeRunSubmitInput,
    options?: OptimizeSubmitOptions,
  ): Promise<OptimizeRunSubmitOutcome>;
  /** The job id of the CURRENT live attachment, or null when none is live. The
   *  screen reads it when a visit ends, to name the exact job it is abandoning. */
  getLiveJobId(): string | null;
  /** The owner that staged `jobId`'s record in THIS controller, or null. */
  ownerFor(jobId: string): string | null;
  /**
   * Remove the session record for `jobId`, by its owner key, verified by read-back.
   *
   * Owner-scoped by construction: the key names the owner, so this cannot reach a
   * concurrent run's record. `unknown-owner` means this controller never staged
   * that job — fail closed rather than guess a key.
   */
  retireSessionRecord(jobId: string): RemoveOwnerSessionOutcome | { status: "unknown-owner" };
  cancel(): Promise<void>;
  finishNow(): Promise<void>;
  /** Reset hot/controller state only. Durable cleanup belongs to T16b/T16e. */
  reset(): void;
  notifyDownloadStarted(): void;
  notifyDownloadSucceeded(filename: string | null): void;
  notifyDownloadUnavailable(): void;
  notifyDownloadFailed(message: string): void;
  notifyCleanup(status: "cleaned" | "failed" | "retained"): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The real write-ahead snapshot seam (F2). Total: it never rejects. */
function defaultStageSnapshot(input: {
  ownerId: string;
  canonicalYaml: string;
  reverseMap: PeopleReverseMap;
}): Promise<SessionCaptureState> {
  return stageSubmissionSnapshot({
    ownerId: input.ownerId,
    payload: buildStagedSubmission({
      canonicalYaml: input.canonicalYaml,
      reverseMap: input.reverseMap,
      // The envelope version is F3's contract, supplied by the one composition
      // module. F2 never stamps a version it invented.
      schemaVersion: ROSTER_SUBMISSION_VERSION,
    }),
  });
}

/**
 * The real proven-no-job purge seam (F2). Reads the CURRENT clear epoch so the
 * delete is fenced against a Clear that landed while the POST was in flight.
 */
async function defaultPurgeSnapshot(ownerId: string): Promise<void> {
  try {
    const expectedClearEpoch = await rosterStorage.getClearEpoch();
    await purgeSubmissionSnapshot({
      ownerId,
      expectedClearEpoch,
      authority: "submit-rejected",
    });
  } catch {
    // Storage is unreachable. A retained snapshot is harmless and Clear reclaims
    // it; failing the submission flow over it would be strictly worse.
  }
}

function defaultOwnerId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return cryptoObj.randomUUID();
  return `owner-${Date.now()}-${globalThis.performance?.now?.() ?? 0}`;
}

function defaultAttemptId(): string {
  return defaultOwnerId();
}

function describeIssues(issues: ScenarioValidationIssue[]): string {
  const first = issues[0]?.message;
  const suffix = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
  return first ? `${first}${suffix}` : "The schedule is not ready to optimise.";
}

function controlErrorCode(error: unknown): string | null {
  return error instanceof OptimizeApiError ? (error.info.code ?? error.info.kind) : null;
}

function controlErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof OptimizeApiError) return error.message || fallback;
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}

function isJobNotFound(error: unknown): error is OptimizeApiError {
  return isExactJobGoneError(error);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export function useOptimizeRun(deps?: UseOptimizeRunDeps): OptimizeRunController {
  const storageRef = useRef<SessionTransactionStorage | null>(null);
  if (storageRef.current === null) {
    storageRef.current = deps?.storage ?? acquireSessionStorage();
  }
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const queryClient = useQueryClient();

  const submitMutation = useSubmitOptimize();
  const cancelMutation = useCancelOptimize();
  const finishMutation = useFinishNowOptimize();

  const [jobId, setJobId] = useState<string | null>(null);
  const [activation, setActivation] = useState<RunActivation | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The token itself is the query/stream attachment identity. Its process-wide
  // attachment id prevents scoped-key reuse across hook lifetimes sharing a
  // QueryClient. State triggers subscription replacement; tokenRef remains the
  // synchronous imperative authority.
  const [attachmentIdentity, setAttachmentIdentity] = useState<AttachmentToken | null>(null);

  // --- immutable attachment token -------------------------------------------
  // The single source of truth for attachment authority. Captured at attach/submit
  // time; every async completion compares against it via EXACT reference equality.
  // The gen subscription below nulls it immediately when the canonical hot-store
  // generation changes.
  const tokenRef = useRef<AttachmentToken | null>(null);
  const mountedRef = useRef(true);
  // The submit attempt token — fences the submit outcome dispatches (between
  // submit-started and the outcome, a reset may revoke the run before the POST
  // resolves). Distinct from tokenRef because the job id is unknown until the
  // outcome; it carries (generation, attemptId) only.
  const submitAttemptRef = useRef<{ generation: number; attemptId: string } | null>(null);

  // Which owner staged which job, for THIS controller instance.
  //
  // Cleanup is owner-keyed, and a job id alone does not name a key. Nothing else
  // in the process can supply the mapping: the owner is minted here, just before
  // the POST, and the record it keys is written under it. Kept for the hook's
  // lifetime rather than cleared on detach, because a `job-gone` detach still owes
  // that job's record a removal.
  const ownerByJobRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      tokenRef.current = null;
      submitAttemptRef.current = null;
      mountedRef.current = false;
    };
  }, []);

  const view = useHotStore((state) => state.runView);

  // --- canonical generation subscription (P1 #1) ----------------------------
  // Observe hot-store `runGeneration` and revoke private attachment, submitting
  // state, and cursor callbacks when it changes (New/Load/reset). Zustand v4+
  // uses `useSyncExternalStore` under the hood, so the snapshot is consistent
  // across the render. This effect runs in the same commit cycle as the gen
  // change; by the time the stream's apply-before-commit fence fires for any
  // in-flight frame, `tokenRef.current` is already `null`, so the exact-
  // equality fence (`creating === tokenRef.current`) drops the dispatch — a
  // late frame from the old stream cannot repopulate the view or persist/clear
  // a later cursor.
  const genSnapshot = useHotStore((state) => state.runGeneration);
  const prevGenRef = useRef(genSnapshot);
  useEffect(() => {
    if (prevGenRef.current !== genSnapshot) {
      prevGenRef.current = genSnapshot;
      const tokenCurrent = tokenRef.current?.generation === genSnapshot;
      if (!tokenCurrent) {
        tokenRef.current = null;
        setJobId(null);
        setActivation(null);
        setAttachmentIdentity(null);
      }
    }
  }, [genSnapshot]);

  // --- dispatch -------------------------------------------------------------
  // The unfenced dispatch — for synchronous, controller-initiated signals.
  const dispatch = useCallback((signal: RunSignal) => {
    const store = useHotStore.getState();
    const prev = store.runView;
    const next = reduceRunView(prev, signal);
    store.setRunView(stampEventTime(prev, next));
  }, []);

  // Whether the captured token is STILL the live attachment: exact reference
  // equality AND same canonical generation. The generation check closes the window
  // between a New/Load generation bump and the passive revocation effect — a late
  // cursor/dispatch/detach whose token predates the current generation is inert,
  // whether or not the effect has already nulled `tokenRef` (P1 #1).
  const tokenIsLive = useCallback(
    (t: AttachmentToken | null): boolean =>
      mountedRef.current &&
      t !== null &&
      t === tokenRef.current &&
      t.generation === useHotStore.getState().runGeneration,
    [],
  );

  // Detach a server-confirmed-gone job from the current controller view.
  const detachGoneJob = useCallback((goneJobId: string) => {
    const token = tokenRef.current;
    if (token === null || token.jobId !== goneJobId) return;
    setJobId(null);
    setActivation(null);
    tokenRef.current = null;
    setAttachmentIdentity(null);
  }, []);

  // The token-fenced dispatch — for async completions (poll, stream, control).
  // Drops the signal when the captured creating token is no longer the live
  // attachment (exact reference equality + live generation).
  const dispatchIfAttached = useCallback(
    (signal: RunSignal, creatingToken: AttachmentToken | null) => {
      if (!tokenIsLive(creatingToken)) return;
      const store = useHotStore.getState();
      const prev = store.runView;
      const next = reduceRunView(prev, signal);
      store.setRunView(stampEventTime(prev, next));
    },
    [tokenIsLive],
  );

  // The single path every exact-token authoritative snapshot uses.
  const applyAuthoritativeSnapshot = useCallback(
    (job: JobResponse, token: AttachmentToken | null) => {
      if (token === null) return;
      const validated = parseJobResponse(job, token.jobId);
      if (validated === null) return;
      dispatchIfAttached({ type: "job-snapshot", job: validated }, token);
    },
    [dispatchIfAttached],
  );

  /**
   * Report one basis degradation, if anyone is listening.
   *
   * Reads the sink from the deps ref rather than closing over it, so a screen that
   * mounts its observability after this hook still receives events. Never throws into
   * the submit path: a diagnostic surface must not be able to fail a run.
   */
  const noteBasisDegradation = useCallback(
    (reason: OptimizeBasisDegradation, jobId: string | null = null): void => {
      try {
        depsRef.current?.observability?.emit({ kind: "basis-degraded", jobId, reason });
      } catch {
        // An observability sink that throws is the sink's problem, not the run's.
      }
    },
    [],
  );

  /**
   * The basis store this run should use: the injected one, or the real projection
   * adapter.
   *
   * THIS USED TO BE `depsRef.current?.basisStore ?? null`, which is how T08's whole
   * durable basis path came to be dead in the shipped app. The only mount that passes
   * `controllerDeps` is a dev fixture, so on the real route the store was ALWAYS null,
   * `buildBasisForSubmission` returned at its first guard, and no `optimizeBases` row
   * was ever written. Nothing surfaced, because a basis-less run is a supported
   * degradation -- and with no basis row, T10's bounded infeasibility diagnostic has no
   * parent to diagnose and truthfully refuses on every infeasible run.
   *
   * Resolved LAZILY, inside `submit`, and never during render: `getScenarioAuthority()`
   * constructs the Dexie handle on first use, and this hook renders on the server for
   * the initial HTML, where IndexedDB does not exist. It is not cached here either --
   * the accessor already memoises the singleton, and caching would pin a stale
   * authority when one is rebound.
   *
   * A throw still degrades to an ordinary un-claimed run rather than blocking Optimize.
   */
  const resolveBasisStore = useCallback((): OptimizeBasisStore | null => {
    const injected = depsRef.current?.basisStore;
    if (injected !== undefined) return injected;
    try {
      return getScenarioAuthority();
    } catch {
      return null;
    }
  }, []);

  // --- submit ---------------------------------------------------------------
  const submit = useCallback(
    async (
      input: OptimizeRunSubmitInput,
      options?: OptimizeSubmitOptions,
    ): Promise<OptimizeRunSubmitOutcome> => {
      if (submitAttemptRef.current !== null) {
        return { status: "blocked-before-post", reason: "submission-in-progress" };
      }

      const prepare = depsRef.current?.prepare ?? prepareOptimizeSubmission;
      const prepared = prepare(input.document, { anonymize: input.anonymize });
      if (!prepared.ok) {
        dispatch({ type: "submit-started", anonymized: input.anonymize, peopleCount: 0 });
        dispatch({
          type: "submit-rejected",
          code: "invalid_scheduling_data",
          message: describeIssues(prepared.issues),
        });
        return { status: "invalid", issues: prepared.issues };
      }

      const storage = storageRef.current!;
      const createOwnerId = depsRef.current?.createOwnerId ?? defaultOwnerId;
      const generation = useHotStore.getState().runGeneration;
      const attemptId = defaultAttemptId();
      submitAttemptRef.current = { generation, attemptId };

      const prep = prepared.prep;
      const runOptions: OptimizeRunOptions = {};
      if (typeof input.prettify === "boolean") runOptions.prettify = input.prettify;
      if (typeof input.timeout === "number") runOptions.timeout = input.timeout;

      const ownerId = createOwnerId();
      // Reported BEFORE anything can fail: the caller's retirement lane needs the
      // owner even for a submission that never reaches a job id.
      options?.onOwnerId?.(ownerId);

      const basisStore = resolveBasisStore();

      // --- immutable submission basis (T08), best-effort ---------------------
      //
      // A basis is claimed ONLY when every input for a verifiable one is present:
      // a readable semantic profile, an authoritative scenario identity, and
      // EXPLICIT prettify/timeout. The last condition matters: the backend binds
      // its RESOLVED options into the identity, so claiming a basis while letting
      // the server pick a default we guessed would fail verification and reject an
      // otherwise valid run. Any missing input therefore degrades to an ordinary
      // un-claimed submission rather than to a rejected one.
      //
      // INTEGRATION: built here, BEFORE the F2 write-ahead staging and the POST, so
      // the durable basis row exists before any job can. The provisional session
      // record itself is built further down from main's `ownerId` — this path adds a
      // basis claim to that submission, it does not own the record.
      const built = await buildBasisForSubmission(input, prep, basisStore, noteBasisDegradation);

      setIsSubmitting(true);
      dispatch({
        type: "submit-started",
        anonymized: prep.anonymized,
        peopleCount: prep.peopleCount,
      });

      // F2 write-ahead: allocate the origin-wide submission ordinal and write the
      // immutable exact-submission snapshot BEFORE the session record is staged, so
      // the document that gets solved is durably recoverable from the moment it is
      // sent. This seam is total by contract — a denied or quota-limited IndexedDB
      // yields a degraded `unavailable` capture state and the POST and the original
      // XLSX download proceed byte-identically. `prep.yaml` is the exact bytes the
      // submit closure below sends, so the snapshot cannot drift from the request.
      const stageSnapshot = depsRef.current?.stageSnapshot ?? defaultStageSnapshot;
      const capture = await stageSnapshot({
        ownerId,
        canonicalYaml: prep.yaml,
        reverseMap: prep.reverseMap,
      });

      // Only a snapshot this transaction actually staged may be purged, and only
      // by its exact owner id. Declared here because the fence immediately below
      // needs it — it used to live after the transaction, which is precisely why
      // there was nothing to clean up with at this point.
      const purgeSnapshot = async (owner: string, staged: SessionCaptureState): Promise<void> => {
        if (staged.status !== "staged") return;
        await (depsRef.current?.purgeSnapshot ?? defaultPurgeSnapshot)(owner);
      };

      // FENCE 1 — immediately after the awaited staging.
      //
      // Staging is the first `await` in this function and it can take real time
      // (IndexedDB, ordinal allocation). A visit revoked during it used to resume
      // here unconditionally and go on to stage a record and send a POST, creating
      // a server job for a user who had already left — and leaving the cleanup of
      // that job dependent on a response nobody was waiting for.
      //
      // Purges exactly the snapshot this attempt just staged and nothing else. No
      // record has been written yet, so there is nothing else to undo.
      if (options?.isCurrent?.() === false) {
        await purgeSnapshot(ownerId, capture);
        if (submitAttemptRef.current?.attemptId === attemptId) {
          submitAttemptRef.current = null;
          setIsSubmitting(false);
        }
        return { status: "revoked-before-post" };
      }

      const record = buildProvisionalSession({
        ownerId,
        anonymized: prep.anonymized,
        peopleCount: prep.peopleCount,
        reverseMap: prep.reverseMap,
        runOptions,
        capture,
      });

      let revokedBeforePost = false;
      const outcome = await runSubmissionTransaction(record, {
        storage,
        submit: async () => {
          // FENCE 2 — the last statement before the request leaves.
          //
          // Staging the record is synchronous, but it sits between fence 1 and
          // here, and this closure is invoked by the transaction rather than
          // inline. Reported as a DEFINITE rejection because that is exactly what
          // it is: the server was never asked, so no job can exist — which lets
          // the transaction roll its own provisional record back owner-scoped, and
          // lets the snapshot be purged on proof rather than on a guess.
          if (options?.isCurrent?.() === false) {
            revokedBeforePost = true;
            return { status: "definitely-rejected", error: new Error("visit revoked") };
          }
          try {
            const job = await submitMutation.mutateAsync({
              yamlContent: prep.yaml,
              ...runOptions,
              ...(built !== null ? { basis: built.fields } : {}),
            });
            // Bind only on an EXACTLY matching echoed identity. A disagreement is a
            // transport-integrity failure, so the row is left unbound rather than
            // pointing at a job whose evidence would be misattributed. The run
            // itself still proceeds — it simply cannot be diagnosed against later.
            if (built !== null && basisStore !== null) {
              await bindBasisToAcceptedJob(built, job, basisStore, noteBasisDegradation);
            }
            return { status: "accepted", jobId: job.id };
          } catch (error) {
            return classifySubmitError(error);
          }
        },
      });

      const attempt = submitAttemptRef.current;
      const stale =
        attempt?.attemptId !== attemptId ||
        attempt.generation !== generation ||
        generation !== useHotStore.getState().runGeneration ||
        // The visit that asked for this run is over. Nothing here is user-facing
        // any more; the accepted job (if any) belongs to the retirement lane.
        options?.isCurrent?.() === false;

      if (attempt?.attemptId === attemptId) {
        submitAttemptRef.current = null;
        setIsSubmitting(false);
      }

      if (stale) {
        // A superseded/abandoned acceptance still gets its job→owner mapping
        // recorded. It is the only way the retirement lane can later name the exact
        // record to remove, and it is deliberately NOT an attachment: no dispatch,
        // no poll, no download, no capture.
        if (outcome.status === "activated") {
          ownerByJobRef.current.set(outcome.record.jobId, ownerId);
          return { status: "stale-accepted", jobId: outcome.record.jobId };
        }
        if (
          outcome.status === "activation-persistence-failed" ||
          outcome.status === "activation-unverified"
        ) {
          ownerByJobRef.current.set(outcome.volatile.jobId, ownerId);
          return { status: "stale-accepted", jobId: outcome.volatile.jobId };
        }
        if (outcome.status === "activation-retired") {
          ownerByJobRef.current.set(outcome.jobId, ownerId);
          return { status: "stale-accepted", jobId: outcome.jobId };
        }
        // A superseded attempt does not change what the SERVER did: a blocked or
        // definitively rejected POST still proves no job exists, so its snapshot is
        // retired here too rather than being orphaned by the reset that raced it.
        if (outcome.status === "blocked-before-post" || outcome.status === "submit-rejected") {
          await purgeSnapshot(ownerId, capture);
        }
        // Fence 2 fired: name it for what it is rather than reporting a server
        // rejection that never happened.
        if (revokedBeforePost) return { status: "revoked-before-post" };
        return outcomeToStaleOutcome(outcome);
      }

      // BEFORE any signal is dispatched. `activation-retired` means the record
      // this attempt staged was removed while the POST was in flight — a route
      // exit, a `pagehide`, a superseding click or a verified Clear. The job
      // exists on the server, but there is no visit left to project it into, so it
      // must not reach the reducer: a `job-activated` here would put a run on a
      // screen the user has left, and start the poll/download/capture chain behind
      // it. Reported as `stale-accepted` so the screen's retirement lane cancels
      // the exact job best-effort and nothing else.
      if (outcome.status === "activation-retired") {
        ownerByJobRef.current.set(outcome.jobId, ownerId);
        return { status: "stale-accepted", jobId: outcome.jobId };
      }

      outcomeToSignals(outcome).forEach(dispatch);

      const attach = (id: string): void => {
        const token = makeToken(generation, attemptId, id);
        tokenRef.current = token;
        ownerByJobRef.current.set(id, ownerId);
        setActivation({
          jobId: id,
          ownerId,
          anonymized: prep.anonymized,
          peopleCount: prep.peopleCount,
          reverseMap: prep.reverseMap,
          capture,
        });
        setJobId(id);
        setAttachmentIdentity(token);
      };

      if (outcome.status === "activated") {
        attach(outcome.record.jobId);
        return { status: "activated", jobId: outcome.record.jobId };
      }
      if (outcome.status === "activation-persistence-failed") {
        attach(outcome.volatile.jobId);
        return { status: "activation-persistence-failed", jobId: outcome.volatile.jobId };
      }
      if (outcome.status === "activation-unverified") {
        attach(outcome.volatile.jobId);
        return {
          status: "activation-unverified",
          jobId: outcome.volatile.jobId,
          reason: outcome.reason,
        };
      }
      // LOCALLY PROVEN no-job outcomes retire the write-ahead snapshot. The whole
      // point of the no-GC/no-expiry policy is that only proof may delete a
      // snapshot — and "the POST was blocked before it was sent" and "the server
      // definitively rejected it" are exactly that proof. Without this the canonical
      // YAML and the real reverse map would sit in IndexedDB until a global Clear.
      if (outcome.status === "blocked-before-post") {
        await purgeSnapshot(ownerId, capture);
        return { status: "blocked-before-post", reason: outcome.reason };
      }
      if (outcome.status === "submit-rejected") {
        await purgeSnapshot(ownerId, capture);
        return { status: "submit-rejected" };
      }
      // `acceptance-unknown` deliberately RETAINS: a server job may exist, and its
      // capture would be impossible without the exact submission.
      return { status: "acceptance-unknown" };
    },
    [dispatch, noteBasisDegradation, resolveBasisStore, submitMutation],
  );

  // --- attachment identity + owner-keyed retirement -------------------------
  //
  // REMOVED here: `attachRecoveredSession`, `registerCursorPersistence`,
  // `revokeCursorPersistence`, `notifyInvalidCursorReset` and
  // `prepareDegradedCleanup`. Every one of them existed to serve a boot-time
  // inspection that resumed a prior run — attaching it, persisting its cursor so a
  // reload could resume again, and cleaning up the record that made it resumable.
  // There is no boot-time inspection any more, and an attach path only a resume
  // could reach is resume, just without a button.

  // The job id of the CURRENT live attachment (exact-token + live generation), or
  // null. The screen reads it when a visit ends, so the retirement lane can name
  // the exact job it is abandoning rather than guessing from the view.
  const getLiveJobId = useCallback((): string | null => {
    const t = tokenRef.current;
    return t && tokenIsLive(t) ? t.jobId : null;
  }, [tokenIsLive]);

  const ownerFor = useCallback(
    (id: string): string | null => ownerByJobRef.current.get(id) ?? null,
    [],
  );

  // Owner-keyed record removal, verified by read-back.
  //
  // This replaces the old boot-inspection-based `cleanup(jobId)`, and the
  // difference is the whole point of owner-keying: that one had to re-inspect the
  // single slot and refuse when it held someone else's run, because "the record"
  // and "this run's record" were the same cell. Here the key IS the scope, so an
  // abandoned run's cleanup and a brand-new submission cannot collide at all.
  const retireSessionRecord = useCallback(
    (id: string): RemoveOwnerSessionOutcome | { status: "unknown-owner" } => {
      const owner = ownerByJobRef.current.get(id);
      // Fail closed. A job this controller never staged has no key we can derive,
      // and enumerating for a plausible one would be exactly the origin-wide
      // guessing the contract forbids.
      if (owner === undefined) return { status: "unknown-owner" };
      return removeOwnerSession(storageRef.current!, owner);
    },
    [],
  );

  // --- controls (cancel / finish-now) ---------------------------------------
  const cancel = useCallback(async () => {
    const token = tokenRef.current;
    const id = token?.jobId ?? null;
    // Validate the EXACT live authority BEFORE the network effect (P1 #1): a same-tick
    // New/Load generation bump revokes control authority synchronously, so no POST is
    // sent against a superseded attachment even before the passive effect runs.
    if (!id || !token || !tokenIsLive(token)) return;
    try {
      const job = await cancelMutation.mutateAsync({
        jobId: id,
        attachmentKey: token,
        isCurrentAttachment: () => tokenIsLive(token),
      });
      applyAuthoritativeSnapshot(job, token);
    } catch (error) {
      if (isJobNotFound(error)) {
        if (!tokenIsLive(token)) return;
        dispatchIfAttached(
          { type: "control-job-gone", code: error.info.code, message: error.message },
          token,
        );
        detachGoneJob(token.jobId);
      } else {
        if (!tokenIsLive(token)) return;
        dispatchIfAttached(
          {
            type: "control-error",
            code: controlErrorCode(error),
            message: controlErrorMessage(error, "Unable to cancel optimisation."),
          },
          token,
        );
      }
    }
  }, [cancelMutation, dispatchIfAttached, detachGoneJob, tokenIsLive, applyAuthoritativeSnapshot]);

  const finishNow = useCallback(async () => {
    const token = tokenRef.current;
    const id = token?.jobId ?? null;
    // Validate live authority BEFORE the network effect (P1 #1) — same as cancel().
    if (!id || !token || !tokenIsLive(token)) return;
    try {
      const job = await finishMutation.mutateAsync({
        jobId: id,
        attachmentKey: token,
        isCurrentAttachment: () => tokenIsLive(token),
      });
      applyAuthoritativeSnapshot(job, token);
    } catch (error) {
      if (isJobNotFound(error)) {
        if (!tokenIsLive(token)) return;
        dispatchIfAttached(
          { type: "control-job-gone", code: error.info.code, message: error.message },
          token,
        );
        detachGoneJob(token.jobId);
      } else {
        if (!tokenIsLive(token)) return;
        dispatchIfAttached(
          {
            type: "control-error",
            code: controlErrorCode(error),
            message: controlErrorMessage(error, "Unable to request current results."),
          },
          token,
        );
      }
    }
  }, [finishMutation, dispatchIfAttached, detachGoneJob, tokenIsLive, applyAuthoritativeSnapshot]);

  const reset = useCallback(() => {
    // Durable cleanup is deliberately not a controller reset side effect: T16e
    // removes the owner-keyed record without erasing a terminal result.
    tokenRef.current = null;
    setJobId(null);
    setActivation(null);
    setAttachmentIdentity(null);
    useHotStore.getState().resetRunView();
  }, []);

  // --- authoritative poll → snapshot ---------------------------------------
  // Provenance-isolated poll: keyed by the immutable attachment token, so a
  // superseded attachment's in-flight request never populates a later
  // observer — reset/re-attach B to the SAME job starts a DIFFERENT query, A's
  // delayed 200/404 resolves into A's now-unobserved query, and the abort signal
  // cancels it. Only a live exact response is mirrored to the shared base below.
  const active = isActiveLifecycle(view.lifecycle);
  const pollToken = attachmentIdentity;
  const jobQuery = useOptimizeJobScoped(jobId, attachmentIdentity, {
    enabled: Boolean(jobId),
    refetchInterval: jobId && active ? OPTIMIZE_POLL_INTERVAL_MS : false,
  });

  // The token that created THIS attachment's poll (captured at the subscription
  // render). With the query now provenance-isolated, this is a belt-and-suspenders
  // fence (exact token + live generation + job-id match) on top of query identity.
  const snapshot = jobQuery.data;
  useEffect(() => {
    if (snapshot && pollToken !== null && snapshot.id === pollToken.jobId) {
      applyAuthoritativeSnapshot(snapshot, pollToken);
      // Mirror the scoped poll result to the shared base ONLY under the exact-token
      // ownership fence (P1 #6/#7) — the scoped observer already isolates a stale A
      // result, so `snapshot` here is always the current attachment's.
      if (tokenIsLive(pollToken)) {
        queryClient.setQueryData(optimizeKeys.job(snapshot.id), snapshot);
      }
    }
  }, [snapshot, pollToken, applyAuthoritativeSnapshot, tokenIsLive, queryClient]);

  const snapshotError = jobQuery.error;
  useEffect(() => {
    if (isExactJobGoneError(snapshotError) && pollToken !== null) {
      dispatchIfAttached(
        { type: "job-gone", code: snapshotError.info.code, message: snapshotError.message },
        pollToken,
      );
      // Detach only while this exact poll token is still the live attachment.
      if (tokenIsLive(pollToken)) detachGoneJob(pollToken.jobId);
    }
  }, [snapshotError, pollToken, dispatchIfAttached, tokenIsLive, detachGoneJob]);

  // --- durable event stream (T06 + T16p seam) ------------------------------
  // Each callback captures the token that created this attachment
  // last bumped. At call time, the captured token is compared to `tokenRef.current`
  // by reference equality. The T16p seam freezes the options at stream start,
  // so an OLD stream's frozen callbacks carry the OLD creating token — even if
  // a new attachment bumped the key, the OLD stream's invocations see a
  // different current token and drop.
  //
  // The closures below are recreated only when the immutable identity changes, so they
  // are recreated when (and only when) a new attachment bumps the subscription
  // identity. The local `creating` const captures `tokenRef.current` at this
  // render; because the closures are recreated exactly when the subscription
  // changes, each closure captures the creating token that matches its
  // subscription.
  const creating = attachmentIdentity;

  // No `onCursorCommit`. The stream's tracker still keeps the cursor IN MEMORY,
  // which is what an in-visit reconnect resumes from; there is simply nowhere
  // durable for it to go now that a reload does not resume.
  const onCursorReset = useCallback(() => {
    if (tokenIsLive(creating)) dispatchIfAttached({ type: "cursor-reset" }, creating);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentIdentity, dispatchIfAttached, tokenIsLive]);

  // The stream callbacks memo uses the same `creating` token captured at this
  // render. Recreated on attachment identity change so each new subscription has
  // its own creating token.
  const streamCallbacks = useMemo(
    () => buildStreamCallbacks((sig) => dispatchIfAttached(sig, creating), undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attachmentIdentity, dispatchIfAttached],
  );

  // The stream's job-gone path must detach the SAME way the poll/control paths do:
  // dispatch the fenced `job-gone` reducer signal AND revoke the private token/
  // jobId/activation (P1 #1c). Otherwise the obsolete job id stays live and a
  // pending same-token poll/control completion could revive a gone job.
  const onStreamJobGone = useCallback(
    (info: OptimizeErrorInfo) => {
      const t = creating;
      if (t === null) return;
      if (!tokenIsLive(t)) return;
      streamCallbacks.onJobGone(info);
      detachGoneJob(t.jobId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attachmentIdentity, streamCallbacks, tokenIsLive, detachGoneJob],
  );

  const onStreamTerminal = useCallback(
    (result: { frame?: StrictTerminalFrame; job?: JobResponse }) => {
      const t = creating;
      if (t === null) return;
      if (!tokenIsLive(t)) return;
      const job = result.job?.id === t.jobId ? result.job : undefined;
      streamCallbacks.onTerminal({ frame: result.frame, job });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attachmentIdentity, streamCallbacks, tokenIsLive],
  );

  useOptimizeEventStream(jobId, {
    enabled: Boolean(jobId) && !isSettledLifecycle(view.lifecycle),
    // Always the floor: a run always starts within the visit that started it.
    initialCursor: null,
    subscriptionKey: attachmentIdentity ?? undefined,
    // The stream applies durable frames to THIS attachment's scoped cache (which the
    // scoped poll observer also reads → immediate SSE lifecycle/control/result, no 4s
    // lag) and mirrors to the shared base only while this attachment is the live owner.
    isCurrentAttachment: () => tokenIsLive(creating),
    onCursorReset,
    onEvent: streamCallbacks.onEvent,
    onTerminal: onStreamTerminal,
    onJobGone: onStreamJobGone,
    onCursorExpired: streamCallbacks.onCursorExpired,
    onCursorInvalid: streamCallbacks.onCursorInvalid,
    onError: streamCallbacks.onError,
  });

  // Terminal download/cleanup notifications are ATTACHMENT-SCOPED (P1 #1): each
  // captures the creating token and dispatches through the
  // fenced `dispatchIfAttached`, so a late A artifact/cleanup completion that resolves
  // after B has attached (or after a reset) is inert and cannot mutate B's view.
  const notifyDownloadStarted = useCallback(
    () => dispatchIfAttached({ type: "download-started" }, creating),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attachmentIdentity, dispatchIfAttached],
  );
  const notifyDownloadSucceeded = useCallback(
    (filename: string | null) =>
      dispatchIfAttached({ type: "download-succeeded", filename }, creating),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attachmentIdentity, dispatchIfAttached],
  );
  const notifyDownloadUnavailable = useCallback(
    () => dispatchIfAttached({ type: "download-unavailable" }, creating),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attachmentIdentity, dispatchIfAttached],
  );
  const notifyDownloadFailed = useCallback(
    (message: string) => dispatchIfAttached({ type: "download-failed", message }, creating),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attachmentIdentity, dispatchIfAttached],
  );
  const notifyCleanup = useCallback(
    (status: "cleaned" | "failed" | "retained") =>
      dispatchIfAttached(
        status === "cleaned"
          ? { type: "cleanup-succeeded" }
          : status === "failed"
            ? { type: "cleanup-failed" }
            : { type: "cleanup-retained" },
        creating,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attachmentIdentity, dispatchIfAttached],
  );

  // Public attachment/control state is MASKED by the live authority (P1 #1): in the
  // same-tick window after a New/Load generation bump — before the passive revocation
  // effect clears React state — `tokenRef`/`activation` still hold A, but its
  // generation is stale, so `tokenIsLive` is false. Deriving the exposed values here
  // means the UI never shows A as attached (and never renders its controls) in that
  // window. The pending submit guard remains private until its request settles.
  const liveGeneration = useHotStore.getState().runGeneration;
  const exposedActivation = tokenIsLive(tokenRef.current) ? activation : null;
  const exposedSubmitting = isSubmitting && submitAttemptRef.current?.generation === liveGeneration;

  return {
    view,
    isSubmitting: exposedSubmitting,
    activation: exposedActivation,
    submit,
    getLiveJobId,
    ownerFor,
    retireSessionRecord,
    cancel,
    finishNow,
    reset,
    notifyDownloadStarted,
    notifyDownloadSucceeded,
    notifyDownloadUnavailable,
    notifyDownloadFailed,
    notifyCleanup,
  };
}

/** Stamp `eventTime` on the newest log entry if the reducer produced one. */
function stampEventTime(prev: OptimizeRunView, next: OptimizeRunView): OptimizeRunView {
  if (next.seq <= prev.seq) return next;
  if (next.log.length === 0) return next;
  const last = next.log[next.log.length - 1];
  if (last.seq !== next.seq || last.eventTime !== null) return next;
  const now = Date.now();
  const stamped: RunLogEntry = { ...last, eventTime: now };
  const log = next.log.slice();
  log[log.length - 1] = stamped;
  return { ...next, log };
}

/** Map a stale submit outcome to a closed inert outcome (no dispatch, no attach). */
function outcomeToStaleOutcome(
  outcome: Awaited<ReturnType<typeof runSubmissionTransaction>>,
): OptimizeRunSubmitOutcome {
  switch (outcome.status) {
    case "blocked-before-post":
      return { status: "blocked-before-post", reason: outcome.reason };
    case "submit-rejected":
      return { status: "submit-rejected" };
    case "acceptance-unknown":
      return { status: "acceptance-unknown" };
    case "activated":
      return { status: "activated", jobId: outcome.record.jobId };
    case "activation-persistence-failed":
      return { status: "activation-persistence-failed", jobId: outcome.volatile.jobId };
    case "activation-unverified":
      return {
        status: "activation-unverified",
        jobId: outcome.volatile.jobId,
        reason: outcome.reason,
      };
    case "activation-retired":
      return { status: "stale-accepted", jobId: outcome.jobId };
  }
}
