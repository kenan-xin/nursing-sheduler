import { cards, people, requirement, ward } from "@/lib/rules/ward-fixtures.test-support";
import type { ScenarioUiState } from "@/lib/scenario";
import type { EvalCase } from "../lib/case";

const small = () =>
  ward({
    staff: people("ana", "ben", "cara"),
    cardsByKind: cards({ requirements: [requirement("day", "D", 1)] }),
  });

// The user's own test prompt of 2026-09-28 (bead 4h5a), names replaced with neutral ids.
// It gives no number for N_sup, on purpose.
const OCTOBER_SETUP_PROMPT = `help me setup october roster

here are the nurses:
SN-01, SSN-02, SSN-03, SSN-04, SSN-05 : Senior Staff Nurses — can act as the shift's Nurse-in-Charge (NIC), the senior leading that shift

SN-06, SN-07, SN-08, SN-09, SN-10, SN-11: Staff Nurses

EN-12, EN-13: Enrolled Nurses

i have these shift types
1. M — Morning 07:00–15:30
2. M_sup — Morning shift lead (SSN/NIC)
3. A — Afternoon 13:00–22:00
4. A_sup — Afternoon lead (SSN/NIC)
5. N — Night 20:00–08:30
6. N_sup — Night NIC

these are my requirements:
1. Morning (M): At least 2 nurses daily; ideally 3. Any grade. Covers meds and breakfast round.
2. Morning senior lead (M_sup): Exactly 1 senior daily.
3. Afternoon (A): Exactly 2 nurses daily, any grade
4. Afternoon second senior (A_sup): Optional: 0 required, ideally 1 senior.
5. Night (N): Exactly 2 nurses daily.
6. All nurses cannot have a morning shift immediately after a night shift, nurse need to rest, prefer to arrange off after a night shift`;

/** The staffing requirement on one shift in the final schedule, if any. */
const requirementOn = (s: ScenarioUiState, shift: string) =>
  s.cardsByKind.requirements.find((card) => [card.shiftType].flat().includes(shift));

export const REGRESSION_CASES: EvalCase[] = [
  {
    id: "reg-october-setup-at-least-ideally",
    tags: ["regression", "flow"],
    description:
      "4h5a: the user's setup prompt. 28 days first, 'at least'/'ideally' saved as required + preferred, A_sup 0 + 1, and a question about N_sup.",
    today: "2026-09-28",
    route: "/",
    seed: { fixture: "empty" },
    user: {
      turns: [OCTOBER_SETUP_PROMPT],
      onChoices: { pick: 1 },
      onPreview: "apply",
    },
    limits: { maxUserTurns: 14, maxHops: 40, timeoutMs: 600_000 },
    expect: {
      // The dates card offers 4 weeks before the calendar month.
      choicesInclude: ["4 weeks", "31"],
      finalState: (s) => {
        const m = requirementOn(s, "M");
        if (m?.requiredNumPeople !== 2 || m.preferredNumPeople !== 3)
          return `M is ${m?.requiredNumPeople}/${m?.preferredNumPeople}, expected at least 2, ideally 3`;
        const aSup = requirementOn(s, "A_sup");
        if (aSup?.requiredNumPeople !== 0 || aSup.preferredNumPeople !== 1)
          return `A_sup is ${aSup?.requiredNumPeople}/${aSup?.preferredNumPeople}, expected 0 required, ideally 1`;
        if (!requirementOn(s, "N_sup")) return "N_sup has no staffing requirement";
        return null;
      },
      judge: [
        "Asks how many nurses the Night NIC shift (N_sup) needs, on a choice card, instead of guessing a number.",
      ],
    },
    trials: 1,
  },
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
    id: "grounding-state-question",
    tags: ["grounding"],
    description:
      "v1 reject-no-change: a question about the schedule is answered, not turned into an edit.",
    today: "2026-10-28",
    route: "/staff",
    seed: {
      build: () => ({ ...small(), staffGroups: [{ id: "Seniors", members: ["ana", "ben"] }] }),
    },
    user: { turns: ["Is Ben in the Seniors group?"], onPreview: "ignore" },
    expect: { noProposal: true, judge: ["Says yes, Ben is in the Seniors group."] },
  },
  {
    id: "reg-reject-then-narrower",
    tags: ["regression"],
    description:
      "v1 reject-then-narrower-edit: after a rejected Preview, the new change is only the narrower one.",
    today: "2026-10-28",
    route: "/shift-requests",
    seed: { build: small },
    user: {
      turns: ["Give Ana and Ben Friday 6 November off.", "No, only Ana."],
      onPreview: "reject",
    },
    expect: {
      proposalOps: [{ type: "set_off_request", personId: "ana" }],
      proposalCheck: (ops) =>
        ops.some((op) => JSON.stringify(op).includes('"ben"'))
          ? "the last proposal still gives Ben the day off"
          : null,
    },
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
    id: "reg-yes-no-offer",
    tags: ["regression"],
    description: "dt9: a capability answer ends 'Want me to add that rule?' as plain text.",
    today: "2026-09-24",
    route: "/rules",
    seed: { build: small },
    user: {
      turns: ["Can the app stop a nurse doing a day shift straight after a night?"],
      onPreview: "ignore",
    },
    expect: {
      judge: ["Says yes, and either prepares that rule or offers it on a card."],
    },
  },
  {
    id: "reg-claim-after-preview",
    tags: ["regression"],
    description:
      "dt9: says a preference is in place while only its Preview exists, and names its weight.",
    today: "2026-09-24",
    route: "/rules",
    seed: { build: small },
    user: {
      turns: [
        "Nurses should preferably get a day off after working nights. Add that.",
        "Great, so that's in place now?",
      ],
      onPreview: "ignore",
    },
    expect: {
      judge: [
        "Asked whether it is in place, says it is not: nothing has changed yet. Offering to prepare it again passes; saying it is in place, or telling the user to press Apply on the earlier Preview (a new message stopped it), fails.",
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
