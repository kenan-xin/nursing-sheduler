// R6 — the assembled replay oracle's truth table, proved without the Compose stack.
//
// The combined cold review at `d981b4d` mutation-tested the assembled gate's
// replay predicate and found three false greens. Because the judge is now pure,
// those mutations become PERMANENT committed coverage rather than a one-off
// experiment: `HISTORICAL_PREDICATE` below is the exact predicate that shipped,
// and each adversarial case asserts that it accepted the input while
// `judgeReplayEvidence` rejects it. If someone ever weakens the judge back
// toward the old shape, these tests go red and name which rule was lost.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// The PRODUCT's reload authority, imported here for the parity assertions: the schema
// half of this suite proves the harness agrees with it rather than restating it.
import { inspectPersistedSession } from "@/lib/optimize/session-transaction";
import {
  ABORT_BOUND_KEYS,
  ABORT_BOUNDS,
  ABORT_TEST_TIMEOUT,
  CLEANUP_ACCEPTED_STATUS,
  CLEANUP_BOUNDS,
  auditCoverageAfterRelease,
  isAcceptedSubmission,
  isCanonicalRawAuthority,
  OPTIMIZE_SESSION_SCHEMA_VERSION,
  isSubmissionRequest,
  OPTIMIZE_SESSION_RECORD_KEY,
  recoverAcceptedOwnership,
  recoverJobIdFromSessionRecord,
  settleAcceptedOwnership,
  trackAcceptedJobs,
  CURSOR_VERSION,
  decodePublicCursor,
  isTerminalJobBody,
  judgeEventsAuthority,
  judgeReplayEvidence,
  judgeVolatileJobIdTexts,
  VOLATILE_JOB_ID_SELECTOR,
  VOLATILE_JOB_ID_TESTID,
  normalizeExpectedOrigin,
  parseEventsRequestUrl,
  PLAYWRIGHT_DEFAULT_TEST_TIMEOUT,
  PRODUCT_SOLVE_LIMIT,
  GOTO_FIXTURE_BOUND_KEYS,
  GOTO_FIXTURE_BOUNDS_TOTAL,
  OBSERVATION_EVALUATE_BOUND,
  releaseLiveJob,
  releaseLiveJobs,
  REPLAY_BOUND_KEYS,
  REPLAY_BOUNDS,
  REPLAY_PHASE_BOUNDS,
  REPLAY_TEST_TIMEOUT,
  TINY_BOUND_KEYS,
  TINY_BOUNDS,
  TINY_TEST_TIMEOUT,
  type AcceptedDrainOutcome,
  type CleanupHttp,
  type OwnershipRecoverySource,
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

/** The fixture/page origin the assembled harness actually serves from. */
const ORIGIN = "http://localhost:51236";

// ---------------------------------------------------------------------------
// Session-record fixtures — the PRODUCT'S CLOSED SCHEMA, field by field
// ---------------------------------------------------------------------------
//
// Every key `lib/optimize/session-transaction.ts` requires is spelled out, so a fixture
// can drop or corrupt exactly one of them and change nothing else. Deliberately built
// here rather than produced by the product's writer: the whole point is to hand the
// recovery helper values the product would REFUSE, which a valid writer cannot emit.
const VALID_ACTIVE_SESSION: Record<string, unknown> = {
  schemaVersion: OPTIMIZE_SESSION_SCHEMA_VERSION,
  ownerId: "owner-1",
  phase: "active",
  anonymized: false,
  runOptions: { prettify: false, timeout: 30 },
  peopleCount: 0,
  reverseMap: [],
  jobId: "job-from-page",
};

/** A record the product's codec accepts, with `over` applied on top. */
const activeSessionRecord = (jobId: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...VALID_ACTIVE_SESSION, jobId, ...over });

/** The valid active record with one required key REMOVED. */
const activeSessionRecordWithout = (key: string): string => {
  const rest = { ...VALID_ACTIVE_SESSION };
  delete rest[key];
  return JSON.stringify(rest);
};

/** A valid PROVISIONAL record — the same payload without a job id. */
const provisionalSessionRecord = (over: Record<string, unknown> = {}): string => {
  const { jobId: _none, ...common } = VALID_ACTIVE_SESSION;
  return JSON.stringify({ ...common, phase: "provisional", ...over });
};

/** A read-only storage view the product's own inspector can be asked about. */
const frozenStorage = (raw: string | null) => ({
  getItem: () => raw,
  setItem: () => {},
  removeItem: () => {},
});

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

  // P2-3. A rejected transport used to propagate out of the helper, so the hook
  // never reached the line that builds and attaches the diagnostic. Every stage is
  // covered, because each one is a separate await.
  const REJECTING = (stage: "post" | "get" | "delete"): CleanupHttp => {
    let clock = 0;
    const boom = async (): Promise<{ status: number; body: string }> => {
      throw new Error(`simulated ${stage} transport failure`);
    };
    return {
      post: stage === "post" ? boom : async () => ({ status: 202, body: "{}" }),
      get:
        stage === "get"
          ? boom
          : async () => ({
              status: 200,
              body: JSON.stringify({ state: "cancelled", terminal: true }),
            }),
      delete: stage === "delete" ? boom : async () => ({ status: 204, body: "" }),
      sleep: async () => {},
      now: () => {
        clock += CLEANUP_BOUNDS.terminalPollInterval;
        return clock;
      },
    };
  };

  it.each(["post", "get", "delete"] as const)(
    "converts a rejected %s into a structured outcome instead of throwing",
    async (stage) => {
      const outcome = await releaseLiveJob(JOB, REJECTING(stage));
      expect(outcome.ok).toBe(false);
      const label = stage === "post" ? "cancel" : stage === "get" ? "status poll" : "delete";
      expect(outcome.steps.join(" | ")).toContain(`${label} -> transport error`);
      expect(outcome.failures.join(" | ")).toMatch(
        new RegExp(`${label} request failed at the transport level`),
      );
      // The report is still buildable, which is what makes the hook's attach reachable.
      expect(outcome.steps.length).toBeGreaterThan(0);
    },
  );

  it("releases EVERY armed job, and reports each by exact identity", async () => {
    const calls: Call[] = [];
    const { http: surface } = http(
      { states: [{ status: 200, body: JSON.stringify({ terminal: true }) }] },
      calls,
    );
    const outcome = await releaseLiveJobs([JOB, OTHER_JOB], surface);
    expect(outcome.ok).toBe(true);
    // Arming only the first and throwing would orphan the second.
    expect(outcome.steps.join(" | ")).toContain(`job ${JOB}:`);
    expect(outcome.steps.join(" | ")).toContain(`job ${OTHER_JOB}:`);
    expect(calls.filter((c) => c.kind === "delete").map((c) => c.url)).toEqual([
      `/api/optimize/${JOB}`,
      `/api/optimize/${OTHER_JOB}`,
    ]);
  });

  it("attempts every job even when an earlier one fails, and prefixes its failures", async () => {
    let seen = 0;
    const surface: CleanupHttp = {
      post: async () => {
        seen += 1;
        return seen === 1 ? { status: 500, body: "" } : { status: 202, body: "{}" };
      },
      get: async () => ({ status: 200, body: JSON.stringify({ terminal: true }) }),
      delete: async () => ({ status: 204, body: "" }),
      sleep: async () => {},
      now: () => 0,
    };
    const outcome = await releaseLiveJobs([JOB, OTHER_JOB], surface);
    expect(outcome.ok).toBe(false);
    expect(outcome.failures.join(" | ")).toContain(`job ${JOB}: cancel returned 500`);
    // The second job was still attempted — one bad release cannot hide the others.
    expect(outcome.steps.join(" | ")).toContain(`job ${OTHER_JOB}: cancel -> 202`);
  });

  it("reports nothing to release when no job was armed", async () => {
    const { http: surface, calls } = http({});
    const outcome = await releaseLiveJobs([], surface);
    expect(outcome.ok).toBe(true);
    expect(outcome.steps).toEqual(["no accepted job was armed; nothing to release"]);
    expect(calls).toEqual([]);
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

/**
 * Build a drain outcome; `resolved` is DERIVED so a fixture cannot lie about it.
 *
 * Shared by BOTH ownership suites: the tracker suite asserts real drains against it
 * (so an expectation must state every field the drain reports — ids, per-acceptance
 * slots, acceptance count, unaccounted count, pending), and the settlement suite
 * builds inputs with it. One helper means the two cannot drift into disagreeing
 * about what a drain outcome is.
 */
const drain = (over: Partial<AcceptedDrainOutcome> = {}): AcceptedDrainOutcome => {
  const merged = {
    ids: [] as string[],
    slots: [] as AcceptedDrainOutcome["slots"],
    acceptedCount: 0,
    unaccountedSlots: 0,
    pending: 0,
    ...over,
  };
  return { ...merged, resolved: merged.pending === 0 && merged.unaccountedSlots === 0 };
};

// P2-2. Ownership must not be able to arrive after the hook snapshots. The tracker
// is a Node-side lifecycle: registered before submit, fed by the response event,
// DRAINED by the hook before it reads `ids()`.
describe("trackAcceptedJobs owns every accepted 202 and cannot outlive the drain", () => {
  interface FakeResponse {
    status(): number;
    url(): string;
    request(): { method(): string; url(): string };
    json(): Promise<unknown>;
  }

  function fakeSource() {
    const handlers = new Map<string, (arg: never) => void>();
    let offCalls = 0;
    return {
      offCalls: () => offCalls,
      source: {
        on: (event: string, h: (arg: never) => void) => {
          handlers.set(event, h);
        },
        off: (event: string, _h: (arg: never) => void) => {
          offCalls += 1;
          handlers.delete(event);
        },
      } as unknown as Parameters<typeof trackAcceptedJobs>[0],
      emit: (r: FakeResponse) =>
        (handlers.get("response") as ((x: FakeResponse) => void) | undefined)?.(r),
      emitRequest: (req: { method(): string; url(): string }) =>
        (handlers.get("request") as ((x: typeof req) => void) | undefined)?.(req),
      emitRequestFailed: (req: { method(): string; url(): string }) =>
        (handlers.get("requestfailed") as ((x: typeof req) => void) | undefined)?.(req),
      isRegistered: () => handlers.has("response"),
    };
  }

  const submissionRequest = { method: () => "POST", url: () => "/api/optimize" };

  const accepted = (id: string, over: Partial<FakeResponse> = {}): FakeResponse => ({
    status: () => 202,
    url: () => "/api/optimize",
    request: () => ({ method: () => "POST", url: () => "/api/optimize" }),
    json: async () => ({ id }),
    ...over,
  });

  it("records an accepted submission and exposes it after drain", async () => {
    const { source, emit } = fakeSource();
    const tracker = trackAcceptedJobs(source);
    emit(accepted("job-a"));
    await tracker.drain();
    expect(tracker.ids()).toEqual(["job-a"]);
    expect(tracker.stats()).toEqual({ started: 1, unaccounted: 0, pending: 0 });
  });

  // The exact race: the id lands while the test is already failing. Draining before
  // the snapshot is what makes it owned instead of orphaned.
  it("owns an id whose body read is still in flight when the hook drains", async () => {
    const { source, emit } = fakeSource();
    const tracker = trackAcceptedJobs(source);
    let release: (v: unknown) => void = () => {};
    emit(
      accepted("job-timeout-race", {
        json: () =>
          new Promise((resolve) => (release = resolve)).then(() => ({ id: "job-timeout-race" })),
      }),
    );
    // Before the drain the id is not visible yet — exactly the window that used to
    // produce `hookSnapshot: []`.
    expect(tracker.ids()).toEqual([]);
    release(null);
    await tracker.drain();
    expect(tracker.ids()).toEqual(["job-timeout-race"]);
  });

  it("drains a read that registers another read, so the set is quiet at snapshot", async () => {
    const { source, emit } = fakeSource();
    const tracker = trackAcceptedJobs(source);
    emit(
      accepted("first", {
        json: async () => {
          emit(accepted("second"));
          return { id: "first" };
        },
      }),
    );
    await tracker.drain();
    // ACCEPTANCE order, not read-completion order: the nested read resolves first,
    // but ownership order is what release determinism depends on.
    expect(tracker.ids()).toEqual(["first", "second"]);
  });

  it("records every accepted id, deduplicated, in acceptance order", async () => {
    const { source, emit } = fakeSource();
    const tracker = trackAcceptedJobs(source);
    emit(accepted("a"));
    emit(accepted("b"));
    emit(accepted("a"));
    await tracker.drain();
    expect(tracker.ids()).toEqual(["a", "b"]);
  });

  // REPLACES a test that pinned the fail-OPEN behaviour: it asserted the drain
  // resolved to `undefined` with empty ids and treated that as the contract. That is
  // exactly the shape that let the hook report cleanup success over a live job. The
  // unreadable body is still not thrown — but the drain now REPORTS it unresolved.
  it("reports an unreadable accepted body as UNRESOLVED rather than as no job", async () => {
    const { source, emit } = fakeSource();
    const tracker = trackAcceptedJobs(source);
    emit(accepted("x", { json: async () => Promise.reject(new Error("body gone")) }));
    const drained = await tracker.drain();
    // The acceptance is reported as its OWN slot with its own reason, not merely
    // counted: the hook's attachment has to be able to say WHICH failure lost the id.
    expect(drained).toEqual(
      drain({
        acceptedCount: 1,
        unaccountedSlots: 1,
        slots: [{ kind: "unreadable", detail: "body gone" }],
      }),
    );
    expect(tracker.stats()).toEqual({ started: 1, unaccounted: 1, pending: 0 });
  });

  // GENUINELY not an accepted submission — no acceptance happened, so there is nothing
  // to account for and the drain is RESOLVED. Distinct from an accepted 202 whose body
  // is unusable, which is the case immediately below: conflating the two is what let an
  // unusable acceptance read as "no job was ever accepted".
  it.each([
    ["a non-202 status", accepted("x", { status: () => 200 })],
    [
      "a non-POST method",
      accepted("x", { request: () => ({ method: () => "GET", url: () => "/api/optimize" }) }),
    ],
    ["a different route", accepted("x", { url: () => "/api/optimize/abc/events" })],
  ])("ignores %s, with nothing left unaccounted", async (_label, response) => {
    const { source, emit } = fakeSource();
    const tracker = trackAcceptedJobs(source);
    emit(response);
    expect(await tracker.drain()).toEqual(drain());
    expect(tracker.ids()).toEqual([]);
    expect(tracker.stats()).toEqual({ started: 0, unaccounted: 0, pending: 0 });
  });

  // AN ACCEPTED 202 WHOSE BODY CARRIES NO USABLE ID. The 202 means a job may well be
  // running; only the NAME is missing. These used to sit in the same "ignores" list as
  // the cases above and were asserted only through `ids()` being empty — the exact
  // fail-open reading, since the drain then reported `resolved: true` and the hook
  // released an empty set and went green. Each is now its own unaccounted SLOT with its
  // own reason.
  it.each([
    ["a missing id", async () => ({}), "accepted body id was absent"],
    ["a null body", async () => null, "accepted body id was absent"],
    ["an empty id", async () => ({ id: "" }), "accepted body id was empty"],
    ["a non-string id", async () => ({ id: 7 }), "accepted body id was number"],
    ["an object id", async () => ({ id: { v: 1 } }), "accepted body id was object"],
  ])("reports %s as an UNACCOUNTED acceptance, never as no job", async (_label, json, detail) => {
    const { source, emit } = fakeSource();
    const tracker = trackAcceptedJobs(source);
    emit(accepted("x", { json }));
    expect(await tracker.drain()).toEqual(
      drain({ acceptedCount: 1, unaccountedSlots: 1, slots: [{ kind: "invalid-body", detail }] }),
    );
    expect(tracker.ids()).toEqual([]);
    expect(tracker.stats()).toEqual({ started: 1, unaccounted: 1, pending: 0 });
  });

  // A REPEATED ID IS NOT A FREE ACCEPTANCE. Two 202s naming the same job are two
  // acceptances, and one identity cannot account for both — the same one-to-one rule
  // settlement applies to recovery. So the second slot is `duplicate` and the drain is
  // unresolved, even though every id it saw is perfectly valid.
  it("treats a second 202 repeating a known id as an unaccounted acceptance", async () => {
    const { source, emit } = fakeSource();
    const tracker = trackAcceptedJobs(source);
    emit(accepted("job-a"));
    emit(accepted("job-a"));
    expect(await tracker.drain()).toEqual(
      drain({
        ids: ["job-a"],
        acceptedCount: 2,
        unaccountedSlots: 1,
        slots: [
          { kind: "id", jobId: "job-a" },
          { kind: "duplicate", jobId: "job-a" },
        ],
      }),
    );
    expect(tracker.stats()).toEqual({ started: 2, unaccounted: 1, pending: 0 });
  });

  it("accepts the absolute submission URL a Request exposes", async () => {
    const { source, emit } = fakeSource();
    const tracker = trackAcceptedJobs(source);
    emit(accepted("abs", { url: () => `${ORIGIN}/api/optimize` }));
    await tracker.drain();
    expect(tracker.ids()).toEqual(["abs"]);
  });

  it("stops recording once disposed, and disposing twice is safe", async () => {
    const { source, emit, isRegistered, offCalls } = fakeSource();
    const tracker = trackAcceptedJobs(source);
    expect(tracker.dispose()).toEqual({ orphaned: 0 });
    expect(tracker.dispose()).toEqual({ orphaned: 0 });
    expect(offCalls()).toBe(3);
    expect(isRegistered()).toBe(false);
    emit(accepted("after-dispose"));
    await tracker.drain();
    expect(tracker.ids()).toEqual([]);
  });

  // THE HARDEST CASE, and the one that made the request channel necessary: the test
  // times out while the POST is still on the wire, so at hook time NOTHING is
  // recorded yet. `drain()` waits for the in-flight request before snapshotting.
  it("waits for a submission still ON THE WIRE before the snapshot", async () => {
    const { source, emit, emitRequest } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 1_000 });
    emitRequest(submissionRequest);
    expect(tracker.stats().pending).toBe(1);
    // The response lands only after the drain has started waiting.
    setTimeout(() => emit(accepted("job-on-the-wire")), 20);
    await tracker.drain();
    expect(tracker.ids()).toEqual(["job-on-the-wire"]);
    expect(tracker.stats().pending).toBe(0);
  });

  // REPLACES a test that pinned the fail-OPEN behaviour at the DEADLINE BOUNDARY:
  // it asserted `ids: []` and `pending: 1` and stopped there, so the hook's
  // "nothing was armed" reading of that state looked like the intended contract.
  // Still bounded — but now the boundary produces an explicit unresolved verdict.
  it("reports a pending submission at its bound as UNRESOLVED, bounded", async () => {
    const { source, emitRequest } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 60 });
    emitRequest(submissionRequest);
    const started = Date.now();
    const drained = await tracker.drain();
    // Bounded: it returns rather than waiting forever for a response that never came.
    expect(Date.now() - started).toBeLessThan(2_000);
    // No acceptance was ever seen, so there is no slot to report — the submission
    // itself is what is unresolved.
    expect(drained).toEqual(drain({ pending: 1 }));
  });

  it("reports a fully accounted drain as RESOLVED", async () => {
    const { source, emit } = fakeSource();
    const tracker = trackAcceptedJobs(source);
    emit(accepted("job-a"));
    emit(accepted("job-b"));
    const drained = await tracker.drain();
    expect(drained).toEqual(
      drain({
        ids: ["job-a", "job-b"],
        acceptedCount: 2,
        slots: [
          { kind: "id", jobId: "job-a" },
          { kind: "id", jobId: "job-b" },
        ],
      }),
    );
  });

  // A partially-unreadable drain must not hide the id it DID capture: cleanup still
  // has to release that job even though ownership as a whole is unresolved.
  it("keeps the ids it captured while still reporting the unreadable one", async () => {
    const { source, emit } = fakeSource();
    const tracker = trackAcceptedJobs(source);
    emit(accepted("job-good"));
    emit(accepted("job-bad", { json: async () => Promise.reject(new Error("body gone")) }));
    expect(await tracker.drain()).toEqual(
      drain({
        ids: ["job-good"],
        acceptedCount: 2,
        unaccountedSlots: 1,
        // ACCEPTANCE order is preserved across a mixed outcome, so the good id and the
        // lost one stay attributable to the submissions that produced them.
        slots: [
          { kind: "id", jobId: "job-good" },
          { kind: "unreadable", detail: "body gone" },
        ],
      }),
    );
  });

  // Disposal is where ownership can vanish silently, so it must SAY what it stranded —
  // but ONLY what the drain has not already reported. REPLACES a test that froze the
  // double count: it asserted `unaccountedSlots: 1` AND `orphaned: 1` for the same
  // physical acceptance, and because `settleAcceptedOwnership` sums both, one unnamed
  // job then demanded TWO distinct recovered identities. Ownership transfers exactly
  // once, so this one slot is reported once.
  it("does not report an unfinished slot the drain already counted", async () => {
    const { source, emit, emitRequest } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 10 });
    emitRequest(submissionRequest);
    // The response arrives (so the POST is no longer pending) but its body read never
    // settles. BOUNDED: an unsettleable read must not hang the fail-closed hook itself.
    emit(accepted("never-reads", { json: () => new Promise<never>(() => {}) }));
    const started = Date.now();
    const drained = await tracker.drain();
    expect(Date.now() - started).toBeLessThan(2_000);
    // The unfinished read counts as an id we could not obtain — the same loss as a
    // rejected read, reached by a slower route.
    expect(drained).toEqual(
      drain({ acceptedCount: 1, unaccountedSlots: 1, slots: [{ kind: "unfinished" }] }),
    );
    expect(tracker.dispose()).toEqual({ orphaned: 0 });
    expect(tracker.dispose()).toEqual({ orphaned: 0 });
  });

  // ...and skipping the drain buys nothing: a caller that reported nothing gets the
  // full count, so the dedupe cannot be turned into a fail-open.
  it("reports everything in flight when it was never drained", async () => {
    const { source, emit, emitRequest } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 10 });
    emitRequest(submissionRequest);
    emitRequest(submissionRequest);
    emit(accepted("never-reads", { json: () => new Promise<never>(() => {}) }));
    // One POST still on the wire plus one acceptance whose read never settles: two
    // distinct physical submissions, neither of them reported.
    expect(tracker.dispose()).toEqual({ orphaned: 2 });
  });

  // A DISTINCT submission that appears only AFTER the drain snapshot is genuinely new
  // work, so disposal must still report it. This is the undercount the dedupe must not
  // introduce.
  it("reports work that arrived after the drain", async () => {
    const { source, emit, emitRequest } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 10 });
    emit(accepted("job-a"));
    expect(await tracker.drain()).toEqual(
      drain({ ids: ["job-a"], acceptedCount: 1, slots: [{ kind: "id", jobId: "job-a" }] }),
    );
    // A second submission goes out after the snapshot and never lands.
    emitRequest(submissionRequest);
    expect(tracker.dispose()).toEqual({ orphaned: 1 });
  });

  // Both kinds at once, one already reported and one not: exactly one is stranded.
  it("reports only the unreported unit when both kinds are in flight", async () => {
    const { source, emit, emitRequest } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 10 });
    emitRequest(submissionRequest);
    emit(accepted("never-reads", { json: () => new Promise<never>(() => {}) }));
    expect(await tracker.drain()).toEqual(
      drain({ acceptedCount: 1, unaccountedSlots: 1, slots: [{ kind: "unfinished" }] }),
    );
    emitRequest(submissionRequest);
    expect(tracker.dispose()).toEqual({ orphaned: 1 });
  });

  // The two waits are SEPARATE windows: a submission that never lands must not eat
  // the window a healthy body read needs, or a slow POST would make a perfectly
  // readable 202 look unobtainable and fail the gate for the wrong reason.
  it("gives the body-read drain its own window after a never-landing submission", async () => {
    const { source, emit, emitRequest } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 80 });
    // TWO submissions on the wire (`pending` is a counter, so both must be emitted for
    // the arithmetic to be honest); only the second gets a response.
    emitRequest(submissionRequest);
    emitRequest(submissionRequest);
    let release: (v: unknown) => void = () => {};
    // The second submission's 202 landed, but its body read is slow.
    emit(
      accepted("job-slow-body", {
        json: () =>
          new Promise((resolve) => (release = resolve)).then(() => ({ id: "job-slow-body" })),
      }),
    );
    setTimeout(() => release(null), 60);
    const drained = await tracker.drain();
    // The read landed inside its OWN window, so it is owned. Only the never-landing
    // POST is unresolved.
    expect(drained).toEqual(
      drain({
        ids: ["job-slow-body"],
        acceptedCount: 1,
        pending: 1,
        slots: [{ kind: "id", jobId: "job-slow-body" }],
      }),
    );
  });

  // A pending submission the drain ALREADY reported is not stranded a second time. It
  // used to appear in both `drained.pending` and `disposal.orphaned`, which made one
  // POST on the wire demand two recovered identities.
  it("does not report a pending submission the drain already counted", async () => {
    const { source, emitRequest } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 10 });
    emitRequest(submissionRequest);
    expect(await tracker.drain()).toEqual(drain({ pending: 1 }));
    expect(tracker.dispose()).toEqual({ orphaned: 0 });
  });

  // A submission whose TRANSPORT failed is resolved, so it is neither pending at the
  // drain nor stranded at disposal — the deliberate asymmetry `settleAcceptedOwnership`
  // documents.
  it("strands nothing for a submission that failed at the transport level", async () => {
    const { source, emitRequest, emitRequestFailed } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 10 });
    emitRequest(submissionRequest);
    emitRequestFailed(submissionRequest);
    expect(await tracker.drain()).toEqual(drain());
    expect(tracker.dispose()).toEqual({ orphaned: 0 });
  });

  it("reports a clean disposal as stranding nothing", async () => {
    const { source, emit } = fakeSource();
    const tracker = trackAcceptedJobs(source);
    emit(accepted("job-a"));
    await tracker.drain();
    expect(tracker.dispose()).toEqual({ orphaned: 0 });
  });

  it("clears a pending submission that fails at the transport level", async () => {
    const { source, emitRequest, emitRequestFailed } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 1_000 });
    emitRequest(submissionRequest);
    emitRequestFailed(submissionRequest);
    expect(tracker.stats().pending).toBe(0);
    await tracker.drain();
    expect(tracker.ids()).toEqual([]);
  });

  it("ignores non-submission requests on the pending channel", () => {
    const { source, emitRequest } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 10 });
    emitRequest({ method: () => "GET", url: () => "/api/optimize" });
    emitRequest({ method: () => "POST", url: () => "/api/optimizer" });
    expect(tracker.stats().pending).toBe(0);
  });

  it("classifies a submission request exactly", () => {
    expect(isSubmissionRequest(submissionRequest)).toBe(true);
    expect(isSubmissionRequest({ method: () => "post", url: () => `${ORIGIN}/api/optimize` })).toBe(
      true,
    );
    expect(isSubmissionRequest({ method: () => "GET", url: () => "/api/optimize" })).toBe(false);
    expect(isSubmissionRequest({ method: () => "POST", url: () => "/api/optimizer" })).toBe(false);
  });

  it("classifies a submission response exactly", () => {
    expect(isAcceptedSubmission(accepted("a"))).toBe(true);
    expect(isAcceptedSubmission(accepted("a", { url: () => "/api/optimize?x=1" }))).toBe(true);
    expect(isAcceptedSubmission(accepted("a", { status: () => 400 }))).toBe(false);
    expect(isAcceptedSubmission(accepted("a", { url: () => "/api/optimizer" }))).toBe(false);
  });
});

// P2-3 (round 9C). COMPOSED over the REAL tracker, because the double count only
// showed up when `drain()` and `dispose()` were used the way the hook actually uses
// them: the pure settlement table below cannot see it, since it is handed counters.
// One physical submission must cost exactly ONE recovered identity, two must cost two,
// and a repeated id must still be red.
describe("drain and dispose count one physical submission once", () => {
  type FakeResponse = {
    status: () => number;
    url: () => string;
    request: () => { method(): string; url(): string };
    json: () => Promise<unknown>;
  };

  const fakeSource = () => {
    const handlers = new Map<string, (payload: never) => void>();
    return {
      source: {
        on: (event: string, handler: (payload: never) => void) => handlers.set(event, handler),
        off: (event: string) => handlers.delete(event),
      } as unknown as Parameters<typeof trackAcceptedJobs>[0],
      emit: (response: FakeResponse) =>
        (handlers.get("response") as ((x: FakeResponse) => void) | undefined)?.(response),
      emitRequest: () =>
        (
          handlers.get("request") as ((x: { method(): string; url(): string }) => void) | undefined
        )?.({ method: () => "POST", url: () => "/api/optimize" }),
    };
  };

  const submissionResponse = (json: () => Promise<unknown>): FakeResponse => ({
    status: () => 202,
    url: () => "/api/optimize",
    request: () => ({ method: () => "POST", url: () => "/api/optimize" }),
    json,
  });

  /** An accepted 202 whose body read NEVER settles — the unfinished-slot boundary. */
  const neverReads = () => submissionResponse(() => new Promise<never>(() => {}));

  /** The documented happy release lifecycle: cancel 202 -> terminal -> delete 204. */
  const releasing = (): CleanupHttp => {
    let clock = 0;
    return {
      post: async () => ({ status: 202, body: "{}" }),
      get: async () => ({
        status: 200,
        body: JSON.stringify({ state: "cancelled", terminal: true }),
      }),
      delete: async () => ({ status: 204, body: "" }),
      sleep: async () => {},
      now: () => {
        clock += CLEANUP_BOUNDS.terminalPollInterval;
        return clock;
      },
    };
  };

  // THE FALSE RED the review measured: `unaccountedSlots: 1` plus `orphaned: 1` for one
  // never-settling body, so the one genuinely recovered id covered half of it.
  it("settles one never-settling acceptance with ONE recovered id, and releases it", async () => {
    const { source, emit, emitRequest } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 10 });
    emitRequest();
    emit(neverReads());
    const drained = await tracker.drain();
    expect([drained.unaccountedSlots, drained.pending, drained.resolved]).toEqual([1, 0, false]);

    const recovery = await recoverAcceptedOwnership({
      readSessionRecord: async () => activeSessionRecord("job-recovered"),
      readVolatileJobIds: async () => [],
    });
    const disposal = tracker.dispose();
    expect(disposal).toEqual({ orphaned: 0 });

    const settled = settleAcceptedOwnership(drained, recovery, disposal);
    expect(settled.failures).toEqual([]);
    expect(settled.ok).toBe(true);
    expect(settled.coverage).toEqual(["job-recovered"]);

    // ...and the recovered id really is released, through the real lifecycle.
    const released = await releaseLiveJobs(settled.ids, releasing());
    expect(released.ok).toBe(true);
    expect(released.absent).toEqual([]);
    expect(auditCoverageAfterRelease(settled, released)).toEqual({ ok: true, failures: [] });
  });

  it("still demands TWO ids for two distinct unresolved acceptances", async () => {
    const { source, emit, emitRequest } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 10 });
    emitRequest();
    emitRequest();
    emit(neverReads());
    emit(neverReads());
    const drained = await tracker.drain();
    expect([drained.unaccountedSlots, drained.pending]).toEqual([2, 0]);
    const disposal = tracker.dispose();
    expect(disposal).toEqual({ orphaned: 0 });

    const one = settleAcceptedOwnership(
      drained,
      { ok: true, ids: ["job-one"], note: "one id" },
      disposal,
    );
    expect(one.ok).toBe(false);
    expect(one.failures).toEqual([
      "accepted ownership unresolved (2 acceptance(s) unaccounted for): authority produced 1 new distinct job id(s) for 2 unresolved acceptance(s); a solver job may exist unnamed",
    ]);

    const both = settleAcceptedOwnership(
      drained,
      { ok: true, ids: ["job-one", "job-two"], note: "two ids" },
      disposal,
    );
    expect(both.ok).toBe(true);
    expect(both.coverage).toEqual(["job-one", "job-two"]);
  });

  it("is still red when the recovered id merely repeats itself", async () => {
    const { source, emit } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 10 });
    emit(neverReads());
    emit(neverReads());
    const drained = await tracker.drain();
    const settled = settleAcceptedOwnership(
      drained,
      { ok: true, ids: ["job-one", "job-one"], note: "the same id twice" },
      tracker.dispose(),
    );
    expect(settled.ok).toBe(false);
    expect(settled.coverage).toEqual(["job-one"]);
  });

  // NO UNDERCOUNT. Work that appears only after the drain snapshot is genuinely
  // unreported, so disposal names it and the settlement is red without a recovery.
  it("is red for a submission that appeared only after the drain", async () => {
    const { source, emit, emitRequest } = fakeSource();
    const tracker = trackAcceptedJobs(source, { pendingSettleMs: 10 });
    emit(submissionResponse(async () => ({ id: "job-a" })));
    const drained = await tracker.drain();
    expect(drained.resolved).toBe(true);
    emitRequest();
    const disposal = tracker.dispose();
    expect(disposal).toEqual({ orphaned: 1 });
    const settled = settleAcceptedOwnership(drained, null, disposal);
    expect(settled.ok).toBe(false);
    expect(settled.failures).toEqual([
      "accepted ownership unresolved (1 stranded by disposal) and no recovery was attempted",
    ]);
    // The id it DID own is still released.
    expect(settled.ids).toEqual(["job-a"]);
  });
});

// P2-2. Ownership must FAIL CLOSED and then RECOVER. The two probes below are the
// exact states the hook used to report as cleanup success:
//
//   { ids: [], resolved: false, pending: 1, failed: 0 }   late accepted
//   { ids: [], resolved: false, pending: 0, failed: 1 }   unreadable accepted body
//
// `settleAcceptedOwnership` is pure, so the whole truth table is provable here, and
// the composed proof at the bottom drives the real `releaseLiveJob` lifecycle over a
// RECOVERED id — cancel -> poll to terminal -> delete — so the recovery path is shown
// to actually release a job rather than merely to report one.
describe("accepted-job ownership fails closed and recovers", () => {
  const CLEAN = drain({
    ids: ["job-a"],
    acceptedCount: 1,
    slots: [{ kind: "id", jobId: "job-a" }],
  });
  const PENDING = drain({ pending: 1 });
  const UNREADABLE = drain({
    acceptedCount: 1,
    unaccountedSlots: 1,
    slots: [{ kind: "unreadable", detail: "body gone" }],
  });
  const CLEAN_DISPOSAL = { orphaned: 0 };

  /** A REAL active record, exactly as the product's validator requires it. */
  const activeRecord = (jobId: string): string => activeSessionRecord(jobId);

  /** A REAL provisional record — no jobId, because the schema forbids one. */
  const provisionalRecord = (): string => provisionalSessionRecord();

  /** Both authorities, defaulting to "nothing here", so each test states only its own. */
  const source = (over: Partial<OwnershipRecoverySource> = {}): OwnershipRecoverySource => ({
    readSessionRecord: async () => null,
    readVolatileJobIds: async () => [],
    ...over,
  });

  it("settles a resolved drain without consulting recovery at all", () => {
    const settled = settleAcceptedOwnership(CLEAN, null, CLEAN_DISPOSAL);
    expect(settled.ok).toBe(true);
    expect(settled.ids).toEqual(["job-a"]);
    expect(settled.failures).toEqual([]);
  });

  // THE CORE REGRESSION. Unresolved with no recovery is NOT success.
  it.each([
    ["a pending submission", PENDING, "1 submission(s) still pending"],
    ["an unreadable accepted body", UNREADABLE, "1 acceptance(s) unaccounted for"],
  ])("refuses to call %s settled when no recovery was attempted", (_label, drained, summary) => {
    const settled = settleAcceptedOwnership(drained, null, CLEAN_DISPOSAL);
    expect(settled.ok).toBe(false);
    expect(settled.ids).toEqual([]);
    expect(settled.failures).toEqual([
      `accepted ownership unresolved (${summary}) and no recovery was attempted`,
    ]);
  });

  it.each([
    ["a pending submission", PENDING],
    ["an unreadable accepted body", UNREADABLE],
  ])("recovers ownership for %s from the page record", (_label, drained) => {
    const settled = settleAcceptedOwnership(
      drained,
      {
        ok: true,
        ids: ["job-recovered"],
        note: "recovered job job-recovered from the page record",
      },
      CLEAN_DISPOSAL,
    );
    expect(settled.ok).toBe(true);
    expect(settled.ids).toEqual(["job-recovered"]);
    expect(settled.notes).toContain("recovery: recovered job job-recovered from the page record");
  });

  it("refuses to settle when the page held no job id to recover", () => {
    const settled = settleAcceptedOwnership(
      UNREADABLE,
      { ok: true, ids: [], note: "no active session record; no job id to recover" },
      CLEAN_DISPOSAL,
    );
    expect(settled.ok).toBe(false);
    // The message is now CARDINAL rather than merely "nothing to recover": it names how
    // many distinct new ids the authority produced against how many acceptances needed
    // covering, which is the same rule that rejects one id standing in for two jobs.
    expect(settled.failures).toEqual([
      "accepted ownership unresolved (1 acceptance(s) unaccounted for): authority produced 0 new distinct job id(s) for 1 unresolved acceptance(s); a solver job may exist unnamed",
    ]);
  });

  it("refuses to settle when recovery itself failed", () => {
    const settled = settleAcceptedOwnership(
      PENDING,
      { ok: false, reason: "page-side session record was unreadable: page closed" },
      CLEAN_DISPOSAL,
    );
    expect(settled.ok).toBe(false);
    expect(settled.failures).toEqual([
      "accepted ownership unresolved (1 submission(s) still pending); recovery failed: page-side session record was unreadable: page closed",
    ]);
  });

  it("names EVERY unresolved cause when a drain has each", () => {
    const settled = settleAcceptedOwnership(
      drain({ acceptedCount: 3, unaccountedSlots: 3, pending: 2 }),
      null,
      { orphaned: 1 },
    );
    expect(settled.failures).toEqual([
      "accepted ownership unresolved (3 acceptance(s) unaccounted for and 2 submission(s) still pending and 1 stranded by disposal) and no recovery was attempted",
    ]);
  });

  // REPLACES a test that asserted duplicate recovery was CLEAN. It claimed that
  // recovering an id we already owned "accounted for" an unreadable body — which is
  // exactly the laundering this round closed: one identity cannot cover a DIFFERENT
  // missing job. Coverage is now one-to-one, so this is red.
  it("refuses a recovered id that merely repeats one already owned", () => {
    const settled = settleAcceptedOwnership(
      drain({ ids: ["job-1", "job-2"], acceptedCount: 3, unaccountedSlots: 1 }),
      { ok: true, ids: ["job-2"], note: "durable active record names job job-2" },
      CLEAN_DISPOSAL,
    );
    expect(settled.ok).toBe(false);
    expect(settled.coverage).toEqual([]);
    expect(settled.failures).toEqual([
      "accepted ownership unresolved (1 acceptance(s) unaccounted for): authority produced 0 new distinct job id(s) for 1 unresolved acceptance(s); a solver job may exist unnamed",
    ]);
    // The ids it DID own are still released, exactly once each.
    expect(settled.ids).toEqual(["job-1", "job-2"]);
  });

  it("covers one unaccounted acceptance with one NEW distinct id", () => {
    const settled = settleAcceptedOwnership(
      drain({ ids: ["job-1"], acceptedCount: 2, unaccountedSlots: 1 }),
      { ok: true, ids: ["job-1", "job-new"], note: "volatile state names 1 job id(s): job-new" },
      CLEAN_DISPOSAL,
    );
    expect(settled.ok).toBe(true);
    expect(settled.coverage).toEqual(["job-new"]);
    expect(settled.ids).toEqual(["job-1", "job-new"]);
  });

  // INSUFFICIENT RECOVERY. Two unaccounted acceptances, one new id: still red.
  it("refuses when recovery cannot cover EVERY unresolved acceptance", () => {
    const settled = settleAcceptedOwnership(
      drain({ acceptedCount: 2, unaccountedSlots: 2 }),
      { ok: true, ids: ["job-new"], note: "durable active record names job job-new" },
      CLEAN_DISPOSAL,
    );
    expect(settled.ok).toBe(false);
    expect(settled.failures).toEqual([
      "accepted ownership unresolved (2 acceptance(s) unaccounted for): authority produced 1 new distinct job id(s) for 2 unresolved acceptance(s); a solver job may exist unnamed",
    ]);
  });

  // CARDINALITY COUNTS EVERY CAUSE, not just unaccounted slots. One unaccounted
  // acceptance plus one job stranded by disposal is TWO jobs that may be running, so a
  // single recovered id covers half of it and the gate stays red. Without this, a rule
  // that counted only `unaccountedSlots` would look correct against every other case
  // here.
  it("counts disposal-stranded work in the coverage denominator", () => {
    const settled = settleAcceptedOwnership(
      drain({ acceptedCount: 1, unaccountedSlots: 1 }),
      { ok: true, ids: ["job-new"], note: "volatile state names 1 job id(s): job-new" },
      { orphaned: 1 },
    );
    expect(settled.ok).toBe(false);
    expect(settled.failures).toEqual([
      "accepted ownership unresolved (1 acceptance(s) unaccounted for and 1 stranded by disposal): authority produced 1 new distinct job id(s) for 2 unresolved acceptance(s); a solver job may exist unnamed",
    ]);
    // The id it DID recover is still released — failing closed must not also abandon a
    // job we can name.
    expect(settled.ids).toEqual(["job-new"]);
  });

  // AN INVALID-BODY 202 is unaccounted, which is the B finding: it used to leave the
  // slot null, increment nothing, and report `resolved: true` with no id.
  it("treats a readable 202 with no usable id as unaccounted", () => {
    const settled = settleAcceptedOwnership(
      drain({
        acceptedCount: 1,
        unaccountedSlots: 1,
        slots: [{ kind: "invalid-body", detail: "accepted body id was absent" }],
      }),
      null,
      CLEAN_DISPOSAL,
    );
    expect(settled.ok).toBe(false);
    expect(settled.ids).toEqual([]);
  });

  // Disposal orphaning is independent: even a resolved drain cannot be called settled
  // if detaching the listeners stranded work.
  it("refuses to settle when disposal stranded in-flight work", () => {
    const settled = settleAcceptedOwnership(CLEAN, null, { orphaned: 2 });
    expect(settled.ok).toBe(false);
    expect(settled.failures).toEqual([
      "accepted ownership unresolved (2 stranded by disposal) and no recovery was attempted",
    ]);
    // The id it DID know is still released.
    expect(settled.ids).toEqual(["job-a"]);
  });

  it("always records the drain shape in its notes, settled or not", () => {
    expect(settleAcceptedOwnership(UNREADABLE, null, CLEAN_DISPOSAL).notes).toContain(
      "drain: 1 acceptance(s), 0 known id(s), 1 unaccounted, 0 pending, 0 stranded by disposal",
    );
  });

  // RELEASE-404 LAUNDERING. A stale id satisfies cardinality (new and distinct) and then
  // releases "fine" via the documented idempotent 404 — so the unaccounted acceptance
  // would look covered by a job that never existed.
  describe("coverage must have actually existed", () => {
    const settled = settleAcceptedOwnership(
      drain({ acceptedCount: 1, unaccountedSlots: 1 }),
      { ok: true, ids: ["job-stale"], note: "durable active record names job job-stale" },
      CLEAN_DISPOSAL,
    );

    it("passes cardinality on its own", () => {
      expect(settled.ok).toBe(true);
      expect(settled.coverage).toEqual(["job-stale"]);
    });

    it("is rejected once release shows the backend never had it", () => {
      const audit = auditCoverageAfterRelease(settled, {
        ok: true,
        steps: ["job job-stale: cancel -> 404 | job already absent; nothing to delete"],
        failures: [],
        absent: ["job-stale"],
      });
      expect(audit.ok).toBe(false);
      expect(audit.failures).toEqual([
        "recovered job job-stale was counted as coverage but the backend never had it; " +
          "the acceptance it was meant to account for is still unnamed",
      ]);
    });

    it("accepts coverage the backend really had", () => {
      const audit = auditCoverageAfterRelease(settled, {
        ok: true,
        steps: ["job job-stale: cancel -> 202 | reached terminal | delete -> 204"],
        failures: [],
        absent: [],
      });
      expect(audit.ok).toBe(true);
    });

    // A TRACKER-OBSERVED id is exempt: the product's terminal auto-chain legitimately
    // DELETEs it before the hook runs, so its 404 is expected, not laundering.
    it("does not penalise a tracker-observed id that was already deleted", () => {
      const clean = settleAcceptedOwnership(CLEAN, null, CLEAN_DISPOSAL);
      expect(clean.coverage).toEqual([]);
      expect(
        auditCoverageAfterRelease(clean, {
          ok: true,
          steps: ["job job-a: cancel -> 404 | job already absent; nothing to delete"],
          failures: [],
          absent: ["job-a"],
        }).ok,
      ).toBe(true);
    });
  });

  // D. The record must satisfy the PRODUCT'S REAL SCHEMA, not merely "has a jobId".
  // Fixtures below are the genuine shapes `lib/optimize/session-transaction.ts`
  // validates — exact schema version, owner id, and `phase` as the discriminator.
  describe("recoverJobIdFromSessionRecord validates the real session schema", () => {
    it("recovers the job id from a valid ACTIVE record", () => {
      expect(recoverJobIdFromSessionRecord(activeRecord("job-from-page"))).toEqual({
        ok: true,
        jobId: "job-from-page",
      });
    });

    // A provisional record is written BEFORE the POST. It legitimately has no job id —
    // and in the `activation-persistence-failed` path it STAYS provisional while a real
    // job runs, so the volatile authority is what must cover that, never a guess here.
    it("reports no job id for a valid PROVISIONAL record", () => {
      expect(recoverJobIdFromSessionRecord(provisionalRecord())).toEqual({
        ok: true,
        jobId: null,
      });
    });

    it("reports no job id when there is no record at all", () => {
      expect(recoverJobIdFromSessionRecord(null)).toEqual({ ok: true, jobId: null });
    });

    it.each([
      ["not JSON", "{oops", "session record is not JSON"],
      ["not an object", "42", "session record is not an object"],
      ["null", "null", "session record is not an object"],
      ["an array", "[]", "session record is not an object"],
      [
        "the shape the old judge accepted — a bare jobId",
        '{"jobId":"job-x"}',
        "session record schemaVersion undefined is not 1",
      ],
      [
        "a FUTURE schema version",
        JSON.stringify({ schemaVersion: 2, ownerId: "o", phase: "active", jobId: "job-x" }),
        "session record schemaVersion 2 is not 1",
      ],
      [
        "a stale schema version",
        JSON.stringify({ schemaVersion: 0, ownerId: "o", phase: "active", jobId: "job-x" }),
        "session record schemaVersion 0 is not 1",
      ],
      [
        "missing an owner id",
        JSON.stringify({ schemaVersion: 1, phase: "active", jobId: "job-x" }),
        "session record has no owner id",
      ],
      [
        "PROVISIONAL but carrying a jobId",
        JSON.stringify({ schemaVersion: 1, ownerId: "o", phase: "provisional", jobId: "job-x" }),
        "provisional session record carries a jobId; not valid",
      ],
      [
        "an unknown phase",
        JSON.stringify({ schemaVersion: 1, ownerId: "o", phase: "zombie", jobId: "job-x" }),
        "session record phase zombie is not active",
      ],
      [
        "missing a phase entirely",
        JSON.stringify({ schemaVersion: 1, ownerId: "o", jobId: "job-x" }),
        "session record phase undefined is not active",
      ],
      [
        "ACTIVE with a non-string jobId",
        JSON.stringify({ schemaVersion: 1, ownerId: "o", phase: "active", jobId: 7 }),
        "active session record has no valid jobId",
      ],
      [
        "ACTIVE with an empty jobId",
        JSON.stringify({ schemaVersion: 1, ownerId: "o", phase: "active", jobId: "" }),
        "active session record has no valid jobId",
      ],
    ])("fails closed on a record that is %s", (_label, raw, reason) => {
      expect(recoverJobIdFromSessionRecord(raw)).toEqual({ ok: false, reason });
    });

    // THE ROUND-9C FINDING. Everything above was already rejected; everything below was
    // ACCEPTED, because this helper re-implemented a REDUCED schema (version, owner,
    // phase, job id) and stopped there. The product's codec also requires `anonymized`,
    // closed `runOptions` within the settled timeout bounds, `peopleCount`, a
    // `reverseMap` consistent with the anonymization flag, an EXACT key set, and a
    // within-cap `lastCursor` when present. The decision is now the product's, so these
    // are provable rather than aspirational.
    const CODEC = "session record was rejected by the product session codec";
    const OVERSIZED_CURSOR = "c".repeat(4_097);

    it.each([
      // The EXACT value the review named: active-looking, well-owned, and a record the
      // product would refuse to reload. Its `job-foreign` id is what could satisfy
      // cardinality and then launder an unnamed acceptance through the 404 branch.
      [
        "the review's active-looking record with no payload at all",
        JSON.stringify({
          schemaVersion: 1,
          ownerId: "owner-1",
          phase: "active",
          jobId: "job-foreign",
        }),
      ],
      // Each required key, dropped one at a time.
      ["missing `anonymized`", activeSessionRecordWithout("anonymized")],
      ["missing `runOptions`", activeSessionRecordWithout("runOptions")],
      ["missing `peopleCount`", activeSessionRecordWithout("peopleCount")],
      ["missing `reverseMap`", activeSessionRecordWithout("reverseMap")],
      // A CLOSED key set: an unknown key makes the record unreadable, so a foreign or
      // future writer's record cannot be mined for an id.
      ["carrying an unknown key", activeSessionRecord("job-x", { surprise: 1 })],
      // Types.
      ["`anonymized` not a boolean", activeSessionRecord("job-x", { anonymized: "false" })],
      ["`peopleCount` negative", activeSessionRecord("job-x", { peopleCount: -1 })],
      ["`peopleCount` fractional", activeSessionRecord("job-x", { peopleCount: 1.5 })],
      ["`peopleCount` a string", activeSessionRecord("job-x", { peopleCount: "0" })],
      // Run options: closed key set and the settled timeout bounds (1..3600 seconds).
      [
        "`runOptions` carrying an unknown key",
        activeSessionRecord("job-x", { runOptions: { prettify: false, timeout: 30, fast: true } }),
      ],
      [
        "`runOptions.prettify` not a boolean",
        activeSessionRecord("job-x", { runOptions: { prettify: 1, timeout: 30 } }),
      ],
      [
        "`runOptions.timeout` below the minimum",
        activeSessionRecord("job-x", { runOptions: { prettify: false, timeout: 0 } }),
      ],
      [
        "`runOptions.timeout` above the maximum",
        activeSessionRecord("job-x", { runOptions: { prettify: false, timeout: 3_601 } }),
      ],
      [
        "`runOptions.timeout` fractional",
        activeSessionRecord("job-x", { runOptions: { prettify: false, timeout: 30.5 } }),
      ],
      ["`runOptions` not an object", activeSessionRecord("job-x", { runOptions: [] })],
      // The reverse-map invariant: cardinality must match the anonymization flag, and
      // every tuple must be a well-formed `P#` -> typed-original pair.
      ["`reverseMap` not an array", activeSessionRecord("job-x", { reverseMap: {} })],
      [
        "a plain run carrying a NON-EMPTY reverse map",
        activeSessionRecord("job-x", { reverseMap: [["P1", "Ann"]] }),
      ],
      [
        "an ANONYMIZED run whose map is empty",
        activeSessionRecord("job-x", { anonymized: true, peopleCount: 2, reverseMap: [] }),
      ],
      [
        "an ANONYMIZED run whose map is short",
        activeSessionRecord("job-x", {
          anonymized: true,
          peopleCount: 2,
          reverseMap: [["P1", "Ann"]],
        }),
      ],
      [
        "an ANONYMIZED map with a malformed anonymized id",
        activeSessionRecord("job-x", {
          anonymized: true,
          peopleCount: 1,
          reverseMap: [["P0", "Ann"]],
        }),
      ],
      [
        "an ANONYMIZED map with a duplicate anonymized id",
        activeSessionRecord("job-x", {
          anonymized: true,
          peopleCount: 2,
          reverseMap: [
            ["P1", "Ann"],
            ["P1", "Bo"],
          ],
        }),
      ],
      [
        "an ANONYMIZED map with a duplicate original",
        activeSessionRecord("job-x", {
          anonymized: true,
          peopleCount: 2,
          reverseMap: [
            ["P1", "Ann"],
            ["P2", "Ann"],
          ],
        }),
      ],
      [
        "an ANONYMIZED map whose tuple is not a pair",
        activeSessionRecord("job-x", {
          anonymized: true,
          peopleCount: 1,
          reverseMap: [["P1", "Ann", "extra"]],
        }),
      ],
      // A persisted cursor is either absent or a real cursor: JSON drops `undefined`,
      // so an empty or non-string value is corruption.
      ["an EMPTY `lastCursor`", activeSessionRecord("job-x", { lastCursor: "" })],
      ["a non-string `lastCursor`", activeSessionRecord("job-x", { lastCursor: 7 })],
      ["a null `lastCursor`", activeSessionRecord("job-x", { lastCursor: null })],
      // A provisional record must satisfy the same payload schema.
      [
        "PROVISIONAL and missing its payload",
        JSON.stringify({ schemaVersion: 1, ownerId: "owner-1", phase: "provisional" }),
      ],
      [
        "PROVISIONAL with an invalid reverse map",
        provisionalSessionRecord({ anonymized: true, peopleCount: 1, reverseMap: [] }),
      ],
    ])("rejects a record the PRODUCT would refuse to reload: %s", (_label, raw) => {
      expect(recoverJobIdFromSessionRecord(raw)).toEqual({
        ok: false,
        reason: expect.any(String),
      });
      // And the product agrees, by construction rather than by coincidence.
      expect(inspectPersistedSession(frozenStorage(raw)).kind).toBe("unreadable");
    });

    it("names a payload defect it cannot attribute as a codec rejection", () => {
      expect(recoverJobIdFromSessionRecord(activeSessionRecordWithout("anonymized"))).toEqual({
        ok: false,
        reason: CODEC,
      });
      expect(recoverJobIdFromSessionRecord(provisionalSessionRecord({ peopleCount: -1 }))).toEqual({
        ok: false,
        reason: "provisional session record was rejected by the product session codec",
      });
    });

    // ACCEPTED SHAPES, pinned so the delegation cannot quietly tighten either: a
    // within-cap cursor is a normal resumable record, and an ANONYMIZED run with a
    // well-formed map of matching cardinality is perfectly valid.
    it.each([
      ["a within-cap saved cursor", activeSessionRecord("job-live", { lastCursor: "v1.abc.def" })],
      [
        "an anonymized run with a well-formed map",
        activeSessionRecord("job-live", {
          anonymized: true,
          peopleCount: 2,
          reverseMap: [
            ["P1", "Ann"],
            ["P2", 7],
          ],
        }),
      ],
      [
        "a run at the timeout bounds",
        activeSessionRecord("job-live", { runOptions: { prettify: true, timeout: 3_600 } }),
      ],
    ])("recovers the job id from %s", (_label, raw) => {
      expect(recoverJobIdFromSessionRecord(raw)).toEqual({ ok: true, jobId: "job-live" });
    });

    // THE ONE INHERITED SALVAGE, stated explicitly rather than left to be discovered:
    // the product treats an otherwise-valid active record whose ONLY defect is an
    // oversized cursor as RESUMABLE with the cursor stripped. The identity and the
    // anonymization map are fully valid, and the id names a job that must be released,
    // so recovery inherits that reading instead of holding a stricter second line.
    it("still recovers the id when the ONLY defect is an oversized saved cursor", () => {
      const raw = activeSessionRecord("job-live", { lastCursor: OVERSIZED_CURSOR });
      expect(inspectPersistedSession(frozenStorage(raw)).kind).toBe("resumable");
      expect(recoverJobIdFromSessionRecord(raw)).toEqual({ ok: true, jobId: "job-live" });
    });

    // ...but an oversized cursor on a record with a SECOND defect stays unreadable, so
    // the salvage cannot be used as a way in.
    it("does not salvage an oversized cursor on an otherwise-invalid record", () => {
      expect(
        recoverJobIdFromSessionRecord(
          activeSessionRecord("job-live", { lastCursor: OVERSIZED_CURSOR, surprise: 1 }),
        ).ok,
      ).toBe(false);
    });

    // EXECUTABLE PARITY. One authority, asserted over the whole corpus: whatever the
    // product's inspector says about a record is what recovery reports about it.
    it("agrees with the product's inspector on every fixture", () => {
      const corpus = [
        null,
        "{oops",
        "42",
        activeSessionRecord("job-live"),
        activeSessionRecord("job-live", { lastCursor: "v1.abc.def" }),
        activeSessionRecordWithout("reverseMap"),
        activeSessionRecord("job-live", { surprise: 1 }),
        provisionalSessionRecord(),
        provisionalSessionRecord({ jobId: "job-x" }),
        JSON.stringify({ schemaVersion: 1, ownerId: "owner-1", phase: "active", jobId: "job-f" }),
      ];
      for (const raw of corpus) {
        const inspected = inspectPersistedSession(frozenStorage(raw));
        const expected =
          inspected.kind === "resumable"
            ? { ok: true, jobId: inspected.record.jobId }
            : inspected.kind === "unreadable"
              ? { ok: false, reason: expect.any(String) }
              : { ok: true, jobId: null };
        expect(recoverJobIdFromSessionRecord(raw), `raw: ${String(raw)}`).toEqual(expected);
      }
    });

    // COMPOSED LAUNDERING PROOF. The stale/foreign record is not merely "rejected": the
    // whole path it used to travel is closed. Recovery fails, so settlement is red, so
    // the hook cannot release `job-foreign` and call an unnamed acceptance covered.
    it("closes the stale-existing-job laundering path end to end", async () => {
      const recovery = await recoverAcceptedOwnership({
        readSessionRecord: async () =>
          JSON.stringify({
            schemaVersion: 1,
            ownerId: "owner-1",
            phase: "active",
            jobId: "job-foreign",
          }),
        readVolatileJobIds: async () => [],
      });
      expect(recovery.ok).toBe(false);
      const settled = settleAcceptedOwnership(
        drain({ acceptedCount: 1, unaccountedSlots: 1 }),
        recovery,
        { orphaned: 0 },
      );
      expect(settled.ok).toBe(false);
      expect(settled.ids).toEqual([]);
      expect(settled.coverage).toEqual([]);
      expect(settled.failures).toEqual([
        `accepted ownership unresolved (1 acceptance(s) unaccounted for); recovery failed: ${CODEC}`,
      ]);
    });
  });

  // D2. THE VOLATILE AUTHORITY'S DOM CONTRACT. The read used to scrape the prose
  // `Job ID: <id>` out of every <p>, which coupled a fail-closed ownership gate to
  // user-visible copy and would equally have matched any other paragraph opening the
  // same way. It is now anchored to a stable `data-testid` on the id VALUE, and every
  // judgement about what that hook yielded lives in this total function — so the
  // whole truth table is provable here rather than inside a Compose run. The markup
  // half of the contract is pinned in `components/optimize/run-status-panel.test.tsx`,
  // which imports `VOLATILE_JOB_ID_SELECTOR` from the module under test.
  describe("judgeVolatileJobIdTexts judges the DOM authority, fail-closed", () => {
    it("pins the selector to the hook the product renders", () => {
      expect(VOLATILE_JOB_ID_TESTID).toBe("optimize-job-id");
      expect(VOLATILE_JOB_ID_SELECTOR).toBe('[data-testid="optimize-job-id"]');
    });

    it("accepts exactly one bare job id", () => {
      expect(judgeVolatileJobIdTexts(["opt_e2e_1"])).toEqual({ ok: true, ids: ["opt_e2e_1"] });
    });

    // `textContent` legitimately carries the surrounding formatting whitespace of the
    // rendered line, so trimming is part of the contract rather than leniency.
    it("trims the formatting whitespace textContent carries", () => {
      expect(judgeVolatileJobIdTexts(["\n  opt_e2e_1  \n"])).toEqual({
        ok: true,
        ids: ["opt_e2e_1"],
      });
    });

    // ABSENCE is the one benign non-answer: no live job is rendered. It must report an
    // empty set rather than a reason, and let CARDINALITY fail the gate if an
    // acceptance actually needed covering — proved by the composed case below.
    it("reports absence as an empty set, never as an id", () => {
      expect(judgeVolatileJobIdTexts([])).toEqual({ ok: true, ids: [] });
    });

    it("still fails closed when absence has to cover an unaccounted acceptance", () => {
      const verdict = judgeVolatileJobIdTexts([]);
      expect(verdict).toEqual({ ok: true, ids: [] });
      const settled = settleAcceptedOwnership(
        drain({ acceptedCount: 1, unaccountedSlots: 1 }),
        { ok: true, ids: verdict.ok ? verdict.ids : [], note: "page holds no volatile id" },
        CLEAN_DISPOSAL,
      );
      expect(settled.ok).toBe(false);
    });

    // MULTIPLE hooks — a stale panel, or a duplicated mount. Neither node can be shown
    // to name the live job, and picking one would be a guess, so this is a reason.
    // Identical texts are rejected too: sameness is not evidence of which is current.
    it.each([
      ["two different ids", ["opt_a", "opt_b"]],
      ["the same id twice", ["opt_a", "opt_a"]],
    ])("refuses to guess between %s", (_label, texts) => {
      const verdict = judgeVolatileJobIdTexts(texts);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.reason).toContain(`page rendered ${texts.length} "optimize-job-id" nodes`);
        expect(verdict.reason).toContain("ambiguous");
      }
    });

    it.each([
      ["an untexted node", [null], "node carried no text (null)"],
      ["an undefined text", [undefined], "node carried no text (undefined)"],
      ["a non-string text", [7 as unknown as string], "node carried no text (7)"],
      ["an empty text", [""], "node text was empty"],
      ["a whitespace-only text", ["   \n "], "node text was empty"],
    ])("fails closed on %s", (_label, texts, fragment) => {
      const verdict = judgeVolatileJobIdTexts(texts as readonly (string | null | undefined)[]);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain(fragment);
    });

    // THE REGRESSION THIS HOOK EXISTS TO NAME. If the testid is ever moved from the id
    // VALUE onto the whole line, the text becomes the prose form again. Silently
    // parsing the id back out would restore the copy coupling under a new name, so the
    // judge rejects it and says exactly what is wrong.
    it("rejects the whole-line prose form instead of parsing it back out", () => {
      const verdict = judgeVolatileJobIdTexts(["Job ID: opt_e2e_1"]);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.reason).toContain("is not a bare job id");
        expect(verdict.reason).toContain("the hook must sit on the id VALUE");
      }
    });

    it("fails closed when the page did not report a list at all", () => {
      expect(judgeVolatileJobIdTexts("opt_a" as unknown as readonly string[])).toEqual({
        ok: false,
        reason: "page did not report a list of volatile job-id nodes",
      });
    });

    // COMPOSED, through the real seam the spec wires: an unusable DOM answer is thrown
    // by the page-side reader, `recoverAcceptedOwnership` turns it into a reason, and
    // settlement goes red. An unusable answer must never read as "no job".
    it("turns an unusable DOM answer into a red settlement, not a quiet zero", async () => {
      const verdict = judgeVolatileJobIdTexts(["opt_a", "opt_b"]);
      expect(verdict.ok).toBe(false);
      const recovery = await recoverAcceptedOwnership(
        source({
          readSessionRecord: async () => provisionalRecord(),
          readVolatileJobIds: async () => {
            throw new Error(verdict.ok ? "unreachable" : verdict.reason);
          },
        }),
      );
      expect(recovery.ok).toBe(false);
      if (!recovery.ok) expect(recovery.reason).toContain("volatile job ids were unreadable");
      const settled = settleAcceptedOwnership(
        drain({ acceptedCount: 1, unaccountedSlots: 1 }),
        recovery,
        CLEAN_DISPOSAL,
      );
      expect(settled.ok).toBe(false);
      expect(settled.failures[0]).toContain("recovery failed");
    });

    // AND the accepting path all the way through: a real volatile id recovered for a
    // genuinely provisional record settles, and is counted as coverage that must still
    // prove it existed (`auditCoverageAfterRelease`, above).
    it("settles the activation-persistence-failed path through the hook", async () => {
      const verdict = judgeVolatileJobIdTexts(["opt_volatile_1"]);
      const recovery = await recoverAcceptedOwnership(
        source({
          readSessionRecord: async () => provisionalRecord(),
          readVolatileJobIds: async () => (verdict.ok ? verdict.ids : []),
        }),
      );
      expect(recovery.ok).toBe(true);
      const settled = settleAcceptedOwnership(
        drain({ acceptedCount: 1, unaccountedSlots: 1 }),
        recovery,
        CLEAN_DISPOSAL,
      );
      expect(settled.ok).toBe(true);
      expect(settled.ids).toEqual(["opt_volatile_1"]);
      expect(settled.coverage).toEqual(["opt_volatile_1"]);
    });
  });

  // D3. WIRING. Every judge above is pure and provable, which is exactly why it can
  // also be pure and UNCALLED: this round's audit found `auditCoverageAfterRelease`
  // fully unit-tested and never invoked by the hook, so the release-404 laundering path
  // it exists to close was still open in the real gate. A pure function nobody calls is
  // indistinguishable, from the outside, from one that does not exist.
  //
  // These are source scans — deliberately narrow, and anchored on the identifiers and
  // the decision expression rather than on prose, so a rename that keeps the behaviour
  // is a one-line update while a silent REMOVAL is red.
  describe("the assembled hook actually wires the judges it depends on", () => {
    const SPEC = readFileSync(resolve(__dirname, "../optimize-assembled-stream.spec.ts"), "utf8");

    it.each([
      ["the DOM authority's selector", "VOLATILE_JOB_ID_SELECTOR"],
      ["the DOM authority's judge", "judgeVolatileJobIdTexts("],
      ["the post-release coverage audit", "auditCoverageAfterRelease("],
      ["the fail-closed settlement", "settleAcceptedOwnership("],
      ["the two-authority recovery", "recoverAcceptedOwnership("],
    ])("calls %s", (_label, token) => {
      expect(SPEC).toContain(token);
    });

    // The volatile read must not scrape the `Job ID:` copy again. That coupling is the
    // whole reason the product now renders a stable hook.
    it("does not scrape the job-id PROSE any more", () => {
      expect(SPEC).not.toMatch(/\/\^Job ID:/);
      expect(SPEC).not.toMatch(/querySelectorAll\("p"\)/);
    });

    // A judge whose verdict does not reach the verdict changes nothing, so the success
    // condition itself is pinned: release converged AND ownership settled AND coverage
    // proved real.
    it("requires all three verdicts before calling cleanup successful", () => {
      expect(SPEC).toContain(
        "if (outcome.ok && settlementFailures.length === 0 && coverageAudit.ok) return;",
      );
    });

    // The hook must never REPLACE a primary failure with a cleanup failure, and must
    // clear the tracker so nothing leaks into the next test.
    it("preserves the primary failure and cannot contaminate the next test", () => {
      expect(SPEC).toContain("if (testInfo.status === testInfo.expectedStatus) {");
      expect(SPEC).toContain("acceptedTracker = null;");
    });
  });

  describe("recoverAcceptedOwnership consults BOTH authorities and never throws", () => {
    it("turns a durable-read rejection into a reason", async () => {
      const recovery = await recoverAcceptedOwnership(
        source({ readSessionRecord: () => Promise.reject(new Error("Target page closed")) }),
      );
      expect(recovery).toEqual({
        ok: false,
        reason: "page-side session record was unreadable: Target page closed",
      });
    });

    it("turns a volatile-read rejection into a reason", async () => {
      const recovery = await recoverAcceptedOwnership(
        source({ readVolatileJobIds: () => Promise.reject(new Error("page gone")) }),
      );
      expect(recovery).toEqual({
        ok: false,
        reason: "page-side volatile job ids were unreadable: page gone",
      });
    });

    it("recovers from a valid ACTIVE durable record", async () => {
      const recovery = await recoverAcceptedOwnership(
        source({ readSessionRecord: async () => activeRecord("job-page") }),
      );
      expect(recovery.ok).toBe(true);
      if (recovery.ok) expect(recovery.ids).toEqual(["job-page"]);
    });

    // THE ACTIVATION-PERSISTENCE-FAILED PATH. The 202 was accepted and a real job is
    // running, but the durable record deliberately stays PROVISIONAL and the id lives
    // only in volatile state. Consulting the durable record alone would report "no job
    // id" over a live solver.
    it("recovers a volatile id when the durable record is still provisional", async () => {
      const recovery = await recoverAcceptedOwnership(
        source({
          readSessionRecord: async () => provisionalRecord(),
          readVolatileJobIds: async () => ["job-volatile"],
        }),
      );
      expect(recovery.ok).toBe(true);
      if (recovery.ok) {
        expect(recovery.ids).toEqual(["job-volatile"]);
        expect(recovery.note).toContain("durable record holds no active job id");
      }
    });

    it("unions both authorities without duplicating a shared id", async () => {
      const recovery = await recoverAcceptedOwnership(
        source({
          readSessionRecord: async () => activeRecord("job-both"),
          readVolatileJobIds: async () => ["job-both", "job-extra"],
        }),
      );
      expect(recovery.ok).toBe(true);
      if (recovery.ok) expect(recovery.ids).toEqual(["job-both", "job-extra"]);
    });

    // PROVISIONAL-ONLY with no volatile id is NOT a clean "no job": it stays
    // unresolved, because we must not guess.
    it("yields nothing for provisional-only, so settlement stays red", async () => {
      const recovery = await recoverAcceptedOwnership(
        source({ readSessionRecord: async () => provisionalRecord() }),
      );
      expect(recovery.ok).toBe(true);
      if (recovery.ok) expect(recovery.ids).toEqual([]);
      expect(
        settleAcceptedOwnership(
          drain({ acceptedCount: 1, unaccountedSlots: 1 }),
          recovery,
          CLEAN_DISPOSAL,
        ).ok,
      ).toBe(false);
    });

    it("rejects an invalid volatile id rather than owning it", async () => {
      const recovery = await recoverAcceptedOwnership(
        source({ readVolatileJobIds: async () => [""] }),
      );
      expect(recovery).toEqual({
        ok: false,
        reason: "page reported an invalid volatile job id",
      });
    });

    it("reads the exact key and schema version the product writes", () => {
      expect(OPTIMIZE_SESSION_RECORD_KEY).toBe("nurse.optimize.session");
      expect(OPTIMIZE_SESSION_SCHEMA_VERSION).toBe(1);
    });
  });

  // THE COMPOSED PROOF. An unreadable accepted body, recovered from the page, must
  // drive the real release lifecycle to completion — otherwise "recovered" would be a
  // report with no consequence, which is the fail-open shape wearing a new label.
  describe("a recovered id is actually released, cancel -> terminal -> delete", () => {
    function fakeHttp(over: Partial<CleanupHttp> = {}) {
      const calls: string[] = [];
      let clock = 0;
      let polls = 0;
      const http: CleanupHttp = {
        post: async (url) => {
          calls.push(`POST ${url}`);
          return { status: 202, body: "" };
        },
        get: async (url) => {
          calls.push(`GET ${url}`);
          polls += 1;
          // First poll is still cancelling; then terminal. The 409-if-you-delete-too-
          // early hazard is the reason this wait exists at all.
          return polls === 1
            ? { status: 200, body: JSON.stringify({ state: "cancelling" }) }
            : { status: 200, body: JSON.stringify({ state: "cancelled" }) };
        },
        delete: async (url) => {
          calls.push(`DELETE ${url}`);
          return { status: 204, body: "" };
        },
        sleep: async (ms) => void (clock += ms),
        now: () => clock,
        ...over,
      };
      return { http, calls: () => calls };
    }

    it("cancels, waits for terminal, then deletes the recovered job", async () => {
      const drained = drain({
        acceptedCount: 1,
        unaccountedSlots: 1,
        slots: [{ kind: "unreadable", detail: "body gone" }],
      });
      const recovery = await recoverAcceptedOwnership(
        source({ readSessionRecord: async () => activeRecord("job-recovered") }),
      );
      const settled = settleAcceptedOwnership(drained, recovery, { orphaned: 0 });
      expect(settled.ok).toBe(true);

      const { http, calls } = fakeHttp();
      const outcome = await releaseLiveJobs(settled.ids, http);
      expect(outcome.ok).toBe(true);
      expect(calls()).toEqual([
        "POST /api/optimize/job-recovered/cancel",
        "GET /api/optimize/job-recovered",
        "GET /api/optimize/job-recovered",
        "DELETE /api/optimize/job-recovered",
      ]);
      // NO NEXT-TEST CONTAMINATION: the job is gone and nothing is left owned.
      expect(outcome.failures).toEqual([]);
    });

    it("releases MULTIPLE accepted jobs, and one failure cannot hide another", async () => {
      const { http, calls } = fakeHttp({
        post: async (url) => {
          if (url.includes("job-2")) throw new Error("socket hang up");
          return { status: 202, body: "" };
        },
      });
      const outcome = await releaseLiveJobs(["job-1", "job-2", "job-3"], http);
      expect(outcome.ok).toBe(false);
      // Every job was ATTEMPTED: job-2's transport error did not abort the loop.
      expect(outcome.steps.map((s) => s.split(":")[0])).toEqual([
        "job job-1",
        "job job-2",
        "job job-3",
      ]);
      expect(outcome.failures).toEqual([
        "job job-2: cancel request failed at the transport level: socket hang up",
      ]);
      expect(calls().filter((c) => c.startsWith("DELETE"))).toEqual([
        "DELETE /api/optimize/job-1",
        "DELETE /api/optimize/job-3",
      ]);
    });
  });

  // MUTATION PROOF. Reverting to the fail-open rule — "if the drain produced no ids,
  // there is nothing to release" — calls BOTH probe states success.
  const FAIL_OPEN_RULE = (drained: AcceptedDrainOutcome): boolean => drained.ids.length === 0;

  it("the fail-OPEN rule this replaces called both probe states successful", () => {
    for (const drained of [PENDING, UNREADABLE]) {
      expect(FAIL_OPEN_RULE(drained)).toBe(true); // "nothing to release" — the false green
      expect(settleAcceptedOwnership(drained, null, CLEAN_DISPOSAL).ok).toBe(false);
    }
  });
});

// P2-3. The abort lane's own complete budget, the third instance of the class.
describe("the abort lane's total budget enumerates EVERY sequential bound", () => {
  const EXPECTED_KEYS = [
    "injectObservationScript",
    "injectFixtureYaml",
    "fixtureSetup",
    "submitClick",
    "firstResponsePoll",
    "observationEvaluates",
    "abortNavigation",
    "abortUrlSettle",
    "bffObservationTail",
    "schedulerAllowance",
  ];

  it("enumerates exactly the expected bounds, in order", () => {
    expect([...ABORT_BOUND_KEYS]).toEqual(EXPECTED_KEYS);
  });

  it("totals the sum of every enumerated bound and nothing else", () => {
    const manual = EXPECTED_KEYS.reduce(
      (total, key) => total + ABORT_BOUNDS[key as keyof typeof ABORT_BOUNDS],
      0,
    );
    expect(ABORT_TEST_TIMEOUT).toBe(manual);
    // 5 + 5 init + 50 fixture + 5 submit + 15 first response + 5 observation
    // + 30 navigation + 30 URL settle + 2 BFF tail + 8 scheduler = 155s.
    expect(ABORT_TEST_TIMEOUT).toBe(155_000);
  });

  it("every bound is a positive finite number", () => {
    for (const key of ABORT_BOUND_KEYS) {
      const value = ABORT_BOUNDS[key];
      expect(Number.isFinite(value), key).toBe(true);
      expect(value, key).toBeGreaterThan(0);
    }
  });

  it("proves the default per-test budget was insufficient BY CONSTRUCTION", () => {
    // The review's enumeration reached >=137s of local bounds under a 30s default.
    const knownSequential =
      ABORT_BOUNDS.injectObservationScript +
      ABORT_BOUNDS.injectFixtureYaml +
      ABORT_BOUNDS.fixtureSetup +
      ABORT_BOUNDS.firstResponsePoll +
      ABORT_BOUNDS.abortNavigation +
      ABORT_BOUNDS.abortUrlSettle +
      ABORT_BOUNDS.bffObservationTail;
    expect(knownSequential).toBeGreaterThanOrEqual(137_000);
    expect(PLAYWRIGHT_DEFAULT_TEST_TIMEOUT).toBeLessThan(knownSequential);
  });

  it("bounds the submit click, whose action default is 0", () => {
    expect(ABORT_BOUNDS.submitClick).toBeGreaterThan(0);
  });

  it("reuses the shared init and fixture bounds rather than restating them", () => {
    expect(ABORT_BOUNDS.injectObservationScript).toBe(REPLAY_BOUNDS.injectObservationScript);
    expect(ABORT_BOUNDS.injectFixtureYaml).toBe(REPLAY_BOUNDS.injectFixtureYaml);
    expect(ABORT_BOUNDS.fixtureSetup).toBe(GOTO_FIXTURE_BOUNDS_TOTAL);
  });

  it("stays meaningfully inside the product's own solve limit", () => {
    expect(ABORT_TEST_TIMEOUT).toBeLessThan(PRODUCT_SOLVE_LIMIT);
    expect(PRODUCT_SOLVE_LIMIT - ABORT_TEST_TIMEOUT).toBeGreaterThanOrEqual(60_000);
  });

  it("keeps all three lane caps independent and bounded", () => {
    const caps = [TINY_TEST_TIMEOUT, REPLAY_TEST_TIMEOUT, ABORT_TEST_TIMEOUT];
    expect(new Set(caps).size).toBe(3);
    for (const cap of caps) expect(cap).toBeLessThan(PRODUCT_SOLVE_LIMIT);
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
    "injectObservationScript",
    "injectFixtureYaml",
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
    // 10s initialization (5+5) + 50s fixture setup (20+5+5+5+5+5+5)
    // + 15s submit/arm (5+10) + 72s stream phases (15+12+10+15+20)
    // + 75s evaluate/navigation (30+20+5+20) + 8s scheduler allowance = 230s.
    expect(REPLAY_TEST_TIMEOUT).toBe(230_000);
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
    "injectObservationScript",
    "injectFixtureYaml",
    "fixtureSetup",
    "submitClick",
    "acceptedIdPoll",
    "sseResponsePoll",
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
    // 5 + 5 init + 50 fixture + 5 submit + 15 accepted-id poll
    // + 15 sse-response poll + 5 observation + 90 completion + 30 slot freed
    // + 8 scheduler = 228s.
    expect(TINY_TEST_TIMEOUT).toBe(228_000);
  });

  it("counts the TWO sequential polls separately, not once", () => {
    // The tiny test runs an accepted-id poll AND an SSE-response poll, each 15s. A
    // single shared key covered both call sites with one entry, so the advertised
    // ceiling was 15s short of the schedule the test can actually run.
    expect(TINY_BOUNDS.acceptedIdPoll).toBe(15_000);
    expect(TINY_BOUNDS.sseResponsePoll).toBe(15_000);
    expect(TINY_BOUNDS.acceptedIdPoll + TINY_BOUNDS.sseResponsePoll).toBe(30_000);
  });

  it("counts EACH addInitScript call separately, in both budgets", () => {
    // `injectYaml` makes two sequential `addInitScript` calls. One arithmetic-only
    // entry could not distinguish an omitted call from a fast one, and the replay
    // budget had no initialization entry at all despite calling the same helper.
    expect(TINY_BOUNDS.injectObservationScript).toBe(5_000);
    expect(TINY_BOUNDS.injectFixtureYaml).toBe(5_000);
    expect(REPLAY_BOUNDS.injectObservationScript).toBe(TINY_BOUNDS.injectObservationScript);
    expect(REPLAY_BOUNDS.injectFixtureYaml).toBe(TINY_BOUNDS.injectFixtureYaml);
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
      TINY_BOUNDS.injectObservationScript +
      TINY_BOUNDS.injectFixtureYaml +
      TINY_BOUNDS.fixtureSetup +
      TINY_BOUNDS.submitClick +
      TINY_BOUNDS.acceptedIdPoll +
      TINY_BOUNDS.sseResponsePoll +
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
      TINY_BOUNDS.injectObservationScript +
      TINY_BOUNDS.injectFixtureYaml +
      TINY_BOUNDS.fixtureSetup +
      TINY_BOUNDS.submitClick +
      TINY_BOUNDS.acceptedIdPoll +
      TINY_BOUNDS.sseResponsePoll +
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
describe("parseEventsRequestUrl enforces the exact canonical events path AND origin", () => {
  it("accepts the canonical relative path resolved against the page origin", () => {
    expect(parseEventsRequestUrl(`/api/optimize/${JOB}/events`, ORIGIN)).toEqual({
      ok: true,
      jobId: JOB,
    });
  });

  it("accepts an absolute URL ONLY on the page origin, which is what a Request exposes", () => {
    expect(parseEventsRequestUrl(`${ORIGIN}/api/optimize/${JOB}/events`, ORIGIN)).toEqual({
      ok: true,
      jobId: JOB,
    });
  });

  it("ignores a default-port spelling difference between equal origins", () => {
    expect(
      parseEventsRequestUrl(`http://localhost/api/optimize/${JOB}/events`, "http://localhost:80"),
    ).toEqual({ ok: true, jobId: JOB });
  });

  it("decodes a percent-encoded job segment", () => {
    const weird = "job with spaces/and-slash";
    const encoded = encodeURIComponent(weird);
    expect(parseEventsRequestUrl(`/api/optimize/${encoded}/events`, ORIGIN)).toEqual({
      ok: true,
      jobId: weird,
    });
  });

  // THE FINDING THIS ROUND CLOSED. Absolute and protocol-relative URLs were parsed
  // for path and encoding but never bound to an origin, so a foreign host carrying
  // the right job on the right path passed.
  const ORIGIN_REJECTED: Array<[string, string, string | null]> = [
    ["a foreign absolute https host", `https://foreign.example/api/optimize/${JOB}/events`, ORIGIN],
    ["a foreign absolute http host", `http://foreign.example/api/optimize/${JOB}/events`, ORIGIN],
    ["a foreign port on the right host", `http://localhost:9/api/optimize/${JOB}/events`, ORIGIN],
    [
      "a foreign scheme on the right host",
      `https://localhost:51236/api/optimize/${JOB}/events`,
      "http://localhost:51236",
    ],
  ];

  it.each(ORIGIN_REJECTED)("rejects %s", (_label, url, origin) => {
    const parsed = parseEventsRequestUrl(url, origin);
    expect(parsed.ok).toBe(false);
    // Absolute forms are now caught by the RAW authority check, which runs before any
    // normalization; the post-normalization origin comparison remains as a backstop.
    if (!parsed.ok) expect(parsed.reason).toMatch(/is not the (canonical|page) origin/);
  });

  // THE FINDING THIS ROUND CLOSED. `new URL()` normalizes each of these
  // SAME-ORIGIN raw spellings into the canonical pathname, so validating after
  // normalization made all four green. The raw form is now judged first.
  const SAME_ORIGIN_ALIASES: Array<[string, string, RegExp]> = [
    [
      "a path-relative URL with no leading slash",
      `api/optimize/${JOB}/events`,
      /path-relative URLs are not part/,
    ],
    [
      "a same-origin protocol-relative URL",
      `//localhost:51236/api/optimize/${JOB}/events`,
      /protocol-relative URLs are not part/,
    ],
    ["a dot-segment alias", `/api/optimize/old/../${JOB}/events`, /raw path does not match/],
    [
      "a leading/trailing whitespace alias",
      `  /api/optimize/${JOB}/events  `,
      /leading or trailing whitespace/,
    ],
    ["an inner-whitespace alias", `/api/optimize/${JOB}/ events`, /whitespace inside the URL/],
    ["a backslash alias", `\\api\\optimize\\${JOB}\\events`, /backslashes are not canonical/],
    [
      "a dot-segment alias inside an absolute same-origin URL",
      `${ORIGIN}/api/optimize/old/../${JOB}/events`,
      /raw path does not match/,
    ],
    ["a same-origin absolute URL with no path", ORIGIN, /absolute URL has no path/],
    ["a non-http scheme", `ftp://localhost:51236/api/optimize/${JOB}/events`, /only http\(s\)/],
  ];

  it.each(SAME_ORIGIN_ALIASES)("rejects %s", (_label, url, reason) => {
    const parsed = parseEventsRequestUrl(url, ORIGIN);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(reason);
  });

  it("rejects a protocol-relative FOREIGN host before it can be normalized", () => {
    const parsed = parseEventsRequestUrl(`//foreign.example/api/optimize/${JOB}/events`, ORIGIN);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/protocol-relative URLs are not part/);
  });

  it("rejects credentials embedded in an otherwise correct URL", () => {
    const parsed = parseEventsRequestUrl(
      `http://user:pass@localhost:51236/api/optimize/${JOB}/events`,
      "http://localhost:51236",
    );
    expect(parsed.ok).toBe(false);
    // Caught by the raw authority check now (`user:pass@localhost:51236` is not the
    // canonical origin) rather than by the post-normalization credential check.
    if (!parsed.ok) expect(parsed.reason).toMatch(/is not the canonical origin/);
  });

  it("fails closed when the expected origin is missing or invalid", () => {
    for (const bad of [null, "", "not-a-url", "ftp://localhost", "http://u:p@localhost"]) {
      const parsed = parseEventsRequestUrl(`/api/optimize/${JOB}/events`, bad);
      expect(parsed.ok, String(bad)).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/no valid expected origin/);
    }
  });

  it("normalizes usable origins and refuses unusable ones", () => {
    expect(normalizeExpectedOrigin("http://localhost:51236/ignored/path")).toBe(
      "http://localhost:51236",
    );
    expect(normalizeExpectedOrigin("https://example.test")).toBe("https://example.test");
    for (const bad of [null, undefined, "", "nope", "ftp://x", "http://u:p@h"]) {
      expect(normalizeExpectedOrigin(bad), String(bad)).toBeNull();
    }
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
    // A bare word has no leading slash and no scheme, so it is rejected as
    // path-relative before any normalization can rewrite it.
    ["a bare word", "events", /path-relative URLs are not part/],
    ["an empty string", "", /empty URL/],
    [
      "a non-canonical encoding of a plain id",
      "/api/optimize/job%2Dplain/events",
      /not a canonical encodeURIComponent spelling/,
    ],
  ];

  it.each(REJECTED)("rejects %s", (_label, url, reason) => {
    const parsed = parseEventsRequestUrl(url, ORIGIN);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(reason);
  });

  // A malformed percent-escape would throw inside `decodeURIComponent`; the parser
  // must convert that into a reason rather than propagate it.
  it("rejects an invalid percent-escape without throwing", () => {
    const parsed = parseEventsRequestUrl("/api/optimize/%E0%A4%A/events", ORIGIN);
    expect(parsed.ok).toBe(false);
  });
});

// P2-1. Validating the raw PATH was not enough: `new URL()` also normalizes the
// AUTHORITY, so every alias below reached `parsed.origin === origin` already rewritten
// into the canonical spelling. Each one was measured against Node's own `URL` and
// confirmed to normalize onto the expected origin, so each was a real false green.
describe("parseEventsRequestUrl judges the RAW authority, before normalization", () => {
  // Direct cases. `reason` is asserted exactly so a case cannot be satisfied by some
  // OTHER rejection (a path or scheme complaint) and silently stop testing authority.
  const AUTHORITY_ALIASES: Array<[string, string, string]> = [
    [
      "an uppercase host",
      `http://LOCALHOST:51236/api/optimize/${JOB}/events`,
      "http://LOCALHOST:51236",
    ],
    [
      "a mixed-case host",
      `http://LocalHost:51236/api/optimize/${JOB}/events`,
      "http://LocalHost:51236",
    ],
    [
      "a percent-encoded host",
      `http://%6cocalhost:51236/api/optimize/${JOB}/events`,
      "http://%6cocalhost:51236",
    ],
    [
      "an empty credential delimiter",
      `http://@localhost:51236/api/optimize/${JOB}/events`,
      "http://@localhost:51236",
    ],
    [
      "a zero-padded port",
      `http://localhost:051236/api/optimize/${JOB}/events`,
      "http://localhost:051236",
    ],
    [
      "a trailing-dot host",
      `http://localhost.:51236/api/optimize/${JOB}/events`,
      "http://localhost.:51236",
    ],
  ];

  it.each(AUTHORITY_ALIASES)("rejects %s", (_label, url, rawAuthority) => {
    const parsed = parseEventsRequestUrl(url, ORIGIN);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe(
        `raw authority ${rawAuthority} is not the canonical origin ${ORIGIN}`,
      );
    }
  });

  // Noncanonical IPv4 literals, which need a host-only expected origin to be the
  // false green they were: `new URL` renders each of these as `127.0.0.1`.
  const IPV4_ALIASES: Array<[string, string]> = [
    ["integer IPv4", "http://2130706433"],
    ["hex IPv4", "http://0x7f000001"],
    ["short-form IPv4", "http://127.1"],
  ];

  it.each(IPV4_ALIASES)("rejects a noncanonical %s literal", (_label, authority) => {
    const parsed = parseEventsRequestUrl(
      `${authority}/api/optimize/${JOB}/events`,
      "http://127.0.0.1",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe(
        `raw authority ${authority} is not the canonical origin http://127.0.0.1`,
      );
    }
  });

  // The greens the repair must NOT break.
  it("still accepts the canonical same-origin absolute form a Request exposes", () => {
    expect(parseEventsRequestUrl(`${ORIGIN}/api/optimize/${JOB}/events`, ORIGIN)).toEqual({
      ok: true,
      jobId: JOB,
    });
  });

  it("still accepts the canonical root-relative form, which has no authority", () => {
    expect(parseEventsRequestUrl(`/api/optimize/${JOB}/events`, ORIGIN)).toEqual({
      ok: true,
      jobId: JOB,
    });
  });

  // THE ONE documented equivalence, both directions of both default ports.
  it.each([
    [
      "http with an explicit :80",
      `http://localhost:80/api/optimize/${JOB}/events`,
      "http://localhost",
    ],
    [
      "http with an elided :80",
      `http://localhost/api/optimize/${JOB}/events`,
      "http://localhost:80",
    ],
    [
      "https with an explicit :443",
      `https://localhost:443/api/optimize/${JOB}/events`,
      "https://localhost",
    ],
    [
      "https with an elided :443",
      `https://localhost/api/optimize/${JOB}/events`,
      "https://localhost:443",
    ],
  ])("preserves the documented default-port equivalence: %s", (_label, url, origin) => {
    expect(parseEventsRequestUrl(url, origin)).toEqual({ ok: true, jobId: JOB });
  });

  // The allowance is DEFAULT-port only: it must not license an arbitrary port, and it
  // must not license the wrong scheme's default.
  it.each([
    [
      "a non-default port against a portless origin",
      `http://localhost:8080/api/optimize/${JOB}/events`,
      "http://localhost",
    ],
    [
      "http's default against an https origin",
      `https://localhost:80/api/optimize/${JOB}/events`,
      "https://localhost",
    ],
    [
      "https's default against an http origin",
      `http://localhost:443/api/optimize/${JOB}/events`,
      "http://localhost",
    ],
    [
      "a default port against an origin that already has an explicit one",
      `http://localhost:80/api/optimize/${JOB}/events`,
      "http://localhost:51236",
    ],
  ])("does not extend the default-port allowance to %s", (_label, url, origin) => {
    const parsed = parseEventsRequestUrl(url, origin);
    expect(parsed.ok).toBe(false);
  });

  it("judges the raw authority directly, with the origin already canonical", () => {
    expect(isCanonicalRawAuthority("http://localhost:51236", ORIGIN)).toBe(true);
    expect(isCanonicalRawAuthority("http://localhost:80", "http://localhost")).toBe(true);
    expect(isCanonicalRawAuthority("https://h:443", "https://h")).toBe(true);
    expect(isCanonicalRawAuthority("http://LOCALHOST:51236", ORIGIN)).toBe(false);
    expect(isCanonicalRawAuthority("http://localhost:51236:", ORIGIN)).toBe(false);
    expect(isCanonicalRawAuthority("http://localhost", ORIGIN)).toBe(false);
  });

  // MIXED evidence. The authority judge must never accept a run because MOST of its
  // URLs were canonical: one aliased URL among canonical ones is still a rejection,
  // and the reason must name the alias rather than a generic count.
  it("rejects a run that mixes canonical URLs with ONE aliased authority", () => {
    const verdict = judgeEventsAuthority(
      [
        `/api/optimize/${JOB}/events`,
        `${ORIGIN}/api/optimize/${JOB}/events`,
        `http://%6cocalhost:51236/api/optimize/${JOB}/events`,
      ],
      JOB,
      ORIGIN,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual([
      `events URL rejected (raw authority http://%6cocalhost:51236 is not the canonical origin ${ORIGIN})`,
    ]);
  });

  it("accepts a run whose canonical relative and absolute forms are mixed", () => {
    const verdict = judgeEventsAuthority(
      [`/api/optimize/${JOB}/events`, `${ORIGIN}/api/optimize/${JOB}/events`],
      JOB,
      ORIGIN,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  // MUTATION PROOF. `NORMALIZED_AUTHORITY_JUDGE` is the exact pre-repair shape: raw
  // PATH validated first (that closure holds), but the authority compared only AFTER
  // `new URL` normalization. It is kept here as a committed adversarial baseline, and
  // asserted to ACCEPT every alias the current judge rejects.
  const NORMALIZED_AUTHORITY_JUDGE = (url: string, origin: string): boolean => {
    if (url !== url.trim()) return false;
    if (/\s/.test(url) || url.includes("\\") || url.includes("?") || url.includes("#"))
      return false;
    let rawPath: string;
    if (url.startsWith("//")) return false;
    if (url.startsWith("/")) {
      rawPath = url;
    } else if (/^https?:\/\//.test(url)) {
      const authorityEnd = url.indexOf("/", url.indexOf("://") + 3);
      if (authorityEnd === -1) return false;
      rawPath = url.slice(authorityEnd);
    } else {
      return false;
    }
    if (!/^\/api\/optimize\/([^/]+)\/events$/.test(rawPath)) return false;
    let parsed: URL;
    try {
      parsed = new URL(url, origin);
    } catch {
      return false;
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) return false;
    return parsed.origin === origin; // <-- the normalized comparison, the whole defect
  };

  it.each(AUTHORITY_ALIASES.filter(([label]) => label !== "a trailing-dot host"))(
    "the normalized-authority judge this replaces ACCEPTED %s",
    (_label, url) => {
      expect(NORMALIZED_AUTHORITY_JUDGE(url, ORIGIN)).toBe(true); // the false green
      expect(parseEventsRequestUrl(url, ORIGIN).ok).toBe(false); // now red
    },
  );

  it.each(IPV4_ALIASES)(
    "the normalized-authority judge this replaces ACCEPTED %s",
    (_label, authority) => {
      const url = `${authority}/api/optimize/${JOB}/events`;
      expect(NORMALIZED_AUTHORITY_JUDGE(url, "http://127.0.0.1")).toBe(true); // the false green
      expect(parseEventsRequestUrl(url, "http://127.0.0.1").ok).toBe(false); // now red
    },
  );

  // The baseline must still be a FAITHFUL replica: it has to keep the closures the
  // previous round landed, or "it used to accept this" would prove nothing.
  it("the baseline retains the raw-PATH closures, so only authority differs", () => {
    for (const aliased of [
      `api/optimize/${JOB}/events`,
      `//localhost:51236/api/optimize/${JOB}/events`,
      `/api/optimize/old/../${JOB}/events`,
      `  /api/optimize/${JOB}/events  `,
    ]) {
      expect(NORMALIZED_AUTHORITY_JUDGE(aliased, ORIGIN)).toBe(false);
    }
    // And it accepts what it should: the canonical forms.
    expect(NORMALIZED_AUTHORITY_JUDGE(`/api/optimize/${JOB}/events`, ORIGIN)).toBe(true);
    expect(NORMALIZED_AUTHORITY_JUDGE(`${ORIGIN}/api/optimize/${JOB}/events`, ORIGIN)).toBe(true);
  });
});

describe("judgeEventsAuthority fails closed and never discards evidence", () => {
  it("accepts a run whose every events request targets the active job", () => {
    const verdict = judgeEventsAuthority(
      [`/api/optimize/${JOB}/events`, `/api/optimize/${JOB}/events`],
      JOB,
      ORIGIN,
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
      ORIGIN,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toMatch(/events URL rejected \(raw path does not match/);
  });

  it("rejects canonical + suffix", () => {
    const verdict = judgeEventsAuthority(
      [`/api/optimize/${JOB}/events`, `/api/optimize/${JOB}/events/old`],
      JOB,
      ORIGIN,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
  });

  it("rejects canonical + a foreign-job canonical path", () => {
    const verdict = judgeEventsAuthority(
      [`/api/optimize/${JOB}/events`, `/api/optimize/${OTHER_JOB}/events`],
      JOB,
      ORIGIN,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toMatch(/targets job "job_ffff/);
    // Both ids are still reported, so the diagnostic shows what was seen.
    expect(verdict.jobIds).toEqual([JOB, OTHER_JOB]);
  });

  it("rejects a query string even on the right job", () => {
    const verdict = judgeEventsAuthority([`/api/optimize/${JOB}/events?x=1`], JOB, ORIGIN);
    expect(verdict.ok).toBe(false);
  });

  it("rejects canonical + a foreign ABSOLUTE origin carrying the right job", () => {
    const verdict = judgeEventsAuthority(
      [`/api/optimize/${JOB}/events`, `https://foreign.example/api/optimize/${JOB}/events`],
      JOB,
      ORIGIN,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toMatch(/is not the (canonical|page) origin/);
  });

  it("rejects canonical + a PROTOCOL-RELATIVE foreign host", () => {
    const verdict = judgeEventsAuthority(
      [`/api/optimize/${JOB}/events`, `//foreign.example/api/optimize/${JOB}/events`],
      JOB,
      ORIGIN,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toMatch(/protocol-relative URLs are not part/);
  });

  // MIXED captures: one canonical URL alongside each same-origin alias. The judge
  // must fail closed on the alias rather than being satisfied by its canonical
  // neighbour, which is how a partial client regression would present.
  it.each([
    ["path-relative", `api/optimize/${JOB}/events`],
    ["protocol-relative", `//localhost:51236/api/optimize/${JOB}/events`],
    ["dot-segment", `/api/optimize/old/../${JOB}/events`],
    ["whitespace", `  /api/optimize/${JOB}/events  `],
    ["backslash", `\\api\\optimize\\${JOB}\\events`],
  ])("rejects canonical + a same-origin %s alias", (_label, alias) => {
    const verdict = judgeEventsAuthority([`/api/optimize/${JOB}/events`, alias], JOB, ORIGIN);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toMatch(/^events URL rejected \(/);
    // The canonical neighbour is still reported, so the diagnostic shows both.
    expect(verdict.jobIds).toEqual([JOB]);
  });

  it("fails closed with no expected ORIGIN to compare against", () => {
    for (const missing of [null, "", "not-a-url"]) {
      const verdict = judgeEventsAuthority([`/api/optimize/${JOB}/events`], JOB, missing);
      expect(verdict.ok, String(missing)).toBe(false);
      expect(verdict.failures[0]).toMatch(/no valid expected origin/);
    }
  });

  it("fails closed with no observed events request at all", () => {
    const verdict = judgeEventsAuthority([], JOB, ORIGIN);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual(["no events request was observed at all"]);
  });

  it("fails closed with no authority to compare against", () => {
    for (const missing of [null, ""]) {
      const verdict = judgeEventsAuthority([`/api/optimize/${JOB}/events`], missing, ORIGIN);
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
