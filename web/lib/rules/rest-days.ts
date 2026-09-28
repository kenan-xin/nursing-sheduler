// "2 rest days in any 7 days in a row" (bead 1v5k): ward practice on top of the
// legal floor (never 7 working days in a row, a separate -infinity shift sequence
// rule). The week is ANY 7 days in a row, not Monday to Sunday, and core has no
// rolling-window count, so the rule is ONE count card in the scenario and the
// workspace, expanded only at the canonical projection into one shift count per
// 7-day window ("more than 5 worked shifts" penalised). A spike showed the
// alternative, 7 succession patterns with one OFF, gets no roster on a 40-nurse
// ward and lets 6 worked days plus a leave day through (see the bead notes).
//
// The card is recognised by its uid prefix, not its fields: the description is
// renamable on the Rules screen, and the uid round-trips through the workspace as
// its `workspaceId`. The stored body (x > 5 over ALL dates) keeps the workspace
// valid for the Python converter, which does not expand it; that is a known gap.

import { generateDateItems } from "@/lib/dates/date-id";
import {
  PREFERENCE_TYPE,
  RESERVED_SHIFT_TYPE,
  type CanonicalShiftCountPreference,
  type CountCard,
  type OrdinaryCountCard,
  type ScenarioUiState,
} from "@/lib/scenario/types";
import { expandPersonRefs } from "./expansion";

export const REST_DAYS_RULE_UID_PREFIX = "rest-days-in-7:";
export const REST_DAYS_RULE_DESCRIPTION = "2 rest days in any 7 days in a row";
export const REST_DAYS_EXPRESSION_TEXT = "At most 5 worked days in any 7 days in a row";
/** Worked days allowed in any 7 days in a row. */
export const MAX_WORKED_IN_7 = 5;
const WINDOW = 7;
/**
 * A strong preference: far above a nurse's own request (10, SOFT_REQUEST_WEIGHT)
 * and the usual ward preferences (8-60), so the optimiser gives up a whole month of
 * someone's requests before a second rest day; still finite, so a short-staffed
 * ward gets a roster with the breaks shown rather than none. Staffing numbers are
 * hard and never traded for it; a preferred (ideal) head count at -100000 still
 * outranks it.
 */
export const REST_DAYS_WEIGHT = -1000;

export function isRestDaysRuleCard(card: { uid: string }): boolean {
  return card.uid.startsWith(REST_DAYS_RULE_UID_PREFIX);
}

/** The one card, for everyone. `id` makes the uid unique within the scenario. */
export function buildRestDaysRuleCard(id: string): OrdinaryCountCard {
  return {
    uid: `${REST_DAYS_RULE_UID_PREFIX}${id}`,
    description: REST_DAYS_RULE_DESCRIPTION,
    person: [RESERVED_SHIFT_TYPE.all],
    countDates: [RESERVED_SHIFT_TYPE.all],
    countShiftTypes: [RESERVED_SHIFT_TYPE.all],
    expression: "x > T",
    target: MAX_WORKED_IN_7,
    weight: REST_DAYS_WEIGHT,
  };
}

function windowRule(
  person: CountCard["person"],
  dates: string[],
  allowed: number,
  weight: number,
): CanonicalShiftCountPreference {
  return {
    type: PREFERENCE_TYPE.shiftCount,
    description: REST_DAYS_RULE_DESCRIPTION,
    person,
    countDates: dates,
    countShiftTypes: [RESERVED_SHIFT_TYPE.all],
    expression: "x > T",
    target: allowed,
    weight,
  };
}

/** A history entry that is a worked shift: not OFF, LEAVE or a blank slot. */
function isWorked(entry: string): boolean {
  return entry !== "" && entry !== RESERVED_SHIFT_TYPE.off && entry !== RESERVED_SHIFT_TYPE.leave;
}

/**
 * The rule's shift counts. "ALL" counts worked shifts only, so leave and OFF are
 * never worked days. Every 7-day window inside the roster gets one rule for the
 * card's people. A window that starts `k` days before the roster gets one rule per
 * nurse from her history (newest entry = the day before the start): she may work
 * 5 minus her worked history days in it, over its `7 - k` roster days. Days before
 * her recorded history count as rest. Windows she cannot break are left out.
 */
export function expandRestDaysRule(
  card: Pick<CountCard, "person" | "weight">,
  state: Pick<ScenarioUiState, "staff" | "staffGroups" | "rangeStart" | "rangeEnd">,
): CanonicalShiftCountPreference[] {
  const dates = generateDateItems({ start: state.rangeStart, end: state.rangeEnd }).map(
    (item) => item.iso,
  );
  const rules: CanonicalShiftCountPreference[] = [];
  for (let start = 0; start + WINDOW <= dates.length; start += 1) {
    rules.push(
      windowRule(card.person, dates.slice(start, start + WINDOW), MAX_WORKED_IN_7, card.weight),
    );
  }
  const people = expandPersonRefs(card.person, state);
  for (const person of state.staff) {
    if (!people.has(String(person.id))) continue;
    const history = person.history ?? [];
    for (let before = 1; before < WINDOW; before += 1) {
      const worked = history.slice(-before).filter(isWorked).length;
      const allowed = MAX_WORKED_IN_7 - worked;
      const inRoster = dates.slice(0, WINDOW - before);
      // No worked history: the window is only roster days plus rest, which the
      // in-roster windows already cover. More than 5 worked already: nothing to fix.
      if (worked === 0 || allowed < 0 || allowed >= inRoster.length) continue;
      rules.push(windowRule([person.id], inRoster, allowed, card.weight));
    }
  }
  return rules;
}
