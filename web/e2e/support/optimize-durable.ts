// T16f — deterministic BFF/SSE fixtures + a browser-side route stubber for the
// durable Optimize & Export acceptance journeys. The Playwright specs drive the
// REAL screen (`/optimize-durable-fixture`, which mounts the real controller +
// SSE parser + reconnect + terminal + cleanup pipeline) and intercept the
// same-origin `/api/**` boundary here, so nothing hand-rolls the protocol: the
// journeys prove the assembled client against fixed, contract-valid wire bytes.
//
// Every JobResponse / SSE payload below is byte-shaped to pass the strict T19
// parsers (`lib/query/event-payloads.ts`) — an off-contract field would make the
// client reconcile or reject, so these fixtures double as a living contract.

import type { Page, Route } from "@playwright/test";
import type { JobResponse, JobState, OptimizationOutcome } from "@/lib/bff/types";

// ===========================================================================
// Replay-oracle judge (R6 combined-cold-review P2)
// ===========================================================================
//
// The assembled gate's release proof for "what the browser recorded after
// reload" used to assert only: at least one raw id, none of them pre-reload, and
// the durable cursor present somewhere among them. That predicate accepted three
// false greens the cold review demonstrated by mutation — a DUPLICATED new id
// (`[c, c]` with cursor `c`), a single FOREIGN-job id, and a valid id MIXED with
// a foreign-job id. None of them is a legal replay, and runtime server-side
// validation does not make this browser oracle stronger: the oracle is precisely
// the proof of what the browser saw.
//
// The judge below is pure, so its whole truth table — valid / duplicate /
// foreign / mixed / stale / missing / malformed — is provable in a unit test
// beside it, deterministically, without the Compose stack. The Playwright spec
// supplies one atomic snapshot and this decides.
//
// Job binding is derived through the CANONICAL cursor contract
// (`core/nurse_scheduling/server/event_cursor.py`), not by string prefix
// matching: the public cursor is
//
//     v1.<unpadded base64url(job_id)>.<unpadded base64url(native_id)>
//
// and a segment is canonical only when its decoded UTF-8 text re-encodes to
// exactly the submitted spelling. Base64 has multiple spellings for the same
// bytes (`MR` and `MQ` both decode to `"1"`), so the round trip is what rejects
// aliases the server never emitted — mirroring `_decode_segment` exactly.
//
// Deliberately NOT asserted: anything about native-id increments. The native id
// is an opaque store token (a decimal int in the memory backend, a `<ms>-<seq>`
// Redis stream id in production); constraining its arithmetic would bind this
// oracle to a storage detail it must not own.

/** Wire version prefix of the public event cursor (`CURSOR_VERSION`). */
export const CURSOR_VERSION = "v1";

/** Unpadded base64url: URL-safe alphabet only, no `=` padding, non-empty. */
const CURSOR_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

/** One decoded public cursor. */
export interface DecodedCursor {
  jobId: string;
  nativeEventId: string;
}

/**
 * Decode one canonical segment, or return `null` when it is not a canonical
 * unpadded base64url UTF-8 spelling. Mirrors `event_cursor.py::_decode_segment`,
 * including the byte-for-byte re-encode that rejects non-canonical aliases.
 */
function decodeCursorSegment(segment: string): string | null {
  if (!CURSOR_SEGMENT_PATTERN.test(segment)) return null;
  const decoded = Buffer.from(segment, "base64url").toString("utf8");
  // `Buffer` is lenient about both base64 aliases and invalid UTF-8 (it
  // substitutes U+FFFD rather than throwing), so the round trip carries the
  // whole rejection: a non-canonical spelling or a bad byte sequence re-encodes
  // to something other than `segment`.
  if (Buffer.from(decoded, "utf8").toString("base64url") !== segment) return null;
  return decoded;
}

/**
 * Decode a public cursor, or return `null` when it is malformed. Shape and
 * version are checked exactly as `event_cursor.py::decode_cursor` does; the job
 * binding itself is compared by the caller.
 */
export function decodePublicCursor(token: string): DecodedCursor | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== CURSOR_VERSION) return null;
  const jobId = decodeCursorSegment(parts[1]);
  const nativeEventId = decodeCursorSegment(parts[2]);
  if (jobId === null || nativeEventId === null) return null;
  return { jobId, nativeEventId };
}

export interface ReplayEvidence {
  /** Raw `id:` values recorded from the post-reload SSE body, in wire order. */
  rawIds: readonly string[];
  /** The durably persisted cursor read in the SAME atomic snapshot as `rawIds`. */
  cursorAfter: string | null;
  /** The exact cursor captured before reload and replayed as `Last-Event-ID`. */
  cursorBefore: string | null;
  /** Every raw id observed BEFORE the reload. */
  preReloadIds: readonly string[];
}

export interface ReplayJudgement {
  ok: boolean;
  /** Every violated rule, named. Empty exactly when `ok`. */
  failures: string[];
}

/**
 * Judge one atomic post-reload snapshot against the strictly-after replay
 * contract.
 *
 * Retained from the original predicate: non-empty evidence, no pre-reload id
 * re-sent, and the durable cursor both new and present among the recorded
 * frames. Added: raw-id UNIQUENESS, and exact JOB BINDING for every recorded id
 * and for the cursor, against the job decoded from `cursorBefore` — the resumed
 * job, since that same cursor is separately asserted to be the exact
 * `Last-Event-ID` on the first post-reload request.
 */
export function judgeReplayEvidence(evidence: ReplayEvidence): ReplayJudgement {
  const failures: string[] = [];
  const { rawIds, cursorAfter, cursorBefore, preReloadIds } = evidence;

  if (cursorBefore === null || cursorBefore.length === 0) {
    return { ok: false, failures: ["no pre-reload cursor was captured to bind the job"] };
  }
  const before = decodePublicCursor(cursorBefore);
  if (before === null) {
    return {
      ok: false,
      failures: [`pre-reload cursor is not a canonical public cursor: ${cursorBefore}`],
    };
  }
  const expectedJob = before.jobId;

  if (rawIds.length === 0) failures.push("no post-reload frame ids were recorded");

  const preReloadSet = new Set(preReloadIds);
  const stale = rawIds.filter((id) => preReloadSet.has(id));
  if (stale.length > 0) {
    failures.push(`replay re-sent ${stale.length} already-seen id(s): ${stale.join(", ")}`);
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of rawIds) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    failures.push(`post-reload frame ids are not unique: ${[...duplicates].join(", ")}`);
  }

  for (const id of rawIds) {
    const decoded = decodePublicCursor(id);
    if (decoded === null) {
      failures.push(`recorded id is not a canonical public cursor: ${id}`);
      continue;
    }
    if (decoded.jobId !== expectedJob) {
      failures.push(
        `recorded id is bound to job "${decoded.jobId}", not the resumed "${expectedJob}": ${id}`,
      );
    }
  }

  if (cursorAfter === null) {
    failures.push("no durable cursor was persisted after reload");
  } else {
    if (preReloadSet.has(cursorAfter)) {
      failures.push(`durable cursor is an already-seen id: ${cursorAfter}`);
    }
    const after = decodePublicCursor(cursorAfter);
    if (after === null) {
      failures.push(`durable cursor is not a canonical public cursor: ${cursorAfter}`);
    } else if (after.jobId !== expectedJob) {
      failures.push(
        `durable cursor is bound to job "${after.jobId}", not the resumed "${expectedJob}"`,
      );
    }
    if (!rawIds.includes(cursorAfter)) {
      failures.push(`durable cursor ${cursorAfter} is absent from the recorded frames`);
    }
  }

  return { ok: failures.length === 0, failures };
}

export const DURABLE_FIXTURE_URL = "/optimize-durable-fixture";
export const JOB_ID = "opt_e2e_1";

const CREATED_AT = "2026-07-20T00:00:00+00:00";
const STARTED_AT = "2026-07-20T00:00:01+00:00";
const FINISHED_AT = "2026-07-20T00:01:00+00:00";

function links(id: string, schedule: string | null): JobResponse["links"] {
  const base = `/optimize/${id}`;
  return {
    self: base,
    events: `${base}/events`,
    cancellation: `${base}/cancel`,
    early_completion: `${base}/finish-now`,
    schedule,
  };
}

const REQUEST: JobResponse["request"] = {
  input_name: "s.yaml",
  solver: "ortools/cp-sat",
  prettify: null,
  timeout_seconds: 300,
};

/** A contract-valid queued JobResponse. */
export function queuedJob(id = JOB_ID, queuePosition = 1): JobResponse {
  return {
    id,
    state: "queued",
    terminal: false,
    queue_position: queuePosition,
    created_at: CREATED_AT,
    started_at: null,
    finished_at: null,
    request: REQUEST,
    result: null,
    error: null,
    controls: { cancellable: true, early_completion_available: false },
    links: links(id, null),
  };
}

/** A contract-valid running JobResponse (server controls both available). */
export function runningJob(id = JOB_ID): JobResponse {
  return {
    id,
    state: "running",
    terminal: false,
    queue_position: null,
    created_at: CREATED_AT,
    started_at: STARTED_AT,
    finished_at: null,
    request: REQUEST,
    result: null,
    error: null,
    controls: { cancellable: true, early_completion_available: true },
    links: links(id, null),
  };
}

/** A contract-valid cancelling JobResponse (no controls). */
export function cancellingJob(id = JOB_ID): JobResponse {
  return {
    ...runningJob(id),
    state: "cancelling",
    controls: { cancellable: false, early_completion_available: false },
  };
}

interface CompletedOptions {
  outcome?: OptimizationOutcome;
  score?: number | null;
}

/** A contract-valid completed JobResponse. Optimal/feasible expose a schedule
 *  link; infeasible carries no artifact. */
export function completedJob(id = JOB_ID, options: CompletedOptions = {}): JobResponse {
  const outcome = options.outcome ?? "optimal";
  const infeasible = outcome === "infeasible";
  const result: NonNullable<JobResponse["result"]> = infeasible
    ? {
        outcome: "infeasible",
        score: null,
        solver_status: "INFEASIBLE",
        termination_reason: "infeasibility_proven",
      }
    : {
        outcome,
        score: options.score ?? (outcome === "optimal" ? 7 : 42),
        solver_status: outcome === "optimal" ? "OPTIMAL" : "FEASIBLE",
        termination_reason: outcome === "optimal" ? "optimality_proven" : "solver_timeout",
      };
  return {
    id,
    state: "completed",
    terminal: true,
    queue_position: null,
    created_at: CREATED_AT,
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    request: REQUEST,
    result,
    error: null,
    controls: { cancellable: false, early_completion_available: false },
    links: links(id, infeasible ? null : `/optimize/${id}/xlsx`),
  };
}

/** A contract-valid cancelled JobResponse. */
export function cancelledJob(id = JOB_ID): JobResponse {
  return {
    id,
    state: "cancelled",
    terminal: true,
    queue_position: null,
    created_at: CREATED_AT,
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    request: REQUEST,
    result: null,
    error: { code: "cancelled", message: "Optimization cancelled." },
    controls: { cancellable: false, early_completion_available: false },
    links: links(id, null),
  };
}

/** A contract-valid failed JobResponse. `worker_lost` is server-resubmittable. */
export function failedJob(
  id = JOB_ID,
  code = "worker_lost",
  message = "The optimization worker stopped before the job completed.",
): JobResponse {
  return {
    id,
    state: "failed",
    terminal: true,
    queue_position: null,
    created_at: CREATED_AT,
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    request: REQUEST,
    result: null,
    error: { code, message },
    controls: { cancellable: false, early_completion_available: false },
    links: links(id, null),
  };
}

// --- SSE frames (flat wire payloads, contract-valid) -----------------------

export interface SseFrameInput {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

/** Serialize frames into one `text/event-stream` body (LF blank-line framing,
 *  matching the backend producer). */
export function sseBody(frames: SseFrameInput[]): string {
  return (
    frames
      .map((f) => `id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`)
      .join("") + ": keep-alive\n\n"
  );
}

export function runningFrame(id = "c1"): SseFrameInput {
  return {
    id,
    event: "job.state_changed",
    data: {
      occurred_at: STARTED_AT,
      state: "running",
      queue_position: null,
      cancel_requested: false,
      early_completion_requested: false,
      terminal: false,
      worker_id: "worker-1",
      controls: { cancellable: true, early_completion_available: true },
    },
  };
}

export function progressedFrame(id: string, score: number, elapsedSeconds: number): SseFrameInput {
  return {
    id,
    event: "job.progressed",
    data: {
      currentBestScore: score,
      elapsedSeconds,
      solutionIndex: 1,
      commentCount: 0,
      source: "solver",
    },
  };
}

/** A `job.phase_changed` frame (ephemeral solver phase report). Shapes match
 *  `frameToSignal`: valid `occurred_at`, non-empty source/code/message, and a
 *  finite elapsedSeconds. */
export function phaseChangedFrame(
  id: string,
  source = "solver",
  code = "solve",
  message = "Optimizing schedule",
  elapsedSeconds = 0.5,
): SseFrameInput {
  return {
    id,
    event: "job.phase_changed",
    data: { occurred_at: STARTED_AT, source, code, message, elapsedSeconds },
  };
}

export function resultAvailableFrame(
  id: string,
  outcome: OptimizationOutcome = "optimal",
): SseFrameInput {
  const infeasible = outcome === "infeasible";
  return {
    id,
    event: "job.result_available",
    data: infeasible
      ? {
          occurred_at: "2026-07-20T00:00:30+00:00",
          outcome: "infeasible",
          score: null,
          solver_status: "INFEASIBLE",
          termination_reason: "infeasibility_proven",
          artifact_name: null,
        }
      : {
          occurred_at: "2026-07-20T00:00:30+00:00",
          outcome,
          score: outcome === "optimal" ? 7 : 42,
          solver_status: outcome === "optimal" ? "OPTIMAL" : "FEASIBLE",
          termination_reason: outcome === "optimal" ? "optimality_proven" : "solver_timeout",
          artifact_name: "schedule.xlsx",
        },
  };
}

/** A strict terminal `job.state_changed` frame for a completed/cancelled/failed
 *  job. Shapes match `parseStrictTerminalFrame`. */
export function terminalFrame(id: string, state: JobState): SseFrameInput {
  const base = {
    occurred_at: FINISHED_AT,
    state,
    queue_position: null,
    cancel_requested: state === "cancelled",
    early_completion_requested: false,
    terminal: true,
    controls: { cancellable: false, early_completion_available: false },
  };
  if (state === "completed") return { id, event: "job.state_changed", data: base };
  const code = state === "cancelled" ? "cancelled" : "worker_lost";
  const message =
    state === "cancelled"
      ? "Optimization cancelled."
      : "The optimization worker stopped before the job completed.";
  return {
    id,
    event: "job.state_changed",
    data: { ...base, error: { code, message } },
  };
}

// --- route stubbing --------------------------------------------------------

/** A minimal valid `.xlsx` (empty ZIP with the local-file `PK\x03\x04` magic is
 *  enough for the download to succeed; restore is a no-op with an empty map). */
const XLSX_EMPTY_ZIP_BASE64 =
  "UEsDBBQAAAAAAAAAIQAAAAAAAAAAAAAAAAAJAAAAdGVzdC50eHRQSwECFAAUAAAAAAAAACEAAAAAAAAAAAAAAAAACQAAAAAAAAAAAAAAAAAAAAAAdGVzdC50eHRQSwUGAAAAAAEAAQA3AAAAJwAAAAAA";

export interface OptimizeRouteConfig {
  /** `/api/info` identity. Defaults to an online, version-matched backend. */
  info?: () => { status: number; body: unknown };
  /** `POST /api/optimize`. Defaults to a 202 running job. */
  onSubmit?: (route: Route) => Promise<void> | void;
  /** `GET /api/optimize/{id}` poll. Defaults to a completed job. */
  onPoll?: (route: Route) => Promise<void> | void;
  /** `GET /api/optimize/{id}/events` SSE. Defaults to a full happy-path stream. */
  onEvents?: (route: Route) => Promise<void> | void;
  /** `GET /api/optimize/{id}/xlsx`. Defaults to a valid empty workbook. */
  onXlsx?: (route: Route) => Promise<void> | void;
  /** `DELETE /api/optimize/{id}` cleanup. Defaults to 204. */
  onDelete?: (route: Route) => Promise<void> | void;
  /** `POST /api/optimize/{id}/cancel`. Defaults to a cancelled job. */
  onCancel?: (route: Route) => Promise<void> | void;
  /** `POST /api/optimize/{id}/finish-now`. Defaults to a completed feasible job. */
  onFinishNow?: (route: Route) => Promise<void> | void;
}

export function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export function sse(route: Route, frames: SseFrameInput[]): Promise<void> {
  return route.fulfill({
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
    body: sseBody(frames),
  });
}

export function xlsx(route: Route): Promise<void> {
  return route.fulfill({
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="schedule.xlsx"',
    },
    body: Buffer.from(XLSX_EMPTY_ZIP_BASE64, "base64"),
  });
}

/**
 * Install the deterministic `/api/**` boundary for one journey. Unhandled `/api`
 * calls are aborted so a missing stub fails loudly rather than hitting the dead
 * backend. Everything else (page assets) continues.
 */
export async function installOptimizeRoutes(
  page: Page,
  config: OptimizeRouteConfig = {},
): Promise<void> {
  const info =
    config.info ??
    (() => ({
      status: 200,
      body: { status: "ready", api_version: "alpha", app_version: "0.1.0" },
    }));

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/info") {
      const { status, body } = info();
      return json(route, status, body);
    }
    if (path === "/api/health") {
      return json(route, 200, { status: "ok", appVersion: "0.1.0" });
    }
    if (path === "/api/optimize" && method === "POST") {
      return config.onSubmit ? config.onSubmit(route) : json(route, 202, runningJob());
    }

    const idMatch = path.match(/^\/api\/optimize\/([^/]+)(\/[a-z-]+)?$/);
    if (idMatch) {
      const sub = idMatch[2];
      if (sub === "/events") {
        return config.onEvents
          ? config.onEvents(route)
          : sse(route, [
              runningFrame("c1"),
              progressedFrame("c2", 5, 0.5),
              progressedFrame("c3", 7, 1),
              resultAvailableFrame("c4", "optimal"),
              terminalFrame("c5", "completed"),
            ]);
      }
      if (sub === "/xlsx") {
        return config.onXlsx ? config.onXlsx(route) : xlsx(route);
      }
      if (sub === "/cancel") {
        return config.onCancel ? config.onCancel(route) : json(route, 200, cancelledJob());
      }
      if (sub === "/finish-now") {
        return config.onFinishNow
          ? config.onFinishNow(route)
          : json(route, 200, completedJob(JOB_ID, { outcome: "feasible" }));
      }
      if (sub === undefined && method === "DELETE") {
        return config.onDelete ? config.onDelete(route) : route.fulfill({ status: 204, body: "" });
      }
      if (sub === undefined && method === "GET") {
        return config.onPoll ? config.onPoll(route) : json(route, 200, completedJob());
      }
    }

    return route.abort();
  });
}

/** Navigate to the durable fixture and wait for the seeded, hydrated screen. */
export async function gotoDurableFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
  await page.goto(DURABLE_FIXTURE_URL);
}
