// Shared durable Optimize fixtures plus the small assembled-browser proof core.

import type { Page, Route } from "@playwright/test";
import type { JobResponse, JobState, OptimizationOutcome } from "@/lib/bff/types";
import {
  inspectPersistedSession,
  OPTIMIZE_SESSION_STORAGE_KEY,
} from "@/lib/optimize/session-transaction";

// ---------------------------------------------------------------------------
// Explicit assembled-lane budgets
// ---------------------------------------------------------------------------

export const OBSERVATION_EVALUATE_BOUND = 5_000;
export const PRODUCT_SOLVE_LIMIT = 300_000;

export const REPLAY_BOUNDS = {
  injectObservationScript: 5_000,
  injectFixtureYaml: 5_000,
  gotoFixtureNavigation: 20_000,
  fixtureRootVisible: 5_000,
  screenVisible: 5_000,
  anonymizeAttributeRead: 5_000,
  anonymizeToggleClick: 5_000,
  anonymizeCheckedAssertion: 5_000,
  submitEnabledAssertion: 5_000,
  submitClick: 5_000,
  acceptedJobIdPoll: 10_000,
  firstResponsePoll: 15_000,
  keepaliveWindow: 12_000,
  resumedScreenVisible: 10_000,
  resumedHeaderPoll: 15_000,
  judgePoll: 20_000,
  freezeAndSnapshotEvaluate: 30_000,
  reloadNavigation: 20_000,
  snapshotReadEvaluate: 5_000,
} as const;

export const TINY_BOUNDS = {
  submitClick: 5_000,
  acceptedIdPoll: 15_000,
  sseResponsePoll: 15_000,
  completionPoll: 90_000,
  // The PRODUCT's terminal auto-delete must be proved before the page-close fence, so
  // the `afterEach` lifecycle can never be the thing that produced the only 404.
  autoDeletePoll: 30_000,
  slotFreedAssertion: 30_000,
} as const;

export const ABORT_BOUNDS = {
  submitClick: 5_000,
  firstResponsePoll: 15_000,
  abortNavigation: 30_000,
  abortUrlSettle: 30_000,
  bffObservationTail: 2_000,
} as const;

export const TINY_TEST_TIMEOUT = 240_000;
export const REPLAY_TEST_TIMEOUT = 240_000;
export const ABORT_TEST_TIMEOUT = 180_000;
export const FIRST_BYTE_TIMEOUT = REPLAY_BOUNDS.firstResponsePoll;
export const KEEPALIVE_WINDOW = REPLAY_BOUNDS.keepaliveWindow;
export const RESUMED_SCREEN_TIMEOUT = REPLAY_BOUNDS.resumedScreenVisible;
export const RESUMED_HEADER_TIMEOUT = REPLAY_BOUNDS.resumedHeaderPoll;
export const JUDGE_POLL_TIMEOUT = REPLAY_BOUNDS.judgePoll;

// ---------------------------------------------------------------------------
// Page-fenced accepted-submit observation
// ---------------------------------------------------------------------------

export interface SubmitRequest {
  method(): string;
  url(): string;
}

export interface SubmitResponse {
  status(): number;
  request(): SubmitRequest;
  json(): Promise<unknown>;
}

export interface SubmitEvents {
  request: SubmitRequest;
  requestfailed: SubmitRequest;
  response: SubmitResponse;
}

export interface SubmitSource {
  on<K extends keyof SubmitEvents>(event: K, handler: (value: SubmitEvents[K]) => void): void;
  off<K extends keyof SubmitEvents>(event: K, handler: (value: SubmitEvents[K]) => void): void;
}

export type AcceptedSlot =
  | { kind: "id"; jobId: string }
  | { kind: "invalid"; detail: string }
  | { kind: "unreadable"; detail: string }
  | { kind: "unresolved" };

export interface SubmitObservation {
  matchingRequests: number;
  acceptedSlots: AcceptedSlot[];
  knownIds: string[];
  failures: string[];
  lostAuthority: boolean;
}

interface RequestRecord {
  request: SubmitRequest;
  settled: boolean;
  acceptedSlot: number | null;
}

export interface SubmitObserver {
  knownIds(): string[];
  result(): SubmitObservation | null;
  settleAfterPageClose(deadline: number, closeFailure?: string | null): Promise<SubmitObservation>;
}

export const SUBMIT_FENCE_MS = 5_000;

// Shared by the existing RunStatusPanel DOM contract test. The assembled gate no
// longer reads this selector or treats DOM state as accepted-job authority.
export const VOLATILE_JOB_ID_SELECTOR = '[data-testid="optimize-job-id"]';

export function judgeVolatileJobIdTexts(
  values: readonly (string | null | undefined)[],
): { ok: true; ids: string[] } | { ok: false; reason: string } {
  if (values.length === 0) return { ok: true, ids: [] };
  if (values.length !== 1 || typeof values[0] !== "string") {
    return { ok: false, reason: "the rendered job-id hook was ambiguous or unreadable" };
  }
  const id = values[0].trim();
  if (id.length === 0 || /\s/.test(id)) {
    return { ok: false, reason: "the rendered job-id hook did not contain one bare id" };
  }
  return { ok: true, ids: [id] };
}

/** Match only the exact authored Optimize submit request. */
export function isOptimizeSubmitRequest(request: SubmitRequest): boolean {
  if (request.method().toUpperCase() !== "POST") return false;
  try {
    const url = new URL(request.url(), "http://submit.invalid");
    return url.pathname === "/api/optimize" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

/**
 * Observe every matching POST from attachment until the caller closes the page.
 * Response arrival and accepted-body reads are independent of the click promise.
 */
export function observeOptimizeSubmit(
  source: SubmitSource,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): SubmitObserver {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const records: RequestRecord[] = [];
  const byRequest = new Map<SubmitRequest, RequestRecord>();
  const slots: Array<AcceptedSlot | undefined> = [];
  const reads = new Set<Promise<void>>();
  let sealed = false;
  let finalResult: SubmitObservation | null = null;

  const recordRequest = (request: SubmitRequest): RequestRecord | null => {
    if (!isOptimizeSubmitRequest(request)) return null;
    const existing = byRequest.get(request);
    if (existing) return existing;
    const record = { request, settled: false, acceptedSlot: null };
    records.push(record);
    byRequest.set(request, record);
    return record;
  };

  const onRequest = (request: SubmitRequest): void => {
    if (!sealed) recordRequest(request);
  };
  const onRequestFailed = (request: SubmitRequest): void => {
    if (sealed) return;
    const record = recordRequest(request);
    if (record) record.settled = true;
  };
  const onResponse = (response: SubmitResponse): void => {
    if (sealed) return;
    const record = recordRequest(response.request());
    if (!record) return;
    record.settled = true;
    if (response.status() !== 202) return;

    const index = slots.length;
    record.acceptedSlot = index;
    slots.push(undefined);
    const read = response
      .json()
      .then((body) => {
        const id = (body as { id?: unknown } | null)?.id;
        if (typeof id !== "string") {
          slots[index] = {
            kind: "invalid",
            detail: `accepted body id was ${id === undefined ? "absent" : typeof id}`,
          };
        } else if (id.length === 0) {
          slots[index] = { kind: "invalid", detail: "accepted body id was empty" };
        } else {
          slots[index] = { kind: "id", jobId: id };
        }
      })
      .catch((error: unknown) => {
        slots[index] = {
          kind: "unreadable",
          detail: error instanceof Error ? error.message : String(error),
        };
      })
      .finally(() => reads.delete(read));
    reads.add(read);
  };

  source.on("request", onRequest);
  source.on("requestfailed", onRequestFailed);
  source.on("response", onResponse);

  const buildResult = (): SubmitObservation => {
    const acceptedSlots = slots.map((slot) => slot ?? ({ kind: "unresolved" } as const));
    const knownIds: string[] = [];
    for (const slot of acceptedSlots) {
      if (slot.kind === "id" && !knownIds.includes(slot.jobId)) knownIds.push(slot.jobId);
    }
    const unresolvedRequests = records.filter((record) => !record.settled).length;
    const failures: string[] = [];
    if (records.length !== 1) {
      failures.push(`expected exactly one matching submit request, observed ${records.length}`);
    }
    if (acceptedSlots.length !== 1) {
      failures.push(`expected exactly one accepted 202, observed ${acceptedSlots.length}`);
    }
    if (unresolvedRequests > 0) {
      failures.push(
        `${unresolvedRequests} matching submit request(s) remained unresolved at the page-close fence`,
      );
    }
    for (const [index, slot] of acceptedSlots.entries()) {
      if (slot.kind === "invalid")
        failures.push(`accepted slot ${index + 1} was malformed: ${slot.detail}`);
      if (slot.kind === "unreadable")
        failures.push(`accepted slot ${index + 1} was unreadable: ${slot.detail}`);
      if (slot.kind === "unresolved")
        failures.push(`accepted slot ${index + 1} body remained unresolved`);
    }
    const lostAuthority =
      records.length > 2 ||
      acceptedSlots.length > 2 ||
      unresolvedRequests > 0 ||
      acceptedSlots.some((slot) => slot.kind !== "id");
    return {
      matchingRequests: records.length,
      acceptedSlots,
      knownIds,
      failures,
      lostAuthority,
    };
  };

  return {
    knownIds: () => {
      const ids: string[] = [];
      for (const slot of slots) {
        if (slot?.kind === "id" && !ids.includes(slot.jobId)) ids.push(slot.jobId);
      }
      return ids;
    },
    result: () => finalResult,
    settleAfterPageClose: async (
      deadline: number,
      closeFailure: string | null = null,
    ): Promise<SubmitObservation> => {
      if (finalResult) return finalResult;
      sealed = true;
      source.off("request", onRequest);
      source.off("requestfailed", onRequestFailed);
      source.off("response", onResponse);
      while (reads.size > 0 && now() < deadline) {
        await sleep(Math.min(10, Math.max(1, deadline - now())));
      }
      const settled = buildResult();
      finalResult =
        closeFailure === null
          ? settled
          : {
              ...settled,
              failures: [`page-close fence failed: ${closeFailure}`, ...settled.failures],
              lostAuthority: true,
            };
      return finalResult;
    },
  };
}

async function boundedFence(work: Promise<void>, ms: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`page close exceeded ${ms}ms`)), ms);
      }),
    ]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Close the page first, then settle every request/body observed before that fence. */
export async function finishSubmitObservation(
  observer: SubmitObserver,
  closePage: () => Promise<void>,
  options: { now?: () => number; fenceMs?: number } = {},
): Promise<SubmitObservation> {
  const existing = observer.result();
  if (existing) return existing;
  const now = options.now ?? (() => Date.now());
  const fenceMs = options.fenceMs ?? SUBMIT_FENCE_MS;
  const deadline = now() + fenceMs;
  const closeFailure = await boundedFence(closePage(), Math.max(1, deadline - now()));
  return observer.settleAfterPageClose(deadline, closeFailure);
}

/**
 * Run the click without letting a rejection cancel accepted-response observation.
 * On rejection the page is fenced and all readable ids are registered first, then
 * the original click error is rethrown unchanged.
 */
export async function runObservedSubmitAction(
  observer: SubmitObserver,
  action: () => Promise<void>,
  closePage: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (primaryError) {
    await finishSubmitObservation(observer, closePage);
    throw primaryError;
  }
}

// ---------------------------------------------------------------------------
// Known-id cleanup lifecycle
// ---------------------------------------------------------------------------

export const CLEANUP_BOUNDS = {
  closeAndSettle: 5_000,
  lifecycle: 65_000,
  report: 3_000,
  hook: 75_000,
  cancel: 8_000,
  terminal: 37_000,
  delete: 8_000,
  transitionReserve: 4_000,
  finalGet: 8_000,
  pollInterval: 500,
} as const;

export interface CleanupHttp {
  post(url: string, timeout: number): Promise<{ status: number; body: string }>;
  delete(url: string, timeout: number): Promise<{ status: number; body: string }>;
  get(url: string, timeout: number): Promise<{ status: number; body: string }>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface CleanupOutcome {
  ok: boolean;
  ids: string[];
  removedIds: string[];
  steps: string[];
  failures: string[];
}

export function isTerminalJobBody(body: string): boolean {
  return classifyJobBody(body) === "terminal";
}

function classifyJobBody(body: string): "terminal" | "nonterminal" | "invalid" {
  try {
    const parsed = JSON.parse(body) as { terminal?: unknown; state?: unknown };
    if (typeof parsed !== "object" || parsed === null) return "invalid";
    if (parsed.terminal === true) return "terminal";
    if (typeof parsed.state !== "string") return "invalid";
    if (["completed", "cancelled", "failed"].includes(parsed.state)) return "terminal";
    if (["queued", "running", "cancelling"].includes(parsed.state)) return "nonterminal";
    return "invalid";
  } catch {
    return "invalid";
  }
}

type HttpAttempt = { ok: true; status: number; body: string } | { ok: false; detail: string };

async function attemptHttp(
  label: string,
  call: () => Promise<{ status: number; body: string }>,
  steps: string[],
  failures: string[],
): Promise<HttpAttempt> {
  try {
    const response = await call();
    steps.push(`${label} -> ${response.status}`);
    return { ok: true, ...response };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    steps.push(`${label} -> transport error`);
    failures.push(`${label} transport failed: ${detail}`);
    return { ok: false, detail };
  }
}

function phaseTimeout(http: CleanupHttp, deadline: number, ceiling: number): number | null {
  const remaining = deadline - http.now();
  if (remaining <= 0) return null;
  return Math.max(1, Math.min(ceiling, remaining));
}

/** Cancel, prove terminality, safely delete, and always attempt the reserved final GET. */
export async function cleanupKnownJob(jobId: string, http: CleanupHttp): Promise<CleanupOutcome> {
  const ids = [jobId];
  const removedIds: string[] = [];
  const steps: string[] = [];
  const failures: string[] = [];
  const base = `/api/optimize/${encodeURIComponent(jobId)}`;
  const startedAt = http.now();
  const finalDeadline = startedAt + CLEANUP_BOUNDS.lifecycle;
  const mutationDeadline = finalDeadline - CLEANUP_BOUNDS.finalGet;
  let terminal = false;
  let absent = false;

  const cancelTimeout = phaseTimeout(http, mutationDeadline, CLEANUP_BOUNDS.cancel);
  if (cancelTimeout === null) {
    failures.push("cancel phase had no time before the reserved final GET");
  } else {
    const cancel = await attemptHttp(
      "cancel",
      () => http.post(`${base}/cancel`, cancelTimeout),
      steps,
      failures,
    );
    if (cancel.ok) {
      if (cancel.status === 404) absent = true;
      else if (cancel.status !== 202)
        failures.push(`cancel returned ${cancel.status}; expected 202 or 404`);
    }
  }

  if (!absent && failures.length === 0) {
    const terminalDeadline = Math.min(http.now() + CLEANUP_BOUNDS.terminal, mutationDeadline);
    while (http.now() < terminalDeadline) {
      const timeout = phaseTimeout(http, terminalDeadline, CLEANUP_BOUNDS.terminal);
      if (timeout === null) break;
      const status = await attemptHttp("status", () => http.get(base, timeout), steps, failures);
      if (!status.ok) break;
      if (status.status === 404) {
        absent = true;
        break;
      }
      if (status.status !== 200) {
        failures.push(`status returned ${status.status}; expected 200 or 404`);
        break;
      }
      const state = classifyJobBody(status.body);
      if (state === "invalid") {
        failures.push("status returned a malformed job body");
        break;
      }
      if (state === "nonterminal") {
        const sleepFor = Math.min(CLEANUP_BOUNDS.pollInterval, terminalDeadline - http.now());
        if (sleepFor > 0) await http.sleep(sleepFor);
        continue;
      }
      terminal = true;
      steps.push("terminal state proved");
      break;
    }
    if (!terminal && !absent && failures.length === 0) {
      failures.push(`job did not reach terminal within ${CLEANUP_BOUNDS.terminal}ms`);
    }
  }

  if (terminal) {
    const deleteTimeout = phaseTimeout(http, mutationDeadline, CLEANUP_BOUNDS.delete);
    if (deleteTimeout === null) {
      failures.push("delete phase had no time before the reserved final GET");
    } else {
      const deleted = await attemptHttp(
        "delete",
        () => http.delete(base, deleteTimeout),
        steps,
        failures,
      );
      if (deleted.ok && deleted.status !== 204 && deleted.status !== 404) {
        failures.push(`delete returned ${deleted.status}; expected 204 or 404`);
      }
    }
  }

  // This call is unconditional. Earlier failure may suppress unsafe DELETE, never absence proof.
  const finalTimeout = Math.max(1, Math.min(CLEANUP_BOUNDS.finalGet, finalDeadline - http.now()));
  const finalGet = await attemptHttp(
    "final GET",
    () => http.get(base, finalTimeout),
    steps,
    failures,
  );
  if (finalGet.ok && finalGet.status === 404) {
    removedIds.push(jobId);
    steps.push(`cleanup success ${jobId}: final GET 404`);
  } else if (finalGet.ok) {
    failures.push(`final GET returned ${finalGet.status}; expected exact 404`);
  }

  return { ok: failures.length === 0, ids, removedIds, steps, failures };
}

/** Clean one or two distinct ids concurrently; all branches settle even when one fails. */
export async function cleanupKnownJobs(
  jobIds: readonly string[],
  http: CleanupHttp,
): Promise<CleanupOutcome> {
  const ids = [...new Set(jobIds)];
  if (ids.length > 2) {
    return {
      ok: false,
      ids,
      removedIds: [],
      steps: [],
      failures: [`normal cleanup accepts at most two distinct known ids, got ${ids.length}`],
    };
  }
  const settled = await Promise.allSettled(ids.map((id) => cleanupKnownJob(id, http)));
  const removedIds: string[] = [];
  const steps: string[] = [];
  const failures: string[] = [];
  for (const [index, result] of settled.entries()) {
    const id = ids[index];
    if (result.status === "rejected") {
      failures.push(`job ${id} cleanup rejected: ${String(result.reason)}`);
      continue;
    }
    steps.push(...result.value.steps.map((step) => `job ${id}: ${step}`));
    failures.push(...result.value.failures.map((failure) => `job ${id}: ${failure}`));
    removedIds.push(...result.value.removedIds);
  }
  return { ok: failures.length === 0, ids, removedIds, steps, failures };
}

// ---------------------------------------------------------------------------
// Compact effective-request and replay judgment
// ---------------------------------------------------------------------------

export const CURSOR_VERSION = "v1";
const CURSOR_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface DecodedCursor {
  jobId: string;
  nativeEventId: string;
}

function decodeCursorSegment(segment: string): string | null {
  if (!CURSOR_SEGMENT_PATTERN.test(segment)) return null;
  const decoded = Buffer.from(segment, "base64url").toString("utf8");
  return Buffer.from(decoded, "utf8").toString("base64url") === segment ? decoded : null;
}

export function decodePublicCursor(token: string): DecodedCursor | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== CURSOR_VERSION) return null;
  const jobId = decodeCursorSegment(parts[1]);
  const nativeEventId = decodeCursorSegment(parts[2]);
  return jobId === null || nativeEventId === null ? null : { jobId, nativeEventId };
}

export interface ResumedRequest {
  url: string;
  lastEventId: string | null;
}

export interface ReplayEvidence {
  acceptedJobId: string | null;
  expectedOrigin: string | null;
  cursorBefore: string | null;
  preReloadIds: readonly string[];
  preReloadRequests: readonly ResumedRequest[];
  firstResumedRequest: ResumedRequest | null;
  postReloadRequests: readonly ResumedRequest[];
  replayIds: readonly string[];
  cursorAfter: string | null;
}

export interface ReplayJudgement {
  ok: boolean;
  failures: string[];
}

function judgeRequestSet(
  label: string,
  requests: readonly ResumedRequest[],
  acceptedJobId: string,
  expectedOrigin: string,
): string[] {
  const failures: string[] = [];
  if (requests.length === 0) return [`no ${label} events request was observed`];
  let origin: string;
  try {
    origin = new URL(expectedOrigin).origin;
  } catch {
    return [`captured page origin was invalid: ${expectedOrigin}`];
  }
  if (origin !== expectedOrigin)
    failures.push(`captured page origin was not canonical: ${expectedOrigin}`);
  const expectedPath = `/api/optimize/${encodeURIComponent(acceptedJobId)}/events`;
  for (const [index, request] of requests.entries()) {
    let url: URL;
    try {
      url = new URL(request.url, origin);
    } catch {
      failures.push(`${label} request ${index + 1} URL was unparseable: ${request.url}`);
      continue;
    }
    if (url.origin !== origin)
      failures.push(`${label} request ${index + 1} origin ${url.origin} was not ${origin}`);
    if (url.pathname !== expectedPath)
      failures.push(`${label} request ${index + 1} path ${url.pathname} was not ${expectedPath}`);
    if (url.search !== "")
      failures.push(`${label} request ${index + 1} carried query ${url.search}`);
    if (url.hash !== "")
      failures.push(`${label} request ${index + 1} carried fragment ${url.hash}`);
  }
  return failures;
}

export function judgeReplayEvidence(evidence: ReplayEvidence): ReplayJudgement {
  const failures: string[] = [];
  const {
    acceptedJobId,
    expectedOrigin,
    cursorBefore,
    preReloadIds,
    preReloadRequests,
    firstResumedRequest,
    postReloadRequests,
    replayIds,
    cursorAfter,
  } = evidence;
  if (!acceptedJobId)
    return { ok: false, failures: ["no accepted POST job authority was captured"] };
  if (!expectedOrigin) return { ok: false, failures: ["no page origin was captured"] };

  failures.push(...judgeRequestSet("pre-reload", preReloadRequests, acceptedJobId, expectedOrigin));
  failures.push(
    ...judgeRequestSet("post-reload", postReloadRequests, acceptedJobId, expectedOrigin),
  );

  if (!cursorBefore) failures.push("no pre-reload cursor was captured");
  else {
    const decoded = decodePublicCursor(cursorBefore);
    if (!decoded) failures.push(`pre-reload cursor was malformed: ${cursorBefore}`);
    else if (decoded.jobId !== acceptedJobId)
      failures.push(`pre-reload cursor targeted ${decoded.jobId}, not ${acceptedJobId}`);
  }
  if (preReloadIds.length === 0) failures.push("no pre-reload frame ids were recorded");
  if (cursorBefore && !preReloadIds.includes(cursorBefore))
    failures.push("pre-reload cursor was absent from pre-reload ids");

  if (!firstResumedRequest) failures.push("no first resumed request was captured");
  else {
    if (firstResumedRequest.lastEventId !== cursorBefore) {
      failures.push("first resumed Last-Event-ID did not equal the pre-reload cursor");
    }
    const firstRecorded = postReloadRequests[0];
    if (
      !firstRecorded ||
      firstRecorded.url !== firstResumedRequest.url ||
      firstRecorded.lastEventId !== firstResumedRequest.lastEventId
    ) {
      failures.push("first resumed request was not the same-index first post-reload request");
    }
  }

  if (replayIds.length === 0) failures.push("no post-reload frame ids were recorded");
  const duplicates = replayIds.filter((id, index) => replayIds.indexOf(id) !== index);
  if (duplicates.length > 0)
    failures.push(`post-reload frame ids were duplicated: ${[...new Set(duplicates)].join(", ")}`);
  const stale = replayIds.filter((id) => preReloadIds.includes(id));
  if (stale.length > 0) failures.push(`replay re-sent pre-reload id(s): ${stale.join(", ")}`);
  for (const id of replayIds) {
    const decoded = decodePublicCursor(id);
    if (!decoded) failures.push(`replay id was malformed: ${id}`);
    else if (decoded.jobId !== acceptedJobId)
      failures.push(`replay id targeted ${decoded.jobId}, not ${acceptedJobId}: ${id}`);
  }

  if (!cursorAfter) failures.push("no post-reload cursor was persisted");
  else {
    const decoded = decodePublicCursor(cursorAfter);
    if (!decoded) failures.push(`post-reload cursor was malformed: ${cursorAfter}`);
    else if (decoded.jobId !== acceptedJobId)
      failures.push(`post-reload cursor targeted ${decoded.jobId}, not ${acceptedJobId}`);
    if (!replayIds.includes(cursorAfter))
      failures.push("post-reload cursor was absent from replay ids");
  }
  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Persisted-session facts, read through the product's own inspector
// ---------------------------------------------------------------------------

export interface ActiveSessionFacts {
  jobId: string | null;
  cursor: string | null;
}

/**
 * Interpret raw persisted-session bytes through the PRODUCT authority
 * (`inspectPersistedSession`) rather than a second schema parser. The browser task
 * captures bytes only; every judgement about phase, job id and cursor is made here
 * against the real versioned, closed contract, so replay evidence cannot drift from
 * a permissive local subset.
 *
 * Only a `resumable` (active) record yields facts. Absent, interrupted (provisional),
 * unreadable and version-mismatched records all read as null/null. An otherwise-valid
 * active record whose ONLY defect is an oversized cursor comes back from the product
 * inspector with that cursor stripped, so this reports its job id with a null cursor
 * rather than resuming from a cursor the product itself refuses.
 *
 * The adapter is deliberately read-only and key-checked: it answers only for the exact
 * product storage key the browser read, and any write attempt is a hard error rather
 * than a silent no-op, so a future inspector that mutated storage could not slip past.
 */
export function activeSessionFacts(raw: string | null): ActiveSessionFacts {
  const inspected = inspectPersistedSession({
    getItem: (key: string) => (key === OPTIMIZE_SESSION_STORAGE_KEY ? raw : null),
    setItem: () => {
      throw new Error("read-only session adapter: setItem must not be called");
    },
    removeItem: () => {
      throw new Error("read-only session adapter: removeItem must not be called");
    },
  });
  if (inspected.kind !== "resumable") return { jobId: null, cursor: null };
  return { jobId: inspected.record.jobId, cursor: inspected.record.lastCursor ?? null };
}

// ---------------------------------------------------------------------------
// Durable fixture data and route helpers (shared by deterministic R6 suites)
// ---------------------------------------------------------------------------

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

export interface SseFrameInput {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

export function sseBody(frames: SseFrameInput[]): string {
  return (
    frames
      .map(
        (frame) =>
          `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`,
      )
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

const XLSX_EMPTY_ZIP_BASE64 =
  "UEsDBBQAAAAAAAAAIQAAAAAAAAAAAAAAAAAJAAAAdGVzdC50eHRQSwECFAAUAAAAAAAAACEAAAAAAAAAAAAAAAAACQAAAAAAAAAAAAAAAAAAAAAAdGVzdC50eHRQSwUGAAAAAAEAAQA3AAAAJwAAAAAA";

export interface OptimizeRouteConfig {
  info?: () => { status: number; body: unknown };
  onSubmit?: (route: Route) => Promise<void> | void;
  onPoll?: (route: Route) => Promise<void> | void;
  onEvents?: (route: Route) => Promise<void> | void;
  onXlsx?: (route: Route) => Promise<void> | void;
  onDelete?: (route: Route) => Promise<void> | void;
  onCancel?: (route: Route) => Promise<void> | void;
  onFinishNow?: (route: Route) => Promise<void> | void;
}

export function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
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
    const path = new URL(request.url()).pathname;

    if (path === "/api/info") {
      const { status, body } = info();
      return json(route, status, body);
    }
    if (path === "/api/health") return json(route, 200, { status: "ok", appVersion: "0.1.0" });
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
      if (sub === "/xlsx") return config.onXlsx ? config.onXlsx(route) : xlsx(route);
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

export async function gotoDurableFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __NS_ENABLE_TEST_BRIDGE?: boolean }).__NS_ENABLE_TEST_BRIDGE = true;
  });
  await page.goto(DURABLE_FIXTURE_URL);
}
