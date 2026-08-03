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
  CURSOR_VERSION,
  decodePublicCursor,
  FIRST_BYTE_TIMEOUT,
  JUDGE_POLL_TIMEOUT,
  judgeReplayEvidence,
  KEEPALIVE_WINDOW,
  PLAYWRIGHT_DEFAULT_TEST_TIMEOUT,
  REPLAY_PHASE_BOUNDS,
  REPLAY_SETUP_MARGIN,
  REPLAY_TEST_TIMEOUT,
  RESUMED_HEADER_TIMEOUT,
  RESUMED_SCREEN_TIMEOUT,
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

// P2-2's derivation, asserted rather than asserted-in-a-comment. The point is not
// that 120s is a nice number — it is that the sum of the test's OWN phase bounds
// already exceeds the default budget, so the default could never have covered a run
// in which every phase behaved legitimately-slowly.
describe("the live replay test's total budget is derived from its phase bounds", () => {
  it("sums exactly the five explicit phase bounds", () => {
    expect(REPLAY_PHASE_BOUNDS).toBe(
      FIRST_BYTE_TIMEOUT +
        KEEPALIVE_WINDOW +
        RESUMED_SCREEN_TIMEOUT +
        RESUMED_HEADER_TIMEOUT +
        JUDGE_POLL_TIMEOUT,
    );
    expect(REPLAY_PHASE_BOUNDS).toBe(72_000);
  });

  it("proves the default per-test budget was insufficient BY CONSTRUCTION", () => {
    // Not "was unlucky": 30s < 72s, so worst-case legitimate phase timing could not
    // fit regardless of host speed.
    expect(PLAYWRIGHT_DEFAULT_TEST_TIMEOUT).toBeLessThan(REPLAY_PHASE_BOUNDS);
  });

  it("is sufficient for worst-case legitimate phase timing, and still bounded", () => {
    expect(REPLAY_TEST_TIMEOUT).toBeGreaterThan(REPLAY_PHASE_BOUNDS);
    expect(REPLAY_TEST_TIMEOUT).toBe(REPLAY_PHASE_BOUNDS + REPLAY_SETUP_MARGIN);
    expect(REPLAY_TEST_TIMEOUT).toBe(120_000);
    // Bounded: a cap that drifts toward "effectively none" would stop being a cap.
    // The solver's own native default is 300s, so the budget must stay well inside
    // it — a genuinely wedged run still fails instead of hanging the gate.
    expect(REPLAY_TEST_TIMEOUT).toBeLessThan(300_000);
  });

  it("leaves the margin proportionate rather than open-ended", () => {
    // The unbounded-by-constant steps (fixture setup, submit, reload navigation)
    // get less headroom than the explicitly-bounded phases they accompany.
    expect(REPLAY_SETUP_MARGIN).toBeLessThan(REPLAY_PHASE_BOUNDS);
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
    const joined = judged.failures.join(" | ");
    // Named at every bound point, so the diagnostic says which parts disagreed.
    expect(joined).toMatch(/pre-reload cursor is bound to job "job_ffff/);
    expect(joined).toMatch(/recorded id is bound to job "job_ffff/);
    expect(joined).toMatch(/durable cursor is bound to job "job_ffff/);
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
  // `expectRules` is the EXACT set of named failures each case must produce — not a
  // loose `/bound to job/` match. The review's point stands: a joined match let the
  // foreign-only case be satisfied by either binding rule, which is how the
  // cursor-specific diagnostic looked independently protected when it is not.
  const FALSE_GREENS: Array<{ label: string; input: ReplayEvidence; expectRules: RegExp[] }> = [
    {
      label: "a duplicated new id",
      input: evidence({
        rawIds: [cursor(JOB, N1), cursor(JOB, N1)],
        cursorAfter: cursor(JOB, N1),
      }),
      expectRules: [/post-reload frame ids are not unique/],
    },
    {
      label: "a foreign-job id only",
      input: evidence({
        rawIds: [cursor(OTHER_JOB, N1)],
        cursorAfter: cursor(OTHER_JOB, N1),
      }),
      // BOTH fire here, and both are asserted by name: the per-id rule and the
      // cursor-specific diagnostic. The latter is a refinement of the former, not a
      // separate gate — see `judgeReplayEvidence`'s contract note.
      expectRules: [/recorded id is bound to job/, /durable cursor is bound to job/],
    },
    {
      label: "a valid id mixed with a foreign-job id",
      input: evidence({
        rawIds: [cursor(JOB, N1), cursor(OTHER_JOB, N2)],
        cursorAfter: cursor(JOB, N1),
      }),
      // Only the per-id rule fires: the cursor itself is legitimately bound.
      expectRules: [/recorded id is bound to job/],
    },
  ];

  it.each(FALSE_GREENS)("$label was ACCEPTED by the shipped predicate", ({ input }) => {
    expect(HISTORICAL_PREDICATE(input)).toBe(true);
  });

  it.each(FALSE_GREENS)("$label is REJECTED by the judge", ({ input, expectRules }) => {
    const judged = judgeReplayEvidence(input);
    expect(judged.ok).toBe(false);
    const joined = judged.failures.join(" | ");
    for (const rule of expectRules) expect(joined).toMatch(rule);
  });

  // The mixed case must NOT report a cursor-binding failure — asserting the exact
  // rule set means a future judge that blamed the cursor for a foreign sibling id
  // would be caught rather than passing on a substring.
  it("does not blame the cursor when only a sibling id is foreign", () => {
    const judged = judgeReplayEvidence(
      evidence({
        rawIds: [cursor(JOB, N1), cursor(OTHER_JOB, N2)],
        cursorAfter: cursor(JOB, N1),
      }),
    );
    expect(judged.failures.join(" | ")).not.toMatch(/durable cursor is bound to job/);
  });
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
