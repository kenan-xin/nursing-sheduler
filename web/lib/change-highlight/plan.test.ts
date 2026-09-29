import { describe, expect, it } from "vitest";
import type { DiffScope, ProposalDiffEntry } from "@/lib/proposal/diff";
import { planChangeHighlight, screenForScope, targetKeyFor } from "./plan";

const entry = (
  key: string,
  scope: DiffScope,
  kind: ProposalDiffEntry["kind"] = "created",
): ProposalDiffEntry => ({ key, scope, label: key, before: null, after: "x", kind });

describe("screenForScope", () => {
  it("maps a scope to its own capability in Advanced", () => {
    expect(screenForScope("staffing-requirements", "advanced")).toBe("staffing-requirements");
    expect(screenForScope("shift-types", "advanced")).toBe("shift-types");
  });
  it("guided mode folds every rule scope into rule-library", () => {
    for (const scope of [
      "staffing-requirements",
      "shift-successions",
      "shift-counts",
      "shift-affinities",
      "shift-type-coverings",
    ] as const) {
      expect(screenForScope(scope, "guided")).toBe("rule-library");
    }
    expect(screenForScope("staff-list", "guided")).toBe("staff-list");
  });
});

describe("targetKeyFor", () => {
  it("passes direct row keys through", () => {
    expect(targetKeyFor(entry('shift:"EVE"', "shift-types"))).toBe('shift:"EVE"');
    expect(targetKeyFor(entry('cell:"bo"|"12"', "leave-and-requests"))).toBe('cell:"bo"|"12"');
  });
  it("removed entries are announced but never targeted", () => {
    expect(targetKeyFor(entry('shift:"EVE"', "shift-types", "removed"))).toBeNull();
  });
  it("points a folded days-off run and an availability line at the person's row", () => {
    expect(targetKeyFor(entry('offrun:"cy"|01|14', "leave-and-requests"))).toBe('person:"cy"');
    expect(targetKeyFor(entry('available:"cy"', "leave-and-requests"))).toBe('person:"cy"');
    expect(
      targetKeyFor(entry('groupleave:"Seniors"|2026-10-05|2026-10-07', "leave-and-requests")),
    ).toBe('person:"Seniors"');
  });
  it("points a binds/narrowed consequence at its count rule", () => {
    expect(targetKeyFor(entry('binds:u1|"cy"', "shift-counts"))).toBe("rule:counts:u1");
    expect(targetKeyFor(entry("narrowed:u1", "shift-counts", "changed"))).toBe("rule:counts:u1");
  });
  it("points a cover row at itself, and leaves its warnings untargeted", () => {
    // The row key is the Staff row's own change key (d582).
    expect(targetKeyFor(entry("cover:Haseena (Ward 3)|2026-11-05|N", "staff-list"))).toBe(
      "cover:Haseena (Ward 3)|2026-11-05|N",
    );
    // A warning restates the count line above it; there is no row of its own to outline.
    expect(
      targetKeyFor(entry("cover-note:extra|night|2026-11-05|N", "staffing-requirements")),
    ).toBeNull();
  });
});

describe("planChangeHighlight", () => {
  it("picks the screen with the most direct entries and lists the rest", () => {
    const plan = planChangeHighlight(
      {
        direct: [
          entry('shift:"EVE"', "shift-types"),
          entry('shift:"LATE"', "shift-types"),
          entry('shift:"N2"', "shift-types"),
          entry('person:"cy"', "staff-list"),
        ],
        cascade: [entry('cell:"bo"|"29"', "leave-and-requests", "removed")],
      },
      "advanced",
    );
    expect(plan.primary).toMatchObject({
      capabilityId: "shift-types",
      directCount: 3,
      keys: ['shift:"EVE"', 'shift:"LATE"', 'shift:"N2"'],
      announcement: "3 shift types added",
    });
    expect(plan.others.map((s) => s.capabilityId)).toEqual(["staff-list", "leave-and-requests"]);
    expect(plan.others[1]).toMatchObject({
      keys: [],
      announcement: "1 leave or request day removed",
    });
  });

  it("breaks a tie in setup order", () => {
    const plan = planChangeHighlight(
      {
        direct: [
          entry('person:"cy"', "staff-list"),
          entry("dates:range", "roster-period", "changed"),
        ],
        cascade: [],
      },
      "advanced",
    );
    expect(plan.primary?.capabilityId).toBe("roster-period");
  });

  it("highlights cascade entries on the screen it opens, and counts a rule once", () => {
    const plan = planChangeHighlight(
      {
        direct: [entry("rule:counts:u1", "shift-counts", "changed")],
        cascade: [
          entry("narrowed:u1", "shift-counts", "changed"),
          entry('binds:u2|"cy"', "shift-counts"),
        ],
      },
      "advanced",
    );
    expect(plan.primary?.keys).toEqual(["rule:counts:u1", "rule:counts:u2"]);
    expect(plan.primary?.announcement).toBe(
      "1 shift count rule changed, 1 shift count rule affected",
    );
  });

  it("merges rule scopes into the Guided Rules screen", () => {
    const plan = planChangeHighlight(
      {
        direct: [
          entry("rule:requirements:r9", "staffing-requirements"),
          entry("rule:successions:s9", "shift-successions"),
        ],
        cascade: [],
      },
      "guided",
    );
    expect(plan.primary).toMatchObject({
      capabilityId: "rule-library",
      directCount: 2,
    });
    expect(plan.others).toEqual([]);
  });

  it("announces a booked cover on the Staff screen, and its warnings as consequences", () => {
    const plan = planChangeHighlight(
      {
        direct: [
          entry("cover:Haseena (Ward 3)|2026-11-05|N", "staff-list"),
          entry("cover:night|2026-11-05|N", "staffing-requirements", "changed"),
        ],
        cascade: [entry("cover-note:extra|night|2026-11-05|N", "staffing-requirements")],
      },
      "advanced",
    );
    // The Staff screen owns the command: one direct entry each, and setup order breaks
    // the tie. Its own announcement is the row.
    expect(plan.primary).toMatchObject({
      capabilityId: "staff-list",
      directCount: 1,
      keys: ["cover:Haseena (Ward 3)|2026-11-05|N"],
      announcement: "1 temporary cover added",
    });
    // The count line is a requested change too; the warning is not a second cover.
    expect(plan.others[0]).toMatchObject({
      capabilityId: "staffing-requirements",
      directCount: 1,
      keys: ["cover:night|2026-11-05|N"],
      announcement: "1 temporary cover changed",
    });
  });
});
