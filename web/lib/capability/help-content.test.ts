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
  it("says mixed-shift runs need a weekly working-day limit too", () => {
    expect(text).toMatch(/in a row/);
    expect(text).toMatch(/per week/);
  });
  it("says limits use fixed dates, not a rolling window", () => {
    expect(text).toMatch(/rolling/);
  });
  it("says it remembers nothing from earlier rosters, owed days included", () => {
    expect(text).toMatch(/one roster period at a time/);
    expect(text).toMatch(/public holiday/);
  });
  it("says skill mix is not supported yet, in both modes", () => {
    expect(text).toMatch(/skill mix/);
    expect(text).toMatch(/not supported yet/);
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
    expect(text).not.toMatch(/at least/i);
    expect(text).toContain("nobody else may work");
    expect(text).toContain("skill-mix");
  });
  it("successions: exact pattern only; a must-follow is risky", () => {
    const text = summary("shift-successions");
    expect(text).toMatch(/exact pattern/);
    expect(text).toMatch(/must follow/);
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
