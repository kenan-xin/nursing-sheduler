// The Optimize score split per priority tier (bead 5gz4, priority ladder spec section 8):
// "Lost: 0 strong rules, 0 ward preferences, 2 nurse wishes (40). Earned: 1118 bonus points."
// Read from the run's penalty ledger; rules count once per card uid, so a rest-days card's
// 7-day windows and a temporary-cover split card each count as the one rule they came from.

import { PREFERENCE_TYPE } from "@/lib/scenario/types";
import type { ExplainContext, Ledger, RuleSource } from "./explanation";
import { formatScore } from "./run-display";
import type { OptimizeRunView } from "./run-view";

export type LossTier = "strong" | "ward" | "wish" | "staffing" | "fairness";

/** Highest tier first. The first three always show, so a zero says "this tier held". */
const TIERS: { tier: LossTier; one: string; many: string; always: boolean }[] = [
  { tier: "strong", one: "strong rule", many: "strong rules", always: true },
  { tier: "ward", one: "ward preference", many: "ward preferences", always: true },
  { tier: "wish", one: "nurse wish", many: "nurse wishes", always: true },
  {
    tier: "staffing",
    one: "preferred staffing count",
    many: "preferred staffing counts",
    always: false,
  },
  { tier: "fairness", one: "fairness rule", many: "fairness rules", always: false },
];

/** Above the ward band (100 to 300), a soft weight is a strong rule. */
const STRONG = 300;

// Mirrors priority ladder spec section 4; hard rules (tier H) and bonuses (tier 5) never lose points.
export function tierOf(source: RuleSource): LossTier | null {
  if (source.hard) return null;
  const strong = Math.abs(source.weight ?? 0) > STRONG;
  switch (source.type) {
    case PREFERENCE_TYPE.shiftRequest:
      return "wish";
    case PREFERENCE_TYPE.shiftTypeRequirement:
      return "staffing";
    case PREFERENCE_TYPE.shiftTypeSuccessions:
      return strong ? "strong" : "ward";
    case PREFERENCE_TYPE.shiftCount:
      return strong ? "strong" : "fairness";
    case PREFERENCE_TYPE.shiftAffinity:
    case PREFERENCE_TYPE.shiftTypeCovering:
      return strong ? "strong" : "ward";
    default:
      return null;
  }
}

export interface ScoreSplit {
  /** Per tier, highest first: broken rules (by card uid) and the points they lost (positive). */
  lost: { tier: LossTier; rules: number; points: number }[];
  earned: number;
}

export function scoreSplit(ledger: Ledger, ctx: ExplainContext): ScoreSplit {
  const lost = new Map<LossTier, { ids: Set<string>; points: number }>();
  const lose = (tier: LossTier, ruleId: string, points: number) => {
    const entry = lost.get(tier) ?? { ids: new Set<string>(), points: 0 };
    entry.ids.add(ruleId);
    entry.points += points;
    lost.set(tier, entry);
  };
  let earned = 0;
  const scored = new Set<number>();
  for (const r of ledger.rules) {
    scored.add(r.rule);
    if (r.points > 0) earned += r.points;
    const source = ctx.sources[r.rule];
    const tier = source ? tierOf(source) : null;
    if (r.points < 0 && source && tier) lose(tier, source.ruleId, -r.points);
  }
  // A wish with a positive weight scores its weight when granted and nothing when missed,
  // so a missed one is absent from the ledger (whose per-rule totals are exact).
  // ponytail: a wish cell naming a group of people or dates counts as missed only when no part was granted.
  ctx.sources.forEach((source, index) => {
    const weight = source.weight ?? 0;
    if (source.type !== PREFERENCE_TYPE.shiftRequest || source.hard || weight <= 0) return;
    if (!scored.has(index)) lose("wish", source.ruleId, weight);
  });
  return {
    lost: TIERS.flatMap(({ tier, always }) => {
      const entry = lost.get(tier);
      if (!entry && !always) return [];
      return [{ tier, rules: entry?.ids.size ?? 0, points: entry?.points ?? 0 }];
    }),
    earned,
  };
}

/** "Lost: 0 strong rules, 1 nurse wish (20). Earned: 1118 bonus points." */
export function scoreSplitText(split: ScoreSplit): string {
  const parts = split.lost.map(({ tier, rules, points }) => {
    const names = TIERS.find((t) => t.tier === tier)!;
    const count = `${rules} ${rules === 1 ? names.one : names.many}`;
    return points > 0 ? `${count} (${formatScore(points)})` : count;
  });
  return `Lost: ${parts.join(", ")}. Earned: ${formatScore(split.earned)} bonus points.`;
}

/** The split of `view`'s completed run, or null without a ledger (old, infeasible, unread). */
export function scoreSplitOf(view: OptimizeRunView): ScoreSplit | null {
  const explanation = view.result?.explanation;
  if (explanation?.kind !== "ledger" || view.explainContext === null) return null;
  return scoreSplit(explanation.ledger, view.explainContext);
}
