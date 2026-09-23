// The host-derived change set (T07).
//
// The property under test is that a Preview cannot UNDERSTATE a change. A range
// shrink reaches the request matrix and the date groups through code the arm itself
// never mentions, so the assertions here are about what the comparison FINDS, not
// about what the arm intended.

import { describe, expect, it } from "vitest";
import { getCapabilityRegistry } from "@/lib/capability/registry";
import { applyAssistantCommands } from "./operations";
import { deriveProposalDiff, SCOPE_LABEL, type DiffScope } from "./diff";
import { octoberWard, peopleScenario, proposalScenario, ruleWardScenario } from "./test-support";

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

  it("shows the borrowed-nurse batch (add_person + set_off_request) as one direct change", () => {
    // The new person's id (their trimmed name) is usable by a later command in the
    // SAME batch -- the Preview must show both the new staff row and every day-off
    // cell as direct (asked-for), never as a cascade the person didn't request.
    const before = peopleScenario();
    const float = "Float RN (Ward 5)";
    const commands = [
      { type: "add_person" as const, name: float, groups: ["RN"] },
      {
        type: "set_off_request" as const,
        personId: float,
        startDate: "2026-10-01",
        endDate: "2026-10-11",
        weight: "must" as const,
      },
      {
        type: "set_off_request" as const,
        personId: float,
        startDate: "2026-10-15",
        endDate: "2026-10-31",
        weight: "must" as const,
      },
    ];
    const applied = applyAssistantCommands(before, commands);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const diff = deriveProposalDiff(before, applied.next, commands);
    expect(diff.cascade).toEqual([]);

    const person = diff.direct.find((entry) => entry.key === `person:"${float}"`);
    expect(person).toMatchObject({
      scope: "staff-list",
      kind: "created",
      after: float,
    });

    const cellKeys = diff.direct.filter((entry) => entry.scope === "leave-and-requests");
    expect(cellKeys).toHaveLength(28);
    expect(cellKeys.every((entry) => entry.after === "Must have the day off")).toBe(true);

    expect(diff.capabilityIds).toEqual(
      expect.arrayContaining(["staff-list", "leave-and-requests"]),
    );
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
