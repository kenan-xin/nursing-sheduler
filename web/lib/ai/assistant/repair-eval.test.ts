// The evaluation harness for guided setup and feasibility repair.
//
// Pure: no LLM, no network, no solver. For each scripted ward it checks what a ward
// manager would check. Are the ranked options sensible, in the right order, and safe?
// Does each one map to operations the host accepts, with the right real-world question?
// Does the top option leave no certain gap? It also writes the before/after scenarios
// as YAML so core/tests/test_assistant_repair_fixtures.py can prove with the REAL
// solver that "before" is infeasible and "after the top option" is feasible.
// Regenerate with: pnpm vitest run lib/ai/assistant/repair-eval -u (vitest file snapshots,
// so no generic filesystem access is needed here).

import { describe, expect, it } from "vitest";
import { computeScenarioSummary } from "@/components/home/scenario-summary";
import { deriveAssumptions, type AssumptionType } from "@/lib/proposal/assumptions";
import { applyAssistantCommands } from "@/lib/proposal/operations";
import { findStaffingShortfalls } from "@/lib/rules/shortfalls";
import { SCENARIOS, type ScenarioName } from "@/lib/rules/ward-fixtures.test-support";
import { serializeScenario, type ScenarioUiState } from "@/lib/scenario";
import { REST_PRACTICE_WARNING, type RepairId } from "./playbook";
import {
  buildFeasibilityReport,
  isSafeOption,
  rankRepairOptions,
  type RepairOption,
} from "./repair-options";
import { deriveSetupProgress } from "./setup-progress";

const FIXTURE_DIR = "../../../../core/tests/fixtures/assistant_repair/";

/** The build stamp changes with every release; the fixtures must not. */
const stableYaml = (state: ScenarioUiState) =>
  serializeScenario(state).replace(/^appVersion:.*\n?/m, "");

/** The options offered after a failed run. */
function options(name: ScenarioName): RepairOption[] {
  const state = SCENARIOS[name]();
  return rankRepairOptions(state, findStaffingShortfalls(state), { runInfeasible: true });
}

function applyTop(name: ScenarioName): ScenarioUiState {
  const state = SCENARIOS[name]();
  const [top] = options(name);
  const result = applyAssistantCommands(state, top.operations);
  if (!result.ok) throw new Error(`${name}: ${result.rejection.message}`);
  return result.next;
}

/** Wards the static check proves infeasible. restRuleTooTight has no proven cause, so no top option. */
const INFEASIBLE: Exclude<ScenarioName, "empty" | "restRuleTooTight">[] = [
  "understaffedNight",
  "onlyRnOnLeave",
  "ruleTooStrict",
  "tooFewNurses",
  "conflictingRequirements",
  "personalCapsTooLow",
  "busyNightsWithRestRule",
];

const EXPECTED: Record<(typeof INFEASIBLE)[number], RepairId[]> = {
  understaffedNight: ["borrow_temporary_nurse", "run_one_short"],
  onlyRnOnLeave: ["borrow_temporary_nurse", "ask_nurse_on_leave"],
  ruleTooStrict: ["relax_count_rule", "borrow_temporary_nurse"],
  tooFewNurses: ["borrow_temporary_nurse"],
  conflictingRequirements: ["align_overlapping_requirements"],
  personalCapsTooLow: ["extra_shift_willing_nurse", "borrow_temporary_nurse"],
  busyNightsWithRestRule: ["borrow_temporary_nurse", "run_one_short"],
};

/** The host question each option's Preview must raise before Apply (none = asked in chat or plain manager call). */
const AGREEMENT: Partial<Record<RepairId, AssumptionType>> = {
  borrow_temporary_nurse: "borrowed_staff_arranged",
  ask_nurse_on_leave: "leave_cancelled",
  extra_shift_willing_nurse: "extra_shifts_agreed",
};

describe("guided setup from an empty scenario", () => {
  it("starts at the dates, asks before proposing, and is not ready to run", () => {
    const state = SCENARIOS.empty();
    const progress = deriveSetupProgress({
      summary: computeScenarioSummary(state),
      runComplete: false,
      uncoveredShifts: [],
      knownGaps: findStaffingShortfalls(state).length,
    });
    expect(progress.nextStep?.id).toBe("dates");
    expect(progress.nextStep?.ask).toContain("The first and last day of the roster.");
    expect(progress.readyToRun).toBe(false);
    expect(buildFeasibilityReport(state, false).options).toEqual([]);
  });

  it("warns before running a ward that is sure to fail", () => {
    const state = SCENARIOS.onlyRnOnLeave();
    const progress = deriveSetupProgress({
      summary: computeScenarioSummary(state),
      runComplete: false,
      uncoveredShifts: [],
      knownGaps: findStaffingShortfalls(state).length,
    });
    expect(progress.readyToRun).toBe(true);
    expect(findStaffingShortfalls(state)).toHaveLength(1);
  });
});

describe.each(INFEASIBLE)("infeasible after a run: %s", (name) => {
  it("offers the expected options, best first", () => {
    expect(options(name).map((o) => o.repairId)).toEqual(EXPECTED[name]);
  });

  it("offers only safe options that the host accepts, each with its agreement", () => {
    const state = SCENARIOS[name]();
    for (const option of options(name)) {
      expect(isSafeOption(state, option), option.repairId).toBe(true);
      expect(option.title.length).toBeGreaterThan(10);
      expect(option.confirmationQuestion).toMatch(/\?$/);
      if (option.operations.length === 0) {
        expect(option.capabilityId, option.repairId).not.toBeNull();
        continue;
      }
      const result = applyAssistantCommands(state, option.operations);
      expect(result.ok, `${option.repairId}: ${result.ok ? "" : result.rejection.message}`).toBe(
        true,
      );
      if (!result.ok) continue;
      const asked = deriveAssumptions(state, result.next, option.operations).map((a) => a.type);
      if (option.enforcedBy === "host_question") {
        // The agreement is a host question on the Preview, so Apply stays disabled until answered.
        expect(asked, option.repairId).toContain(AGREEMENT[option.repairId]);
      } else {
        expect(asked, option.repairId).toEqual([]);
      }
    }
  });

  it("leaves no certain gap after the top option", () => {
    expect(findStaffingShortfalls(applyTop(name))).toEqual([]);
  });

  it("keeps the solver fixtures in step with the scripted wards", async () => {
    await expect(stableYaml(SCENARIOS[name]())).toMatchFileSnapshot(
      `${FIXTURE_DIR}${name}.before.yaml`,
    );
    await expect(stableYaml(applyTop(name))).toMatchFileSnapshot(
      `${FIXTURE_DIR}${name}.after.yaml`,
    );
  });
});

describe("the scripted wards read as real ward situations", () => {
  it("understaffed night: borrow one nurse for the 5th only, or run that night one short", () => {
    const [borrow, short] = options("understaffedNight");
    expect(borrow.operations).toEqual([
      { type: "add_person", name: "Borrowed nurse 1", groups: [], temporary: true },
      {
        type: "set_off_request",
        personId: "Borrowed nurse 1",
        startDate: "2026-11-01",
        endDate: "2026-11-04",
        weight: "must",
      },
      {
        type: "set_off_request",
        personId: "Borrowed nurse 1",
        startDate: "2026-11-06",
        endDate: "2026-11-07",
        weight: "must",
      },
    ]);
    expect(short.operations).toEqual([
      { type: "set_staffing_requirement_people", ruleId: "night-05", requiredNumPeople: 2 },
    ]);
    expect(short.confirmation).toBe("manager");
  });

  it("only RN on leave: borrow an RN, or ask rn1 about her leave, and never lower the RN rule", () => {
    const [borrow, ask] = options("onlyRnOnLeave");
    expect(borrow.operations[0]).toEqual({
      type: "add_person",
      name: "Borrowed nurse 1",
      groups: ["RN"],
      temporary: true,
    });
    expect(borrow.needsFromUser.join(" ")).toMatch(/qualified as RN/);
    expect(ask.operations).toEqual([
      { type: "clear_requests", personId: "rn1", startDate: "2026-11-03", endDate: "2026-11-03" },
    ]);
    expect(ask).toMatchObject({ confirmation: "named_nurse", enforcedBy: "host_question" });
    expect(ask.needsFromUser.join(" ")).toMatch(/sick or compassionate/);
    for (const o of options("onlyRnOnLeave")) {
      for (const op of o.operations) expect("ruleId" in op && op.ruleId).not.toBe("night-rn");
    }
  });

  it("rule too strict: allow 2 nights each instead of 1, checked against legal limits", () => {
    const [relax] = options("ruleTooStrict");
    expect(relax.operations).toEqual([
      expect.objectContaining({
        type: "edit_count_rule",
        ruleId: "max-nights",
        target: 2,
        weight: "infinity",
      }),
    ]);
    expect(relax.confirmationQuestion).toMatch(/legal limits/);
  });

  it("busy nights with a rest rule: borrow a nurse for the two busy nights only, off in between", () => {
    const [borrow] = options("busyNightsWithRestRule");
    expect(borrow.operations).toEqual([
      { type: "add_person", name: "Borrowed nurse 1", groups: [], temporary: true },
      ...[
        ["2026-11-01", "2026-11-01"],
        ["2026-11-03", "2026-11-05"],
        ["2026-11-07", "2026-11-07"],
      ].map(([startDate, endDate]) => ({
        type: "set_off_request",
        personId: "Borrowed nurse 1",
        startDate,
        endDate,
        weight: "must",
      })),
    ]);
    expect(borrow.enforcedBy).toBe("host_question");
  });

  it("too few nurses: borrow a temporary nurse for the whole period, asked on the Preview", () => {
    const [borrow] = options("tooFewNurses");
    expect(borrow.operations).toEqual([
      { type: "add_person", name: "Borrowed nurse 1", groups: [], temporary: true },
    ]);
    expect(borrow.enforcedBy).toBe("host_question");
  });

  it("personal caps too low: ask ana for one more night, and her agreement gates Apply", () => {
    const state = SCENARIOS.personalCapsTooLow();
    const [extra] = options("personalCapsTooLow");
    expect(extra.operations).toEqual([
      expect.objectContaining({
        type: "edit_count_rule",
        ruleId: "ana-nights",
        description: "At most 4 nights",
        people: ["ana"],
        target: 4,
        weight: "infinity",
      }),
    ]);
    expect(extra).toMatchObject({ confirmation: "named_nurse", enforcedBy: "host_question" });
    const result = applyAssistantCommands(state, extra.operations);
    if (!result.ok) throw new Error(result.rejection.message);
    expect(deriveAssumptions(state, result.next, extra.operations)).toEqual([
      expect.objectContaining({ type: "extra_shifts_agreed" }),
    ]);
  });

  it("conflicting requirements: raise the ward total to match the RN rule, never lower the RN rule", () => {
    const [align] = options("conflictingRequirements");
    expect(align.operations).toEqual([
      { type: "set_staffing_requirement_people", ruleId: "night-total", requiredNumPeople: 2 },
    ]);
  });

  it("rest rules too tight: no certain cause, so no blind borrow; soften a rest rule, with the warning", () => {
    // Unexplained order is soften a hard request, relax a count cap, then soften a rest rule:
    // this ward has only the rest rules.
    const state = SCENARIOS.restRuleTooTight();
    const report = buildFeasibilityReport(state, true);
    expect(report.findings).toEqual([]);
    expect(report.options.map((o) => o.repairId)).toEqual(["soften_rest_rule"]);
    const [soften] = report.options;
    expect(soften.operations).toEqual([
      {
        type: "edit_succession_rule",
        ruleId: "no-day-after-night",
        description: "No day shift straight after a night",
        people: ["Nurses"],
        pattern: ["N", "D"],
        dates: ["ALL"],
        weight: "-10",
      },
    ]);
    expect(soften).toMatchObject({
      evidence: "hypothesis",
      confirmation: "manager",
      enforcedBy: "apply",
    });
    expect(soften.why).toContain(REST_PRACTICE_WARNING);
    expect(isSafeOption(state, soften)).toBe(true);
    const result = applyAssistantCommands(state, soften.operations);
    if (!result.ok) throw new Error(result.rejection.message);
    const card = result.next.cardsByKind.successions.find((c) => c.uid === "no-day-after-night");
    // Softened, never deleted or switched off.
    expect(card).toMatchObject({ weight: -10 });
    expect(card?.disabled).toBeFalsy();
    expect(buildFeasibilityReport(state, false).options).toEqual([]);
  });
});
