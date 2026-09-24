import { cards, people, requirement, ward } from "@/lib/rules/ward-fixtures.test-support";
import type { ScenarioUiState } from "@/lib/scenario";
import type { EvalCase } from "../lib/case";
import flowC from "../fixtures/flow-c-infeasible-demo.yaml?raw";

const successions = (s: ScenarioUiState) =>
  s.cardsByKind.successions as { pattern: string[]; weight: number }[];
const mna = () =>
  ward({
    shifts: [
      { id: "M", description: "Morning" },
      { id: "A", description: "Afternoon" },
      { id: "N", description: "Night" },
    ],
    staff: people("ana", "ben", "cara", "dev", "eve"),
  });

export const FLOW_CASES: EvalCase[] = [
  {
    id: "setup-flow-a",
    tags: ["flow"],
    description: "Guided setup from nothing with a simulated Flow A ward manager.",
    today: "2025-07-20",
    route: "/",
    seed: { fixture: "empty" },
    user: {
      simulated: {
        persona:
          "Sister Tan, nurse manager of a 12-bed general medicine ward in Singapore, short answers, not technical",
        goal: "Set up the August 2025 roster: staff, shifts M/A/N, staffing and rest rules, then stop before running it.",
        facts: {
          dates: "1 to 31 August 2025, import public holidays",
          staff:
            "NM-Tan, SSN-Lim, SSN-Goh, SSN-Wong, SN-Nurul, SN-Priya, SN-Ahmad, SN-Mei, SN-Raj, SN-Siti, EN-Chen, EN-Kumar",
          seniors: "NM-Tan, SSN-Lim, SSN-Goh, SSN-Wong",
          shifts: "M 07:00-15:00, A 14:00-22:00, N 21:30-07:30",
          morningStaff: "at least 2, ideally 3",
          afternoonStaff: "2",
          nightStaff: "2",
          restRule: "no morning straight after a night; try to give a day off after nights",
          leave: "nobody",
        },
        maxTurns: 12,
        onPreview: "apply",
      },
    },
    limits: { maxUserTurns: 14, maxHops: 40, timeoutMs: 600_000 },
    expect: {
      finalState: (s) => {
        if (s.staff.length !== 12) return `${s.staff.length} staff, expected 12`;
        if (s.shifts.length < 3) return `${s.shifts.length} shifts, expected 3`;
        if (!successions(s).some((r) => r.pattern.join(",") === "N,M" && r.weight === -Infinity))
          return "no hard N then M forbid";
        if (successions(s).some((r) => r.weight === Infinity))
          return "a succession is a hard must-follow";
        return null;
      },
      judge: [
        "Suggests usual values (such as common shift times) instead of asking for every detail.",
      ],
    },
    trials: 1,
  },
  {
    id: "flow-c-diagnose",
    tags: ["flow"],
    description:
      "Flow C: mornings need 4 with only 3 nurses; name the headcount as the main cause.",
    today: "2026-09-24",
    route: "/optimize-and-export",
    seed: { yaml: flowC },
    optimizer: { outcome: "infeasible" },
    afterRunFinished: true,
    user: { turns: ["Why did it fail?"] },
    expect: {
      toolsCalled: ["suggest_feasibility_options"],
      judge: ["Names the morning shift needing more nurses than the ward has as the main cause."],
    },
  },
  {
    id: "flow-b-shared-shift",
    tags: ["flow"],
    description: "Two ward groups on one shift code exclude each other (L2).",
    today: "2026-09-24",
    route: "/shift-type-requirements",
    seed: {
      build: () =>
        ward({
          shifts: [
            { id: "M", description: "Morning" },
            { id: "N", description: "Night" },
          ],
          staff: people("icu1", "icu2", "gen1", "gen2"),
          staffGroups: [
            { id: "ICU", members: ["icu1", "icu2"] },
            { id: "GEN", members: ["gen1", "gen2"] },
          ],
          cardsByKind: cards({
            requirements: [
              requirement("icu-m", "M", 1, {
                qualifiedPeople: ["ICU"],
                description: "1 ICU nurse every morning",
              }),
            ],
          }),
        }),
    },
    user: { turns: ["Add a rule that the general ward needs 1 GEN nurse on M every morning too."] },
    expect: {
      judge: [
        "Explains that two groups restricted to the same shift code block each other, and suggests a separate morning shift code for the general ward.",
      ],
    },
  },
  {
    id: "limit-consecutive-days",
    tags: ["flow"],
    description: "Max 5 days in a row, any shift, is not exact (L4).",
    today: "2026-09-24",
    route: "/rules",
    seed: { build: mna },
    user: {
      turns: ["Nobody should work more than 5 days in a row, any shift."],
      onPreview: "ignore",
    },
    expect: {
      judge: [
        "Says the app cannot limit runs of mixed shifts exactly, and offers a weekly limit on working days instead or as well.",
      ],
    },
  },
  {
    id: "exact-vs-preferred",
    tags: ["flow"],
    description: "'At least 2, ideally 3' must not become exactly 3 (L3).",
    today: "2026-09-24",
    route: "/shift-type-requirements",
    seed: { build: mna },
    user: { turns: ["Mornings need at least 2 nurses, ideally 3."], onPreview: "ignore" },
    expect: {
      proposalOps: [{ type: "add_staffing_requirement", requiredNumPeople: 2 }],
      judge: [
        "Says the number is exact, and that the preferred 3 is set on the Staffing requirements screen.",
      ],
    },
  },
  {
    id: "off-after-nights",
    tags: ["flow"],
    description: "Hard no-day-after-night; the day off after nights stays a preference (L6).",
    today: "2026-09-24",
    route: "/shift-type-successions",
    seed: { build: () => ward({ staff: people("ana", "ben", "cara") }) },
    user: {
      turns: ["No day shift straight after a night, and try to give a day off after nights."],
      onPreview: "ignore",
    },
    expect: {
      proposalOps: [{ type: "add_succession_rule", pattern: ["N", "D"], weight: "-infinity" }],
      proposalCheck: (ops) =>
        ops.some((op) => op.type === "add_succession_rule" && op.weight === "infinity")
          ? "a succession is a hard must-follow"
          : null,
      judge: ["Makes the day off after nights a preference, not a must."],
    },
  },
];
