import { describe, expect, it } from "vitest";
import { buildRuleModel } from "./rule-check";
import { findPersonIdx, findSwapPartners, givingProblem, planSwap, type SwapContext } from "./swap";
import { priyaContext, priyaDocument, priyaGrid } from "./swap-fixtures";

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
