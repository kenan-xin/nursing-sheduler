import { describe, expect, it } from "vitest";

import { buildRestDaysRuleCard } from "@/lib/rules/rest-days";
import { toCanonicalScenarioDocument } from "@/lib/scenario";
import { preferenceCardUids } from "@/lib/scenario/canonical";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { preferenceSources, type ExplainContext, type Ledger } from "./explanation";
import { scoreSplit, scoreSplitText } from "./score-split";

function ledger(rules: { rule: number; points: number }[]): Ledger {
  return {
    objective: rules.reduce((sum, r) => sum + r.points, 0),
    balanced: true,
    terms: rules.length,
    rules: rules.map((r) => ({ ...r, matches: 1 })),
    matches: [],
    truncated: false,
    seconds: 0,
  };
}

function ward() {
  const state = makeValidUiState();
  // One rest-days card (one shift count per 7-day window) and one temporary-cover split
  // succession card (`#d<iso>` / `#s<n>` uids) that both trace back to card "s1".
  state.cardsByKind.counts.push(buildRestDaysRuleCard("x"));
  state.cardsByKind.successions.push(
    { uid: "s1#d2026-05-15", person: "ALL", pattern: ["N", "D"], weight: -100 },
    { uid: "s1#s1", person: "ALL", pattern: ["N", "E"], weight: -100 },
  );
  const ctx: ExplainContext = {
    sources: preferenceSources(toCanonicalScenarioDocument(state), preferenceCardUids(state)),
    people: [],
  };
  const at = (uid: string) => ctx.sources.flatMap((s, i) => (s.ruleId === uid ? [i] : []));
  return { ctx, at };
}

describe("scoreSplit", () => {
  it("adds up lost points per tier, counting each card uid once", () => {
    const { ctx, at } = ward();
    const rest = at("rest-days-in-7:x");
    const cover = at("s1");
    expect(rest.length).toBeGreaterThan(1);
    expect(cover).toHaveLength(2);
    const split = scoreSplit(
      ledger([
        { rule: rest[0]!, points: -1000 },
        { rule: rest[1]!, points: -2000 },
        { rule: cover[0]!, points: -100 },
        { rule: cover[1]!, points: -100 },
        { rule: at("r1")[0]!, points: -3 },
        // Bob's shift wish (c2, +2) was granted; his day-off wish (c3, +1) is absent: missed.
        { rule: at("c2")[0]!, points: 2 },
      ]),
      ctx,
    );
    expect(split).toEqual({
      lost: [
        { tier: "strong", rules: 1, points: 3000 },
        { tier: "ward", rules: 1, points: 200 },
        { tier: "wish", rules: 1, points: 1 },
        { tier: "staffing", rules: 1, points: 3 },
      ],
      earned: 2,
    });
    expect(scoreSplitText(split)).toBe(
      "Lost: 1 strong rule (3,000), 1 ward preference (200), 1 nurse wish (1), " +
        "1 preferred staffing count (3). Earned: 2 points.",
    );
  });

  it("keeps the three top tiers at zero and never counts the hard leave pin", () => {
    const { ctx, at } = ward();
    const split = scoreSplit(
      ledger([
        { rule: at("c2")[0]!, points: 2 },
        { rule: at("c3")[0]!, points: 1 },
      ]),
      ctx,
    );
    expect(scoreSplitText(split)).toBe(
      "Lost: 0 strong rules, 0 ward preferences, 0 nurse wishes. Earned: 3 points.",
    );
  });
});
