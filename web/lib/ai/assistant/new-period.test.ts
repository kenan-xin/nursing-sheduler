import { describe, expect, it } from "vitest";
import { deriveNewPeriod, type PastRoster } from "@/lib/proposal";
import { proposalScenario } from "@/lib/proposal/test-support";
import { buildNewPeriodView, scheduleRef, summarizePastRoster } from "./new-period";

const roster: PastRoster = {
  context: {
    people: [{ id: "ana" }, { id: "bo" }],
    shiftTypes: [{ id: "Day" }],
    calendar: Array.from({ length: 30 }, (_, i) => ({
      iso: `2026-04-${String(i + 1).padStart(2, "0")}`,
      weekday: "Mon",
      weekend: false,
      holiday: false,
    })),
    baselineMinimums: [],
    leaveCreditMinutes: null,
  },
  solvedDays: [0, 1].map(() =>
    Array.from({ length: 30 }, (_, d) =>
      d % 2 ? { kind: "off" as const } : { kind: "shift" as const, shiftId: "Day" },
    ),
  ),
  edits: [{ personIdx: 1, dateIdx: 29, day: { kind: "leave" } }],
};

function viewFor(range: { start: string; end: string }, withRoster: boolean) {
  const past = proposalScenario();
  const result = deriveNewPeriod(past, withRoster ? roster : null, range);
  if (!result.ok) throw new Error(result.message);
  return buildNewPeriodView(
    { name: "Ward 3 · April 2026", scenario: past },
    result.plan,
    "Ward 3 · May 2026",
  );
}

describe("schedule refs", () => {
  it("are short, stable and not the id", () => {
    expect(scheduleRef("abc-123")).toBe(scheduleRef("abc-123"));
    expect(scheduleRef("abc-123")).not.toBe(scheduleRef("abc-124"));
    expect(scheduleRef("abc-123")).toMatch(/^sch-[0-9a-f]{8}$/);
  });
});

describe("the past roster summary", () => {
  it("gives each person's totals and last 7 days, hand edits applied", () => {
    const summary = summarizePastRoster(roster);
    expect(summary.period).toEqual({ start: "2026-04-01", end: "2026-04-30" });
    expect(summary.rows[0]).toEqual({
      person: "ana",
      totals: { Day: 15, OFF: 15 },
      lastDays: ["OFF", "Day", "OFF", "Day", "OFF", "Day", "OFF"],
    });
    expect(summary.rows[1]!.lastDays.at(-1)).toBe("LEAVE");
  });
});

describe("the card's sentences", () => {
  it("say what is copied, what is left behind, and where the chat goes", () => {
    const view = viewFor({ start: "2026-05-01", end: "2026-05-31" }, true);
    expect(view.copied).toBe(
      "Copies 2 people, 2 shift types and 2 rules from “Ward 3 · April 2026”, for May 2026.",
    );
    expect(view.holidays).toBe("Singapore public holidays are marked for May 2026.");
    expect(view.history).toBe(
      "Rest history: the last 7 days of April 2026's roster, for 2 people.",
    );
    expect(view.notCarried).toBe(
      "Not copied: 2 requests, 1 leave day. Add them for May 2026 if they still apply.",
    );
    expect(view.dropped).toEqual(["Date group “Handover days”: 2 dates → 0 dates"]);
    expect(view.outcome).toMatch(/chat moves to “Ward 3 · May 2026”/);
  });

  it("say why no history was carried", () => {
    expect(viewFor({ start: "2026-06-01", end: "2026-06-30" }, true).history).toBe(
      "June 2026 does not follow straight after April 2026, so no rest history was carried.",
    );
    expect(viewFor({ start: "2026-05-01", end: "2026-05-31" }, false).history).toBe(
      "“Ward 3 · April 2026” has no saved roster, so no rest history was carried.",
    );
  });
});
