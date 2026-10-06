// Leave repairs against the REAL solver (bead nursing-sheduler-msnp): a ward made
// infeasible by a nurse's leave, the solver's proven core naming that leave, and the
// options' own operations, applied by the host, giving a roster with every hard rest rule
// kept. Opt-in, like the other Python-backed suites:
//   RUN_DIFFERENTIAL=1 PYTHON=/usr/bin/python3 pnpm vitest run lib/ai/assistant/leave-repair.solver

import { describe, expect, it } from "vitest";
import { resolveCore, type InfeasibleCore } from "@/lib/optimize/explanation";
import { applyAssistantCommands } from "@/lib/proposal/operations";
import { findStaffingShortfalls } from "@/lib/rules/shortfalls";
import { cards, leave, people, requirement, ward } from "@/lib/rules/ward-fixtures.test-support";
import {
  prepareOptimizeSubmission,
  toCanonicalScenarioDocument,
  type ScenarioUiState,
  type SuccessionCard,
  type UiRequestCell,
} from "@/lib/scenario";
// Direct path: the barrel re-exports repair-options and `@/lib/scenario` would cycle.
import { withCoverOverrides } from "@/lib/scenario/temporary-cover";
import { callOracleRaw, GATED, oracleBudget } from "@/lib/scenario/differential/oracle-client";
import { buildFeasibilityReport, type RepairOption } from "./repair-options";

interface Solved {
  ok: boolean;
  status?: string;
  error?: string;
  explanation?: { kind: string; core: InfeasibleCore | null } | null;
}

function solve(state: ScenarioUiState): Solved {
  const prep = prepareOptimizeSubmission(toCanonicalScenarioDocument(withCoverOverrides(state)), {
    anonymize: false,
  });
  if (!prep.ok) throw new Error(`not submittable: ${JSON.stringify(prep.issues)}`);
  const solved = callOracleRaw<Solved>({
    op: "schedule",
    yaml: prep.prep.yaml,
    timeout: 20,
    explain: true,
  });
  if (!solved.ok) throw new Error(solved.error);
  return solved;
}

const found = (s: Solved) => s.status === "OPTIMAL" || s.status === "FEASIBLE";

const rest = (uid: string, pattern: string[]): SuccessionCard => ({
  uid,
  description: uid,
  person: ["ALL"],
  pattern,
  weight: -Infinity,
});

/** 3 nurses, 1 day + 1 night every day, no day straight after a night, no two nights in a row. */
const restWard = (reqData: UiRequestCell[], nightsBusy = false): ScenarioUiState =>
  ward({
    staff: people("ana", "ben", "cara"),
    reqData,
    cardsByKind: cards({
      requirements: nightsBusy
        ? [
            requirement("day", "D", 1),
            requirement("nights-busy", "N", 2, {
              date: ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"],
            }),
            requirement("nights-quiet", "N", 1, { date: ["2026-11-06", "2026-11-07"] }),
          ]
        : [requirement("day", "D", 1), requirement("night", "N", 1)],
      // Two nights a night leaves no one for a no-two-nights rule: that ward keeps only the first.
      successions: nightsBusy
        ? [rest("no-day-after-night", ["N", "D"])]
        : [rest("no-day-after-night", ["N", "D"]), rest("no-two-nights", ["N", "N"])],
    }),
  });

function appliedSolve(state: ScenarioUiState, option: RepairOption): Solved {
  const result = applyAssistantCommands(state, option.operations);
  if (!result.ok) throw new Error(result.rejection.message);
  // Every hard rest rule is still there, unchanged.
  expect(result.next.cardsByKind.successions).toEqual(state.cardsByKind.successions);
  return solve(result.next);
}

describe.skipIf(!GATED)("leave repairs, solver-confirmed", () => {
  it(
    "a leave day the static check proves is the gap: the core names it, and moving or giving it up solves",
    () => {
      const state = restWard([leave("cara", "05")], true);
      const before = solve(state);
      expect(before.status).toBe("INFEASIBLE");
      expect(before.explanation?.kind).toBe("infeasible");
      const core = resolveCore(before.explanation!.core!, { sources: [], people: [] });
      expect(core).toContainEqual(
        expect.objectContaining({ kind: "leave", nurse: "cara", date: "2026-11-05" }),
      );
      const options = buildFeasibilityReport(state, true, core).options;
      const move = options.find((o) => o.repairId === "move_leave")!;
      expect(move.operations).toEqual([
        { type: "move_leave", personId: "cara", fromDate: "05", toDate: "06" },
      ]);
      expect(found(appliedSolve(state, move))).toBe(true);
    },
    oracleBudget(2),
  );

  it(
    "a leave block only the solver sees: the core names it, and its options solve",
    () => {
      // 2 a day from 3 nurses is enough to the static check. But with cara away on the
      // 4th and 5th, whoever works the night of the 4th can work neither shift on the 5th.
      const state = restWard([leave("cara", "04"), leave("cara", "05")]);
      expect(findStaffingShortfalls(state)).toEqual([]);
      const before = solve(state);
      expect(before.status).toBe("INFEASIBLE");
      const core = resolveCore(before.explanation!.core!, { sources: [], people: [] });
      const leaveDays = core.filter((m) => m.kind === "leave");
      expect(leaveDays.length).toBeGreaterThan(0);
      expect(leaveDays.every((m) => m.nurse === "cara")).toBe(true);

      // Without the core, the app has no leave option to offer: it never guesses.
      const blind = buildFeasibilityReport(state, true, null).options.map((o) => o.repairId);
      expect(blind).not.toContain("move_leave");
      const options = buildFeasibilityReport(state, true, core).options;
      const ids = options.map((o) => o.repairId);
      // The rest rules are the only rule changes ranked above the leave repairs.
      expect(ids.filter((id) => id !== "soften_rest_rule")).toEqual([
        "move_leave",
        "ask_nurse_on_leave",
      ]);
      for (const id of ["move_leave", "ask_nurse_on_leave"] as const) {
        const option = options.find((o) => o.repairId === id)!;
        expect(option.evidence).toBe("hypothesis");
        // One leave day breaks a minimal core: one agreement, not two.
        expect(option.operations, id).toHaveLength(1);
        expect(found(appliedSolve(state, option)), id).toBe(true);
      }
    },
    oracleBudget(3),
  );
});
