// Shared fixtures for the proposal suites. Not a test file (vitest collects
// `*.test.ts*` only), so it may be imported freely -- including by the repository
// and adapter suites, which must exercise the SAME documents as the pure ones.

import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";

/**
 * A small authored ward, chosen so every arm has something real to act on:
 *
 *   • a one-month range, so date ids are the two-digit `DD` form and a shrink
 *     purges references without re-keying the survivors;
 *   • a LEAVE pin inside the range (the operational-confirmation case);
 *   • a request and an off-preference that a range shrink destroys (the cascade);
 *   • one single-target requirement (adjustable) and one multi-target requirement
 *     (the unsupported shape both surfaces refuse).
 */
export function proposalScenario(): ScenarioUiState {
  return {
    ...createEmptyScenarioUiState(),
    rangeStart: "2026-04-01",
    rangeEnd: "2026-04-30",
    staff: [
      { _k: "p1", id: "ana" },
      { _k: "p2", id: "bo" },
    ],
    shifts: [
      { _k: "s1", id: "Day" },
      { _k: "s2", id: "Night" },
    ],
    dateGroups: [{ _k: "g1", id: "Handover days", members: ["04", "05"] }],
    reqData: [
      { uid: "cell-leave", person: "ana", date: "02", kind: "leave" },
      { uid: "cell-off", person: "bo", date: "29", kind: "off", weight: -5 },
      { uid: "cell-req", person: "ana", date: "07", kind: "request", shiftType: "Day", weight: 3 },
    ],
    cardsByKind: {
      requirements: [
        {
          uid: "req-day",
          description: "Day cover",
          shiftType: "Day",
          requiredNumPeople: 2,
          weight: Number.POSITIVE_INFINITY,
        },
        {
          uid: "req-multi",
          description: "Day or Night cover",
          shiftType: ["Day", "Night"],
          requiredNumPeople: 3,
          weight: Number.POSITIVE_INFINITY,
        },
      ],
      successions: [],
      counts: [],
      affinities: [],
      coverings: [],
    },
  };
}

/** The registry stamp fixtures prepare under. */
export const FIXTURE_STAMP = {
  appBuildVersion: "test-build",
  manifestSha256: "test-manifest",
} as const;
