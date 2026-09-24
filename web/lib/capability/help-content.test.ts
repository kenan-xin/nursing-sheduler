import { describe, expect, it } from "vitest";
import { CAPABILITY_ENTRIES } from "./help-content";
import { listCapabilities } from "./resolve";

const summary = (id: string) =>
  CAPABILITY_ENTRIES.find((e) => e.id === id)?.nurseFacingSummary ?? "";

describe("what the scheduler cannot do (scheduler-limits)", () => {
  const text = summary("scheduler-limits");

  it("says it does not read clock times or hours between shifts", () => {
    expect(text).toMatch(/clock times/);
    expect(text).toMatch(/between shifts/);
  });
  it("says days in a row across mixed shifts are a shift-order rule of 'any shift'", () => {
    // `ALL` in a succession is any worked shift (preference_types.py), so this IS expressible.
    expect(text).toMatch(/in a row/);
    expect(text).toMatch(/'any shift'/);
    expect(text).not.toMatch(/cannot count days in a row/);
  });
  it("says limits use fixed dates, not a rolling window", () => {
    expect(text).toMatch(/rolling/);
  });
  it("says counts start fresh each period, but shift-order rules read each nurse's history", () => {
    expect(text).toMatch(/Counts start fresh each roster period/);
    expect(text).toMatch(/public holiday/);
    expect(text).toMatch(/last shifts entered on the Requests page/);
    expect(text).not.toMatch(/remembers nothing/);
  });
  it("no longer says skill mix is unsupported, and points to staffing requirements", () => {
    expect(text).not.toMatch(/not supported yet/);
    expect(text).toMatch(/skill mix.*Staffing requirements/);
  });
  it("says it checks no law or policy, without stating any law", () => {
    expect(text).toMatch(/checks no employment law/);
    expect(text).not.toMatch(/\d+\s*hours? (of )?rest/i);
    expect(text).not.toMatch(/ratio of|1:\d/);
  });
  it("is served in both modes", () => {
    for (const mode of ["guided", "advanced"] as const) {
      const listed = listCapabilities({ mode, modeResolved: true, gates: [] });
      if (listed.status !== "ok") throw new Error("expected ok");
      expect(listed.value.map((c) => c.id)).toContain("scheduler-limits");
    }
  });
});

describe("the rule entries carry the solver facts", () => {
  it("staffing: exact, the preferred count on this screen, one shift code per group", () => {
    const text = summary("staffing-requirements");
    expect(text).toMatch(/preferred number is set here/);
    expect(text).toMatch(/separate shift code/);
    expect(text).toMatch(/two teams are each set as the only people/);
    expect(text).not.toMatch(/at least/i);
    expect(text).toContain("nobody else may work");
    expect(text).toMatch(
      /A skill-mix rule says how many of a shift's people must come from a group/,
    );
    expect(text).toMatch(/anyone can fill the other places/);
    expect(text).not.toMatch(/cannot express|cannot set one up/);
  });
  it("successions: exact pattern only; a must-follow is risky", () => {
    const text = summary("shift-successions");
    expect(text).toMatch(/exact pattern/);
    expect(text).toMatch(/must follow/);
    expect(text).toMatch(/'any shift' matches every worked shift/);
  });
  it("counts: a balance rule spreads nights and weekends", () => {
    const text = summary("shift-counts");
    expect(text).toMatch(/as close to/);
    expect(text).toMatch(/same few people/);
  });
  it("generate-roster: score, not proven best, and re-runs", () => {
    const text = summary("generate-roster");
    expect(text).toMatch(/score/);
    expect(text).toMatch(/not proven/);
    expect(text).toMatch(/different roster/);
  });
  it("roster-period: holiday groups need the import", () => {
    expect(summary("roster-period")).toMatch(/empty until/);
  });
});
