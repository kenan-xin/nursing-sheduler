// a5pb (experimental): repair options fed by the backend's solver-proven remedies.
// The remedies below have the shape core/nurse_scheduling/explain.py returns for the
// matching core fixtures (tests/fixtures/assistant_repair/*.before.yaml).

import { describe, expect, it } from "vitest";

import { preferenceSources, resolveRemedies, type SmallestFixes } from "@/lib/optimize/explanation";
import { SCENARIOS } from "@/lib/rules/ward-fixtures.test-support";
import { toCanonicalScenarioDocument } from "@/lib/scenario";
import type { ScenarioUiState } from "@/lib/scenario/types";
import { buildFeasibilityReport, rankRepairOptions, witnessOptions } from "./repair-options";

function remedies(state: ScenarioUiState, fixes: SmallestFixes) {
  const sources = preferenceSources(toCanonicalScenarioDocument(state));
  return resolveRemedies(fixes, { sources, people: [] });
}

const fixes = (...remedies: SmallestFixes["remedies"]): SmallestFixes => ({
  remedies,
  fixable: true,
  solves: remedies.length,
  seconds: 0.01,
});

const remedy = (rank: number, cost: number, members: SmallestFixes["remedies"][0]["members"]) => ({
  rank,
  cost,
  optimal: true,
  members,
  proof: "backup_solve",
  seconds: 0.002,
});

describe("witnessOptions", () => {
  const rnState = SCENARIOS.onlyRnOnLeave();
  const rn = remedies(
    rnState,
    fixes(
      remedy(1, 100, [
        {
          rule: 2,
          kind: "staffing",
          date: "2026-11-03",
          shift: ["N"],
          need: 1,
          short: 1,
          filled: 0,
        },
      ]),
      remedy(2, 1000, [
        { rule: 3, kind: "leave", nurse: "rn1", date: "2026-11-03", shift: ["LEAVE"] },
      ]),
    ),
  );

  it("turns a short RN night into a borrowed RN, and the leave into asking rn1", () => {
    const options = witnessOptions(rnState, rn);
    expect(options.every((o) => o.evidence === "solver_witness")).toBe(true);
    expect(options.map((o) => o.repairId)).toEqual([
      "borrow_temporary_nurse",
      "ask_nurse_on_leave",
    ]);
    expect(options[0].operations).toEqual([
      {
        type: "add_temporary_cover",
        name: "Borrowed nurse 1 (another ward)",
        date: "2026-11-03",
        shiftType: "N",
        groups: ["RN"],
      },
    ]);
    expect(options[1].operations).toEqual([
      { type: "clear_requests", personId: "rn1", startDate: "2026-11-03", endDate: "2026-11-03" },
    ]);
  });

  it("never offers running the only RN night with nobody (the safety floor)", () => {
    expect(witnessOptions(rnState, rn).some((o) => o.repairId === "run_one_short")).toBe(false);
  });

  it("raises the one nurse's cap the backend proved, not another card with the same name", () => {
    const state = SCENARIOS.personalCapsTooLow();
    const [option] = witnessOptions(
      state,
      remedies(
        state,
        fixes(
          remedy(1, 20, [
            {
              rule: 3,
              kind: "cap",
              nurse: "ben",
              expression: "x <= T",
              target: 3,
              cap: 3,
              needed: 4,
            },
          ]),
        ),
      ),
    );
    expect(option.repairId).toBe("relax_count_rule");
    expect(JSON.stringify(option.operations)).toContain("ben-nights");
    expect(option.title).toContain("Allow up to 4");
  });

  it("puts proven options first and says so in the report", () => {
    const ranked = rankRepairOptions(rnState, [], { runInfeasible: true, witness: rn });
    expect(ranked[0].evidence).toBe("solver_witness");
    const report = buildFeasibilityReport(rnState, true, rn);
    expect(report.options[0].evidence).toBe("solver_witness");
    expect(report.certainty).toContain("solver_witness");
    // No witness: byte-identical to today's report.
    expect(buildFeasibilityReport(rnState, true, null)).toEqual(
      buildFeasibilityReport(rnState, true),
    );
  });
});
