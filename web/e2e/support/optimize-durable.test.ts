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
  judgeReplayEvidence,
  type ReplayEvidence,
} from "./optimize-durable";

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
 * baseline for the three false greens.
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

describe("judgeReplayEvidence — the three false greens the old predicate accepted", () => {
  const FALSE_GREENS: Array<{ label: string; input: ReplayEvidence; expect: RegExp }> = [
    {
      label: "a duplicated new id",
      input: evidence({
        rawIds: [cursor(JOB, N1), cursor(JOB, N1)],
        cursorAfter: cursor(JOB, N1),
      }),
      expect: /not unique/,
    },
    {
      label: "a foreign-job id only",
      input: evidence({
        rawIds: [cursor(OTHER_JOB, N1)],
        cursorAfter: cursor(OTHER_JOB, N1),
      }),
      expect: /bound to job/,
    },
    {
      label: "a valid id mixed with a foreign-job id",
      input: evidence({
        rawIds: [cursor(JOB, N1), cursor(OTHER_JOB, N2)],
        cursorAfter: cursor(JOB, N1),
      }),
      expect: /bound to job/,
    },
  ];

  it.each(FALSE_GREENS)("$label was ACCEPTED by the shipped predicate", ({ input }) => {
    expect(HISTORICAL_PREDICATE(input)).toBe(true);
  });

  it.each(FALSE_GREENS)("$label is REJECTED by the judge", ({ input, expect: pattern }) => {
    const judged = judgeReplayEvidence(input);
    expect(judged.ok).toBe(false);
    expect(judged.failures.join(" | ")).toMatch(pattern);
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
