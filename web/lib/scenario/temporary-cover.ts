// Temporary cover (d582): the staffing credit a cover nurse gives, applied on read.
//
// A cover is never a solver person. She lowers exactly the requirement equations
// that would count her as one (core/nurse_scheduling/preference_types.py,
// shift_type_requirements): the card is enabled and resolves her date, one of its
// top-level shift selectors expands to her shift, and `qualifiedPeople` is absent
// or ALL or names a staff group she is in (or one containing it). A person-id ref
// never matches her. Her credit is her shift's coefficient (default 1); a skill
// mix counts heads, so it credits 1 per cover.
//
// Covers are stored apart (`ScenarioUiState.temporaryCover`); the authored cards
// never hold them. `applyCovers` builds the solver form: a per-date override where
// only the head count moves, and two solver-equivalent splits where more must move:
// per selector (one override applies to every equation of a card) and per date
// (skill mix and `preferredNumPeople` have no per-date form).

import { isValidIso } from "@/lib/dates/date-id";
import { expandShiftTypeRefs, flattenShiftTypeRefs } from "@/lib/rules/expansion";
import { requiredOn, requirementDateIsos } from "@/lib/rules/shortfalls";
import {
  RESERVED_SHIFT_TYPE,
  isDayStateSelector,
  type RequirementCard,
  type RequirementOverride,
  type ScenarioUiState,
  type ShiftTypeRef,
  type UiTemporaryCover,
} from "./types";

/** The group plus every group that contains it, transitively. */
export type GroupClosure = (groupId: string) => ReadonlySet<string>;

/** One requirement equation, card- or document-derived. */
export interface CoverTarget {
  readonly shiftIds: readonly string[];
  /** Parallel to `shiftIds`, default 1. */
  readonly coefficients: readonly number[];
  /** Group ids named by `qualifiedPeople`; null = absent or ALL. */
  readonly qualifiedGroups: ReadonlySet<string> | null;
}

export interface CoverDecrement {
  /** Index into the SUBMITTED `document.preferences` (after splits). */
  readonly pref: number;
  readonly iso: string;
  /** count - wardNeed(count, credit): what the solve subtracted. */
  readonly required: number;
  readonly preferred?: number;
  /** `entryIdx` indexes the AUTHORED card's skillMix (an entry lowered to 0 is not submitted). */
  readonly mix?: readonly (readonly [entryIdx: number, by: number])[];
}

export interface CoverApplication {
  readonly state: ScenarioUiState;
  readonly decrements: readonly CoverDecrement[];
}

export type CoverFlag = "out-of-period" | "unknown-shift" | "unknown-group" | "no-card";

export interface CoverEffect {
  readonly cardUid: string;
  readonly label: string;
  readonly iso: string;
  readonly shiftId: string;
  /** The authored count on her date (hand override included). */
  readonly before: number;
  /** The ward need with every working cover applied. */
  readonly after: number;
}

export interface CoverStatus {
  /** Index into `state.temporaryCover`. */
  readonly index: number;
  /** Non-null: lowers nothing. */
  readonly flag: CoverFlag | null;
  readonly effects: readonly CoverEffect[];
  /** Credit past the requirement on her slot (F4). */
  readonly extra: number;
  /** Cards on her shift and date restricted to groups she is not in (F1 warning). */
  readonly restrictedBy: readonly { cardUid: string; label: string; group: string }[];
}

export const wardNeed = (count: number, credit: number): number => Math.max(0, count - credit);

const isAll = (ref: unknown) => String(ref).toUpperCase() === RESERVED_SHIFT_TYPE.all;
const asList = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const selectorsOf = (card: Pick<RequirementCard, "shiftType">) => asList(card.shiftType);

export function groupClosureOf(
  groups: readonly { id: string | number; members: readonly (string | number)[] }[],
): GroupClosure {
  const parents = new Map<string, string[]>();
  for (const group of groups) {
    for (const member of group.members) {
      parents.set(String(member), [...(parents.get(String(member)) ?? []), String(group.id)]);
    }
  }
  const cache = new Map<string, ReadonlySet<string>>();
  return (groupId) => {
    let found = cache.get(groupId);
    if (!found) {
      const set = new Set([groupId]);
      // A Set iterates entries added during iteration: a breadth-first walk, cycle-safe.
      for (const id of set) for (const parent of parents.get(id) ?? []) set.add(parent);
      cache.set(groupId, (found = set));
    }
    return found;
  };
}

export function coverCounts(
  target: CoverTarget,
  cover: Pick<UiTemporaryCover, "shiftType" | "groups">,
  closure: GroupClosure,
): boolean {
  if (!target.shiftIds.includes(String(cover.shiftType))) return false;
  const qualified = target.qualifiedGroups;
  return (
    qualified === null ||
    cover.groups.some((group) => [...closure(group)].some((id) => qualified.has(id)))
  );
}

export function coverCredit(
  target: CoverTarget,
  iso: string,
  covers: readonly UiTemporaryCover[],
  closure: GroupClosure,
): number {
  let credit = 0;
  for (const cover of covers) {
    if (cover.date !== iso || !coverCounts(target, cover, closure)) continue;
    credit += target.coefficients[target.shiftIds.indexOf(String(cover.shiftType))] ?? 1;
  }
  return credit;
}

/** Heads a skill-mix entry for `mixGroup` gains on `iso`: covers counted in `target` and in that group. */
export function mixCredit(
  target: CoverTarget,
  mixGroup: string,
  iso: string,
  covers: readonly UiTemporaryCover[],
  closure: GroupClosure,
): number {
  return covers.filter(
    (cover) =>
      cover.date === iso &&
      coverCounts(target, cover, closure) &&
      (isAll(mixGroup) || cover.groups.some((group) => closure(group).has(mixGroup))),
  ).length;
}

function workedShiftIds(state: Pick<ScenarioUiState, "shifts">): Set<string> {
  return new Set(
    state.shifts.map((shift) => String(shift.id)).filter((id) => !isDayStateSelector(id)),
  );
}

/** One target per top-level selector, mirroring `_compile_shift_requirement_groups`. */
export function cardTargets(state: ScenarioUiState, card: RequirementCard): CoverTarget[] {
  const worked = workedShiftIds(state);
  const expand = (selector: ShiftTypeRef | ShiftTypeRef[]) => {
    const refs = flattenShiftTypeRefs(selector);
    if (refs.some(isAll)) return [...worked];
    return [...expandShiftTypeRefs(refs, state)].filter((id) => worked.has(id));
  };
  const coefficient = new Map<string, number>();
  for (const [ref, value] of card.shiftTypeCoefficients ?? []) {
    for (const id of expand(ref)) coefficient.set(id, value);
  }
  const refs = asList(card.qualifiedPeople);
  const groupIds = new Set(state.staffGroups.map((group) => String(group.id)));
  const qualifiedGroups =
    refs.length === 0 || refs.some(isAll)
      ? null
      : new Set(refs.map(String).filter((ref) => groupIds.has(ref)));
  return selectorsOf(card).map((selector) => {
    const shiftIds = expand(selector);
    return {
      shiftIds,
      coefficients: shiftIds.map((id) => coefficient.get(id) ?? 1),
      qualifiedGroups,
    };
  });
}

interface Prepared {
  closure: GroupClosure;
  /** Covers with no period, shift or group flag. A no-card cover credits nothing anywhere, so this
   *  is the same credit as "flag === null" without walking every card first. */
  working: UiTemporaryCover[];
  flags: (CoverFlag | null)[];
  cards: { card: RequirementCard; dates: Set<string>; targets: CoverTarget[] }[];
}

function prepare(state: ScenarioUiState): Prepared {
  const worked = workedShiftIds(state);
  const groupIds = new Set(state.staffGroups.map((group) => String(group.id)));
  const flags = state.temporaryCover.map((cover): CoverFlag | null => {
    if (!isValidIso(cover.date) || cover.date < state.rangeStart || cover.date > state.rangeEnd) {
      return "out-of-period";
    }
    if (!worked.has(String(cover.shiftType))) return "unknown-shift";
    if (cover.groups.some((group) => !groupIds.has(String(group)))) return "unknown-group";
    return null;
  });
  return {
    closure: groupClosureOf(state.staffGroups),
    working: state.temporaryCover.filter((_, i) => flags[i] === null),
    flags,
    cards: state.cardsByKind.requirements
      .filter((card) => !card.disabled)
      .map((card) => ({
        card,
        dates: new Set(requirementDateIsos(state, card)),
        targets: cardTargets(state, card),
      })),
  };
}

interface Lowered {
  count: number;
  credit: number;
  required: number;
  preferred: number | undefined;
  /** Per authored skill-mix entry. */
  mix: number[];
}

function lower(
  card: RequirementCard,
  target: CoverTarget | undefined,
  iso: string,
  covers: readonly UiTemporaryCover[],
  closure: GroupClosure,
): Lowered {
  const count = requiredOn(card, iso);
  const credit = target ? coverCredit(target, iso, covers, closure) : 0;
  const required = wardNeed(count, credit);
  const preferred =
    card.preferredNumPeople === undefined || credit === 0
      ? card.preferredNumPeople
      : Math.max(required, card.preferredNumPeople - credit);
  const mix = (card.skillMix ?? []).map((entry) =>
    target && credit > 0
      ? Math.max(
          0,
          entry.minNumPeople - mixCredit(target, String(entry.people), iso, covers, closure),
        )
      : entry.minNumPeople,
  );
  return { count, credit, required, preferred, mix };
}

/** The need an authored card states on one date, with every working cover applied. `shiftId`
 *  picks the selector (equation); omitted = the first, a single-selector card's only one. */
export function cardNeedOn(
  state: ScenarioUiState,
  card: RequirementCard,
  iso: string,
  shiftId?: string,
): { required: number; preferred?: number; mix: number[]; credit: number; extra: number } {
  const { closure, working } = prepare(state);
  const covers = card.disabled || !requirementDateIsos(state, card).includes(iso) ? [] : working;
  const targets = cardTargets(state, card);
  const target =
    shiftId === undefined ? targets[0] : targets.find((t) => t.shiftIds.includes(String(shiftId)));
  const n = lower(card, target, iso, covers, closure);
  return {
    required: n.required,
    ...(n.preferred === undefined ? {} : { preferred: n.preferred }),
    mix: n.mix,
    credit: n.credit,
    extra: Math.max(0, n.credit - n.count),
  };
}

type Mark = Omit<CoverDecrement, "pref">;
type Part = { card: RequirementCard; marks: Mark[] };

function withOverrides(card: RequirementCard, overrides: RequirementOverride[]): RequirementCard {
  const { requiredNumPeopleOverrides: _old, ...rest } = card;
  return overrides.length ? { ...rest, requiredNumPeopleOverrides: overrides } : rest;
}

/** One equation's card, lowered on every covered date; null when no number moves. */
function lowerPart(
  card: RequirementCard,
  target: CoverTarget,
  dates: readonly string[],
  prepared: Prepared,
): Part[] | null {
  const overrides: RequirementOverride[] = [...(card.requiredNumPeopleOverrides ?? [])];
  const marks: Mark[] = [];
  const copies: Part[] = [];
  const split = new Set<string>();
  for (const iso of dates) {
    const n = lower(card, target, iso, prepared.working, prepared.closure);
    if (n.credit === 0) continue;
    const required = n.count - n.required;
    const preferred = (card.preferredNumPeople ?? 0) - (n.preferred ?? 0);
    const mix = (card.skillMix ?? [])
      .map((entry, k) => [k, entry.minNumPeople - n.mix[k]] as const)
      .filter(([, by]) => by > 0);
    if (preferred > 0 || mix.length > 0) {
      split.add(iso);
      const {
        requiredNumPeopleOverrides: _moved,
        preferredNumPeople: _p,
        skillMix: _m,
        ...body
      } = card;
      const skillMix = (card.skillMix ?? [])
        .map((entry, k) => ({ ...entry, minNumPeople: n.mix[k] }))
        .filter((entry) => entry.minNumPeople > 0);
      copies.push({
        card: {
          ...body,
          uid: `${card.uid}#d${iso}`,
          date: [iso],
          requiredNumPeople: n.required,
          ...(n.preferred === undefined ? {} : { preferredNumPeople: n.preferred }),
          ...(skillMix.length ? { skillMix } : {}),
        },
        marks: [
          {
            iso,
            required,
            ...(preferred > 0 ? { preferred } : {}),
            ...(mix.length ? { mix } : {}),
          },
        ],
      });
    } else if (required > 0) {
      const at = overrides.findIndex(([date]) => date === iso);
      const entry: RequirementOverride = [iso, n.required];
      if (at === -1) overrides.push(entry);
      else overrides[at] = entry;
      marks.push({ iso, required });
    }
  }
  if (!marks.length && !copies.length) return null;
  // A lowered result equal to the rule's own count is no exception (the per-date override
  // normalization); a split date's override has moved into its copy.
  const kept = overrides.filter(
    ([iso, count]) =>
      !split.has(iso) && !(count === card.requiredNumPeople && marks.some((m) => m.iso === iso)),
  );
  const rest = dates.filter((iso) => !split.has(iso));
  if (rest.length === 0) return copies;
  const original = withOverrides(split.size ? { ...card, date: rest } : card, kept);
  return [{ card: original, marks }, ...copies];
}

/** Every part a card becomes in the solver form; null when no number moves. */
function lowerCard(
  state: ScenarioUiState,
  card: RequirementCard,
  prepared: Prepared,
): Part[] | null {
  const dates = requirementDateIsos(state, card);
  if (!prepared.working.some((cover) => dates.includes(cover.date))) return null;
  const selectors = selectorsOf(card);
  const targets = cardTargets(state, card);
  const parts =
    selectors.length > 1
      ? selectors.map((selector, i) => ({
          card: { ...card, uid: `${card.uid}#s${i}`, shiftType: [selector] },
          target: targets[i],
        }))
      : [{ card, target: targets[0] }];
  let changed = false;
  const out: Part[] = [];
  for (const part of parts) {
    const lowered = lowerPart(part.card, part.target, dates, prepared);
    if (lowered) changed = true;
    out.push(...(lowered ?? [{ card: part.card, marks: [] }]));
  }
  return changed ? out : null;
}

/** The solver form: the state the submission projects, plus what it subtracted. */
export function applyCovers(state: ScenarioUiState): CoverApplication {
  const prepared = prepare(state);
  if (prepared.working.length === 0) return { state, decrements: [] };
  let changed = false;
  const parts: Part[] = [];
  for (const card of state.cardsByKind.requirements) {
    const lowered = card.disabled ? null : lowerCard(state, card, prepared);
    if (lowered) changed = true;
    parts.push(...(lowered ?? [{ card, marks: [] }]));
  }
  if (!changed) return { state, decrements: [] };
  // `mapPreferences` (canonical.ts) emits max-one-shift-per-day first, then each
  // enabled requirement in order.
  const decrements: CoverDecrement[] = [];
  let pref = 0;
  for (const { card, marks } of parts) {
    if (card.disabled) continue;
    pref += 1;
    for (const mark of marks) decrements.push({ pref, ...mark });
  }
  return {
    state: {
      ...state,
      cardsByKind: { ...state.cardsByKind, requirements: parts.map((part) => part.card) },
    },
    decrements,
  };
}

export function withCoverOverrides(state: ScenarioUiState): ScenarioUiState {
  return applyCovers(state).state;
}

const cardLabel = (card: RequirementCard) =>
  card.description || flattenShiftTypeRefs(card.shiftType).join(", ");

export function coverStatuses(state: ScenarioUiState): CoverStatus[] {
  const prepared = prepare(state);
  return state.temporaryCover.map((cover, index) => {
    const flag = prepared.flags[index];
    if (flag !== null) return { index, flag, effects: [], extra: 0, restrictedBy: [] };
    const shiftId = String(cover.shiftType);
    const effects: CoverEffect[] = [];
    const restrictedBy: CoverStatus["restrictedBy"][number][] = [];
    let extra = 0;
    for (const { card, dates, targets } of prepared.cards) {
      if (!dates.has(cover.date)) continue;
      let restricted = false;
      for (const target of targets) {
        if (!target.shiftIds.includes(shiftId)) continue;
        if (!coverCounts(target, cover, prepared.closure)) {
          restricted = true;
          continue;
        }
        const n = lower(card, target, cover.date, prepared.working, prepared.closure);
        const label = cardLabel(card);
        effects.push({
          cardUid: card.uid,
          label,
          iso: cover.date,
          shiftId,
          before: n.count,
          after: n.required,
        });
        extra = Math.max(extra, n.credit - n.count);
      }
      if (restricted) {
        const group = asList(card.qualifiedPeople).map(String).join(", ");
        restrictedBy.push({ cardUid: card.uid, label: cardLabel(card), group });
      }
    }
    return { index, flag: effects.length ? null : "no-card", effects, extra, restrictedBy };
  });
}
