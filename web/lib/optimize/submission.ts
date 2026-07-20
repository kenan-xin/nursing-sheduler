// T16a — pure glue between T16q's durable submission transaction and the run-view
// reducer. No React, storage, or network here: the controller wires the effects and
// calls these helpers, so the classification/mapping decisions are unit-testable in
// isolation.

import { OptimizeApiError, type OptimizeErrorInfo } from "@/lib/bff/errors";
import type { JobResponse } from "@/lib/bff/types";
import type { SseFrame } from "@/lib/query/sse";
import { isIsoDateTime } from "@/lib/time/iso-date-time";
import {
  parseControlChangedPayload,
  parseResultAvailablePayload,
  parseStateChangedPayload,
} from "@/lib/query/event-payloads";
import type { OptimizationOutcome } from "@/lib/bff/types";
import type { SubmissionTransactionOutcome, SubmitResult } from "./session-transaction";
import type { RunLogPayload, RunPhaseEntry, RunProgressPoint, RunSignal } from "./run-view";
import type { JobState } from "@/lib/bff/types";

// ---------------------------------------------------------------------------
// Submit outcome classification
// ---------------------------------------------------------------------------

/**
 * Error kinds that prove the server did NOT create a job — the request was
 * rejected before enqueue (bad request, oversized, invalid content, queue full, or
 * a lifecycle/contention conflict). Everything else — a 5xx, an unreachable/unready
 * backend, or an unknown/opaque failure — leaves acceptance ambiguous, so the map
 * must be retained and the run treated as interrupted rather than rolled back.
 */
const DEFINITE_REJECTION_KINDS: ReadonlySet<string> = new Set([
  "validation",
  "too-large",
  "request-invalid",
  "queue-full",
  "conflict",
]);

/**
 * Classify a caught submit error into the closed `SubmitResult` the transaction
 * expects. Only a recognized definite-rejection kind rolls back; a thrown/opaque
 * error or a server/transport failure is `acceptance-unknown` so the recovery map
 * is never discarded while a job might exist.
 */
export function classifySubmitError(error: unknown): SubmitResult {
  if (error instanceof OptimizeApiError && DEFINITE_REJECTION_KINDS.has(error.info.kind)) {
    return { status: "definitely-rejected", error };
  }
  return { status: "acceptance-unknown", error };
}

/** A short, code-first message for a submit error (never an English detail match). */
function submitErrorFields(error: unknown): { code: string | null; message: string } {
  if (error instanceof OptimizeApiError) {
    return { code: error.info.code ?? error.info.kind, message: error.message };
  }
  if (error instanceof Error) return { code: null, message: error.message };
  return { code: null, message: "Optimize submission failed." };
}

// ---------------------------------------------------------------------------
// Transaction outcome → run signals
// ---------------------------------------------------------------------------

/**
 * Translate a completed T16q submission transaction into the ordered run signals
 * the reducer applies. `activated`, `activation-persistence-failed`, and
 * `activation-unverified` all yield a live `job-activated` (a job exists) but differ
 * on whether reload recovery is available. The definite-rejection / ambiguous /
 * blocked branches never produce a job id.
 */
export function outcomeToSignals(outcome: SubmissionTransactionOutcome): RunSignal[] {
  switch (outcome.status) {
    case "blocked-before-post":
      return [
        { type: "submit-blocked", code: outcome.reason, message: blockedMessage(outcome.reason) },
      ];

    case "submit-rejected": {
      const { code, message } = submitErrorFields(outcome.error);
      return [{ type: "submit-rejected", code, message }];
    }

    case "acceptance-unknown": {
      const { code, message } = submitErrorFields(outcome.error);
      return [{ type: "submit-unknown", code, message }];
    }

    case "activated":
      return [
        { type: "job-activated", jobId: outcome.record.jobId, reloadRecoveryAvailable: true },
      ];

    case "activation-persistence-failed":
      return [
        {
          type: "job-activated",
          jobId: outcome.volatile.jobId,
          reloadRecoveryAvailable: false,
          reason: "activation-persistence-failed",
        },
      ];

    case "activation-unverified":
      return [
        {
          type: "job-activated",
          jobId: outcome.volatile.jobId,
          reloadRecoveryAvailable: false,
          reason: outcome.reason,
        },
      ];
  }
}

/** A stable, human-readable message per durable-stage failure reason. */
function blockedMessage(reason: string): string {
  switch (reason) {
    case "session-conflict":
      return "Another optimize run is already staged in this browser session. Discard it before starting a new run.";
    case "storage-unavailable":
      return "Browser session storage is unavailable, so this run cannot be safely recovered.";
    case "quota-exceeded":
      return "Browser session storage is full, so this run cannot be safely recovered.";
    case "invalid-record":
      return "The optimize run could not be prepared for recovery.";
    case "read-back-failed":
      return "The optimize run could not be durably staged before submission.";
    default:
      return "The optimize run could not be started.";
  }
}

// ---------------------------------------------------------------------------
// Ephemeral SSE frame normalization
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Validate an optional-but-typed field. If the field is `undefined`, return
 * `null` (genuinely absent). If present, accept only the expected type/domain
 * — return a sentinel `INVALID` symbol to signal "supplied with wrong type",
 * which the caller uses to REJECT the entire frame rather than silently
 * coercing it away (P1: strict ephemeral).
 */
const INVALID = Symbol("invalid");
function optionalTyped<T>(
  value: unknown,
  validate: (v: unknown) => v is T,
): T | null | typeof INVALID {
  if (value === undefined) return null;
  return validate(value) ? value : INVALID;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegIntegerOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

/**
 * Normalize a `job.progressed` frame into a chart point, or null when the
 * frame is malformed. Strict validation (P1): required non-empty `source`,
 * finite `currentBestScore`, finite `elapsedSeconds`. Optional fields
 * `solutionIndex` and `commentCount` are accepted as non-negative integers OR
 * null/undefined; a present-but-wrong-type value REJECTS the entire frame
 * rather than being silently coerced.
 *
 * The flat wire shape (camelCase, matching the exact backend emitters in
 * `serialize_solver_progress`) is:
 * `{ source, currentBestScore, elapsedSeconds, solutionIndex?, commentCount? }`.
 */
export function normalizeProgressFrame(frame: SseFrame): RunProgressPoint | null {
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const source = nonEmptyString(data.source);
  if (source === null) return null;
  const score = data.currentBestScore;
  if (!isFiniteNumber(score)) return null;
  const elapsed = data.elapsedSeconds;
  if (!isFiniteNumber(elapsed)) return null;
  // Optional progress fields: reject the entire frame when supplied with a
  // wrong type/domain (no silent coercion).
  const solutionIndex = optionalTyped(data.solutionIndex, isNonNegIntegerOrNull);
  if (solutionIndex === INVALID) return null;
  const commentCount = optionalTyped(data.commentCount, isNonNegIntegerOrNull);
  if (commentCount === INVALID) return null;
  return {
    source,
    currentBestScore: score,
    elapsedSeconds: elapsed,
    solutionIndex,
    commentCount,
  };
}

/**
 * Normalize a `job.phase_changed` frame into a phase entry, or null when
 * malformed. Strict validation (P1): required non-empty `source`, non-empty
 * `code`, non-empty `message`, AND finite `elapsedSeconds` (matching the exact
 * backend emitter `serialize_schedule_phase_progress`).
 */
export function normalizePhaseFrame(frame: SseFrame): RunPhaseEntry | null {
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const source = nonEmptyString(data.source);
  if (source === null) return null;
  const code = nonEmptyString(data.code);
  if (code === null) return null;
  const message = nonEmptyString(data.message);
  if (message === null) return null;
  const elapsed = data.elapsedSeconds;
  if (!isFiniteNumber(elapsed)) return null;
  return { source, code, message, elapsedSeconds: elapsed };
}

/**
 * Turn one ephemeral SSE frame into a run signal, or null when it is a durable
 * frame (handled by the query layer's cache reconciliation) or an unrecognized /
 * malformed frame. Only `job.progressed` and `job.phase_changed` are ephemeral run
 * signals here; state/control/result frames surface authoritatively via the polled
 * `JobResponse` cache. The cursor (`frame.id`) and `occurred_at` (required, snake_case
 * from the SSE envelope) are carried through so the reducer can log them in wire order.
 *
 * Strict validation: a frame missing required renderable fields (source, code,
 * finite score/elapsed, non-empty message) OR missing/invalid `occurred_at`
 * produces no signal — and therefore no log entry.
 */
export function frameToSignal(frame: SseFrame): RunSignal | null {
  // `occurred_at` is the exact backend SSE envelope key (sse.py emits it
  // snake_case). The camelCase `occurredAt` alias is NOT accepted.
  const occurredAt = extractOccurredAt(frame);
  if (occurredAt === null) return null;
  if (frame.event === "job.progressed") {
    const point = normalizeProgressFrame(frame);
    if (!point) return null;
    return { type: "progress", point, cursor: frame.id, occurredAt };
  }
  if (frame.event === "job.phase_changed") {
    const entry = normalizePhaseFrame(frame);
    if (!entry) return null;
    return { type: "phase", entry, cursor: frame.id, occurredAt };
  }
  return null;
}

/** Durable SSE event names that the query layer reconciles into the job cache. */
const DURABLE_FRAME_EVENTS: ReadonlySet<string> = new Set([
  "job.state_changed",
  "job.control_changed",
  "job.result_available",
]);

/**
 * Build a `durable-frame-applied` signal for a durable SSE frame, or null when
 * the frame is ephemeral/unrecognized/malformed OR fails strict validation.
 *
 * Strict validation (P1 — strict wire log):
 *   • `occurred_at` (snake_case) MUST be present as a non-empty string. The T06
 *     SSE envelope always carries it; a missing/invalid/aliased value means
 *     the frame is malformed/incomplete and produces no log entry.
 *   • The payload MUST parse via the exact T06 domain parsers
 *     (`parseStateChangedPayload`, `parseControlChangedPayload`,
 *     `parseResultAvailablePayload`). A payload the T06 parser rejects produces
 *     no log entry — never a placeholder "?" detail.
 *
 * Returns a typed `RunLogPayload` so T16e can render without reparsing JSON.
 */
export function durableFrameSignal(frame: SseFrame): RunSignal | null {
  if (!DURABLE_FRAME_EVENTS.has(frame.event)) return null;
  const occurredAt = extractOccurredAt(frame);
  if (occurredAt === null) return null;
  const built = buildDurablePayloadAndDetail(frame);
  if (built === null) return null;
  return {
    type: "durable-frame-applied",
    event: frame.event,
    cursor: frame.id,
    payload: built.payload,
    detail: built.detail,
    occurredAt,
  };
}

/**
 * Extract the SSE envelope's `occurred_at` (the exact snake_case backend key from
 * `sse.py`). The camelCase `occurredAt` alias is NOT accepted — the envelope is
 * canonical snake_case. Returns the value only when it is a real timezone-bearing
 * ISO-8601 datetime (see `isIsoDateTime`); a missing, non-string, whitespace,
 * arbitrary-string, offset-less, or impossible-date value yields null so the frame
 * produces no log entry.
 */
function extractOccurredAt(frame: SseFrame): string | null {
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const value = data.occurred_at;
  if (typeof value !== "string" || !isIsoDateTime(value)) return null;
  return value;
}

/**
 * Build a typed `RunLogPayload` and a short renderable `detail` string from a
 * strictly-validated durable frame. Returns null when the T06 parser rejects.
 */
function buildDurablePayloadAndDetail(
  frame: SseFrame,
): { payload: RunLogPayload; detail: string } | null {
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  if (frame.event === "job.state_changed") {
    const payload = parseStateChangedPayload(data);
    if (payload === null) return null;
    const detail =
      payload.queue_position !== null
        ? `state=${payload.state}, queue=${payload.queue_position}`
        : `state=${payload.state}`;
    return {
      payload: {
        kind: "state",
        state: payload.state as JobState,
        terminal: payload.terminal,
        queuePosition: payload.queue_position,
        cancelRequested: payload.cancel_requested,
        earlyCompletionRequested: payload.early_completion_requested,
        cancellable: payload.controls.cancellable,
        earlyCompletionAvailable: payload.controls.early_completion_available,
        error: payload.error ?? null,
      },
      detail,
    };
  }
  if (frame.event === "job.control_changed") {
    const payload = parseControlChangedPayload(data);
    if (payload === null) return null;
    return {
      payload: { kind: "control", earlyCompletionRequested: payload.early_completion_requested },
      detail: `early_completion=${payload.early_completion_requested}`,
    };
  }
  if (frame.event === "job.result_available") {
    const payload = parseResultAvailablePayload(data);
    if (payload === null) return null;
    const score = payload.score !== null ? `, score=${payload.score}` : "";
    return {
      payload: {
        kind: "result",
        outcome: payload.outcome as OptimizationOutcome,
        score: payload.score,
        solverStatus: payload.solver_status,
        terminationReason: payload.termination_reason,
        artifactName: payload.artifact_name,
      },
      detail: `outcome=${payload.outcome}${score}`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Durable-stream callback wiring
// ---------------------------------------------------------------------------

/** The subset of stream options the controller supplies (the rest are cursor/enable). */
export interface RunStreamCallbacks {
  onEvent: (frame: SseFrame) => Promise<void>;
  onTerminal: (result: { frame?: SseFrame; job?: JobResponse }) => void;
  onJobGone: (info: OptimizeErrorInfo) => void;
  onCursorExpired: (info: OptimizeErrorInfo) => void;
  onCursorInvalid: (info: OptimizeErrorInfo) => void;
  onCursorCommit?: (cursor: string) => void;
  onCursorReset: () => void;
  onError: (error: unknown) => void;
}

/**
 * Build the durable-stream callbacks that feed the run reducer. Kept pure (only a
 * `dispatch` sink) so the recovery/terminal/malformed-frame wiring is unit-testable
 * without a live SSE transport. `onEvent` is async so the T16p apply-before-commit
 * fence only advances the cursor after the run signal has been applied.
 *
 * For each successfully applied frame:
 *   • ephemeral frames (`job.progressed`, `job.phase_changed`) dispatch their
 *     run signal (progress/phase) with the frame's cursor and `occurredAt`;
 *   • durable frames (`job.state_changed`, `job.control_changed`,
 *     `job.result_available`) dispatch a `durable-frame-applied` signal that
 *     logs the event in wire order. Authoritative state arrives via the next
 *     `job-snapshot` from cache reconciliation (T16p), so this does NOT duplicate
 *     state — it only preserves the event log's faithfulness to the wire.
 *
 * `onCursorCommit` forwards the only cursor T16p declares safe to persist
 * (post-apply); the controller passes it through to T16b's durable cursor store.
 */
export function buildStreamCallbacks(
  dispatch: (signal: RunSignal) => void,
  onCursorCommit?: (cursor: string) => void,
): RunStreamCallbacks {
  return {
    onEvent: async (frame) => {
      const ephemeral = frameToSignal(frame);
      if (ephemeral) dispatch(ephemeral);
      const durable = durableFrameSignal(frame);
      if (durable) dispatch(durable);
    },
    onTerminal: ({ job }) => {
      if (job) dispatch({ type: "job-snapshot", job });
    },
    onJobGone: (info) => dispatch({ type: "job-gone", code: info.code, message: info.message }),
    onCursorExpired: (info) =>
      dispatch({
        type: "cursor-recovery",
        reason: "expired",
        oldestEventId: info.oldestEventId ?? null,
      }),
    onCursorInvalid: () => dispatch({ type: "cursor-recovery", reason: "invalid" }),
    onCursorCommit,
    onCursorReset: () => dispatch({ type: "cursor-reset" }),
    onError: (error) =>
      dispatch({
        type: "stream-error",
        message: error instanceof Error ? error.message : "Optimization stream disconnected.",
      }),
  };
}
