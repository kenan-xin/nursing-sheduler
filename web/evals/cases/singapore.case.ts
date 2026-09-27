import { cards, people, requirement, ward } from "@/lib/rules/ward-fixtures.test-support";
import type { EvalCase } from "../lib/case";

const sixNurses = () =>
  ward({
    staff: people("ana", "ben", "cara", "dev", "eve", "siti"),
    cardsByKind: cards({
      requirements: [requirement("day", "D", 2), requirement("night", "N", 1)],
    }),
  });

export const SINGAPORE_CASES: EvalCase[] = [
  {
    id: "sg-moh-rest-rule",
    tags: ["sg"],
    description: "No MOH minimum rest rule exists; do not invent one.",
    today: "2026-09-24",
    route: "/rules",
    seed: { build: sixNurses },
    user: { turns: ["What's the MOH minimum rest between shifts? Put it in."] },
    expect: {
      noProposal: true,
      judge: [
        "Does not state any MOH rest-hour number. Says MOH sets no minimum rest between shifts, that rest rules are the ward's recommended practice, and offers to set up the ward's own rule.",
      ],
    },
  },
  {
    id: "sg-long-shift-hours",
    tags: ["sg"],
    description: "The 12-hour limit counts working hours: a long day with a 2-hour break is legal.",
    today: "2026-09-24",
    route: "/shift-types",
    seed: {
      build: () => ({
        ...sixNurses(),
        shifts: [
          { id: "D", description: "Day" },
          { id: "N", description: "Night" },
          {
            id: "Long",
            description: "Long day",
            startTime: "08:00",
            endTime: "20:30",
            restMinutes: 120,
            durationMinutes: 630,
          },
        ],
      }),
    },
    user: { turns: ["Is our Long shift over the 12-hour legal limit?"] },
    expect: {
      noProposal: true,
      judge: [
        "Says the Long shift is within the 12-hour limit because its 2-hour break is not working time (10.5 hours worked).",
        "Does not call the Long shift illegal or over the limit.",
      ],
    },
  },
  {
    id: "sg-ratio",
    tags: ["sg"],
    description: "No mandated nurse-patient ratio: ask the ward for its own numbers on a card.",
    today: "2026-09-24",
    route: "/rules",
    seed: { build: sixNurses },
    user: { turns: ["What nurse-patient ratio does MOH require for a general ward?"] },
    expect: {
      noProposal: true,
      toolsCalled: ["offer_choices"],
      judge: [
        "Says MOH sets no nurse-to-patient ratio and the ward decides its own numbers.",
        "Asks the user for the ward's own ratio numbers, or offers to set them on a card (for example Set our numbers / Not now).",
        "Does not invent or give a default ratio number (such as 1:4 or 1:6) for the ward to use.",
      ],
    },
  },
  {
    id: "sg-fair-nights",
    tags: ["sg"],
    description: "Balance nights with a squared-deviation count rule.",
    today: "2026-09-24",
    route: "/shift-counts",
    seed: { build: sixNurses },
    user: {
      turns: ["The same three nurses keep getting all the nights. Make it fair."],
      onPreview: "ignore",
    },
    expect: {
      proposalOps: [{ type: "add_count_rule", expression: "|x - T|^2" }],
      proposalCheck: (ops) => {
        const op = ops.find((o) => o.type === "add_count_rule");
        if (!op) return "no count rule";
        if (!(Number(op.weight) < 0)) return `weight ${op.weight} is not negative`;
        return op.shiftTypes.includes("N") ? null : "does not count nights";
      },
      judge: [
        "Warns that a fairness rule can make the run take longer or end without proof it is the best roster.",
      ],
    },
  },
  {
    id: "sg-ph-in-lieu",
    tags: ["sg"],
    description: "A lieu day is a day-off request; owed days are not tracked.",
    today: "2026-10-01",
    route: "/shift-requests",
    seed: {
      build: () => ({ ...sixNurses(), rangeStart: "2026-10-01", rangeEnd: "2026-10-31" }),
    },
    user: {
      turns: ["Siti worked National Day. Give her a day off in lieu on the 14th."],
      onPreview: "ignore",
    },
    expect: {
      proposalOps: [{ type: "set_off_request" }],
      proposalCheck: (ops) =>
        JSON.stringify(ops).includes("siti") && JSON.stringify(ops).includes("14")
          ? null
          : "not Siti on the 14th",
      judge: ["Says the app does not keep track of owed days off between rosters."],
    },
  },
  {
    id: "sg-mc-cover",
    tags: ["sg"],
    description: "MC cover on the saved roster: find who is free and offer the cover on a card.",
    today: "2026-11-03",
    route: "/roster",
    seed: { build: sixNurses },
    // The roster a successful run saved. Tomorrow (2026-11-04): Ben and Dev on Day, Eve on
    // Night; Ana, Cara and Siti are off.
    savedRoster: {
      ana: "D D D OFF OFF OFF D",
      ben: "D OFF D D D OFF OFF",
      cara: "N N OFF OFF OFF D OFF",
      dev: "OFF D OFF D OFF N N",
      eve: "OFF OFF N N N OFF OFF",
      siti: "OFF OFF OFF OFF D D D",
    },
    user: {
      turns: ["Ben is on MC tomorrow morning. Who can cover?"],
      onChoices: { pick: 1 },
    },
    expect: {
      toolsCalled: ["find_swap_partners", "prepare_roster_swap"],
      toolsNotCalled: ["request_optimize_run"],
      judge: [
        "Names at least one of Ana, Cara or Siti as free to cover Ben's day shift tomorrow, and never offers Dev or Eve, who already work that day.",
        "Offers one concrete cover (a named nurse takes Ben's day shift) on a roster change card or an option card, not only in text.",
      ],
    },
  },
  {
    id: "sg-nic-per-shift",
    tags: ["sg"],
    description: "A nurse in charge per shift is a skill mix; no twin shifts.",
    today: "2026-09-24",
    route: "/rules",
    seed: {
      build: () => ({ ...sixNurses(), staffGroups: [{ id: "Seniors", members: ["ana", "ben"] }] }),
    },
    user: { turns: ["Every shift needs one nurse in charge from the seniors."] },
    expect: {
      // A skill mix of 1 from Seniors on each shift; never qualifiedPeople, which bans the rest.
      proposalCheck: (ops) => {
        if (JSON.stringify(ops).includes('"qualifiedPeople":["Seniors"]'))
          return "bans everyone but the seniors";
        const mixed = new Set(
          ops.flatMap((op) =>
            op.type === "set_skill_mix" &&
            op.skillMix.some((e) => String(e.people) === "Seniors" && e.minNumPeople >= 1)
              ? [op.ruleId]
              : [],
          ),
        );
        return mixed.has("day") && mixed.has("night") ? null : "not a skill mix on every shift";
      },
      judge: ["Does not suggest making a separate senior-only copy of each shift."],
    },
  },
  {
    id: "sg-same-day-off",
    tags: ["sg"],
    description: "Two want Saturday off, only one can go: the manager decides.",
    today: "2026-10-28",
    route: "/shift-requests",
    seed: {
      build: () =>
        ward({
          staff: people("ana", "ben", "cara"),
          cardsByKind: cards({
            requirements: [requirement("day", "D", 2), requirement("night", "N", 1)],
          }),
        }),
    },
    user: { turns: ["Ana and Ben both want Saturday the 7th off."] },
    expect: {
      toolsCalled: ["offer_choices"],
      judge: ["Leaves the choice of who gets the day off to the manager."],
    },
  },
];
