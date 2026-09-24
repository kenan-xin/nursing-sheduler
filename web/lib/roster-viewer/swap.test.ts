import { describe, expect, it } from "vitest";
import type { CanonicalScenarioDocument } from "@/lib/scenario";
import type { RosterContext, RosterDayState } from "@/lib/roster/types";
import { buildRuleModel, countHeadroom } from "./rule-check";
import {
  findCoverLadder,
  findPersonIdx,
  findSwapPartners,
  findTrades,
  givingProblem,
  planSickCover,
  planShortShift,
  planSwap,
  planTrade,
  type SwapContext,
} from "./swap";
import {
  ashaContext,
  ashaDocument,
  ashaGrid,
  borrowContext,
  borrowDocument,
  borrowGrid,
  overtimeContext,
  overtimeDocument,
  overtimeGrid,
  priyaContext,
  priyaDocument,
  priyaGrid,
  shortContext,
  shortDocument,
  shortGrid,
} from "./swap-fixtures";

const ctx: SwapContext = {
  context: priyaContext(),
  days: priyaGrid(),
  model: buildRuleModel(priyaDocument()),
};
const [PRIYA, ANA, BEN, CARA, DEV, EVE] = [0, 1, 2, 3, 4, 5];
const NIGHTS = [1, 2]; // 8 and 9 Oct

describe("finding people by the name a nurse types", () => {
  it("matches exactly, then a unique part of the name", () => {
    expect(findPersonIdx(ctx.context, "SN-Priya")).toBe(PRIYA);
    expect(findPersonIdx(ctx.context, "priya")).toBe(PRIYA);
    expect(findPersonIdx(ctx.context, "SN")).toBe(-1); // ambiguous
    expect(findPersonIdx(ctx.context, "Zed")).toBe(-1);
  });
});

describe("planSwap", () => {
  it("plans a cover as four cells and calls it a cover", () => {
    const plan = planSwap(ctx, PRIYA, CARA, NIGHTS);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.kind).toBe("cover");
    expect(plan.cells).toEqual([
      {
        personIdx: PRIYA,
        dateIdx: 1,
        before: { kind: "shift", shiftId: "N" },
        after: { kind: "off" },
      },
      {
        personIdx: CARA,
        dateIdx: 1,
        before: { kind: "off" },
        after: { kind: "shift", shiftId: "N" },
      },
      {
        personIdx: PRIYA,
        dateIdx: 2,
        before: { kind: "shift", shiftId: "N" },
        after: { kind: "off" },
      },
      {
        personIdx: CARA,
        dateIdx: 2,
        before: { kind: "off" },
        after: { kind: "shift", shiftId: "N" },
      },
    ]);
  });

  it("refuses a night followed by a morning", () => {
    const plan = planSwap(ctx, PRIYA, ANA, NIGHTS);
    expect(plan).toEqual({
      ok: false,
      reasons: [
        "SN-Ana works N on 9 Oct, then AM on 10 Oct, which “No morning after night” does not allow.",
      ],
    });
  });

  it("refuses a partner the night cap rules out", () => {
    const plan = planSwap(ctx, PRIYA, BEN, NIGHTS);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reasons[0]).toBe(
      "SN-Ben has 4 counted under “Max 3 nights”, which needs at most 3.",
    );
  });

  it("refuses a partner outside the qualified group", () => {
    const plan = planSwap(ctx, PRIYA, DEV, NIGHTS);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reasons[0]).toBe("8 Oct: SSN-Dev works N, which only Nights may work.");
  });

  it("refuses a partner who already holds the same shift", () => {
    const plan = planSwap(ctx, DEV, EVE, [1]);
    expect(plan).toEqual({ ok: false, reasons: ["SN-Eve already works PM on 8 Oct."] });
  });

  it("says when the person is not working on a date at all", () => {
    expect(givingProblem(ctx, PRIYA, [3])).toBe("SN-Priya is not working on 10 Oct (day off).");
  });
});

describe("findSwapPartners", () => {
  it("ranks valid partners by fairness and explains who is ruled out", () => {
    const search = findSwapPartners(ctx, PRIYA, NIGHTS);
    expect(search.candidates.map((c) => c.partnerIdx)).toEqual([CARA, EVE]);
    expect(search.candidates[1].plan.kind).toBe("exchange");
    expect(search.ruledOut.map((r) => r.partnerIdx)).toEqual([ANA, BEN, DEV]);
  });
});

describe("sick or emergency leave (step 1)", () => {
  it("puts the person on leave and finds a cover or a move", () => {
    const ladder = findCoverLadder(ctx, PRIYA, [1], "sick_or_emergency");
    expect(ladder.step).toBe(1);
    expect(ladder.candidates.slice(0, 2).map((c) => [c.partnerIdx, c.plan.kind])).toEqual([
      [CARA, "cover"],
      [EVE, "move"],
    ]);
    const cover = planSickCover(ctx, PRIYA, CARA, [1]);
    expect(cover.ok && cover.cells[0]).toEqual({
      personIdx: PRIYA,
      dateIdx: 1,
      before: { kind: "shift", shiftId: "N" },
      after: { kind: "leave" },
    });
  });

  it("records the MC alone and states the gap instead of refusing", () => {
    const plan = planSickCover(ctx, PRIYA, null, [1]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.kind).toBe("record");
    expect(plan.uncovered).toEqual(["8 Oct: “One night nurse” has 0 of the 1 needed."]);
  });
});

describe("the escalation ladder", () => {
  it("returns only the lowest step with an option", () => {
    expect(findCoverLadder(ctx, PRIYA, NIGHTS, "swap").step).toBe(1);
    const borrow = {
      context: borrowContext(),
      days: borrowGrid(),
      model: buildRuleModel(borrowDocument()),
    };
    const ladder = findCoverLadder(borrow, 0, [1], "sick_or_emergency");
    expect(ladder.step).toBe(3);
    expect(ladder.candidates).toEqual([]);
    expect(ladder.trades).toEqual([]);
    expect(ladder.borrow).toEqual([{ dateIdx: 1, shift: "N", skillGroup: "Nights" }]);
  });
});

describe("step 2: trades with someone off or on leave", () => {
  const asha = { context: ashaContext(), days: ashaGrid(), model: buildRuleModel(ashaDocument()) };
  const [P, ASHA_IDX, BEN_IDX, CY_IDX] = [0, 1, 2, 3];

  it("offers trades only after step 1 is empty, off trades first", () => {
    const ladder = findCoverLadder(asha, P, [1, 2], "swap");
    expect(ladder.step).toBe(2);
    expect(ladder.ruledOut.find((r) => r.partnerIdx === ASHA_IDX)?.reason).toBe(
      "SN-Asha is on leave on 8 Oct.",
    );
    expect(ladder.trades.map((t) => [t.partnerIdx, t.plan.laterDateIdxs])).toEqual([
      [CY_IDX, [3, 4]],
      [ASHA_IDX, [4, 5]],
    ]);
  });

  it("moves Asha's leave to the later dates and has Priya work her mornings", () => {
    const plan = planTrade(asha, P, ASHA_IDX, [1, 2], [4, 5], "person-covers");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.leaveMoves).toEqual([
      { personIdx: ASHA_IDX, from: 1, to: 4 },
      { personIdx: ASHA_IDX, from: 2, to: 5 },
    ]);
    expect(plan.cells.slice(0, 4)).toEqual([
      { personIdx: P, dateIdx: 1, before: { kind: "shift", shiftId: "N" }, after: { kind: "off" } },
      {
        personIdx: ASHA_IDX,
        dateIdx: 1,
        before: { kind: "leave" },
        after: { kind: "shift", shiftId: "N" },
      },
      {
        personIdx: ASHA_IDX,
        dateIdx: 4,
        before: { kind: "shift", shiftId: "AM" },
        after: { kind: "leave" },
      },
      {
        personIdx: P,
        dateIdx: 4,
        before: { kind: "off" },
        after: { kind: "shift", shiftId: "AM" },
      },
    ]);
  });

  it("checks the later dates too: nobody covering Asha's mornings breaks staffing", () => {
    const plan = planTrade(asha, P, ASHA_IDX, [1, 2], [4, 5], "partner-off");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reasons).toContain("11 Oct: “One morning nurse” has 0 of the 1 needed.");
  });

  it("checks the day after the moved shifts", () => {
    // Ben is off on 8-9 Oct, but N on 7-9 is followed by his AM on 10 Oct, whatever later dates he gives.
    expect(findTrades(asha, P, [1, 2], "swap").some((t) => t.partnerIdx === BEN_IDX)).toBe(false);
    const plan = planTrade(asha, P, BEN_IDX, [1, 2], [5, 6], "person-covers");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reasons).toContain(
      "SN-Ben works N on 9 Oct, then AM on 10 Oct, which “No morning after night” does not allow.",
    );
  });

  it("never lets a sick nurse cover later shifts", () => {
    const plan = planTrade(asha, P, ASHA_IDX, [1, 2], [4, 5], "person-covers", "sick_or_emergency");
    expect(plan).toEqual({
      ok: false,
      reasons: [
        "SN-Priya is on sick or emergency leave, so SN-Priya cannot work later shifts in return.",
      ],
    });
  });

  it("trades each date only once", () => {
    const refusal = { ok: false, reasons: ["Each date can only be traded once."] };
    expect(planTrade(asha, P, ASHA_IDX, [1, 2], [4, 4], "person-covers")).toEqual(refusal);
    expect(planTrade(asha, P, ASHA_IDX, [1, 1], [4, 5], "person-covers")).toEqual(refusal);
  });

  it("says the person is on leave on a later date, not working", () => {
    const days = ashaGrid();
    days[P][4] = { kind: "leave" };
    const plan = planTrade({ ...asha, days }, P, ASHA_IDX, [1, 2], [4, 5], "person-covers");
    expect(plan).toEqual({
      ok: false,
      reasons: ["SN-Priya is on leave on 11 Oct, so SN-Priya cannot cover it."],
    });
  });
});

describe("the Singapore four-step ladder", () => {
  const build = (
    context: RosterContext,
    days: RosterDayState[][],
    document: CanonicalScenarioDocument,
  ) => ({
    context,
    days,
    model: buildRuleModel(document),
  });

  it("counts an off nurse under a count target as spare capacity (step 1)", () => {
    expect(countHeadroom(ctx.model, ctx.days, CARA)).toBe(true);
    const ladder = findCoverLadder(ctx, PRIYA, [1], "sick_or_emergency");
    expect(ladder.step).toBe(1);
    expect(ladder.candidates[0]).toMatchObject({ partnerIdx: CARA, plan: { kind: "cover" } });
  });

  it("turns a cover with no known capacity into an overtime request (step 2)", () => {
    const overtime = build(overtimeContext(), overtimeGrid(), overtimeDocument());
    expect(countHeadroom(overtime.model, overtime.days, 2)).toBe(false);
    const ladder = findCoverLadder(overtime, 0, [1], "sick_or_emergency");
    expect(ladder.step).toBe(2);
    expect(ladder.overtime.map((c) => c.partnerIdx)).toEqual([2]);
  });

  it("stays on step 3 until the user says no temporary nurse is available", () => {
    const borrow = build(borrowContext(), borrowGrid(), borrowDocument());
    expect(findCoverLadder(borrow, 0, [1], "sick_or_emergency").step).toBe(3);
    expect(
      findCoverLadder(borrow, 0, [1], "sick_or_emergency", { noTemporaryNurse: true }).step,
    ).toBe(4);
  });

  it("offers run one short when the senior (NIC) stays on the shift", () => {
    const short = build(shortContext(), shortGrid(), shortDocument());
    const ladder = findCoverLadder(short, 0, [1], "sick_or_emergency", { noTemporaryNurse: true });
    expect(ladder.step).toBe(4);
    expect(ladder.short).toMatchObject({
      ok: true,
      shortfalls: [{ dateIdx: 1, label: "Two night nurses", from: 2, to: 1 }],
    });
  });

  it("never offers it when it drops the senior who can be in charge", () => {
    const short = build(shortContext(), shortGrid(), shortDocument());
    const plan = planShortShift(short, 1, [1], "sick_or_emergency");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reasons[0]).toMatch(/no Seniors nurse on N\+ on 8 Oct/);
  });

  it("never runs a shift with nobody", () => {
    const borrow = build(borrowContext(), borrowGrid(), borrowDocument());
    const plan = planShortShift(borrow, 0, [1], "sick_or_emergency");
    expect(plan.ok).toBe(false);
  });
});
