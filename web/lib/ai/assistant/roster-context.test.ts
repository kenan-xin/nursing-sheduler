import { describe, expect, it } from "vitest";
import { buildRuleModel } from "@/lib/roster-viewer/rule-check";
import { planShortShift, planSickCover, planSwap, planTrade } from "@/lib/roster-viewer/swap";
import {
  ashaContext,
  ashaDocument,
  ashaGrid,
  overtimeContext,
  overtimeDocument,
  overtimeGrid,
  priyaContext,
  priyaDocument,
  priyaGrid,
  priyaRosterDocument,
  shortContext,
  shortDocument,
  shortGrid,
} from "@/lib/roster-viewer/swap-fixtures";
import {
  buildBorrowView,
  buildOvertimeView,
  buildRosterChangeView,
  buildShortView,
  buildSickView,
  buildTradeView,
  readRosterForAssistant,
  summarizeRoster,
} from "./roster-context";

const row = {
  document: priyaRosterDocument(),
  revision: 1,
  candidateSource: { jobId: "job-1", candidateVersion: 1 },
};
const pointer = { jobId: "job-1", candidateVersion: 1, submissionOrdinal: 1 };

describe("readRosterForAssistant", () => {
  it("reads the working roster and sees no newer run when it came from the latest one", async () => {
    const read = await readRosterForAssistant({
      readWorking: async () => row as never,
      readCurrentCandidate: async () => pointer,
    });
    expect(read).toMatchObject({ status: "ready", newerRunWaiting: false });
  });

  it("flags a newer run that has not been loaded", async () => {
    const read = await readRosterForAssistant({
      readWorking: async () => row as never,
      readCurrentCandidate: async () => ({ ...pointer, jobId: "job-2" }),
    });
    expect(read).toMatchObject({ status: "ready", newerRunWaiting: true });
  });

  it("says unavailable, not empty, when storage cannot be read", async () => {
    const read = await readRosterForAssistant({
      readWorking: async () => {
        throw new Error("no IndexedDB");
      },
      readCurrentCandidate: async () => null,
    });
    expect(read).toEqual({ status: "unavailable" });
  });
});

describe("summarizeRoster", () => {
  it("gives one row of codes per person for the asked range", () => {
    const summary = summarizeRoster(
      priyaRosterDocument(),
      { fromDate: "2026-10-08", toDate: "2026-10-09", people: ["Priya"] },
      false,
    );
    if (typeof summary === "string") throw new Error(summary);
    expect(summary.dates).toEqual(["2026-10-08", "2026-10-09"]);
    expect(summary.rows).toEqual([{ person: "SN-Priya", days: ["N", "N"] }]);
    expect(summary.rulesBrokenNow).toEqual([]);
  });

  it("refuses an unknown name and lists who is on the roster", () => {
    expect(summarizeRoster(priyaRosterDocument(), { people: ["Zed"] }, false)).toMatch(
      /Not on this roster: Zed.*SN-Priya/,
    );
  });
});

describe("buildRosterChangeView", () => {
  it("shows every changed cell in the ward's words", () => {
    const ctx = {
      context: priyaContext(),
      days: priyaGrid(),
      model: buildRuleModel(priyaDocument()),
    };
    const plan = planSwap(ctx, 0, 5, [1, 2]);
    if (!plan.ok) throw new Error(plan.reasons.join(" "));
    const view = buildRosterChangeView(ctx.context, 0, 5, plan, "Priya needs those nights off.");
    expect(view.title).toBe("SN-Priya and SN-Eve, 8 Oct and 9 Oct");
    expect(view.rows[0]).toEqual({
      person: "SN-Priya",
      date: "8 Oct",
      now: "Night",
      after: "Afternoon",
    });
    expect(view.rows).toHaveLength(4);
  });

  it("says Day off and Leave on the card, never the roster codes", () => {
    const ctx = {
      context: priyaContext(),
      days: priyaGrid(),
      model: buildRuleModel(priyaDocument()),
    };
    const plan = planSickCover(ctx, 0, 3, [1]);
    if (!plan.ok) throw new Error(plan.reasons.join(" "));
    const view = buildSickView(ctx.context, 0, 3, plan, "MC.");
    expect(view.rows).toEqual([
      { person: "SN-Priya", date: "8 Oct", now: "Night", after: "Leave" },
      { person: "SN-Cara", date: "8 Oct", now: "Day off", after: "Night" },
    ]);
  });
});

describe("ladder views", () => {
  it("says the Asha agreement in one plain sentence", () => {
    const ctx = { context: ashaContext(), days: ashaGrid(), model: buildRuleModel(ashaDocument()) };
    const plan = planTrade(ctx, 0, 1, [1, 2], [4, 5], "person-covers");
    if (!plan.ok) throw new Error(plan.reasons.join(" "));
    const view = buildTradeView(ctx.context, 0, 1, plan, "Priya needs those nights off.");
    expect(view.stepLabel).toBe("Step 2 · Ask someone off or on leave to come in");
    expect(view.agreement).toBe(
      "SN-Asha agreed to come in on 8–9 Oct and take leave on 11–12 Oct instead, and SN-Priya agreed to work 11–12 Oct.",
    );
    expect(view.leaveRows).toEqual(["SN-Asha's leave: 8–9 Oct → 11–12 Oct"]);
    expect(view.notes).toContain("This changes the roster and the leave record together.");
  });

  it("states the gap when only the MC is recorded", () => {
    const ctx = {
      context: priyaContext(),
      days: priyaGrid(),
      model: buildRuleModel(priyaDocument()),
    };
    const plan = planSickCover(ctx, 0, null, [1]);
    if (!plan.ok) throw new Error("record should never refuse");
    const view = buildSickView(ctx.context, 0, null, plan, "MC.");
    expect(view.heading).toBe("Cover SN-Priya's MC?");
    expect(view.notes).toContain(
      "Still uncovered: 8 Oct: “One night nurse” has 0 of the 1 needed.",
    );
  });

  it("frames an overtime cover as a request with its pay-back", () => {
    const ctx = {
      context: overtimeContext(),
      days: overtimeGrid(),
      model: buildRuleModel(overtimeDocument()),
    };
    const plan = planSickCover(ctx, 0, 2, [1]);
    if (!plan.ok) throw new Error(plan.reasons.join(" "));
    const view = buildOvertimeView(ctx.context, 0, 2, plan, "sick_or_emergency", "Priya is on MC.");
    expect(view.heading).toBe("Ask SN-Kai to come in?");
    expect(view.agreement).toBe("SN-Kai agreed to come in on 8 Oct for overtime pay.");
  });

  it("says where a temporary nurse comes from", () => {
    const view = buildBorrowView(
      "SN-Tan",
      "relief_pool",
      [],
      [{ date: "8 Oct", shift: "N" }],
      null,
      "Short on nights.",
    );
    expect(view.title).toBe("SN-Tan (relief pool): N on 8 Oct");
    expect(view.notes[0]).toBe(
      "Adds SN-Tan (relief pool) as temporary staff, off on every other date.",
    );
    expect(view.notes).toContain("Please let your nurse manager know.");
  });

  it("asks for the nurse manager's sign-off to run one short", () => {
    const ctx = {
      context: shortContext(),
      days: shortGrid(),
      model: buildRuleModel(shortDocument()),
    };
    const plan = planShortShift(ctx, 0, [1], "sick_or_emergency");
    if (!plan.ok) throw new Error(plan.reasons.join(" "));
    const view = buildShortView(ctx.context, 0, plan, "No one is available.");
    expect(view.stepLabel).toBe("Step 4 · Last resort: run one short");
    expect(view.agreement).toBe(
      "My nurse manager has agreed it is safe to run “Two night nurses” on 8 Oct with 1 instead of 2.",
    );
  });
});
