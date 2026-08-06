// Solved-baseline identity (F3). The point of these tests is that the digest is
// SENSITIVE to everything it claims to cover and INSENSITIVE to nothing else — a
// hash that ignored a swapped person or a numeric/string id difference would let a
// tampered file import cleanly.

import { describe, expect, it } from "vitest";
import { canonicalBaselineJson, computeSolvedBaselineId, isSolvedBaselineId } from "./baseline";
import type { RosterBaselineInput } from "./baseline";
import type { RosterDayState } from "./types";

const D: RosterDayState = { kind: "shift", shiftId: "D" };
const N: RosterDayState = { kind: "shift", shiftId: "N" };
const OFF: RosterDayState = { kind: "off" };

function baseInput(): RosterBaselineInput {
  return {
    people: [{ id: "Alice Ng" }, { id: 7 }],
    dates: [{ iso: "2026-07-03" }, { iso: "2026-07-04" }],
    solvedDays: [
      [D, OFF],
      [N, D],
    ],
  };
}

describe("computeSolvedBaselineId", () => {
  it("is a 64-hex SHA-256 digest, stable across calls", async () => {
    const first = await computeSolvedBaselineId(baseInput());
    const second = await computeSolvedBaselineId(baseInput());
    expect(isSolvedBaselineId(first)).toBe(true);
    expect(second).toBe(first);
  });

  it("is insensitive to object key ORDER but sensitive to array order", async () => {
    const reordered: RosterBaselineInput = {
      ...baseInput(),
      solvedDays: [
        // Same day-states, keys written in the other order.
        [{ shiftId: "D", kind: "shift" } as RosterDayState, OFF],
        [N, D],
      ],
    };
    expect(await computeSolvedBaselineId(reordered)).toBe(
      await computeSolvedBaselineId(baseInput()),
    );

    const swappedPeople: RosterBaselineInput = {
      ...baseInput(),
      people: [{ id: 7 }, { id: "Alice Ng" }],
    };
    expect(await computeSolvedBaselineId(swappedPeople)).not.toBe(
      await computeSolvedBaselineId(baseInput()),
    );
  });

  it("distinguishes a numeric person id from the same-looking string id", async () => {
    const numeric = await computeSolvedBaselineId({
      ...baseInput(),
      people: [{ id: 7 }, { id: 8 }],
    });
    const stringy = await computeSolvedBaselineId({
      ...baseInput(),
      people: [{ id: "7" }, { id: "8" }],
    });
    expect(numeric).not.toBe(stringy);
    // And the reason is visible in the canonicalization, not just the digest.
    expect(canonicalBaselineJson({ ...baseInput(), people: [{ id: 7 }, { id: 8 }] })).toContain(
      '"people":[7,8]',
    );
    expect(canonicalBaselineJson({ ...baseInput(), people: [{ id: "7" }, { id: "8" }] })).toContain(
      '"people":["7","8"]',
    );
  });

  it("distinguishes a numeric shift id from the same-looking string shift id", async () => {
    const numeric = await computeSolvedBaselineId({
      ...baseInput(),
      solvedDays: [
        [{ kind: "shift", shiftId: 1 }, OFF],
        [N, D],
      ],
    });
    const stringy = await computeSolvedBaselineId({
      ...baseInput(),
      solvedDays: [
        [{ kind: "shift", shiftId: "1" }, OFF],
        [N, D],
      ],
    });
    expect(numeric).not.toBe(stringy);
  });

  it("changes when any single covered value changes", async () => {
    const base = await computeSolvedBaselineId(baseInput());
    const mutations: RosterBaselineInput[] = [
      { ...baseInput(), people: [{ id: "Alice Ng" }, { id: 8 }] },
      { ...baseInput(), dates: [{ iso: "2026-07-03" }, { iso: "2026-07-05" }] },
      {
        ...baseInput(),
        solvedDays: [
          [N, OFF],
          [N, D],
        ],
      },
      {
        ...baseInput(),
        solvedDays: [
          [D, { kind: "leave" }],
          [N, D],
        ],
      },
    ];
    for (const mutation of mutations) {
      expect(await computeSolvedBaselineId(mutation)).not.toBe(base);
    }
  });

  it("stamps the baseline schema version into the canonicalization", () => {
    expect(canonicalBaselineJson(baseInput())).toContain('"schemaVersion":"roster-baseline/1"');
  });

  it("rejects anything that is not a SHA-256 hex digest", () => {
    expect(isSolvedBaselineId("")).toBe(false);
    expect(isSolvedBaselineId("a".repeat(63))).toBe(false);
    expect(isSolvedBaselineId("A".repeat(64))).toBe(false);
    expect(isSolvedBaselineId("g".repeat(64))).toBe(false);
    expect(isSolvedBaselineId(42)).toBe(false);
  });
});
