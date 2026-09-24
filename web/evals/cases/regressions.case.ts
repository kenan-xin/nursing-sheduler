import { cards, people, requirement, ward } from "@/lib/rules/ward-fixtures.test-support";
import type { EvalCase } from "../lib/case";

const small = () =>
  ward({
    staff: people("ana", "ben", "cara"),
    cardsByKind: cards({ requirements: [requirement("day", "D", 1)] }),
  });

export const REGRESSION_CASES: EvalCase[] = [
  {
    id: "grounding-unknown-nurse",
    tags: ["grounding", "smoke"],
    description: "No Bob on the ward: never invent him.",
    today: "2026-10-28",
    route: "/shift-requests",
    seed: { build: small },
    user: { turns: ["Give Bob Thursday off."] },
    expect: { noProposal: true, choicesFromStaff: true },
  },
  {
    id: "reg-empty-reply-after-infeasible",
    tags: ["regression", "smoke"],
    description: "A failed run must end in a reply and an option card.",
    today: "2026-10-20",
    route: "/optimize-and-export",
    seed: { fixture: "understaffedNight" },
    optimizer: { outcome: "infeasible" },
    afterRunFinished: true,
    user: { turns: [] },
    expect: { toolsCalled: ["offer_choices"] },
  },
  {
    id: "reg-pick-one-as-text",
    tags: ["regression", "smoke"],
    description: "Two Tans: ask on a card, not in text.",
    today: "2026-10-28",
    route: "/shift-requests",
    seed: { build: () => ward({ staff: people("tan-wei", "tan-mei", "ana") }) },
    user: { turns: ["Give Tan Friday off."] },
    expect: { toolsCalled: ["offer_choices"] },
  },
  {
    id: "reg-offer-as-text",
    tags: ["regression"],
    description: "dt9: 'Want me to take you to the Shifts screen?' as plain text.",
    today: "2026-09-24",
    route: "/rules",
    seed: { build: small },
    user: { turns: ["Where do I change the night shift's start time?"] },
    expect: {
      noProposal: true,
      judge: [
        "Takes the user to the Shifts screen, or says that is where to change it, without asking a yes/no question in text.",
      ],
    },
  },
  {
    id: "reg-wrong-year",
    tags: ["regression", "smoke"],
    description: "A month without a year is the next such month.",
    today: "2026-09-24",
    route: "/dates",
    seed: { fixture: "empty" },
    user: { turns: ["Set the roster for January."], onPreview: "ignore" },
    expect: {
      proposalOps: [{ type: "set_roster_range", start: "2027-01-01", end: "2027-01-31" }],
    },
  },
  {
    id: "reg-break-suggest",
    tags: ["regression"],
    description: "Suggest the unpaid break; do not ask for it.",
    today: "2026-09-24",
    route: "/shift-types",
    seed: { build: small },
    user: { turns: ["Add a night shift from 21:00 to 07:00."], onPreview: "ignore" },
    expect: {
      proposalOps: [{ type: "add_shift_type" }],
      proposalCheck: (ops) =>
        ops.some((op) => op.type === "add_shift_type" && op.restMinutes > 0)
          ? null
          : "no break set on the new shift",
    },
  },
  {
    id: "reg-navigate-after-apply",
    tags: ["regression"],
    description: "After Apply the app opens the screen; the reply is one line.",
    today: "2026-09-24",
    route: "/dates",
    seed: { build: small },
    user: { turns: ["Add a night shift from 21:00 to 07:00."], onPreview: "apply" },
    expect: {
      proposalOps: [{ type: "add_shift_type" }],
      navigatedTo: "/shift-types",
      judge: [
        "After the user applied, the reply is one short line and does not ask to confirm again.",
      ],
    },
  },
];
