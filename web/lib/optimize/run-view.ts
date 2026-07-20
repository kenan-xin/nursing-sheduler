// T16a — the feature-local Optimize run view model and its pure reducer.
//
// This is the single typed projection of an optimize run that the screen (T16e),
// the progress chart (T16d), and the recovery UI (T16b/c) read. It deliberately
// replaces the intentionally lean T04 `RunState` placeholder for this feature: a
// closed, discriminated model rather than a `ui: Record<string, unknown>` bag.
//
// The reducer is PURE — `(view, signal) => view` with no clock, storage, network,
// or React — so every lifecycle / outcome / control / error / queue / recovery
// transition is exhaustively unit-testable. The controller (`use-optimize-run.ts`)
// owns all effects and feeds signals in; it never mutates the model directly.
//
// Authority rules baked in here (reconciled functional spec 10 + Contract C2):
//   • The server is authoritative for lifecycle, queue position, controls, result,
//     and error. A `job-snapshot` (from a poll or an SSE-applied cache frame, or a
//     cancel/finish-now response) REPLACES those fields; the model never infers a
//     capability the server did not report.
//   • Progress and phase frames are ephemeral chart/log data (never durable state);
//     they accumulate in bounded histories and are cleared on cursor recovery.
//   • `worker_lost` is a terminal `failed` job distinguished ONLY by its structured
//     `error.code`, never by an English message, and it is the case that offers
//     Resubmit.
//   • Reload-recovery availability is carried explicitly so a degraded post-202
//     activation (T16q `activation-persistence-failed` / `activation-unverified`)
//     never claims a resumable session it cannot prove.

import type { JobResponse, JobState, OptimizationOutcome } from "@/lib/bff/types";

// ---------------------------------------------------------------------------
// Bounded-history limits + deterministic eviction
// ---------------------------------------------------------------------------

/** Max retained progress points; a long run keeps only the most recent window. */
export const MAX_PROGRESS_POINTS = 2000;
/** Max retained phase entries. */
export const MAX_PHASE_ENTRIES = 500;
/** Max retained unified event-log entries. */
export const MAX_LOG_ENTRIES = 1000;

/**
 * Append `item` to a bounded history, evicting the OLDEST entries when the cap is
 * exceeded. Deterministic (drop-from-front), so history is stable and testable and
 * an unbounded stream can never grow the hot store without limit.
 */
function pushBounded<T>(history: readonly T[], item: T, max: number): T[] {
  const next = [...history, item];
  return next.length > max ? next.slice(next.length - max) : next;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * The full run lifecycle surfaced to the UI. The six job-lifecycle values mirror
 * the backend `JobState` verbatim; the three `submit-*` values model pre-job
 * outcomes that have no server job to poll.
 */
export type RunLifecycle =
  | "idle" // reset — nothing running
  | "submitting" // POST in flight, before a 202
  | "submit-blocked" // T16q blocked the durable stage before POST (never reached the server)
  | "submit-rejected" // the server definitively rejected the submission — no job exists
  | "submit-unknown" // the submission outcome is ambiguous — a job MAY exist (interrupted)
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";

/** Lifecycles with an active server job the controller should poll/stream. */
const ACTIVE_LIFECYCLES: ReadonlySet<RunLifecycle> = new Set<RunLifecycle>([
  "queued",
  "running",
  "cancelling",
]);

/** Whether a lifecycle has a live server job (drives poll/stream enablement). */
export function isActiveLifecycle(lifecycle: RunLifecycle): boolean {
  return ACTIVE_LIFECYCLES.has(lifecycle);
}

/** Server-provided run controls (never inferred locally). */
export interface RunControls {
  cancellable: boolean;
  earlyCompletionAvailable: boolean;
}

/** The solver verdict, distinct from the lifecycle (Contract C2). */
export interface RunResult {
  outcome: OptimizationOutcome;
  score: number | null;
  solverStatus: string;
  terminationReason: string | null;
}

/** Where a structured error originated, so the UI can route it correctly. */
export type RunErrorSource = "submit" | "session" | "job" | "stream" | "control";

/** A code-first structured error — never a parsed English detail string. */
export interface RunError {
  source: RunErrorSource;
  /** The backend / T16q machine code, or null when only a message is available. */
  code: string | null;
  message: string;
}

/** Which opaque-cursor recovery the durable stream just performed. */
export type CursorRecoveryReason = "expired" | "invalid";

export interface CursorRecoveryState {
  reason: CursorRecoveryReason;
  /** The oldest still-retained cursor (expired only), opaque. */
  oldestEventId: string | null;
}

/**
 * One normalized `job.progressed` frame (ephemeral chart data). The two chart
 * axes — `currentBestScore` and `elapsedSeconds` — are ALWAYS finite non-null
 * numbers: the normalizer rejects any frame missing or non-finifying either
 * field (mirrors the old-app `page.tsx:498` append rule). `solutionIndex` and
 * `commentCount` remain nullable (optional supplementary fields).
 */
export interface RunProgressPoint {
  source: string;
  currentBestScore: number;
  elapsedSeconds: number;
  solutionIndex: number | null;
  commentCount: number | null;
}

/**
 * One normalized `job.phase_changed` frame (ephemeral log data). Strict
 * validated: `source`, `code`, `message` are non-empty strings; `elapsedSeconds`
 * is a finite number (the backend always emits it).
 */
export interface RunPhaseEntry {
  source: string;
  code: string;
  message: string;
  elapsedSeconds: number;
}

/** A coarse category for a unified event-log entry. */
export type RunLogKind =
  | "lifecycle"
  | "state"
  | "control"
  | "result"
  | "progress"
  | "phase"
  | "recovery"
  | "terminal"
  | "error";

/**
 * Typed validated payload for one applied wire frame. T16e renders directly
 * from this without reparsing raw JSON. The variant `kind` matches the SSE
 * event name's domain (state/control/result are durable; progress/phase are
 * ephemeral) — every field accepted by the T06 parsers is retained.
 *
 * Controller-initiated entries (submit-started, download, cleanup, recovery,
 * cursor-reset, transport errors) do NOT carry a typed payload — they use the
 * `detail` string field for their short summary.
 */
export type RunLogPayload =
  | {
      kind: "state";
      state: JobState;
      terminal: boolean;
      queuePosition: number | null;
      cancelRequested: boolean;
      earlyCompletionRequested: boolean;
      cancellable: boolean;
      earlyCompletionAvailable: boolean;
      error: { code: string; message: string } | null;
    }
  | {
      kind: "control";
      earlyCompletionRequested: boolean;
    }
  | {
      kind: "result";
      outcome: OptimizationOutcome;
      score: number | null;
      solverStatus: string;
      terminationReason: string | null;
      artifactName: string | null;
    }
  | {
      kind: "progress";
      source: string;
      currentBestScore: number;
      elapsedSeconds: number;
      solutionIndex: number | null;
      commentCount: number | null;
    }
  | {
      kind: "phase";
      source: string;
      code: string;
      message: string;
      elapsedSeconds: number;
    };

/**
 * One entry in the bounded unified event log. Fields:
 *   • `seq` — monotonic, stable for ordering.
 *   • `kind` — coarse category for routing/styling. State/control/result are
 *     distinct categories for durable frames (NOT collapsed into a single
 *     "state" category).
 *   • `label` — short stable label (e.g. "state:running", "phase:solve").
 *   • `event` — the SSE event name for applied frames ("job.progressed",
 *     "job.phase_changed", "job.state_changed", "job.control_changed",
 *     "job.result_available"), or null for controller-initiated entries
 *     (submit-started, download, cleanup, control-error). Lets T16e reproduce
 *     the exact wire order of real events.
 *   • `cursor` — the opaque, job-bound event id for applied SSE frames, or null.
 *   • `payload` — typed validated payload for applied wire frames; null for
 *     controller-initiated entries. T16e renders from this without reparsing.
 *   • `detail` — short renderable summary for controller-initiated entries
 *     (or a fallback for wire frames that don't carry a payload).
 *   • `elapsedSeconds` — the frame's solver/scheduler timing where available.
 *   • `occurredAt` — the backend's wall-clock timestamp where present (ISO
 *     string from the SSE envelope's `occurred_at`), or null.
 *   • `eventTime` — wall-clock stamp applied by the controller's dispatch
 *     wrapper (when the frame was applied locally), null in pure reducer tests.
 *
 * Poll/cache snapshots update authoritative state but do NOT produce a log
 * entry, so the bounded budget is reserved for real applied events.
 */
export interface RunLogEntry {
  seq: number;
  kind: RunLogKind;
  label: string;
  event: string | null;
  cursor: string | null;
  payload: RunLogPayload | null;
  detail: string | null;
  elapsedSeconds: number | null;
  occurredAt: string | null;
  eventTime: number | null;
}

/** Download progression of the terminal artifact (T16e drives the fetch). */
export type DownloadStatus = "idle" | "available" | "downloading" | "downloaded" | "unavailable";

/** Best-effort terminal cleanup progression (T16e drives the DELETE). */
export type CleanupStatus = "idle" | "pending" | "cleaned" | "failed" | "retained";

export interface DownloadState {
  status: DownloadStatus;
  /** Whether the server exposes a downloadable schedule artifact for this job. */
  artifactAvailable: boolean;
  filename: string | null;
}

export interface CleanupState {
  status: CleanupStatus;
}

/**
 * Whether the current tab could resume this run after a reload, and why not. A
 * degraded post-202 activation keeps the job usable in-tab but sets
 * `reloadRecoveryAvailable: false` so the UI never promises reload recovery.
 */
export interface SessionRecoveryState {
  reloadRecoveryAvailable: boolean;
  reason: string | null;
}

/** The closed, typed projection of one optimize run. */
export interface OptimizeRunView {
  lifecycle: RunLifecycle;
  jobId: string | null;
  anonymized: boolean;
  peopleCount: number | null;
  queuePosition: number | null;
  controls: RunControls;
  result: RunResult | null;
  /** Convenience mirror of `result.outcome` (null until a result arrives). */
  outcome: OptimizationOutcome | null;
  /** Latest displayed incumbent score (live progress, then the final result). */
  latestScore: number | null;
  error: RunError | null;
  cursorRecovery: CursorRecoveryState | null;
  progress: RunProgressPoint[];
  phases: RunPhaseEntry[];
  log: RunLogEntry[];
  download: DownloadState;
  cleanup: CleanupState;
  sessionRecovery: SessionRecoveryState;
  /** Whether Resubmit should be offered after T16b/T16e confirms record cleanup. */
  resubmittable: boolean;
  /** Monotonic sequence for deterministic log ordering. */
  seq: number;
}

const INITIAL_CONTROLS: RunControls = { cancellable: false, earlyCompletionAvailable: false };
const INITIAL_DOWNLOAD: DownloadState = {
  status: "idle",
  artifactAvailable: false,
  filename: null,
};
const INITIAL_CLEANUP: CleanupState = { status: "idle" };
const INITIAL_SESSION_RECOVERY: SessionRecoveryState = {
  reloadRecoveryAvailable: false,
  reason: null,
};

/** The zero-value run view. */
export const INITIAL_OPTIMIZE_RUN_VIEW: OptimizeRunView = {
  lifecycle: "idle",
  jobId: null,
  anonymized: false,
  peopleCount: null,
  queuePosition: null,
  controls: INITIAL_CONTROLS,
  result: null,
  outcome: null,
  latestScore: null,
  error: null,
  cursorRecovery: null,
  progress: [],
  phases: [],
  log: [],
  download: INITIAL_DOWNLOAD,
  cleanup: INITIAL_CLEANUP,
  sessionRecovery: INITIAL_SESSION_RECOVERY,
  resubmittable: false,
  seq: 0,
};

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * The closed set of inputs the controller feeds the reducer. Everything the UI
 * shows is a pure function of the initial view and the ordered signal stream.
 */
export type RunSignal =
  // Full reset back to idle (New / Load / explicit clear).
  | { type: "reset" }
  // A submission started: resets prior run state and enters `submitting`.
  | { type: "submit-started"; anonymized: boolean; peopleCount: number }
  // T16q could not durably stage before POST (session conflict, storage failure).
  | { type: "submit-blocked"; code: string; message: string }
  // The server definitively rejected the submission — no job was created.
  | { type: "submit-rejected"; code: string | null; message: string }
  // The submission outcome is ambiguous (a job may exist) — interrupted/retention.
  | { type: "submit-unknown"; code: string | null; message: string }
  // A 202 job exists; `reloadRecoveryAvailable` reflects whether the active record
  // became durable (false for a degraded post-202 activation).
  | {
      type: "job-activated";
      jobId: string;
      reloadRecoveryAvailable: boolean;
      reason?: string | null;
    }
  // Authoritative server state (poll, SSE-applied cache, or control response).
  | { type: "job-snapshot"; job: JobResponse }
  // A normalized ephemeral progress frame. `cursor` is the opaque event id;
  // `occurredAt` is the backend wall-clock (required for wire log entry).
  | {
      type: "progress";
      point: RunProgressPoint;
      cursor?: string | null;
      occurredAt?: string | null;
    }
  // A normalized ephemeral phase frame. Same cursor/occurredAt requirements.
  | {
      type: "phase";
      entry: RunPhaseEntry;
      cursor?: string | null;
      occurredAt?: string | null;
    }
  // A durable SSE frame (state/control/result) was applied at the T16p
  // controller fence. It logs the event in wire order with its cursor, payload,
  // and occurredAt but does NOT change authoritative state — that arrives via
  // the next `job-snapshot` from cache reconciliation. Keeps the event log
  // faithful to the wire without collapsing it into poll snapshots.
  | {
      type: "durable-frame-applied";
      event: string;
      cursor: string | null;
      payload: RunLogPayload;
      detail: string | null;
      occurredAt?: string | null;
    }
  // The durable stream recovered from an expired/invalid cursor — clears history.
  | { type: "cursor-recovery"; reason: CursorRecoveryReason; oldestEventId?: string | null }
  // A persisted resume cursor was cleared during recovery (informational).
  | { type: "cursor-reset" }
  // The job is gone (expired/deleted/never existed) — recovery, not a solver failure.
  | { type: "job-gone"; code: string | null; message: string }
  // The reconnect budget was exhausted while the job was non-terminal (non-fatal).
  | { type: "stream-error"; message: string }
  // A cancel / finish-now request failed; the server lifecycle is unchanged.
  | { type: "control-error"; code: string | null; message: string }
  // A control request returned `job_not_found`: the job is gone. Detaches the
  // obsolete job id and marks the run resubmittable, mirroring the poll path.
  | { type: "control-job-gone"; code: string | null; message: string }
  // Terminal-artifact download progression (driven by T16e).
  | { type: "download-started" }
  | { type: "download-succeeded"; filename: string | null }
  | { type: "download-unavailable" }
  | { type: "download-failed"; message: string }
  // Terminal cleanup progression (driven by T16e).
  | { type: "cleanup-succeeded" }
  | { type: "cleanup-failed" }
  | { type: "cleanup-retained" };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** The `worker_lost` structured code — the failure that offers Resubmit. */
export const WORKER_LOST_CODE = "worker_lost";

function appendLog(
  view: OptimizeRunView,
  kind: RunLogKind,
  label: string,
  detail: string | null = null,
  elapsedSeconds: number | null = null,
  event: string | null = null,
  cursor: string | null = null,
  occurredAt: string | null = null,
  payload: RunLogPayload | null = null,
): {
  log: RunLogEntry[];
  seq: number;
} {
  const seq = view.seq + 1;
  return {
    log: pushBounded(
      view.log,
      {
        seq,
        kind,
        label,
        event,
        cursor,
        payload,
        detail,
        elapsedSeconds,
        occurredAt,
        eventTime: null,
      },
      MAX_LOG_ENTRIES,
    ),
    seq,
  };
}

function mapResult(job: JobResponse): RunResult | null {
  if (job.result === null) return null;
  return {
    outcome: job.result.outcome,
    score: job.result.score,
    solverStatus: job.result.solver_status,
    terminationReason: job.result.termination_reason,
  };
}

/** A fresh run view that keeps only what a repeat run should carry forward. */
function freshRun(base: OptimizeRunView, patch: Partial<OptimizeRunView>): OptimizeRunView {
  // A new submission clears prior score/status/job/incumbent/progress/log/download
  // (reconciled spec FR-OE-40 / AC-OE-25). `seq` keeps advancing so log ordering is
  // globally monotonic across runs.
  return {
    ...INITIAL_OPTIMIZE_RUN_VIEW,
    seq: base.seq,
    ...patch,
  };
}

/**
 * Reduce one signal into the next run view. Pure and total: an unrecognized signal
 * is impossible (the union is closed), and every branch returns a new object rather
 * than mutating the input.
 */
export function reduceRunView(view: OptimizeRunView, signal: RunSignal): OptimizeRunView {
  switch (signal.type) {
    case "reset":
      return { ...INITIAL_OPTIMIZE_RUN_VIEW, seq: view.seq };

    case "submit-started": {
      const started = freshRun(view, {
        lifecycle: "submitting",
        anonymized: signal.anonymized,
        peopleCount: signal.peopleCount,
      });
      const detail = `anonymized=${signal.anonymized}, people=${signal.peopleCount}`;
      const { log, seq } = appendLog(started, "lifecycle", "submitting", detail);
      return { ...started, log, seq };
    }

    case "submit-blocked": {
      const { log, seq } = appendLog(view, "error", "submit-blocked", signal.code);
      return {
        ...view,
        lifecycle: "submit-blocked",
        jobId: null,
        controls: INITIAL_CONTROLS,
        error: { source: "session", code: signal.code, message: signal.message },
        sessionRecovery: INITIAL_SESSION_RECOVERY,
        resubmittable: false,
        log,
        seq,
      };
    }

    case "submit-rejected": {
      const code = signal.code ?? "unknown";
      const { log, seq } = appendLog(view, "error", "submit-rejected", code);
      return {
        ...view,
        lifecycle: "submit-rejected",
        jobId: null,
        controls: INITIAL_CONTROLS,
        error: { source: "submit", code: signal.code, message: signal.message },
        sessionRecovery: INITIAL_SESSION_RECOVERY,
        // A clean rejection created no job, so a corrected resubmission is safe.
        resubmittable: true,
        log,
        seq,
      };
    }

    case "submit-unknown": {
      const code = signal.code ?? "unknown";
      const { log, seq } = appendLog(view, "error", "submit-unknown", code);
      return {
        ...view,
        lifecycle: "submit-unknown",
        jobId: null,
        controls: INITIAL_CONTROLS,
        error: { source: "submit", code: signal.code, message: signal.message },
        // A job MAY exist; do not offer a one-click resubmit that could double-run.
        sessionRecovery: INITIAL_SESSION_RECOVERY,
        resubmittable: false,
        log,
        seq,
      };
    }

    case "job-activated": {
      const detail = signal.reason ?? (signal.reloadRecoveryAvailable ? "durable" : "volatile");
      const { log, seq } = appendLog(view, "lifecycle", `activated:${signal.jobId}`, detail);
      return {
        ...view,
        jobId: signal.jobId,
        sessionRecovery: {
          reloadRecoveryAvailable: signal.reloadRecoveryAvailable,
          reason: signal.reason ?? null,
        },
        log,
        seq,
      };
    }

    case "job-snapshot": {
      const job = signal.job;
      const lifecycle = job.state as RunLifecycle;
      const result = mapResult(job);
      const artifactAvailable = job.links.schedule !== null;
      const terminal = job.terminal;

      // Terminal artifact availability: a downloadable schedule flips download to
      // `available`; a terminal run with none is `unavailable`. Non-terminal frames
      // leave the download machine untouched.
      let download = view.download;
      if (terminal) {
        download = artifactAvailable
          ? view.download.status === "idle"
            ? { ...view.download, status: "available", artifactAvailable: true }
            : { ...view.download, artifactAvailable: true }
          : { ...view.download, status: "unavailable", artifactAvailable: false };
      } else {
        download = { ...view.download, artifactAvailable };
      }

      const workerLost = job.state === "failed" && job.error?.code === WORKER_LOST_CODE;

      // P1 #3 (snapshots): poll/cache reconciliation appends ZERO log entries,
      // even on lifecycle changes and terminal snapshots. The wire event log is
      // reserved for SSE-applied frames; authoritative state changes from
      // snapshots are reflected in lifecycle/controls/result/error but never
      // consume the bounded event budget. This keeps the wire log faithful to
      // real events without filtering by `event !== null`.
      return {
        ...view,
        lifecycle,
        jobId: job.id,
        queuePosition: job.queue_position,
        controls: {
          cancellable: job.controls.cancellable,
          earlyCompletionAvailable: job.controls.early_completion_available,
        },
        result,
        outcome: result?.outcome ?? null,
        // A final result score supersedes the live incumbent; otherwise keep it.
        latestScore: result?.score ?? view.latestScore,
        // Authoritative: adopt the server error, or clear a prior job error.
        error: job.error
          ? { source: "job", code: job.error.code, message: job.error.message }
          : null,
        download,
        resubmittable: workerLost,
      };
    }

    case "progress": {
      const p = signal.point;
      const parts: string[] = [`score=${p.currentBestScore}`, `elapsed=${p.elapsedSeconds}s`];
      if (p.solutionIndex !== null) parts.push(`solution=#${p.solutionIndex}`);
      if (p.commentCount !== null) parts.push(`comments=${p.commentCount}`);
      const payload: RunLogPayload = {
        kind: "progress",
        source: p.source,
        currentBestScore: p.currentBestScore,
        elapsedSeconds: p.elapsedSeconds,
        solutionIndex: p.solutionIndex,
        commentCount: p.commentCount,
      };
      const { log, seq } = appendLog(
        view,
        "progress",
        "progress",
        parts.join(", "),
        p.elapsedSeconds,
        "job.progressed",
        signal.cursor ?? null,
        signal.occurredAt ?? null,
        payload,
      );
      return {
        ...view,
        progress: pushBounded(view.progress, signal.point, MAX_PROGRESS_POINTS),
        latestScore: p.currentBestScore,
        log,
        seq,
      };
    }

    case "phase": {
      const e = signal.entry;
      const detail = e.message ? `${e.code}: ${e.message}` : e.code;
      const payload: RunLogPayload = {
        kind: "phase",
        source: e.source,
        code: e.code,
        message: e.message,
        elapsedSeconds: e.elapsedSeconds ?? 0,
      };
      const { log, seq } = appendLog(
        view,
        "phase",
        `phase:${e.code}`,
        detail,
        e.elapsedSeconds,
        "job.phase_changed",
        signal.cursor ?? null,
        signal.occurredAt ?? null,
        payload,
      );
      return {
        ...view,
        phases: pushBounded(view.phases, signal.entry, MAX_PHASE_ENTRIES),
        log,
        seq,
      };
    }

    case "durable-frame-applied": {
      // A durable SSE frame (state/control/result) was applied at the T16p
      // controller fence. Log it in exact wire order with its event name,
      // cursor, payload, and occurredAt. Authoritative state arrives via the
      // next `job-snapshot` from cache reconciliation. The payload `kind`
      // determines the log `kind` so state/control/result stay distinct
      // categories (not collapsed into a single "state" bucket).
      const { log, seq } = appendLog(
        view,
        signal.payload.kind,
        signal.event,
        signal.detail,
        null,
        signal.event,
        signal.cursor,
        signal.occurredAt ?? null,
        signal.payload,
      );
      return { ...view, log, seq };
    }

    case "cursor-recovery": {
      const { log, seq } = appendLog(
        view,
        "recovery",
        `cursor-${signal.reason}`,
        signal.oldestEventId ?? null,
      );
      // Earlier progress/phase history is no longer trustworthy after a cursor
      // recovery — clear the ephemeral chart/log data (reconciled spec) but keep the
      // audit log and the authoritative job fields.
      return {
        ...view,
        cursorRecovery: { reason: signal.reason, oldestEventId: signal.oldestEventId ?? null },
        progress: [],
        phases: [],
        log,
        seq,
      };
    }

    case "cursor-reset": {
      const { log, seq } = appendLog(view, "recovery", "cursor-reset");
      return { ...view, log, seq };
    }

    case "job-gone":
    case "control-job-gone": {
      const code = signal.code ?? "unknown";
      const { log, seq } = appendLog(view, "terminal", "job-gone", code);
      // The job expired/deleted/never existed — a recovery surfaced via
      // error.code, NOT a solver failure. Detach the obsolete job id so
      // poll/stream stop. Download is unavailable; T16b/T16e separately inspect
      // and clean the one durable session record before a repeat submission.
      return {
        ...view,
        lifecycle: "failed",
        jobId: null,
        queuePosition: null,
        controls: INITIAL_CONTROLS,
        error: { source: "job", code: signal.code, message: signal.message },
        download: { ...view.download, status: "unavailable", artifactAvailable: false },
        sessionRecovery: INITIAL_SESSION_RECOVERY,
        resubmittable: true,
        log,
        seq,
      };
    }

    case "stream-error": {
      // Reconnect budget exhausted while non-terminal: transport is down, but the
      // server job may still be running. Record it without changing lifecycle so the
      // UI can show a disconnect notice (reconciled spec: transport disconnect is
      // not itself a run failure).
      const { log, seq } = appendLog(view, "error", "stream-disconnected", signal.message);
      return {
        ...view,
        error: { source: "stream", code: null, message: signal.message },
        log,
        seq,
      };
    }

    case "control-error": {
      // A cancel/finish-now request failed. The server remains authoritative for
      // lifecycle/controls, so record the error without altering them — the next
      // authoritative snapshot still governs.
      const { log, seq } = appendLog(view, "error", "control-error", signal.code ?? "unknown");
      return {
        ...view,
        error: { source: "control", code: signal.code, message: signal.message },
        log,
        seq,
      };
    }

    case "download-started": {
      const { log, seq } = appendLog(view, "result", "download-started");
      return { ...view, download: { ...view.download, status: "downloading" }, log, seq };
    }

    case "download-succeeded": {
      const { log, seq } = appendLog(view, "result", "download-succeeded", signal.filename ?? null);
      return {
        ...view,
        download: {
          status: "downloaded",
          artifactAvailable: true,
          filename: signal.filename ?? view.download.filename,
        },
        log,
        seq,
      };
    }

    case "download-unavailable": {
      const { log, seq } = appendLog(view, "result", "download-unavailable");
      return {
        ...view,
        download: { ...view.download, status: "unavailable", artifactAvailable: false },
        log,
        seq,
      };
    }

    case "download-failed": {
      const { log, seq } = appendLog(view, "error", "download-failed", signal.message);
      return {
        ...view,
        error: { source: "job", code: null, message: signal.message },
        // A failed download leaves the artifact still available to retry.
        download: { ...view.download, status: "available" },
        log,
        seq,
      };
    }

    case "cleanup-succeeded": {
      const { log, seq } = appendLog(view, "result", "cleanup-succeeded");
      return { ...view, cleanup: { status: "cleaned" }, log, seq };
    }

    case "cleanup-failed": {
      const { log, seq } = appendLog(view, "error", "cleanup-failed");
      return { ...view, cleanup: { status: "failed" }, log, seq };
    }

    case "cleanup-retained": {
      const { log, seq } = appendLog(view, "result", "cleanup-retained");
      return { ...view, cleanup: { status: "retained" }, log, seq };
    }
  }
}

/** Reduce an ordered list of signals from the initial view (test/replay helper). */
export function reduceRunViewAll(
  signals: readonly RunSignal[],
  from: OptimizeRunView = INITIAL_OPTIMIZE_RUN_VIEW,
): OptimizeRunView {
  return signals.reduce(reduceRunView, from);
}

/** A terminal job snapshot (or gone/rejected outcome) means polling can stop. */
export function isSettledLifecycle(lifecycle: RunLifecycle): boolean {
  return (
    lifecycle === "completed" ||
    lifecycle === "cancelled" ||
    lifecycle === "failed" ||
    lifecycle === "submit-blocked" ||
    lifecycle === "submit-rejected" ||
    lifecycle === "submit-unknown"
  );
}
