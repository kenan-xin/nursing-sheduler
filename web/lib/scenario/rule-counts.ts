// Rule counting — the single authority for "how many rules are ON".
//
// The prototype counts ENABLED rules, never rule cards: Home's fifth stat tile is
// `_derived.filter(r => r.on).length` labelled "RULES ON" (Nurse Scheduling
// v2.dc.html:1376 → :1382), and the guided Rules screen states the same number as
// its "{onCount} OF {total} RULES ON" summary (`components/guided-rules/rules-screen.tsx`).
// Home, the Rules screen and the Optimize scenario stat grid all report it, so the
// rule lives here rather than being restated in each caller.
//
// A card-derived rule is on when its source constraint is not `disabled`. On top of
// the cards, the canonical document ALWAYS carries the built-in structural preference
// ("at most one shift per day" — `./canonical.ts`), and the Guided Rules registry
// projects it as one always-on, never-disableable row
// (`components/guided-rules/builtins.ts`): exactly one built-in today.

import type { CardsByKind } from "./types";

/** The always-on built-in structural rules the canonical document emits. */
export const BUILTIN_RULE_COUNT = 1;

/**
 * The number of ENABLED rules: the built-ins plus every non-disabled card across
 * the five constraint kinds. NOT the raw card total — a disabled card is excluded
 * from the canonical document, so it is not a rule that is "on".
 */
export function countEnabledRules(cardsByKind: CardsByKind): number {
  const enabledCards =
    cardsByKind.requirements.filter((card) => !card.disabled).length +
    cardsByKind.successions.filter((card) => !card.disabled).length +
    cardsByKind.counts.filter((card) => !card.disabled).length +
    cardsByKind.affinities.filter((card) => !card.disabled).length +
    cardsByKind.coverings.filter((card) => !card.disabled).length;
  return BUILTIN_RULE_COUNT + enabledCards;
}
