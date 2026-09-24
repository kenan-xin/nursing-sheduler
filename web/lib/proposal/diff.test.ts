// The host-derived change set (T07).
//
// The property under test is that a Preview cannot UNDERSTATE a change. A range
// shrink reaches the request matrix and the date groups through code the arm itself
// never mentions, so the assertions here are about what the comparison FINDS, not
// about what the arm intended.

import { describe, expect, it } from "vitest";
import { getCapabilityRegistry } from "@/lib/capability/registry";
import { applyAssistantCommands } from "./operations";
import { deriveProposalDiff, diffScenarioDocuments, SCOPE_LABEL, type DiffScope } from "./diff";
import type { AssistantCommandV1 } from "./commands";
import { octoberWard, peopleScenario, proposalScenario, ruleWardScenario } from "./test-support";
import { cards, people, requirement, ward } from "@/lib/rules/ward-fixtures.test-support";

describe("deriveProposalDiff", () => {
  it("separates what was asked for from what the app will do as a result", () => {
    const before = proposalScenario();
    const commands = [
      {
        type: "set_roster_range" as const,
        start: "2026-04-01",
        end: "2026-04-15",
        importPublicHolidays: false,
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const diff = deriveProposalDiff(before, applied.next, commands);

    // Direct: the range itself, and only the range.
    expect(diff.direct.map((entry) => entry.key)).toEqual(["dates:range"]);
    expect(diff.direct[0].before).toBe("2026-04-01 to 2026-04-30");
    expect(diff.direct[0].after).toBe("2026-04-01 to 2026-04-15");

    // Cascade: the off-preference on the 29th is destroyed by the shrink. Nothing
    // in the command says so; only the document comparison knows.
    const destroyed = diff.cascade.find((entry) => entry.key === 'cell:"bo"|"29"');
    expect(destroyed).toBeDefined();
    expect(destroyed?.kind).toBe("removed");
    expect(destroyed?.after).toBeNull();

    // And the later setup domain it invalidated is marked for review.
    expect(diff.needsReview).toEqual(["requests"]);
    expect(diff.capabilityIds).toContain("leave-and-requests");
    expect(diff.capabilityIds).toContain("roster-period");
  });

  it("reports a rule change as direct with both values, and nothing else", () => {
    const before = proposalScenario();
    const commands = [
      {
        type: "set_staffing_requirement_people" as const,
        ruleId: "req-day",
        requiredNumPeople: 4,
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");

    const diff = deriveProposalDiff(before, applied.next, commands);
    expect(diff.direct).toHaveLength(1);
    expect(diff.direct[0].label).toBe("Day cover");
    expect(diff.direct[0].before).toBe("On · “Day cover” · Exactly 2 people on Day, every date");
    expect(diff.direct[0].after).toBe("On · “Day cover” · Exactly 4 people on Day, every date");
    expect(diff.cascade).toEqual([]);
    expect(diff.needsReview).toEqual([]);
  });

  it("reports set_skill_mix as a direct change to that requirement", () => {
    const before = ruleWardScenario();
    const commands = [
      {
        type: "set_skill_mix" as const,
        ruleId: "req-day",
        skillMix: [{ people: "RN", minNumPeople: 1 }],
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error(`fixture should apply: ${applied.rejection.message}`);

    const diff = deriveProposalDiff(before, applied.next, commands);
    expect(diff.direct.map((entry) => entry.key)).toEqual(["rule:requirements:req-day"]);
    expect(diff.direct[0].after).toContain("at least 1 from “RN”");
    expect(diff.cascade).toEqual([]);
  });

  it("shows a displaced cell at a move's destination as part of the same change", () => {
    const before = proposalScenario();
    const commands = [
      {
        type: "move_leave" as const,
        personId: "ana",
        fromDate: "02",
        toDate: "07",
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");

    const diff = deriveProposalDiff(before, applied.next, commands);
    const keys = diff.direct.map((entry) => entry.key).sort();
    // BOTH coordinates are named by the command, so both are direct: losing the Day
    // request is a consequence the user must see, not a hidden one.
    expect(keys).toEqual(['cell:"ana"|"02"', 'cell:"ana"|"07"']);
    const destination = diff.direct.find((entry) => entry.key === 'cell:"ana"|"07"');
    expect(destination?.before).toContain("Day");
    expect(destination?.after).toBe("On leave");
  });

  it("shows each new shift with its clock times and each new group with its shifts, as asked-for", () => {
    const before = proposalScenario();
    const commands = [
      {
        type: "add_shift_type" as const,
        code: " N ",
        name: "Night shift",
        startTime: "20:00",
        endTime: "08:30",
        restMinutes: 60,
      },
      {
        type: "add_shift_type" as const,
        code: "am1",
        name: "",
        startTime: "08:00",
        endTime: "15:00",
        restMinutes: 0,
      },
      {
        type: "add_shift_group" as const,
        groupId: "Night shifts",
        members: ["N", "Night"],
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");

    const diff = deriveProposalDiff(before, applied.next, commands);
    expect(diff.direct.map((entry) => entry.key).sort()).toEqual([
      'shift:"N"',
      'shift:"am1"',
      "shiftgroup:Night shifts",
    ]);
    expect(diff.cascade).toEqual([]);

    const night = diff.direct.find((entry) => entry.key === 'shift:"N"');
    expect(night?.kind).toBe("created");
    // Rest changes the stored (and model-filled) duration, so the Preview must say so.
    expect(night?.after).toBe(
      "Night shift · 20:00–08:30 (ends next day) · 60 min break (11h 30m paid)",
    );
    // Rest 0 is stored as absent, exactly as the Shifts page stores it -- no break text.
    expect(diff.direct.find((entry) => entry.key === 'shift:"am1"')?.after).toBe(
      "am1 · 08:00–15:00",
    );
    // Members follow shift order: Night (existing) before N (new).
    expect(diff.direct.find((entry) => entry.key === "shiftgroup:Night shifts")?.after).toBe(
      "Night, N",
    );
    expect(diff.capabilityIds).toContain("shift-types");
    expect(diff.needsReview).toEqual([]);
  });

  it("lists recorded leave and requests date by date, in plain words, as asked-for", () => {
    const before = octoberWard();
    const commands = [
      {
        type: "add_leave" as const,
        personId: "Ana",
        startDate: "2026-10-10",
        endDate: "2026-10-16",
      },
      {
        type: "set_shift_request" as const,
        personId: "Ben",
        shiftType: "N",
        startDate: "2026-10-19",
        endDate: "2026-10-25",
        weight: -5,
      },
      {
        type: "set_shift_request" as const,
        personId: "Chris",
        shiftType: "L",
        startDate: "2026-10-20",
        endDate: "2026-10-20",
        weight: 5,
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error(`fixture should apply: ${applied.rejection.message}`);

    const diff = deriveProposalDiff(before, applied.next, commands);
    expect(diff.cascade).toEqual([]);
    // Ana's 14th was already leave and Ben's 21st is a day off: neither changes, neither is listed.
    expect(diff.direct.map((entry) => entry.key).sort()).toEqual([
      'cell:"Ana"|"10"',
      'cell:"Ana"|"11"',
      'cell:"Ana"|"12"',
      'cell:"Ana"|"13"',
      'cell:"Ana"|"15"',
      'cell:"Ana"|"16"',
      'cell:"Ben"|"19"',
      'cell:"Ben"|"20"',
      'cell:"Ben"|"22"',
      'cell:"Ben"|"23"',
      'cell:"Ben"|"24"',
      'cell:"Ben"|"25"',
      'cell:"Chris"|"20"',
    ]);
    const entry = (key: string) => diff.direct.find((candidate) => candidate.key === key);
    expect(entry('cell:"Ana"|"10"')).toMatchObject({
      label: "Ana on 10",
      before: null,
      after: "On leave",
      kind: "created",
      scope: "leave-and-requests",
    });
    expect(entry('cell:"Ben"|"22"')).toMatchObject({
      before: "Wants D (weight 3)",
      after: "Wants D (weight 3), Would rather not work N (weight -5)",
      kind: "changed",
    });
    expect(entry('cell:"Chris"|"20"')?.after).toBe("Wants D (weight 2), Wants L (weight 5)");
    expect(diff.capabilityIds).toEqual(["leave-and-requests"]);
    expect(diff.needsReview).toEqual([]);
  });

  it("reads a weight-0 day-off request as a plain ask, not a weighted one", () => {
    const before = octoberWard();
    const commands = [
      {
        type: "set_off_request" as const,
        personId: "Chris",
        startDate: "2026-10-01",
        endDate: "2026-10-01",
        weight: 0,
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");

    const diff = deriveProposalDiff(before, applied.next, commands);
    expect(diff.direct).toEqual([
      {
        key: 'cell:"Chris"|"01"',
        scope: "leave-and-requests",
        label: "Chris on 01",
        before: null,
        after: "Asked for the day off",
        kind: "created",
      },
    ]);
  });

  it("shows a cancelled leave and the night it frees, as one asked-for change", () => {
    const before = octoberWard();
    const commands = [
      {
        type: "clear_requests" as const,
        personId: "Ana",
        startDate: "2026-10-14",
        endDate: "2026-10-14",
      },
      {
        type: "set_shift_request" as const,
        personId: "Ana",
        shiftType: "N",
        startDate: "2026-10-14",
        endDate: "2026-10-14",
        weight: "must" as const,
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");

    const diff = deriveProposalDiff(before, applied.next, commands);
    expect(diff.direct).toEqual([
      {
        key: 'cell:"Ana"|"14"',
        scope: "leave-and-requests",
        label: "Ana on 14",
        before: "On leave",
        after: "Must work N",
        kind: "changed",
      },
    ]);
    expect(diff.cascade).toEqual([]);
  });

  it("lists every new rule as asked-for and states each in plain words", () => {
    const before = ruleWardScenario();
    const nightAfter = {
      type: "add_succession_rule" as const,
      description: "No day shift straight after a night shift",
      people: ["ana", "ben", "cai"],
      pattern: ["Night", "Day"],
      dates: ["ALL"],
      weight: "-infinity",
    };
    const commands = [
      nightAfter,
      nightAfter,
      {
        type: "add_count_rule" as const,
        description: "At most 5 night shifts per nurse per month",
        people: ["ana", "ben", "cai"],
        shiftTypes: ["Night"],
        dates: ["ALL"],
        expression: "x <= T" as const,
        target: 5,
        weight: "infinity",
      },
      {
        type: "add_staffing_requirement" as const,
        description: "Two RNs on every night shift",
        shiftType: "Night",
        qualifiedPeople: ["RN"],
        dates: ["ALL"],
        requiredNumPeople: 2,
      },
      {
        type: "edit_count_rule" as const,
        ruleId: "cnt-nights",
        description: "Night cap",
        people: ["ana"],
        shiftTypes: ["Night"],
        dates: ["WEEKEND"],
        expression: "x <= T" as const,
        target: 4,
        weight: "50",
      },
      {
        type: "remove_rule" as const,
        ruleKind: "requirements" as const,
        ruleId: "req-multi",
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error(`fixture should apply: ${applied.rejection.message}`);

    const diff = deriveProposalDiff(before, applied.next, commands);
    expect(diff.cascade).toEqual([]);
    expect(diff.direct).toHaveLength(6);

    const after = (key: string) => diff.direct.find((entry) => entry.key === key);
    const newSequences = diff.direct.filter(
      (entry) => entry.key.startsWith("rule:successions:") && entry.kind === "created",
    );
    expect(newSequences).toHaveLength(2);
    expect(newSequences[0].after).toBe(
      "On · “No day shift straight after a night shift” · Night → Day on consecutive days " +
        "for ana, ben, cai, every date: must never happen",
    );
    expect(
      diff.direct.find((entry) => entry.key.startsWith("rule:counts:") && entry.kind === "created")
        ?.after,
    ).toBe(
      "On · “At most 5 night shifts per nurse per month” · At most 5 Night shifts for each " +
        "of ana, ben, cai, across every date: must always hold",
    );
    expect(
      diff.direct.find(
        (entry) => entry.key.startsWith("rule:requirements:") && entry.kind === "created",
      )?.after,
    ).toBe(
      "On · “Two RNs on every night shift” · Exactly 2 people on Night, every date; " +
        "only RN may work Night",
    );

    const edited = after("rule:counts:cnt-nights");
    expect(edited?.kind).toBe("changed");
    expect(edited?.before).toBe(
      "On · “Night cap” · At most 6 Night shifts for each of ana, across every date: must always hold",
    );
    expect(edited?.after).toBe(
      "On · “Night cap” · At most 4 Night shifts for each of ana, across weekends: " +
        "kept to where possible (weight 50)",
    );

    const removed = after("rule:requirements:req-multi");
    expect(removed?.kind).toBe("removed");
    expect(removed?.before).toBe(
      "On · “Day or Night cover” · Exactly 3 people on each of Day, Night, every date",
    );
    expect(diff.needsReview).toEqual([]);
  });

  it("shows a borrowed nurse as a person, a group change and two runs of days off", () => {
    // The new person's id (their trimmed name) is usable by a later command in the
    // SAME batch; every entry is direct (asked-for), never a cascade.
    const before = peopleScenario();
    const float = "Float RN (Ward 5)";
    const offRun = (startDate: string, endDate: string) => ({
      type: "set_off_request" as const,
      personId: float,
      startDate,
      endDate,
      weight: "must" as const,
    });
    const commands = [
      { type: "add_person" as const, name: float, groups: ["RN"], temporary: false },
      offRun("2026-10-01", "2026-10-11"),
      offRun("2026-10-15", "2026-10-31"),
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");
    const diff = deriveProposalDiff(before, applied.next, commands);

    expect(diff.direct.map((entry) => entry.key).sort()).toEqual([
      `available:"${float}"`,
      `offrun:"${float}"|2026-10-01|2026-10-11`,
      `offrun:"${float}"|2026-10-15|2026-10-31`,
      "peoplegroup:RN",
      `person:"${float}"`,
    ]);
    expect(diff.cascade).toEqual([]);
    expect(diff.needsReview).toEqual([]);
    const find = (key: string) => diff.direct.find((entry) => entry.key === key);
    expect(find(`person:"${float}"`)).toMatchObject({ kind: "created", after: float });
    expect(find("peoplegroup:RN")).toMatchObject({
      label: "Staff group “RN”",
      before: "ana, 7",
      after: `+ ${float}`,
    });
    expect(find(`available:"${float}"`)).toMatchObject({
      label: float,
      after: "Available: 12–14 Oct",
      kind: "created",
    });
    expect(find(`offrun:"${float}"|2026-10-01|2026-10-11`)).toMatchObject({
      scope: "leave-and-requests",
      label: `${float}: Must have the day off`,
      after: "11 days, 2026-10-01 to 2026-10-11",
      kind: "created",
    });
    expect(find(`offrun:"${float}"|2026-10-15|2026-10-31`)?.after).toBe(
      "17 days, 2026-10-15 to 2026-10-31",
    );
    expect(diff.capabilityIds).toEqual(
      expect.arrayContaining(["staff-list", "leave-and-requests"]),
    );
  });

  it("says when an added person is temporary", () => {
    const before = peopleScenario();
    const commands: AssistantCommandV1[] = [
      { type: "add_person", name: "Float RN", groups: [], temporary: true },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error(applied.rejection.message);
    const entry = deriveProposalDiff(before, applied.next, commands).direct.find(
      (e) => e.key === `person:${JSON.stringify("Float RN")}`,
    );
    expect(entry).toMatchObject({
      kind: "created",
      after: "Float RN (temporary: borrowed or agency)",
    });
  });

  it("skips the availability line when the days they are here are not one run", () => {
    const before = peopleScenario();
    const commands = [
      { type: "add_person" as const, name: "Float", groups: [], temporary: false },
      {
        type: "set_off_request" as const,
        personId: "Float",
        startDate: "2026-10-05",
        endDate: "2026-10-20",
        weight: "must" as const,
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");
    const diff = deriveProposalDiff(before, applied.next, commands);

    expect(diff.direct.some((entry) => entry.key.startsWith("available:"))).toBe(false);
  });

  it("names every enabled hard count rule a new person or group member becomes bound by", () => {
    const base = peopleScenario();
    const count = (uid: string, person: string[], weight: number, extra = {}) => ({
      uid,
      description: uid,
      person,
      countDates: ["ALL"],
      countShiftTypes: ["Day"],
      expression: ">=",
      target: 4,
      weight,
      ...extra,
    });
    const before = {
      ...base,
      cardsByKind: {
        ...base.cardsByKind,
        counts: [
          count("RN hours", ["RN"], Infinity, { tag: "contracted_hours", policy: "exact" }),
          count("RN soft", ["RN"], -1),
          count("Everyone minimum", ["ALL"], Infinity),
          count("Everyone off", ["ALL"], Infinity, { disabled: true }),
          count("Seniors cap", ["Seniors"], -Infinity),
        ],
      },
    } as typeof base;
    const commands = [
      { type: "add_person" as const, name: "Float", groups: ["RN"], temporary: false },
      {
        type: "edit_person" as const,
        personId: 7,
        name: "7",
        groups: ["RN", "Seniors"],
        temporary: false,
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");
    const diff = deriveProposalDiff(before, applied.next, commands);

    const binds = diff.cascade.filter((entry) => entry.key.startsWith("binds:"));
    expect(binds.map((entry) => entry.label).sort()).toEqual([
      "“Everyone minimum” now also binds Float",
      "“RN hours” now also binds Float",
      "“Seniors cap” now also binds 7",
    ]);
    expect(binds[0]).toMatchObject({ scope: "shift-counts", before: null, kind: "created" });
    expect(binds.find((entry) => entry.label.includes("RN hours"))?.after).toBe(
      "Hard rule for “RN”; days they must have off do not count toward it",
    );
  });

  it("does not collapse a one-day must-be-off, or a run of softer requests", () => {
    const before = peopleScenario();
    const commands = [
      {
        type: "set_off_request" as const,
        personId: 7,
        startDate: "2026-10-04",
        endDate: "2026-10-04",
        weight: "must" as const,
      },
      {
        type: "set_off_request" as const,
        personId: 7,
        startDate: "2026-10-10",
        endDate: "2026-10-12",
        weight: 3,
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");
    const diff = deriveProposalDiff(before, applied.next, commands);

    expect(diff.direct.map((entry) => entry.key).sort()).toEqual([
      'cell:7|"04"',
      'cell:7|"10"',
      'cell:7|"11"',
      'cell:7|"12"',
    ]);
  });

  it("shows a rename as one renamed entry, with the groups it touched", () => {
    const before = peopleScenario();
    const commands = [
      {
        type: "edit_person" as const,
        personId: "ana",
        name: "Ana Lim",
        groups: ["RN"],
        temporary: false,
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");
    const diff = deriveProposalDiff(before, applied.next, commands);

    expect(diff.direct.find((entry) => entry.key === 'person:"ana"')).toBeUndefined();
    expect(diff.direct.find((entry) => entry.key === 'person:"Ana Lim"')).toMatchObject({
      label: "Renamed “ana” to “Ana Lim”",
      before: "ana",
      after: "Ana Lim",
      kind: "changed",
    });
    expect(diff.direct.find((entry) => entry.key === "peoplegroup:RN")?.after).toBe(
      "+ Ana Lim, − ana",
    );
  });

  it("shows a staff group rename as one renamed entry", () => {
    const before = peopleScenario();
    const commands = [
      {
        type: "edit_people_group" as const,
        groupId: "Seniors",
        newGroupId: "Band 6+",
        description: "Band 6 and above",
        members: ["bo", "ana"],
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");
    const diff = deriveProposalDiff(before, applied.next, commands);

    expect(diff.direct.map((entry) => entry.key)).toEqual(["peoplegroup:Band 6+"]);
    expect(diff.direct[0]).toMatchObject({
      label: "Renamed staff group “Seniors” to “Band 6+”",
      before: "bo · “Band 6 and above”",
      after: "ana, bo · “Band 6 and above”",
      kind: "changed",
    });
  });

  it("removing a person lists what goes with them", () => {
    const before = peopleScenario();
    const commands = [{ type: "remove_person" as const, personId: "bo" }];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");
    const diff = deriveProposalDiff(before, applied.next, commands);

    expect(diff.direct.map((entry) => entry.key)).toEqual(['person:"bo"']);
    expect(diff.cascade.map((entry) => entry.key).sort()).toEqual([
      'cell:"bo"|"29"',
      "peoplegroup:Seniors",
      "rule:counts:count-bo",
    ]);
    expect(diff.cascade.find((entry) => entry.key === "peoplegroup:Seniors")?.after).toBe(
      "− bo · “Band 6 and above”",
    );
    expect(diff.needsReview).toEqual(["rules", "requests"]);
  });

  it("adding and removing staff groups are direct", () => {
    const before = peopleScenario();
    const commands = [
      {
        type: "add_people_group" as const,
        groupId: " Night team ",
        description: "",
        members: [7],
      },
      { type: "remove_people_group" as const, groupId: "Seniors" },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");
    const diff = deriveProposalDiff(before, applied.next, commands);

    expect(diff.direct.map((entry) => [entry.key, entry.kind]).sort()).toEqual([
      ["peoplegroup:Night team", "created"],
      ["peoplegroup:Seniors", "removed"],
    ]);
    expect(diff.direct.find((entry) => entry.key === "peoplegroup:Night team")?.after).toBe("7");
  });

  it("keeps a leave the run replaces as its own entry", () => {
    const before = peopleScenario();
    const commands = [
      {
        type: "set_off_request" as const,
        personId: "ana",
        startDate: "2026-10-01",
        endDate: "2026-10-03",
        weight: "must" as const,
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    if (!applied.ok) throw new Error("fixture should apply");
    const diff = deriveProposalDiff(before, applied.next, commands);

    expect(diff.direct.find((entry) => entry.key.startsWith("offrun:"))?.after).toBe(
      "2 days, 2026-10-01 to 2026-10-03",
    );
    expect(diff.direct.find((entry) => entry.key === 'cell:"ana"|"02"')).toMatchObject({
      before: "On leave",
      after: "Must have the day off",
      kind: "changed",
    });
    expect(diff.direct).toHaveLength(2);
  });
});

describe("rule sentences state what the solver enforces", () => {
  // The Preview is what a ward manager trusts before Apply, so each sentence restates
  // core/nurse_scheduling/preference_types.py, not the rule editor's labels.
  const sentence = (kind: "requirements" | "counts", card: Record<string, unknown>) => {
    const before = ruleWardScenario();
    const after = {
      ...before,
      cardsByKind: {
        ...before.cardsByKind,
        [kind]: [...before.cardsByKind[kind], card],
      },
    };
    const diff = deriveProposalDiff(before, after, []);
    return [...diff.direct, ...diff.cascade].find((entry) => entry.key === `rule:${kind}:x`)?.after;
  };
  const requirement = {
    uid: "x",
    shiftType: ["Night"],
    requiredNumPeople: 2,
    weight: -1,
  };
  const count = {
    uid: "x",
    person: ["ALL"],
    countDates: ["ALL"],
    countShiftTypes: ["Night"],
    expression: "x <= T",
    target: 5,
  };

  it("a preferred count makes a range that leans toward it", () => {
    expect(
      sentence("requirements", {
        ...requirement,
        preferredNumPeople: 3,
        weight: -50,
      }),
    ).toBe("On · 2 to 3 people on Night, every date (3 preferred, weight -50)");
  });

  it("an aggregate group is one combined count, and qualified people ban everyone else", () => {
    expect(
      sentence("requirements", {
        ...requirement,
        shiftType: ["Working shifts"],
        requiredNumPeople: 1,
        qualifiedPeople: ["Senior"],
      }),
    ).toBe(
      "On · Exactly 1 person on Working shifts, every date; only Senior may work Working shifts",
    );
  });

  it("a count's weight rewards the expression holding, so a negative one works against it", () => {
    expect(sentence("counts", { ...count, weight: -50 })).toBe(
      "On · At most 5 Night shifts for everyone, across every date: " +
        "worked against, the solver is rewarded for breaking it (weight -50)",
    );
    expect(sentence("counts", { ...count, weight: Number.NEGATIVE_INFINITY })).toBe(
      "On · At most 5 Night shifts for everyone, across every date: " +
        "must never hold, the solver forces the opposite",
    );
  });

  it("close to target pulls toward T with a negative weight", () => {
    expect(sentence("counts", { ...count, expression: "|x - T|^2", weight: -5 })).toBe(
      "On · Close to 5 Night shifts for everyone, across every date: " +
        "pulled toward 5 (weight -5)",
    );
    expect(
      sentence("counts", {
        ...count,
        expression: "|x - T|^2",
        weight: Number.NEGATIVE_INFINITY,
      }),
    ).toBe("On · Close to 5 Night shifts for everyone, across every date: must be exactly 5");
  });
});

describe("skill mix in the Preview", () => {
  const before = ward({
    staff: people("rn1", "en1"),
    staffGroups: [
      { id: "RN", members: ["rn1"] },
      { id: "Senior", members: ["rn1"] },
    ],
    cardsByKind: cards({ requirements: [requirement("night", "N", 4)] }),
  });
  const after = {
    ...before,
    cardsByKind: cards({
      requirements: [
        requirement("night", "N", 4, {
          skillMix: [
            { people: "RN", minNumPeople: 2 },
            { people: "Senior", minNumPeople: 1 },
          ],
        }),
      ],
    }),
  };

  it("shows the skill mix as a before/after change on the card", () => {
    const entries = diffScenarioDocuments(before, after);
    const entry = entries.find((e) => e.key === "rule:requirements:night");
    expect(entry?.kind).toBe("changed");
    expect(entry?.before).not.toContain("at least");
    expect(entry?.after).toContain(
      "; at least 2 from “RN”, 1 from “Senior” — anyone can fill the other places",
    );
  });
});

describe("scope identities", () => {
  it("every scope but the deferred export route is a real shipped capability id", () => {
    // The Preview says "this affects these screens" by naming capability ids. If one
    // of them were not in the deployed registry, the assistant would be pointing at
    // a screen the app does not have -- the exact failure the registry exists to stop.
    const ids = new Set(getCapabilityRegistry().entries.map((entry) => entry.id));
    for (const scope of Object.keys(SCOPE_LABEL) as DiffScope[]) {
      if (scope === "export-layout") continue;
      expect(ids.has(scope), `${scope} is not a shipped capability id`).toBe(true);
    }
  });
});
