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
import { useHotStore } from "@/lib/store";
import {
  prepareOptimizeSubmission,
  type PrepareOptimizeSubmissionOptions,
  type PrepareOptimizeSubmissionResult,
  type ScenarioValidationIssue,
} from "@/lib/scenario";
import type { CanonicalScenarioDocument } from "@/lib/scenario/types";
import {
  buildProvisionalSession,
  runSubmissionTransaction,
  type OptimizeRunOptions,
  type PreparedDegradedCleanup,
  type SessionTransactionStorage,
} from "./session-transaction";
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

/** What the caller passes to start (or resubmit) a run. */
export interface OptimizeRunSubmitInput {
  /** The strict Workspace V1 projection to optimize (T17). */
  document: CanonicalScenarioDocument;
  /** Apply T16's fixed people-only anonymization + description removal. */
  anonymize: boolean;
  prettify?: boolean;
  timeout?: number;
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
  // durable session record is deliberately retained for T16b recovery/cleanup.
  | { status: "stale-accepted"; jobId: string };

/** The closed result of a `resubmit()` call. An occupied recovery record remains
 * blocked until T16b/T16e confirms cleanup. */
export type OptimizeRunResubmitOutcome =
  | OptimizeRunSubmitOutcome
  | { status: "resubmit-blocked"; reason: string };

/** The closed result of attaching a prepared recovery transport. */
export type RecoveredAttachOutcome =
  | { status: "attached"; jobId: string }
  | { status: "invalid"; reason: string }
  | { status: "conflict"; reason: string };

/**
 * The transport-ready attachment T16b constructs after it has inspected and
 * interpreted the persisted record. T16a deliberately does not receive record
 * bytes, schema/owner/options metadata, or any other persistence concern.
 */
export interface PreparedRecoveryAttachment {
  jobId: string;
  /** Minimal hot-state data needed for download restoration and recovery copy. */
  activation: Omit<RunActivation, "jobId">;
  /** The opaque resume cursor to seed the stream's first `Last-Event-ID`. */
  initialCursor: string | null;
}

/**
 * A T16b-owned cursor-persistence provider. The controller drives it by identity, not
 * by frozen closures, so the CURRENT mounted provider is always the observation sink:
 *   • `prepare(jobId, reloadRecoveryAvailable)` — a durable/degraded job became current;
 *     the provider resets its health to that job (degraded ⇒ reload recovery unavailable).
 *   • `onCommit(jobId, cursor)` / `onReset(jobId)` — the post-commit/reset opaque cursor
 *     for the live durable job; the provider persists/clears it and records durability.
 *   • `revoke(jobId)` — exact attachment authority ended; health becomes idle.
 * The controller resolves the CURRENT provider at call time, so a recovery-hook remount
 * over a still-live stream takes over persistence without stale frozen callbacks and
 * without restarting transport. T16a never parses or writes the record.
 */
export interface CursorPersistenceProvider {
  prepare(jobId: string, reloadRecoveryAvailable: boolean): void;
  onCommit(jobId: string, cursor: string): void;
  onReset(jobId: string): void;
  revoke(jobId: string): void;
}

/** The job + people reverse map retained for T16c XLSX restoration and T16b/e. */
export interface RunActivation {
  jobId: string;
  anonymized: boolean;
  peopleCount: number;
  reverseMap: PeopleReverseMap;
  /** Whether a reload could resume this run (false for a degraded post-202 stage). */
  reloadRecoveryAvailable: boolean;
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
}

/** The controller surface consumed by the screen (T16e) and recovery UI (T16b/c). */
export interface OptimizeRunController {
  /** The typed run view (read from the hot store; re-renders on change). */
  view: OptimizeRunView;
  /** Whether a submission POST is currently in flight (masked by live authority). */
  isSubmitting: boolean;
  /** The active/volatile job + reverse map, or null before a job exists (masked by
   *  live authority so a superseded attachment never appears attached). */
  activation: RunActivation | null;
  submit(input: OptimizeRunSubmitInput): Promise<OptimizeRunSubmitOutcome>;
  resubmit(input: OptimizeRunSubmitInput): Promise<OptimizeRunResubmitOutcome>;
  /** Attach transport-ready recovery data prepared by T16b. */
  attachRecoveredSession(input: PreparedRecoveryAttachment): RecoveredAttachOutcome;
  /** The job id of the CURRENT live attachment, or null when none is live. Lets T16b
   *  boot idempotently against the actual live attachment (not a one-way flag), so a
   *  StrictMode setup→cleanup→setup replay re-attaches instead of going silent. */
  getLiveJobId(): string | null;
  /** Register T16b's cursor-persistence provider. Returns an identity-scoped
   *  unregister that clears the controller provider ONLY if this provider is still the
   *  registration. The newest live registration is current; removing it restores the
   *  previous survivor. If a durable/degraded job is already live, the provider is
   *  immediately `prepare`d for it. */
  registerCursorPersistence(provider: CursorPersistenceProvider): () => void;
  /** The opaque authority to clean up a degraded (`activation-persistence-failed` /
   *  `-unverified`) run's retained PROVISIONAL record, or null when the current live
   *  attachment is not that degraded job. Forwarded verbatim; never interpreted here. */
  prepareDegradedCleanup(jobId: string): PreparedDegradedCleanup | null;
  /** End cursor-persistence authority for the exact current job without resetting the
   * terminal view. Used after verified durable cleanup. */
  revokeCursorPersistence(jobId: string): void;
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
  return first ? `${first}${suffix}` : "The schedule is not ready to optimize.";
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

  // T16b recovery seams. Stored in refs; read by the stream effect.
  //   • `initialCursorRef` — the recovered resume cursor to seed the first request.
  //   • `persistCtxRef` — the CURRENT durable/degraded persistence context (job +
  //     whether reload recovery is available). Bound to the attachment token via the
  //     stream fence so a revoked stream cannot persist/clear a later job's cursor.
  //   • `providerRegistrationsRef` — ordered mounted T16b providers. The last entry is
  //     resolved at call time; removing it restores the previous survivor.
  //   • `degradedCleanupRef` — the opaque provisional-cleanup authority for the current
  //     degraded run, scoped to its exact attachment token.
  const initialCursorRef = useRef<string | null>(null);
  const persistCtxRef = useRef<{ jobId: string; reloadRecoveryAvailable: boolean } | null>(null);
  const providerRegistrationsRef = useRef<
    Array<{ registration: symbol; provider: CursorPersistenceProvider }>
  >([]);
  const degradedCleanupRef = useRef<{
    token: AttachmentToken;
    jobId: string;
    cleanup: PreparedDegradedCleanup;
  } | null>(null);

  const currentProvider = useCallback((): CursorPersistenceProvider | null => {
    const registrations = providerRegistrationsRef.current;
    return registrations.length > 0 ? registrations[registrations.length - 1].provider : null;
  }, []);

  const revokeRegisteredProviders = useCallback((jobId: string): void => {
    for (const { provider } of providerRegistrationsRef.current) {
      provider.revoke(jobId);
    }
  }, []);

  const revokePersistenceAuthority = useCallback(
    (expectedToken: AttachmentToken | null): void => {
      if (expectedToken === null || tokenRef.current !== expectedToken) return;
      const ctx = persistCtxRef.current;
      if (ctx !== null && ctx.jobId === expectedToken.jobId) {
        // Every mounted provider may have been prepared for this attachment before a
        // newer registration shadowed it. Revoke the exact job across the ordered set
        // so a later-restored survivor cannot expose stale health. Each provider guards
        // by its own current job, so a provider already prepared for successor B ignores
        // a revoke for A.
        revokeRegisteredProviders(ctx.jobId);
      }
      initialCursorRef.current = null;
      persistCtxRef.current = null;
      degradedCleanupRef.current = null;
    },
    [revokeRegisteredProviders],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      revokePersistenceAuthority(tokenRef.current);
      tokenRef.current = null;
      submitAttemptRef.current = null;
      initialCursorRef.current = null;
      persistCtxRef.current = null;
      degradedCleanupRef.current = null;
      providerRegistrationsRef.current = [];
      mountedRef.current = false;
    };
  }, [revokePersistenceAuthority]);

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
        revokePersistenceAuthority(tokenRef.current);
        tokenRef.current = null;
        initialCursorRef.current = null;
        persistCtxRef.current = null;
        degradedCleanupRef.current = null;
        setJobId(null);
        setActivation(null);
        setAttachmentIdentity(null);
      }
    }
  }, [genSnapshot, revokePersistenceAuthority]);

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

  // Clear the T16b recovery bundle (resume cursor + persistence context + degraded
  // cleanup) so a later attachment cannot inherit a prior recovery's cursor context or
  // degraded-cleanup authority. The registered provider persists across attachments
  // (it is per-hook, not per-run). Called on every detach and reset.
  const clearRecoveryRefs = useCallback(() => {
    initialCursorRef.current = null;
    persistCtxRef.current = null;
    degradedCleanupRef.current = null;
  }, []);

  // Detach a server-confirmed-gone job from the current controller view.
  const detachGoneJob = useCallback(
    (goneJobId: string) => {
      const token = tokenRef.current;
      if (token === null || token.jobId !== goneJobId) return;
      revokePersistenceAuthority(token);
      setJobId(null);
      setActivation(null);
      tokenRef.current = null;
      clearRecoveryRefs();
      setAttachmentIdentity(null);
    },
    [clearRecoveryRefs, revokePersistenceAuthority],
  );

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

  // --- submit ---------------------------------------------------------------
  const submit = useCallback(
    async (input: OptimizeRunSubmitInput): Promise<OptimizeRunSubmitOutcome> => {
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

      const record = buildProvisionalSession({
        ownerId: createOwnerId(),
        anonymized: prep.anonymized,
        peopleCount: prep.peopleCount,
        reverseMap: prep.reverseMap,
        runOptions,
      });

      setIsSubmitting(true);
      dispatch({
        type: "submit-started",
        anonymized: prep.anonymized,
        peopleCount: prep.peopleCount,
      });

      const outcome = await runSubmissionTransaction(record, {
        storage,
        submit: async () => {
          try {
            const job = await submitMutation.mutateAsync({
              yamlContent: prep.yaml,
              ...runOptions,
            });
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
        generation !== useHotStore.getState().runGeneration;

      if (attempt?.attemptId === attemptId) {
        submitAttemptRef.current = null;
        setIsSubmitting(false);
      }

      if (stale) {
        if (outcome.status === "activated") {
          return { status: "stale-accepted", jobId: outcome.record.jobId };
        }
        if (
          outcome.status === "activation-persistence-failed" ||
          outcome.status === "activation-unverified"
        ) {
          return { status: "stale-accepted", jobId: outcome.volatile.jobId };
        }
        return outcomeToStaleOutcome(outcome);
      }

      outcomeToSignals(outcome).forEach(dispatch);

      const attach = (id: string, reloadRecoveryAvailable: boolean): void => {
        revokePersistenceAuthority(tokenRef.current);
        const token = makeToken(generation, attemptId, id);
        tokenRef.current = token;
        // A fresh run always starts at the floor — no seeded resume cursor. Set the
        // persistence context and `prepare` the current provider so its cursor writer
        // is installed for a DURABLE run (and health resets to this job); a degraded
        // (non-durable) activation reports reload recovery unavailable and keeps no
        // writer. Any prior degraded-cleanup authority is dropped for a fresh attach.
        initialCursorRef.current = null;
        persistCtxRef.current = { jobId: id, reloadRecoveryAvailable };
        degradedCleanupRef.current = null;
        currentProvider()?.prepare(id, reloadRecoveryAvailable);
        setActivation({
          jobId: id,
          anonymized: prep.anonymized,
          peopleCount: prep.peopleCount,
          reverseMap: prep.reverseMap,
          reloadRecoveryAvailable,
        });
        setJobId(id);
        setAttachmentIdentity(token);
      };

      // Capture the opaque degraded provisional-cleanup authority for the attachment
      // just created (its retained record is the provisional this transaction staged).
      const captureDegradedCleanup = (id: string, cleanup: PreparedDegradedCleanup): void => {
        if (tokenRef.current) {
          degradedCleanupRef.current = { token: tokenRef.current, jobId: id, cleanup };
        }
      };

      if (outcome.status === "activated") {
        attach(outcome.record.jobId, true);
        return { status: "activated", jobId: outcome.record.jobId };
      }
      if (outcome.status === "activation-persistence-failed") {
        attach(outcome.volatile.jobId, false);
        captureDegradedCleanup(outcome.volatile.jobId, outcome.cleanupDegraded);
        return { status: "activation-persistence-failed", jobId: outcome.volatile.jobId };
      }
      if (outcome.status === "activation-unverified") {
        attach(outcome.volatile.jobId, false);
        captureDegradedCleanup(outcome.volatile.jobId, outcome.cleanupDegraded);
        return {
          status: "activation-unverified",
          jobId: outcome.volatile.jobId,
          reason: outcome.reason,
        };
      }
      if (outcome.status === "blocked-before-post") {
        return { status: "blocked-before-post", reason: outcome.reason };
      }
      if (outcome.status === "submit-rejected") {
        return { status: "submit-rejected" };
      }
      return { status: "acceptance-unknown" };
    },
    [currentProvider, dispatch, revokePersistenceAuthority, submitMutation],
  );

  const resubmit = useCallback(
    async (input: OptimizeRunSubmitInput): Promise<OptimizeRunResubmitOutcome> => {
      const outcome = await submit(input);
      return outcome.status === "blocked-before-post"
        ? { status: "resubmit-blocked", reason: outcome.reason }
        : outcome;
    },
    [submit],
  );

  // --- attach transport prepared by T16b -----------------------------------
  const attachRecoveredSession = useCallback(
    (input: PreparedRecoveryAttachment): RecoveredAttachOutcome => {
      if (
        typeof input.jobId !== "string" ||
        input.jobId.length === 0 ||
        input.jobId.length > 512 ||
        !(input.initialCursor === null || typeof input.initialCursor === "string")
      ) {
        return {
          status: "invalid",
          reason: "The prepared recovery transport is invalid.",
        };
      }

      // Same-job reattach must be a TRUE no-mutation idempotent result OR a
      // visible cursor-conflict — never silently swap cursors. The current
      // attachment is the authority ONLY when it is still LIVE (P1 #1): a
      // generation-stale token (New/Load already bumped the generation) is treated
      // as synchronously revoked, so a same-stack New/Load→same-A does not falsely
      // return `attached`, and New/Load→B is not spuriously rejected as conflicting
      // with stale A. A stale token falls through to a clean fresh attach.
      const currentToken = tokenIsLive(tokenRef.current) ? tokenRef.current : null;
      if (currentToken !== null) {
        if (currentToken.jobId !== input.jobId) {
          return {
            status: "conflict",
            reason: `A different optimize run (${currentToken.jobId}) is already attached.`,
          };
        }
        // Same job. Different cursor → visible conflict (never silent swap).
        if (input.initialCursor !== initialCursorRef.current) {
          return {
            status: "conflict",
            reason:
              "A run is already attached to this job with a different resume cursor. Reset before re-attaching with a new cursor.",
          };
        }
        // Same job + cursor is idempotent. Leave ALL live subscription inputs untouched
        // (token, cursor callbacks, initial cursor, subscription identity).
        return { status: "attached", jobId: input.jobId };
      }

      if (submitAttemptRef.current !== null) {
        return {
          status: "conflict",
          reason: "An optimize submission is already in progress.",
        };
      }

      const generation = useHotStore.getState().runGeneration;
      const attemptId = defaultAttemptId();
      revokePersistenceAuthority(tokenRef.current);
      const token = makeToken(generation, attemptId, input.jobId);
      tokenRef.current = token;

      // Seed the resume cursor and set the durable persistence context, then `prepare`
      // the current provider so cursor persistence targets the CURRENT mounted provider
      // (not a frozen closure). A recovered attach is always durable. Any prior degraded
      // authority is dropped.
      initialCursorRef.current = input.initialCursor;
      persistCtxRef.current = {
        jobId: input.jobId,
        reloadRecoveryAvailable: input.activation.reloadRecoveryAvailable,
      };
      degradedCleanupRef.current = null;
      currentProvider()?.prepare(input.jobId, input.activation.reloadRecoveryAvailable);

      dispatch({
        type: "job-activated",
        jobId: input.jobId,
        reloadRecoveryAvailable: input.activation.reloadRecoveryAvailable,
      });

      setActivation({
        jobId: input.jobId,
        ...input.activation,
      });
      setJobId(input.jobId);
      setAttachmentIdentity(token);
      return { status: "attached", jobId: input.jobId };
    },
    [currentProvider, dispatch, revokePersistenceAuthority, tokenIsLive],
  );

  // The job id of the CURRENT live attachment (exact-token + live generation), or
  // null. T16b boots idempotently against this real state: after a StrictMode
  // setup→cleanup→setup replay clears the token, this returns null and T16b re-attaches.
  const getLiveJobId = useCallback((): string | null => {
    const t = tokenRef.current;
    return t && tokenIsLive(t) ? t.jobId : null;
  }, [tokenIsLive]);

  // Minimal ordered provider registrations. The last mounted registrant is current.
  // Removing it restores the previous survivor; removing an older entry leaves the
  // current provider untouched. Exact registration symbols make duplicate provider
  // objects safe under StrictMode replay.
  const registerCursorPersistence = useCallback(
    (provider: CursorPersistenceProvider): (() => void) => {
      const registration = Symbol("cursor-persistence-provider");
      providerRegistrationsRef.current.push({ registration, provider });
      const ctx = persistCtxRef.current;
      if (ctx !== null) provider.prepare(ctx.jobId, ctx.reloadRecoveryAvailable);
      return () => {
        const registrations = providerRegistrationsRef.current;
        const index = registrations.findIndex((entry) => entry.registration === registration);
        if (index < 0) return;
        const wasCurrent = index === registrations.length - 1;
        registrations.splice(index, 1);
        if (!wasCurrent) return;
        const liveCtx = persistCtxRef.current;
        if (liveCtx !== null) provider.revoke(liveCtx.jobId);
        const survivor = currentProvider();
        if (liveCtx !== null && survivor !== null) {
          survivor.prepare(liveCtx.jobId, liveCtx.reloadRecoveryAvailable);
        }
      };
    },
    [currentProvider],
  );

  // The opaque degraded provisional-cleanup authority for the current live degraded
  // run, or null. Exact-token + exact-job scoped so a stale/superseded degraded run's
  // authority is never returned. Forwarded to T16b verbatim; never interpreted here.
  const prepareDegradedCleanup = useCallback(
    (id: string): PreparedDegradedCleanup | null => {
      const d = degradedCleanupRef.current;
      return d && d.jobId === id && tokenIsLive(d.token) ? d.cleanup : null;
    },
    [tokenIsLive],
  );

  const revokeCursorPersistence = useCallback(
    (id: string): void => {
      const token = tokenRef.current;
      if (token === null || token.jobId !== id || !tokenIsLive(token)) return;
      revokePersistenceAuthority(token);
    },
    [revokePersistenceAuthority, tokenIsLive],
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
            message: controlErrorMessage(error, "Unable to cancel optimization."),
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
    // Durable cleanup is deliberately not a controller reset side effect. T16b/T16e
    // inspect and remove the one session record without erasing a terminal result.
    revokePersistenceAuthority(tokenRef.current);
    tokenRef.current = null;
    clearRecoveryRefs();
    setJobId(null);
    setActivation(null);
    setAttachmentIdentity(null);
    useHotStore.getState().resetRunView();
  }, [clearRecoveryRefs, revokePersistenceAuthority]);

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

  const onCursorCommit = useCallback(
    (cursor: string) => {
      // Generation-fenced (P1 #1): between a New/Load generation bump and the passive
      // revocation effect, `tokenRef.current` may still equal A's token, so plain
      // reference equality would let A persist its cursor. `tokenIsLive` also
      // compares the live canonical generation, making the late commit inert. The
      // CURRENT provider is resolved at call time (a remount takes over the sink), and
      // only a durable job (reload recovery available) persists its cursor.
      const ctx = persistCtxRef.current;
      if (tokenIsLive(creating) && ctx?.reloadRecoveryAvailable) {
        currentProvider()?.onCommit(ctx.jobId, cursor);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attachmentIdentity, currentProvider, tokenIsLive],
  );

  const onCursorReset = useCallback(() => {
    if (tokenIsLive(creating)) {
      dispatchIfAttached({ type: "cursor-reset" }, creating);
      const ctx = persistCtxRef.current;
      if (ctx?.reloadRecoveryAvailable) currentProvider()?.onReset(ctx.jobId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentIdentity, currentProvider, dispatchIfAttached, tokenIsLive]);

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
    initialCursor: initialCursorRef.current,
    subscriptionKey: attachmentIdentity ?? undefined,
    // The stream applies durable frames to THIS attachment's scoped cache (which the
    // scoped poll observer also reads → immediate SSE lifecycle/control/result, no 4s
    // lag) and mirrors to the shared base only while this attachment is the live owner.
    isCurrentAttachment: () => tokenIsLive(creating),
    onCursorCommit,
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
    resubmit,
    attachRecoveredSession,
    getLiveJobId,
    registerCursorPersistence,
    prepareDegradedCleanup,
    revokeCursorPersistence,
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
  }
}
