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
import { proposalScenario } from "./test-support";

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
    expect(diff.direct[0].before).toContain('"requiredNumPeople":2');
    expect(diff.direct[0].after).toContain('"requiredNumPeople":4');
    expect(diff.cascade).toEqual([]);
    expect(diff.needsReview).toEqual([]);
  });

  it("shows a displaced cell at a move's destination as part of the same change", () => {
    const before = proposalScenario();
    const commands = [
      { type: "move_leave" as const, personId: "ana", fromDate: "02", toDate: "07" },
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
    expect(destination?.after).toBe("Leave");
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
      { type: "add_shift_group" as const, groupId: "Night shifts", members: ["N", "Night"] },
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
    expect(night?.after).toBe("Night shift · 20:00–08:30 (ends next day)");
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
