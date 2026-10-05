// The priority ladder for rule weights (bead rnrt; spec
// docs/superpowers/specs/2026-09-29-priority-ladder-design.md sections 4, 5.2 and 7).
//
// Every soft rule's weight belongs to one tier, and each tier has a band of allowed
// sizes, so a higher tier wins over any realistic amount of a lower one. Two users:
// - the assistant's rule operations refuse a weight outside its card's band
//   (`weightBandRefusal`, called from `lib/proposal/operations.ts`), naming the band;
// - `checkWeightOrder` lists every enabled card whose stored weight is off the ladder,
//   for get_setup_progress and the Optimize screen's pre-Run warning. Neither blocks:
//   the UI editors still accept any number.
//
// Tier 5 (spare-slot bonuses) has no card kind yet; uv8n adds it here.

import type {
  CardsByKind,
  CountCard,
  RequirementCard,
  ScenarioUiState,
  UiOffRequestCell,
  UiShiftRequestCell,
  Weight,
} from "@/lib/scenario/types";
import { isRestDaysRuleCard } from "./rest-days";

/** A finite tier. Infinite weights are the hard tier and are never refused. */
export type SoftTier = "strong" | "ward" | "wish" | "preferred" | "fairness" | "spare";
export type TierId = "hard" | SoftTier;

/** The allowed size of a weight in one tier, without its sign (section 4). */
export interface TierBand {
  name: string;
  min: number;
  max: number;
}

export const TIER_BANDS: Record<SoftTier, TierBand> = {
  strong: { name: "a strong ward rule", min: 1000, max: 1000 },
  ward: { name: "a ward preference", min: 100, max: 300 },
  wish: { name: "a nurse wish", min: 20, max: 40 },
  preferred: { name: "a Preferred staffing count", min: 10, max: 10 },
  fairness: { name: "a fairness or balance rule", min: 4, max: 4 },
  // A spare place (an "ideally" count above the real need) costs nothing when empty;
  // the uv8n bonus will rank which spare place fills first.
  spare: { name: "a spare place", min: 0, max: 0 },
};

/** One weighted thing the ladder can place: a rule card, or one request cell. */
export type LadderKind = keyof CardsByKind | "requests";

export interface LadderCards extends CardsByKind {
  requests: (UiOffRequestCell | UiShiftRequestCell)[];
}
type CardOf<K extends LadderKind> = LadderCards[K][number];

interface KindRule<K extends LadderKind> {
  label: string;
  /** Whether a minus sign is meaningful ("against", "apart"): the band then holds both signs. */
  bothSigns: boolean;
  /** The tiers a FINITE weight may sit in. Empty: the weight is hard or has no effect. */
  tiers: (card: CardOf<K>) => readonly SoftTier[];
}

/** One rule per kind. A new kind fails the type check until it is placed here. */
export type LadderRules = { [K in LadderKind]: KindRule<K> };

/** A preferred count above the required one is the only time a requirement's weight counts. */
const hasPreferred = (card: RequirementCard) =>
  card.preferredNumPeople !== undefined && card.preferredNumPeople !== card.requiredNumPeople;

const countTiers = (card: CountCard): readonly SoftTier[] => {
  if (card.tag === "contracted_hours") return [];
  return isRestDaysRuleCard(card) ? ["strong"] : ["fairness"];
};

export const LADDER: LadderRules = {
  requests: { label: "a nurse wish", bothSigns: true, tiers: () => ["wish"] },
  successions: { label: "a shift sequence rule", bothSigns: true, tiers: () => ["ward", "strong"] },
  counts: { label: "a shift count rule", bothSigns: true, tiers: countTiers },
  affinities: { label: "a pairing rule", bothSigns: true, tiers: () => ["ward"] },
  requirements: {
    label: "a Preferred staffing count",
    bothSigns: false,
    tiers: (card) => (hasPreferred(card) ? ["preferred", "spare"] : []),
  },
  // A supervision rule is always enforced, whatever its weight.
  coverings: { label: "a supervision rule", bothSigns: false, tiers: () => [] },
};

const inBand = (band: TierBand, weight: number) =>
  Math.abs(weight) >= band.min && Math.abs(weight) <= band.max;

type AnyCard = CardOf<LadderKind>;

/** The kind's tiers for this card. One cast: TS cannot call a union of per-kind functions. */
function tiersFor(kind: LadderKind, card: AnyCard): readonly SoftTier[] {
  return (LADDER[kind] as unknown as KindRule<LadderKind>).tiers(card);
}

/** The card's tier: hard for an infinite weight, else the band it sits in, else its main tier. */
export function tierOf<K extends LadderKind>(kind: K, card: CardOf<K>): TierId {
  const tiers = tiersFor(kind, card);
  if (!Number.isFinite(card.weight) || tiers.length === 0) return "hard";
  return tiers.find((tier) => inBand(TIER_BANDS[tier], card.weight)) ?? tiers[0];
}

function range(band: TierBand, bothSigns: boolean): string {
  const span = (sign: string) =>
    band.min === band.max ? `${sign}${band.max}` : `${sign}${band.min} to ${sign}${band.max}`;
  if (band.max === 0) return "0";
  return bothSigns ? `${span("")} (or ${span("-")})` : span("-");
}

/** "a nurse wish takes 20 to 40 (or -20 to -40)". */
function allowedText(kind: LadderKind, tiers: readonly SoftTier[]): string {
  const rule = LADDER[kind];
  const parts = tiers.map((tier) => {
    const text = range(TIER_BANDS[tier], rule.bothSigns);
    const name = TIER_BANDS[tier].name;
    return tiers.length > 1 && name !== rule.label ? `${text} for ${name}` : text;
  });
  return `${rule.label} takes ${parts.join(", or ")}`;
}

/** The band a weight breaks, as the refusal says it, or undefined when it is on the ladder. */
export function weightBandRefusal<K extends LadderKind>(
  kind: K,
  card: CardOf<K>,
): string | undefined {
  const tiers = tiersFor(kind, card);
  if (!Number.isFinite(card.weight) || tiers.length === 0) return undefined;
  if (tiers.some((tier) => inBand(TIER_BANDS[tier], card.weight))) return undefined;
  return allowedText(kind, tiers);
}

/** The nearest weight on the ladder, keeping the sign: the fix to offer. */
function nearestOnLadder(weight: number, tiers: readonly SoftTier[]): number {
  const sign = weight < 0 ? -1 : 1;
  const size = Math.abs(weight);
  const edges = tiers.flatMap((tier) => [TIER_BANDS[tier].min, TIER_BANDS[tier].max]);
  const best = edges.reduce((a, b) => (Math.abs(b - size) < Math.abs(a - size) ? b : a));
  return best === 0 ? 0 : sign * best;
}

export interface LadderFinding {
  kind: LadderKind;
  /** The card's uid; absent for requests, which are grouped by weight. */
  ruleId?: string;
  weight: Weight;
  /** How many cells share this weight (requests only, else 1). */
  count: number;
  /** The nearest weight inside the band, the fix to offer. */
  suggestedWeight: number;
  message: string;
}

/**
 * Every enabled card, and every group of request cells with the same weight, whose
 * weight is off the ladder. Pure: no store, no React.
 */
export function checkWeightOrder(
  state: Pick<ScenarioUiState, "cardsByKind" | "reqData">,
): LadderFinding[] {
  const findings: LadderFinding[] = [];
  const kinds = Object.keys(state.cardsByKind) as (keyof CardsByKind)[];
  for (const kind of kinds) {
    for (const card of state.cardsByKind[kind] as CardsByKind[typeof kind][number][]) {
      if (card.disabled || !weightBandRefusal(kind, card)) continue;
      const tiers = tiersFor(kind, card);
      const name = card.description?.trim() || card.uid;
      findings.push({
        kind,
        ruleId: card.uid,
        weight: card.weight,
        count: 1,
        suggestedWeight: nearestOnLadder(card.weight, tiers),
        message: `"${name}" has weight ${card.weight}, but ${allowedText(kind, tiers)}.`,
      });
    }
  }
  const byWeight = new Map<number, number>();
  for (const cell of state.reqData) {
    if (cell.kind === "leave" || !weightBandRefusal("requests", cell)) continue;
    byWeight.set(cell.weight, (byWeight.get(cell.weight) ?? 0) + 1);
  }
  for (const [weight, count] of byWeight) {
    const many = count === 1 ? "1 request has" : `${count} requests have`;
    findings.push({
      kind: "requests",
      weight,
      count,
      suggestedWeight: nearestOnLadder(weight, ["wish"]),
      message: `${many} weight ${weight}, but ${allowedText("requests", ["wish"])}.`,
    });
  }
  return findings;
}
