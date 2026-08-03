// R6 — the assembled replay oracle's truth table, proved without the Compose stack.
//
// The combined cold review at `d981b4d` mutation-tested the assembled gate's
// replay predicate and found three false greens. Because the judge is now pure,
// those mutations become PERMANENT committed coverage rather than a one-off
// experiment: `HISTORICAL_PREDICATE` below is the exact predicate that shipped,
// and each adversarial case asserts that it accepted the input while
// `judgeReplayEvidence` rejects it. If someone ever weakens the judge back
// toward the old shape, these tests go red and name which rule was lost.

import { describe, expect, it } from "vitest";
import {
  CLEANUP_ACCEPTED_STATUS,
  CLEANUP_BOUNDS,
  CURSOR_VERSION,
  decodePublicCursor,
  isTerminalJobBody,
  judgeEventsAuthority,
  judgeReplayEvidence,
  parseEventsRequestUrl,
  PLAYWRIGHT_DEFAULT_TEST_TIMEOUT,
  PRODUCT_SOLVE_LIMIT,
  GOTO_FIXTURE_BOUND_KEYS,
  GOTO_FIXTURE_BOUNDS_TOTAL,
  OBSERVATION_EVALUATE_BOUND,
  releaseLiveJob,
  REPLAY_BOUND_KEYS,
  REPLAY_BOUNDS,
  REPLAY_PHASE_BOUNDS,
  REPLAY_TEST_TIMEOUT,
  TINY_BOUND_KEYS,
  TINY_BOUNDS,
  TINY_TEST_TIMEOUT,
  type CleanupHttp,
  type ReplayEvidence,
} from "./optimize-durable";

// Two historical oracles are kept below as adversarial baselines, each asserted to
// have ACCEPTED the exact evidence the current judge rejects. They are test-only
// (never exported from shared support, never reachable from the gate), and they are
// what stops the judge being quietly weakened back to either earlier shape.

// An INDEPENDENT encoder, deliberately not imported from the module under test:
// the judge decodes, this constructs, so a shared bug cannot cancel out.
function seg(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}
function cursor(jobId: string, nativeId: string): string {
  return `${CURSOR_VERSION}.${seg(jobId)}.${seg(nativeId)}`;
}

const JOB = "job_640a73beed6b4c619e0123ee2280da23";
const OTHER_JOB = "job_ffffffffffffffffffffffffffffffff";

// Redis-shaped native ids, exactly as the production backend mints them.
const N1 = "1785742420590-0";
const N2 = "1785742421174-0";
const N3 = "1785742422344-0";
const N_OLD = "1785742419000-0";

const PRE_RELOAD = [cursor(JOB, N_OLD)];

/**
 * Normalize a diagnostic array so exact comparison is readable: substitute the
 * long opaque job ids and cursor envelopes for stable symbols. Order and count are
 * preserved exactly — that is the whole point of comparing arrays instead of
 * matching substrings.
 */
function normalize(failures: readonly string[]): string[] {
  const substitutions: Array<[string, string]> = [
    [cursor(JOB, N_OLD), "<cursor JOB/N_OLD>"],
    [cursor(JOB, N1), "<cursor JOB/N1>"],
    [cursor(JOB, N2), "<cursor JOB/N2>"],
    [cursor(JOB, N3), "<cursor JOB/N3>"],
    [cursor(OTHER_JOB, N_OLD), "<cursor OTHER/N_OLD>"],
    [cursor(OTHER_JOB, N1), "<cursor OTHER/N1>"],
    [cursor(OTHER_JOB, N2), "<cursor OTHER/N2>"],
    [OTHER_JOB, "OTHER"],
    [JOB, "JOB"],
  ];
  return failures.map((failure) => {
    let out = failure;
    for (const [from, to] of substitutions) out = out.split(from).join(to);
    return out;
  });
}

function evidence(over: Partial<ReplayEvidence> = {}): ReplayEvidence {
  return {
    expectedJobId: JOB,
    rawIds: [cursor(JOB, N1), cursor(JOB, N2)],
    cursorAfter: cursor(JOB, N2),
    cursorBefore: cursor(JOB, N_OLD),
    preReloadIds: PRE_RELOAD,
    ...over,
  };
}

/**
 * The predicate as it shipped at `d981b4d`, verbatim in behaviour: non-empty,
 * no pre-reload id, cursor new and present. Retained ONLY as the adversarial
 * baseline for the false greens it accepted.
 */
function HISTORICAL_PREDICATE(e: ReplayEvidence): boolean {
  const preReloadSet = new Set(e.preReloadIds);
  return (
    e.rawIds.length > 0 &&
    e.rawIds.every((id) => !preReloadSet.has(id)) &&
    e.cursorAfter !== null &&
    !preReloadSet.has(e.cursorAfter) &&
    e.rawIds.includes(e.cursorAfter)
  );
}

/**
 * The judge as it shipped at `e7d5926`: everything the current judge does, EXCEPT
 * that the expected job was decoded out of `cursorBefore` instead of supplied
 * independently. Retained as the adversarial baseline for the self-consistent
 * foreign envelope, which it accepted because the foreign cursor named its own
 * expected job.
 */
function CURSOR_DERIVED_JUDGE(e: ReplayEvidence): boolean {
  if (e.cursorBefore === null) return false;
  const before = decodePublicCursor(e.cursorBefore);
  if (before === null) return false;
  const expectedJob = before.jobId; // <- the circularity
  const preReloadSet = new Set(e.preReloadIds);
  if (e.rawIds.length === 0) return false;
  if (e.rawIds.some((id) => preReloadSet.has(id))) return false;
  if (new Set(e.rawIds).size !== e.rawIds.length) return false;
  for (const id of e.rawIds) {
    const decoded = decodePublicCursor(id);
    if (decoded === null || decoded.jobId !== expectedJob) return false;
  }
  if (e.cursorAfter === null || preReloadSet.has(e.cursorAfter)) return false;
  const after = decodePublicCursor(e.cursorAfter);
  if (after === null || after.jobId !== expectedJob) return false;
  return e.rawIds.includes(e.cursorAfter);
}

// P2-3. The cleanup lifecycle, with an injected HTTP surface so every documented
// status path is provable without the Compose stack.
describe("releaseLiveJob converges on terminal before deleting", () => {
  interface Call {
    kind: "post" | "get" | "delete";
    url: string;
  }

  function http(
    script: {
      cancel?: { status: number; body?: string };
      states?: Array<{ status: number; body?: string }>;
      delete?: { status: number; body?: string };
    },
    calls: Call[] = [],
  ): { http: CleanupHttp; calls: Call[] } {
    let clock = 0;
    let stateIndex = 0;
    const states = script.states ?? [];
    return {
      calls,
      http: {
        post: async (url) => {
          calls.push({ kind: "post", url });
          return { status: script.cancel?.status ?? 202, body: script.cancel?.body ?? "{}" };
        },
        get: async (url) => {
          calls.push({ kind: "get", url });
          const next = states[Math.min(stateIndex, states.length - 1)] ?? { status: 200 };
          stateIndex += 1;
          return { status: next.status, body: next.body ?? "{}" };
        },
        delete: async (url) => {
          calls.push({ kind: "delete", url });
          return { status: script.delete?.status ?? 204, body: script.delete?.body ?? "" };
        },
        sleep: async () => {},
        now: () => {
          clock += CLEANUP_BOUNDS.terminalPollInterval;
          return clock;
        },
      },
    };
  }

  const RUNNING = JSON.stringify({ state: "running", terminal: false });
  const CANCELLING = JSON.stringify({ state: "cancelling", terminal: false });
  const CANCELLED = JSON.stringify({ state: "cancelled", terminal: true });

  it("cancels, waits out `cancelling`, then deletes — in that order", async () => {
    const { http: surface, calls } = http({
      states: [
        { status: 200, body: RUNNING },
        { status: 200, body: CANCELLING },
        { status: 200, body: CANCELLED },
      ],
    });
    const outcome = await releaseLiveJob(JOB, surface);
    expect(outcome.failures).toEqual([]);
    expect(outcome.ok).toBe(true);
    // The ordering IS the fix: DELETE must be last, after terminal is observed.
    expect(calls.map((c) => c.kind)).toEqual(["post", "get", "get", "get", "delete"]);
    expect(calls[0].url).toBe(`/api/optimize/${JOB}/cancel`);
    expect(calls.at(-1)!.url).toBe(`/api/optimize/${JOB}`);
  });

  // The exact defect: the old hook DELETEd immediately, which on a RUNNING job is
  // the documented 409 (`delete_job` requires terminal), and it ignored the status.
  it("reproduces the old immediate-delete 409 and reports it as a failure", async () => {
    const { http: surface } = http({
      states: [{ status: 200, body: CANCELLING }],
      delete: { status: 409 },
    });
    const outcome = await releaseLiveJob(JOB, surface);
    expect(outcome.ok).toBe(false);
    // It never reaches DELETE here, because terminal never arrives — which is
    // precisely why the old immediate DELETE could 409.
    expect(outcome.failures.join(" | ")).toMatch(/did not reach a terminal state/);
  });

  it("treats an undocumented delete status as a cleanup failure", async () => {
    const { http: surface } = http({
      states: [{ status: 200, body: CANCELLED }],
      delete: { status: 409 },
    });
    const outcome = await releaseLiveJob(JOB, surface);
    expect(outcome.ok).toBe(false);
    expect(outcome.failures.join(" | ")).toMatch(/delete returned 409/);
  });

  it("accepts the documented idempotent 404 on cancel and skips deleting", async () => {
    const { http: surface, calls } = http({ cancel: { status: 404 } });
    const outcome = await releaseLiveJob(JOB, surface);
    expect(outcome.ok).toBe(true);
    expect(calls.map((c) => c.kind)).toEqual(["post"]);
  });

  it("accepts the documented idempotent 404 on delete", async () => {
    const { http: surface } = http({
      states: [{ status: 200, body: CANCELLED }],
      delete: { status: 404 },
    });
    expect((await releaseLiveJob(JOB, surface)).ok).toBe(true);
  });

  it("rejects an undocumented cancel status instead of continuing", async () => {
    const { http: surface, calls } = http({ cancel: { status: 500 } });
    const outcome = await releaseLiveJob(JOB, surface);
    expect(outcome.ok).toBe(false);
    expect(outcome.failures.join(" | ")).toMatch(/cancel returned 500/);
    expect(calls.map((c) => c.kind)).toEqual(["post"]);
  });

  it("treats a job that vanishes mid-poll as already released", async () => {
    const { http: surface } = http({ states: [{ status: 404 }] });
    expect((await releaseLiveJob(JOB, surface)).ok).toBe(true);
  });

  it("rejects an unexpected status-poll response", async () => {
    const { http: surface } = http({ states: [{ status: 503 }] });
    const outcome = await releaseLiveJob(JOB, surface);
    expect(outcome.ok).toBe(false);
    expect(outcome.failures.join(" | ")).toMatch(/status poll returned 503/);
  });

  it("pins the documented accepted statuses", () => {
    expect(CLEANUP_ACCEPTED_STATUS.cancel).toEqual([202, 404]);
    expect(CLEANUP_ACCEPTED_STATUS.delete).toEqual([204, 404]);
  });

  it("recognises terminal state from either the flag or the state name", () => {
    expect(isTerminalJobBody(JSON.stringify({ terminal: true }))).toBe(true);
    expect(isTerminalJobBody(JSON.stringify({ state: "completed" }))).toBe(true);
    expect(isTerminalJobBody(JSON.stringify({ state: "failed" }))).toBe(true);
    expect(isTerminalJobBody(CANCELLING)).toBe(false);
    expect(isTerminalJobBody(RUNNING)).toBe(false);
    expect(isTerminalJobBody("not json")).toBe(false);
  });
});

// P2-2's derivation, asserted rather than asserted-in-a-comment. The point is not
// that 120s is a nice number — it is that the sum of the test's OWN phase bounds
// already exceeds the default budget, so the default could never have covered a run
// in which every phase behaved legitimately-slowly.
describe("the live replay test's total budget enumerates EVERY sequential bound", () => {
  // The previous cap summed only the five stream phases and then added an unproved
  // margin, so it was incomplete by construction: `page.goto` alone permits 30s and
  // the reload navigation another 30s. Every one of those is now an explicit named
  // entry, and the total is computed by summing the object — so this key-set
  // assertion is what makes an omission fail loudly rather than silently shrink the
  // ceiling.
  const EXPECTED_KEYS = [
    "gotoFixtureNavigation",
    "fixtureRootVisible",
    "screenVisible",
    "anonymizeAttributeRead",
    "anonymizeToggleClick",
    "anonymizeCheckedAssertion",
    "submitEnabledAssertion",
    "submitClick",
    "acceptedJobIdPoll",
    "firstResponsePoll",
    "keepaliveWindow",
    "resumedScreenVisible",
    "resumedHeaderPoll",
    "judgePoll",
    "freezeAndSnapshotEvaluate",
    "reloadNavigation",
    "snapshotReadEvaluate",
    "observationEvaluates",
    "schedulerAllowance",
  ];

  it("enumerates exactly the expected bounds, in order", () => {
    expect([...REPLAY_BOUND_KEYS]).toEqual(EXPECTED_KEYS);
  });

  it("totals the sum of every enumerated bound and nothing else", () => {
    const manual = EXPECTED_KEYS.reduce(
      (total, key) => total + REPLAY_BOUNDS[key as keyof typeof REPLAY_BOUNDS],
      0,
    );
    expect(REPLAY_TEST_TIMEOUT).toBe(manual);
    // 50s fixture setup (20+5+5+5+5+5+5) + 15s submit/arm (5+10)
    // + 72s stream phases (15+12+10+15+20) + 75s evaluate/navigation (30+20+5+20)
    // + 8s scheduler allowance = 220s.
    expect(REPLAY_TEST_TIMEOUT).toBe(220_000);
  });

  it("every bound is a positive finite number", () => {
    for (const key of REPLAY_BOUND_KEYS) {
      const value = REPLAY_BOUNDS[key];
      expect(Number.isFinite(value), key).toBe(true);
      expect(value, key).toBeGreaterThan(0);
    }
  });

  it("covers the constructed legitimate schedule the review derived", () => {
    // The review's worst-case enumeration was 152.2s (80.2s of omitted
    // default-bounded work + 72s of named phases). The complete cap must exceed it.
    expect(REPLAY_TEST_TIMEOUT).toBeGreaterThan(152_200);
  });

  it("proves the default per-test budget was insufficient BY CONSTRUCTION", () => {
    // Not "was unlucky": even the phase subtotal alone exceeds the default.
    expect(PLAYWRIGHT_DEFAULT_TEST_TIMEOUT).toBeLessThan(REPLAY_PHASE_BOUNDS);
    expect(REPLAY_PHASE_BOUNDS).toBe(72_000);
  });

  it("stays meaningfully inside the product's own solve limit", () => {
    // A cap that reached the solve limit would stop being a cap: a genuinely
    // wedged run must still fail rather than hang the gate.
    expect(REPLAY_TEST_TIMEOUT).toBeLessThan(PRODUCT_SOLVE_LIMIT);
    expect(PRODUCT_SOLVE_LIMIT - REPLAY_TEST_TIMEOUT).toBeGreaterThanOrEqual(60_000);
  });

  it("keeps the scheduler allowance small relative to the enumerated work", () => {
    // It is an allowance for jitter between steps, not a second margin.
    expect(REPLAY_BOUNDS.schedulerAllowance).toBeLessThan(REPLAY_TEST_TIMEOUT / 10);
  });

  it("accounts for EVERY standalone observation evaluate, not just one", () => {
    // The replay test makes four observation reads outside any poll: `readSseObs`
    // for the accepted-id check and again after the keepalive window, and
    // `readReplayObservation` for the first resumed request and the final snapshot.
    // A single-call entry (the earlier `finalObservationEvaluate`) under-counted by
    // three — the same omission class this suite exists to catch, found while
    // applying the method to the tiny test.
    expect(REPLAY_BOUNDS.observationEvaluates).toBe(4 * OBSERVATION_EVALUATE_BOUND);
  });
});

// The sibling defect, closed by the same method. The tiny test's own 90s completion
// poll could never reach its bound under Playwright's 30s default.
describe("the tiny assembled test's total budget enumerates EVERY sequential bound", () => {
  const EXPECTED_KEYS = [
    "injectInitScripts",
    "fixtureSetup",
    "submitClick",
    "firstResponsePoll",
    "observationEvaluates",
    "completionPoll",
    "slotFreedAssertion",
    "schedulerAllowance",
  ];

  it("enumerates exactly the expected bounds, in order", () => {
    expect([...TINY_BOUND_KEYS]).toEqual(EXPECTED_KEYS);
  });

  it("totals the sum of every enumerated bound and nothing else", () => {
    const manual = EXPECTED_KEYS.reduce(
      (total, key) => total + TINY_BOUNDS[key as keyof typeof TINY_BOUNDS],
      0,
    );
    expect(TINY_TEST_TIMEOUT).toBe(manual);
    // 5 inject + 50 fixture + 5 submit + 15 first response + 5 observation
    // + 90 completion + 30 slot freed + 8 scheduler = 208s.
    expect(TINY_TEST_TIMEOUT).toBe(208_000);
  });

  it("every bound is a positive finite number", () => {
    for (const key of TINY_BOUND_KEYS) {
      const value = TINY_BOUNDS[key];
      expect(Number.isFinite(value), key).toBe(true);
      expect(value, key).toBeGreaterThan(0);
    }
  });

  it("proves the default per-test budget was insufficient BY CONSTRUCTION", () => {
    // The completion poll ALONE exceeds the default, so the assertion could never
    // have reached its own bound regardless of host speed. That is the defect.
    expect(TINY_BOUNDS.completionPoll).toBeGreaterThan(PLAYWRIGHT_DEFAULT_TEST_TIMEOUT);
    // And so does the shared fixture setup, independently.
    expect(TINY_BOUNDS.fixtureSetup).toBeGreaterThan(PLAYWRIGHT_DEFAULT_TEST_TIMEOUT);
  });

  it("preserves the completion poll rather than shrinking it to fit a cap", () => {
    expect(TINY_BOUNDS.completionPoll).toBe(90_000);
  });

  it("reuses the shared gotoFixture total instead of restating its literals", () => {
    // One source of truth: changing a `gotoFixture` bound must follow into both
    // budgets, so they cannot drift apart from each other or from the helper.
    expect(TINY_BOUNDS.fixtureSetup).toBe(GOTO_FIXTURE_BOUNDS_TOTAL);
    expect(GOTO_FIXTURE_BOUNDS_TOTAL).toBe(
      GOTO_FIXTURE_BOUND_KEYS.reduce((total, key) => total + REPLAY_BOUNDS[key], 0),
    );
    expect(GOTO_FIXTURE_BOUNDS_TOTAL).toBe(50_000);
  });

  it("stays meaningfully inside the product's own solve limit", () => {
    expect(TINY_TEST_TIMEOUT).toBeLessThan(PRODUCT_SOLVE_LIMIT);
    expect(PRODUCT_SOLVE_LIMIT - TINY_TEST_TIMEOUT).toBeGreaterThanOrEqual(60_000);
  });

  it("keeps the scheduler allowance small relative to the enumerated work", () => {
    expect(TINY_BOUNDS.schedulerAllowance).toBeLessThan(TINY_TEST_TIMEOUT / 10);
  });

  it("admits a legitimate phase that runs well past the old 30s default", () => {
    // The point of the cap: a completion that legitimately takes, say, 45s must be
    // able to finish. Under the old default the TEST died at 30s while the poll
    // still had 60s of its own bound left.
    const legitimateSlowCompletion = 45_000;
    expect(legitimateSlowCompletion).toBeGreaterThan(PLAYWRIGHT_DEFAULT_TEST_TIMEOUT);
    expect(legitimateSlowCompletion).toBeLessThan(TINY_BOUNDS.completionPoll);
    // Even with every earlier phase at its own ceiling, the slow completion fits.
    const earlierPhases =
      TINY_BOUNDS.injectInitScripts +
      TINY_BOUNDS.fixtureSetup +
      TINY_BOUNDS.submitClick +
      TINY_BOUNDS.firstResponsePoll +
      TINY_BOUNDS.observationEvaluates;
    expect(earlierPhases + legitimateSlowCompletion + TINY_BOUNDS.slotFreedAssertion).toBeLessThan(
      TINY_TEST_TIMEOUT,
    );
  });

  it("still fails a never-completing job, at the phase bound and inside the total", () => {
    // A job that never completes exhausts the completion poll and fails THERE,
    // rather than silently consuming the whole budget: the sum of every bound up to
    // and including the completion poll is strictly less than the total.
    const throughCompletion =
      TINY_BOUNDS.injectInitScripts +
      TINY_BOUNDS.fixtureSetup +
      TINY_BOUNDS.submitClick +
      TINY_BOUNDS.firstResponsePoll +
      TINY_BOUNDS.observationEvaluates +
      TINY_BOUNDS.completionPoll;
    expect(throughCompletion).toBeLessThan(TINY_TEST_TIMEOUT);
    // And the total is finite, so a wedged run cannot hang the gate.
    expect(Number.isFinite(TINY_TEST_TIMEOUT)).toBe(true);
  });

  it("is independent of the replay budget — neither cap governs the other", () => {
    expect(TINY_TEST_TIMEOUT).not.toBe(REPLAY_TEST_TIMEOUT);
    for (const cap of [TINY_TEST_TIMEOUT, REPLAY_TEST_TIMEOUT]) {
      expect(cap).toBeLessThan(PRODUCT_SOLVE_LIMIT);
    }
  });
});

// P2-1. The old extraction was unanchored and its caller silently DISCARDED
// whatever failed to match, so a legacy path, a suffixed path and extra segments
// all passed as "one job". Every case below is bound to the exact client contract
// `/api/optimize/${encodeURIComponent(jobId)}/events` (lib/query/optimize.ts:345).
describe("parseEventsRequestUrl enforces the exact canonical events path", () => {
  it("accepts the canonical relative path the client actually builds", () => {
    expect(parseEventsRequestUrl(`/api/optimize/${JOB}/events`)).toEqual({
      ok: true,
      jobId: JOB,
    });
  });

  it("accepts the same path as an absolute URL, which is what a Request exposes", () => {
    expect(parseEventsRequestUrl(`http://localhost:51236/api/optimize/${JOB}/events`)).toEqual({
      ok: true,
      jobId: JOB,
    });
  });

  it("decodes a percent-encoded job segment", () => {
    const weird = "job with spaces/and-slash";
    const encoded = encodeURIComponent(weird);
    expect(parseEventsRequestUrl(`/api/optimize/${encoded}/events`)).toEqual({
      ok: true,
      jobId: weird,
    });
  });

  const REJECTED: Array<[string, string, RegExp]> = [
    ["a legacy events path", "/api/legacy/events", /does not match/],
    ["a suffix after /events", `/api/optimize/${JOB}/events/old`, /does not match/],
    ["an extra segment before /events", `/api/optimize/${JOB}/extra/events`, /does not match/],
    ["a missing /api prefix", `/optimize/${JOB}/events`, /does not match/],
    ["an events-shaped path on another resource", "/api/jobs/x/events", /does not match/],
    ["an empty job segment", "/api/optimize//events", /does not match/],
    ["a query string", `/api/optimize/${JOB}/events?after=1`, /query string is not part/],
    ["a hash", `/api/optimize/${JOB}/events#frag`, /hash is not part/],
    ["a bare word", "events", /unparseable URL/],
    ["an empty string", "", /empty URL/],
    [
      "a non-canonical encoding of a plain id",
      "/api/optimize/job%2Dplain/events",
      /not a canonical encodeURIComponent spelling/,
    ],
  ];

  it.each(REJECTED)("rejects %s", (_label, url, reason) => {
    const parsed = parseEventsRequestUrl(url);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(reason);
  });

  // A malformed percent-escape would throw inside `decodeURIComponent`; the parser
  // must convert that into a reason rather than propagate it.
  it("rejects an invalid percent-escape without throwing", () => {
    const parsed = parseEventsRequestUrl("/api/optimize/%E0%A4%A/events");
    expect(parsed.ok).toBe(false);
  });
});

describe("judgeEventsAuthority fails closed and never discards evidence", () => {
  it("accepts a run whose every events request targets the active job", () => {
    const verdict = judgeEventsAuthority(
      [`/api/optimize/${JOB}/events`, `/api/optimize/${JOB}/events`],
      JOB,
    );
    expect(verdict.failures).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.jobIds).toEqual([JOB]);
  });

  // The exact three shapes the review's mutation proved were silently dropped.
  it("rejects canonical + legacy", () => {
    const verdict = judgeEventsAuthority(
      [`/api/optimize/${JOB}/events`, "/api/legacy/events"],
      JOB,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toMatch(/events URL rejected \(path does not match/);
  });

  it("rejects canonical + suffix", () => {
    const verdict = judgeEventsAuthority(
      [`/api/optimize/${JOB}/events`, `/api/optimize/${JOB}/events/old`],
      JOB,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
  });

  it("rejects canonical + a foreign-job canonical path", () => {
    const verdict = judgeEventsAuthority(
      [`/api/optimize/${JOB}/events`, `/api/optimize/${OTHER_JOB}/events`],
      JOB,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toMatch(/targets job "job_ffff/);
    // Both ids are still reported, so the diagnostic shows what was seen.
    expect(verdict.jobIds).toEqual([JOB, OTHER_JOB]);
  });

  it("rejects a query string even on the right job", () => {
    const verdict = judgeEventsAuthority([`/api/optimize/${JOB}/events?x=1`], JOB);
    expect(verdict.ok).toBe(false);
  });

  it("fails closed with no observed events request at all", () => {
    const verdict = judgeEventsAuthority([], JOB);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual(["no events request was observed at all"]);
  });

  it("fails closed with no authority to compare against", () => {
    for (const missing of [null, ""]) {
      const verdict = judgeEventsAuthority([`/api/optimize/${JOB}/events`], missing);
      expect(verdict.ok, String(missing)).toBe(false);
      expect(verdict.failures[0]).toMatch(/no independent job authority/);
    }
  });
});

describe("decodePublicCursor mirrors the canonical event_cursor contract", () => {
  it("decodes a well-formed cursor into its job and native id", () => {
    expect(decodePublicCursor(cursor(JOB, N1))).toEqual({
      jobId: JOB,
      nativeEventId: N1,
    });
  });

  it.each([
    ["wrong version", `v2.${seg(JOB)}.${seg(N1)}`],
    ["two segments", `${CURSOR_VERSION}.${seg(JOB)}`],
    ["four segments", `${CURSOR_VERSION}.${seg(JOB)}.${seg(N1)}.${seg(N1)}`],
    ["empty job segment", `${CURSOR_VERSION}..${seg(N1)}`],
    ["empty native segment", `${CURSOR_VERSION}.${seg(JOB)}.`],
    ["padded segment", `${CURSOR_VERSION}.${seg(JOB)}=.${seg(N1)}`],
    ["standard-base64 alphabet", `${CURSOR_VERSION}.${seg(JOB)}.a+b/c`],
    ["not a cursor at all", "1785742420590-0"],
    ["empty string", ""],
  ])("rejects %s", (_label, token) => {
    expect(decodePublicCursor(token)).toBeNull();
  });

  // Base64 has multiple spellings for the same bytes; the canonical round trip is
  // what rejects the ones the server never emitted.
  it("rejects a non-canonical base64url alias of a valid segment", () => {
    expect(decodePublicCursor(`${CURSOR_VERSION}.${seg(JOB)}.MR`)).toBeNull();
    // ...while its canonical spelling for the same decoded text is accepted.
    expect(decodePublicCursor(`${CURSOR_VERSION}.${seg(JOB)}.MQ`)).toEqual({
      jobId: JOB,
      nativeEventId: "1",
    });
  });
});

describe("judgeReplayEvidence — valid replays are green", () => {
  it("accepts a multi-frame strictly-after replay", () => {
    const judged = judgeReplayEvidence(evidence());
    expect(judged.failures).toEqual([]);
    expect(judged.ok).toBe(true);
  });

  it("accepts a single-frame replay", () => {
    expect(
      judgeReplayEvidence(evidence({ rawIds: [cursor(JOB, N1)], cursorAfter: cursor(JOB, N1) })).ok,
    ).toBe(true);
  });

  // The cursor lags the frames by design: a chunk is recorded before the parser
  // applies it, so the newest frame may not be committed yet. That must stay green.
  it("accepts a cursor that lags behind the newest recorded frame", () => {
    expect(
      judgeReplayEvidence(
        evidence({
          rawIds: [cursor(JOB, N1), cursor(JOB, N2), cursor(JOB, N3)],
          cursorAfter: cursor(JOB, N2),
        }),
      ).ok,
    ).toBe(true);
  });

  // Native ids are opaque store tokens. The judge must not bind their arithmetic.
  it("does not constrain native-id increments, ordering or shape", () => {
    for (const natives of [
      ["1", "2"],
      ["9", "4"],
      ["1785742420590-0", "1785742420590-1"],
      ["1785742999999-7", "1785742420590-0"],
    ]) {
      const rawIds = natives.map((n) => cursor(JOB, n));
      expect(
        judgeReplayEvidence(evidence({ rawIds, cursorAfter: rawIds[rawIds.length - 1] })).ok,
        natives.join(","),
      ).toBe(true);
    }
  });
});

// THE FINDING THIS ROUND CLOSED. `cursorBefore`, every frame and `cursorAfter` all
// name the SAME foreign job, so the envelope is internally consistent and only an
// authority from outside it can tell that the session was really running another
// job. The cursor-derived judge accepted it; the current judge cannot.
describe("judgeReplayEvidence — a self-consistent foreign envelope", () => {
  const SELF_CONSISTENT_FOREIGN = evidence({
    expectedJobId: JOB, // what the session was ACTUALLY running
    cursorBefore: cursor(OTHER_JOB, N_OLD),
    rawIds: [cursor(OTHER_JOB, N1), cursor(OTHER_JOB, N2)],
    cursorAfter: cursor(OTHER_JOB, N2),
    preReloadIds: [cursor(OTHER_JOB, N_OLD)],
  });

  it("was ACCEPTED by the cursor-derived judge that shipped at e7d5926", () => {
    expect(CURSOR_DERIVED_JUDGE(SELF_CONSISTENT_FOREIGN)).toBe(true);
  });

  it("is REJECTED because the authority comes from outside the envelope", () => {
    const judged = judgeReplayEvidence(SELF_CONSISTENT_FOREIGN);
    expect(judged.ok).toBe(false);
    // EXACT normalized array — count, order and absence, not substrings. A joined
    // `toMatch` could not tell an extra or reordered diagnostic from the intended
    // set, which is what made the redundant `cursorAfter` message look
    // independently protected when it is not.
    expect(normalize(judged.failures)).toEqual([
      'pre-reload cursor is bound to job "OTHER", not the active "JOB"',
      'recorded id is bound to job "OTHER", not the active "JOB": <cursor OTHER/N1>',
      'recorded id is bound to job "OTHER", not the active "JOB": <cursor OTHER/N2>',
      'durable cursor is bound to job "OTHER", not the active "JOB"',
    ]);
  });

  it("stays green when the authority genuinely matches the envelope", () => {
    // Same shape, but the session really was running that job.
    expect(judgeReplayEvidence({ ...SELF_CONSISTENT_FOREIGN, expectedJobId: OTHER_JOB }).ok).toBe(
      true,
    );
  });

  it("fails closed when no independent authority was captured", () => {
    for (const missing of [null, ""]) {
      const judged = judgeReplayEvidence(evidence({ expectedJobId: missing }));
      expect(judged.ok, String(missing)).toBe(false);
      expect(judged.failures.join(" | ")).toMatch(/no independent pre-reload job authority/);
    }
  });

  it("rejects a cursorBefore bound to a job the session was not running", () => {
    const judged = judgeReplayEvidence(evidence({ cursorBefore: cursor(OTHER_JOB, N_OLD) }));
    expect(judged.ok).toBe(false);
    expect(judged.failures.join(" | ")).toMatch(/pre-reload cursor is bound to job/);
  });
});

describe("judgeReplayEvidence — the false greens the d981b4d predicate accepted", () => {
  // `expectDiagnostics` is the EXACT normalized failure array each case must
  // produce — count, order and absence. A joined substring match let the
  // foreign-only case be satisfied by either binding rule, which is how the
  // redundant cursor diagnostic looked independently protected when it is not.
  const FALSE_GREENS: Array<{
    label: string;
    input: ReplayEvidence;
    expectDiagnostics: string[];
  }> = [
    {
      label: "a duplicated new id",
      input: evidence({
        rawIds: [cursor(JOB, N1), cursor(JOB, N1)],
        cursorAfter: cursor(JOB, N1),
      }),
      expectDiagnostics: ["post-reload frame ids are not unique: <cursor JOB/N1>"],
    },
    {
      label: "a foreign-job id only",
      input: evidence({
        rawIds: [cursor(OTHER_JOB, N1)],
        cursorAfter: cursor(OTHER_JOB, N1),
      }),
      // BOTH fire, in this exact order: the per-id rule and then the redundant
      // cursor-specific diagnostic, which is a refinement of it rather than a
      // separate gate — see `judgeReplayEvidence`'s contract note.
      expectDiagnostics: [
        'recorded id is bound to job "OTHER", not the active "JOB": <cursor OTHER/N1>',
        'durable cursor is bound to job "OTHER", not the active "JOB"',
      ],
    },
    {
      label: "a valid id mixed with a foreign-job id",
      input: evidence({
        rawIds: [cursor(JOB, N1), cursor(OTHER_JOB, N2)],
        cursorAfter: cursor(JOB, N1),
      }),
      // Exactly ONE diagnostic: the cursor itself is legitimately bound, so a judge
      // that also blamed the cursor would fail this array comparison.
      expectDiagnostics: [
        'recorded id is bound to job "OTHER", not the active "JOB": <cursor OTHER/N2>',
      ],
    },
  ];

  it.each(FALSE_GREENS)("$label was ACCEPTED by the shipped predicate", ({ input }) => {
    expect(HISTORICAL_PREDICATE(input)).toBe(true);
  });

  it.each(FALSE_GREENS)(
    "$label is REJECTED with the exact diagnostic array",
    ({ input, expectDiagnostics }) => {
      const judged = judgeReplayEvidence(input);
      expect(judged.ok).toBe(false);
      expect(normalize(judged.failures)).toEqual(expectDiagnostics);
    },
  );
});

describe("judgeReplayEvidence — protections the old predicate already had stay red", () => {
  it("rejects a stale pre-reload id", () => {
    const input = evidence({ rawIds: [cursor(JOB, N_OLD), cursor(JOB, N1)] });
    expect(HISTORICAL_PREDICATE(input)).toBe(false);
    const judged = judgeReplayEvidence(input);
    expect(judged.ok).toBe(false);
    expect(judged.failures.join(" | ")).toMatch(/already-seen/);
  });

  it("rejects a cursor missing from the recorded frames", () => {
    const input = evidence({ cursorAfter: cursor(JOB, N3) });
    expect(HISTORICAL_PREDICATE(input)).toBe(false);
    expect(judgeReplayEvidence(input).failures.join(" | ")).toMatch(/absent from the recorded/);
  });

  it("rejects a missing durable cursor", () => {
    const input = evidence({ cursorAfter: null });
    expect(HISTORICAL_PREDICATE(input)).toBe(false);
    expect(judgeReplayEvidence(input).failures.join(" | ")).toMatch(/no durable cursor/);
  });

  it("rejects empty evidence", () => {
    const input = evidence({ rawIds: [], cursorAfter: null });
    expect(HISTORICAL_PREDICATE(input)).toBe(false);
    expect(judgeReplayEvidence(input).failures.join(" | ")).toMatch(/no post-reload frame ids/);
  });
});

describe("judgeReplayEvidence — malformed evidence is red", () => {
  it("rejects a malformed recorded id", () => {
    // The cursor must sit on the VALID id, so the malformed extra id is the only
    // defect — otherwise the old predicate would fail on cursor-absence instead and
    // the case would not isolate malformedness.
    const input = evidence({
      rawIds: [cursor(JOB, N1), "not-a-cursor"],
      cursorAfter: cursor(JOB, N1),
    });
    // The old predicate happily accepted an unparseable id too.
    expect(HISTORICAL_PREDICATE(input)).toBe(true);
    expect(judgeReplayEvidence(input).failures.join(" | ")).toMatch(
      /not a canonical public cursor/,
    );
  });

  it("rejects a malformed durable cursor", () => {
    const input = evidence({ rawIds: ["v9.x.y"], cursorAfter: "v9.x.y" });
    expect(HISTORICAL_PREDICATE(input)).toBe(true);
    expect(judgeReplayEvidence(input).failures.join(" | ")).toMatch(
      /not a canonical public cursor/,
    );
  });

  it("cannot bind a job when the pre-reload cursor is malformed", () => {
    const judged = judgeReplayEvidence(evidence({ cursorBefore: "garbage" }));
    expect(judged.ok).toBe(false);
    expect(judged.failures.join(" | ")).toMatch(/pre-reload cursor is not a canonical/);
  });

  it("cannot bind a job when no pre-reload cursor was captured", () => {
    expect(judgeReplayEvidence(evidence({ cursorBefore: null })).failures.join(" | ")).toMatch(
      /no pre-reload cursor/,
    );
  });
});
