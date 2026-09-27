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

import { formatShortDate, isValidIso } from "@/lib/dates/date-id";
import { expandShiftTypeRefs, flattenShiftTypeRefs } from "@/lib/rules/expansion";
import { requiredOn, requirementDateIsos } from "@/lib/rules/shortfalls";
import {
  RESERVED_SHIFT_TYPE,
  isDayStateSelector,
  type PersonRef,
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
  readonly mix?: readonly CoverMixDecrement[];
}

/**
 * One authored skill-mix floor a cover lowered.
 *
 * The AUTHORED floor is recorded, not a position in the submitted copy: a floor
 * the cover zeroes out is DROPPED from the copy's `skillMix` (a 0 floor asks
 * nothing of the solver), so the copy's positions no longer line up with the
 * authored ones and cannot name the floor that went missing. A reader rebuilding
 * the authored card from the copy needs the floor itself.
 */
export interface CoverMixDecrement {
  /** Index into the AUTHORED card's `skillMix`. */
  readonly entryIdx: number;
  /** The authored floor's group/person selector, as written on the card. */
  readonly people: PersonRef;
  /** The authored `minNumPeople`. */
  readonly authored: number;
  /** What the cover took off it (one head per cover in the floor's groups). */
  readonly by: number;
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
export function cardTargets(state: CoverInput, card: RequirementCard): CoverTarget[] {
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

function prepare(state: CoverInput): Prepared {
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
  state: CoverInput,
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

/** One equation's card, lowered on every covered date; null when no number moves. A `forced`
 *  date is split off even with no credit (the solver-equivalence fixtures). */
function lowerPart(
  card: RequirementCard,
  target: CoverTarget,
  dates: readonly string[],
  prepared: Prepared,
  forced: ReadonlySet<string>,
): Part[] | null {
  const overrides: RequirementOverride[] = [...(card.requiredNumPeopleOverrides ?? [])];
  const marks: Mark[] = [];
  const copies: Part[] = [];
  const split = new Set<string>();
  for (const iso of dates) {
    const n = lower(card, target, iso, prepared.working, prepared.closure);
    if (n.credit === 0 && !forced.has(iso)) continue;
    const required = n.count - n.required;
    const preferred = (card.preferredNumPeople ?? 0) - (n.preferred ?? 0);
    const mix = (card.skillMix ?? [])
      .map((entry, k) => ({
        entryIdx: k,
        people: entry.people,
        authored: entry.minNumPeople,
        by: entry.minNumPeople - n.mix[k],
      }))
      .filter((entry) => entry.by > 0);
    if (preferred > 0 || mix.length > 0 || forced.has(iso)) {
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
  forced: ReadonlySet<string> | undefined,
): Part[] | null {
  const dates = requirementDateIsos(state, card);
  if (!forced && !prepared.working.some((cover) => dates.includes(cover.date))) return null;
  const selectors = selectorsOf(card);
  const targets = cardTargets(state, card);
  const parts =
    selectors.length > 1
      ? selectors.map((selector, i) => ({
          card: { ...card, uid: `${card.uid}#s${i}`, shiftType: [selector] },
          target: targets[i],
        }))
      : [{ card, target: targets[0] }];
  let changed = forced !== undefined;
  const out: Part[] = [];
  for (const part of parts) {
    const lowered = lowerPart(part.card, part.target, dates, prepared, forced ?? new Set());
    if (lowered) changed = true;
    out.push(...(lowered ?? [{ card: part.card, marks: [] }]));
  }
  return changed ? out : null;
}

/** The solver form: the state the submission projects, plus what it subtracted. */
export function applyCovers(state: ScenarioUiState): CoverApplication {
  const prepared = prepare(state);
  if (prepared.working.length === 0) return { state, decrements: [] };
  return project(state, prepared, new Map());
}

/**
 * The submission's splits with no credit: each `touched` card (by uid) is split per selector,
 * and each listed ISO date is split off into its own copy. Numbers never move, so the result
 * is solver-equivalent to `state`; the Task 6 fixtures prove it with the real solver.
 */
export function splitCardsForCover(
  state: ScenarioUiState,
  touched: ReadonlyMap<string, readonly string[]>,
): ScenarioUiState {
  return project(state, { ...prepare(state), working: [] }, touched).state;
}

function project(
  state: ScenarioUiState,
  prepared: Prepared,
  touched: ReadonlyMap<string, readonly string[]>,
): CoverApplication {
  let changed = false;
  const parts: Part[] = [];
  for (const card of state.cardsByKind.requirements) {
    const forced = touched.get(card.uid);
    const lowered = card.disabled
      ? null
      : lowerCard(state, card, prepared, forced && new Set(forced));
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

/** A refusal is one plain sentence for the form's error line and the host's reply. */
export type CoverValidation = { ok: true } | { ok: false; message: string };

/**
 * The Staff form's validation, shared with the assistant host (d582 §6): a name, a
 * date, a worked shift, groups that exist, and no second entry for the same name on
 * the same date. `editingIndex` is the entry being re-saved (so it does not clash
 * with itself). A date outside the period is NOT refused here — that is a drift
 * flag (F3), not a form error.
 */
export function validateCover(
  state: CoverInput,
  entry: Pick<UiTemporaryCover, "name" | "date" | "shiftType" | "groups">,
  editingIndex?: number,
): CoverValidation {
  const name = entry.name.trim();
  if (!name) return { ok: false, message: "Enter the nurse's name." };
  if (!isValidIso(entry.date)) return { ok: false, message: "Pick a date." };
  const shift = String(entry.shiftType);
  if (!workedShiftIds(state).has(shift)) return { ok: false, message: "Pick a shift she works." };
  const groupIds = new Set(state.staffGroups.map((group) => String(group.id)));
  if (entry.groups.some((group) => !groupIds.has(String(group))))
    return { ok: false, message: "A selected group no longer exists." };
  const clash = state.temporaryCover.findIndex(
    (cover, i) => i !== editingIndex && cover.name.trim() === name && cover.date === entry.date,
  );
  if (clash !== -1) {
    return {
      ok: false,
      message:
        String(state.temporaryCover[clash].shiftType) === shift
          ? `${name} already covers ${shift} on ${formatShortDate(entry.date)}.`
          : `${name} can only cover one shift a day.`,
    };
  }
  return { ok: true };
}

const cardLabel = (card: RequirementCard) =>
  card.description || flattenShiftTypeRefs(card.shiftType).join(", ");

/**
 * Everything `coverStatuses` reads, and nothing else. A full `ScenarioUiState` is
 * assignable to it, so existing callers are unaffected; a screen that wants to
 * subscribe narrowly uses `coverSlicesOf` + `coverCardsOf` + `coverInputFrom`, which
 * is how a store write to `meta` or to a card kind the arithmetic never walks stops
 * re-rendering the cover UI.
 */
export type CoverInput = Pick<
  ScenarioUiState,
  | "staffGroups"
  | "shifts"
  | "shiftGroups"
  | "rangeStart"
  | "rangeEnd"
  | "dateGroups"
  | "temporaryCover"
> & { cardsByKind: { requirements: RequirementCard[] } };

/** The non-card slices of `CoverInput`, as one shallow subscription key. */
export type CoverSlices = Pick<
  ScenarioUiState,
  | "staffGroups"
  | "shifts"
  | "shiftGroups"
  | "rangeStart"
  | "rangeEnd"
  | "dateGroups"
  | "temporaryCover"
>;

export function coverSlicesOf(state: ScenarioUiState): CoverSlices {
  return {
    staffGroups: state.staffGroups,
    shifts: state.shifts,
    shiftGroups: state.shiftGroups,
    rangeStart: state.rangeStart,
    rangeEnd: state.rangeEnd,
    dateGroups: state.dateGroups,
    temporaryCover: state.temporaryCover,
  };
}

/** The only card kind the cover arithmetic walks, as its own subscription key. */
export function coverCardsOf(state: ScenarioUiState): RequirementCard[] {
  return state.cardsByKind.requirements;
}

/** `CoverInput` from the two subscription keys. */
export function coverInputFrom(slices: CoverSlices, requirements: RequirementCard[]): CoverInput {
  return { ...slices, cardsByKind: { requirements } };
}

export function coverStatuses(state: CoverInput): CoverStatus[] {
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
