// Solver-equivalence fixtures for temporary cover (d582 Task 6). Each pair is
// written as strict YAML and solved by core/tests/test_temporary_cover_equivalence.py
// with the real CP-SAT solver. Regenerate with
// `pnpm vitest run lib/scenario/temporary-cover.fixtures -u`.
//
// The split pairs apply the submission's splits with no credit, so the solver must
// give the same status and objective. They prove core accepts the explicit per-date
// ISO lists a date split writes.

import { describe, expect, it } from "vitest";
import { cards, leave, people, requirement, ward } from "@/lib/rules/ward-fixtures.test-support";
import { splitCardsForCover, withCoverOverrides } from "./temporary-cover";
import { makeTemporaryCover, stableYaml } from "./test-fixtures";
import type { RequirementCard, ScenarioUiState } from "./types";

const FIXTURE_DIR = "../../../core/tests/fixtures/temporary_cover/";

/** Four nurses (ana and ben are RN), AM/PM/N, 1-3 Nov, with weighted requests. */
function smallWard(requirements: RequirementCard[], patch: Partial<ScenarioUiState> = {}) {
  return ward({
    rangeEnd: "2026-11-03",
    staff: people("ana", "ben", "cara", "dan"),
    staffGroups: [{ id: "RN", members: ["ana", "ben"] }],
    shifts: [{ id: "AM" }, { id: "PM" }, { id: "N" }],
    cardsByKind: cards({ requirements }),
    reqData: [
      {
        uid: "r1",
        kind: "request",
        person: "ana",
        date: "2026-11-02",
        shiftType: "AM",
        weight: 2,
      },
      { uid: "r2", kind: "off", person: "cara", date: "2026-11-01", weight: 1 },
    ],
    ...patch,
  });
}

function pair(name: string, before: ScenarioUiState, after: ScenarioUiState) {
  return Promise.all([
    expect(stableYaml(before)).toMatchFileSnapshot(`${FIXTURE_DIR}${name}.before.yaml`),
    expect(stableYaml(after)).toMatchFileSnapshot(`${FIXTURE_DIR}${name}.after.yaml`),
  ]);
}

describe("temporary cover solver-equivalence fixtures", () => {
  it("shift_split: a two-selector card split per selector", async () => {
    const before = smallWard([
      requirement("am-pm", "AM", 1, {
        shiftType: ["AM", "PM"],
        preferredNumPeople: 2,
        weight: -3,
      }),
      requirement("night", "N", 1),
    ]);
    const after = splitCardsForCover(before, new Map([["am-pm", []]]));
    expect(after.cardsByKind.requirements.map((card) => card.shiftType)).toEqual([
      ["AM"],
      ["PM"],
      ["N"],
    ]);
    await pair("shift_split", before, after);
  });

  it("date_split: an RN skill-mix card split by date, with a hand override moved", async () => {
    // cara and dan are away on the 2nd, so only the hand override (1 on AM) is feasible:
    // a copy that lost it would turn INFEASIBLE.
    const away = { reqData: [leave("cara", "2026-11-02"), leave("dan", "2026-11-02")] };
    const before = smallWard(
      [
        requirement("am-rn", "AM", 2, {
          preferredNumPeople: 3,
          weight: -2,
          skillMix: [{ people: "RN", minNumPeople: 1 }],
          requiredNumPeopleOverrides: [["2026-11-02", 1]],
        }),
        requirement("night", "N", 1),
      ],
      away,
    );
    const after = splitCardsForCover(before, new Map([["am-rn", ["2026-11-02"]]]));
    expect(after.cardsByKind.requirements.map((card) => card.date)).toEqual([
      ["2026-11-01", "2026-11-03"],
      ["2026-11-02"],
      ["ALL"],
    ]);
    await pair("date_split", before, after);
  });

  it("rn_cover: one RN cover makes an RN-short night feasible", async () => {
    const night = requirement("rn-night", "N", 2, { qualifiedPeople: ["RN"] });
    const before = smallWard([night], { reqData: [leave("ana", "2026-11-02")] });
    const covered = {
      ...before,
      temporaryCover: [makeTemporaryCover({ date: "2026-11-02", shiftType: "N", groups: ["RN"] })],
    };
    const after = withCoverOverrides(covered);
    expect(after.cardsByKind.requirements[0].requiredNumPeopleOverrides).toEqual([
      ["2026-11-02", 1],
    ]);
    await pair("rn_cover", before, after);
  });
});
