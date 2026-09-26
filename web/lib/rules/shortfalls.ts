// Static staffing check: shortfalls the solver is certain to reject.
//
// Pure, React-free and AI-free (the assistant reads it, a non-AI screen may show it).
// Every finding is a PROOF, not a hint. It mirrors the solver's hard staffing model
// (core/nurse_scheduling/preference_types.py, shift_type_requirements):
// - a requirement is an EXACT head count, or `requiredNumPeople..preferredNumPeople`
//   when `preferredNumPeople` is set; overlapping requirements all apply;
//   a requiredNumPeopleOverrides entry replaces the count on its date;
// - `qualifiedPeople` bans everyone else from that requirement's shifts and dates,
//   which binds every other requirement on the same shift too;
// - leave pins and hard day-offs, hard "never" shift requests, hard count caps, and
//   the always-on "at most one shift per day".
// That is what lets the assistant state a finding as the cause (the evidence
// contract's first rule, diagnostic-explanations.ts).
//
// ponytail: ignores successions, affinities, coverings, hard "must work" requests,
// coefficient-weighted requirement counts and counts, and minimum counts; those
// infeasibilities surface only from a real run. Add a check here when a real ward hits one.

import {
  RESERVED_SHIFT_TYPE,
  isDayStateSelector,
  type DateRef,
  type PersonRef,
  type RequirementCard,
  type ScenarioUiState,
  type UiRequestCell,
} from "@/lib/scenario";
import { cardNeedOn } from "@/lib/scenario/temporary-cover";
import { expandPersonRefs, expandShiftTypeRefs, flattenShiftTypeRefs } from "./expansion";
import { makeDates, requiredOn, requirementDateIsos } from "./requirement-dates";

// The date scope of a requirement lives in `./requirement-dates` so the temporary-cover
// module can read it without importing this one (d582); re-exported for its importers.
export { requirementDateIds, toDateId } from "./requirement-dates";
export { requiredOn, requirementDateIsos };

export type StaffingFindingKind =
  | "requirement_short"
  | "day_short"
  | "cap_short"
  | "requirement_conflict";
export type AwayReason = "leave" | "day_off" | "never_request";

export interface StaffingFinding {
  kind: StaffingFindingKind;
  /** Span-formatted date id; `null` for a whole-period `cap_short`. */
  dateId: string | null;
  iso: string | null;
  /** Worked shift ids the finding is about. */
  shiftTypes: string[];
  /**
   * Requirement card uids involved. `requirement_short`/`day_short`: the short
   * requirements (largest head count first), then any skill-mix rules whose ban
   * removed someone. `requirement_conflict`: the inner requirements, then the outer one.
   */
  ruleIds: string[];
  /** People needed that date, or shifts needed over the period (`cap_short`). */
  required: number;
  /**
   * People free that date, shifts the caps allow (`cap_short`), or the most people
   * the outer requirement allows on its shifts (`requirement_conflict`).
   */
  available: number;
  /** Qualified people who would count but are away that date. */
  away: { person: string; reason: AwayReason }[];
  /** Hard count rules that bound supply (`cap_short` only). */
  capRuleIds: string[];
  /** A requirement involved counts only a named group or people (skill mix). */
  skillMix: boolean;
  /**
   * The group or person of the short skill-mix entry; null when no skill-mix entry is short.
   * A skill-mix `requirement_conflict` (ruleIds is the one card) names its groups joined by " and ".
   */
  mixPeople: string | null;
  /**
   * How much of `required` a temporary cover already fills (d582 F5). Absent when nothing
   * covers the finding's slot, so a ward without a cover reads exactly as it did before.
   */
  coverCredit?: number;
}

export interface SkillMixOverflow {
  groups: string[];
  required: number;
  available: number;
}

/**
 * Skill-mix entries whose groups share no one each need their OWN people on the shift, so
 * their minimums add up. Null when that sum fits `max` (the head-count ceiling). Greedy,
 * largest minimum first, so a report is a proof; overlapping groups are legal (an RN who is
 * also a senior counts toward both). Shared by the static check and the assistant's checks.
 */
export function skillMixOverflow(
  state: ScenarioUiState,
  skillMix: readonly { people: PersonRef; minNumPeople: number }[] | undefined,
  max: number,
): SkillMixOverflow | null {
  const staffIds = new Set(state.staff.map((person) => String(person.id)));
  const used = new Set<string>();
  const groups: string[] = [];
  let required = 0;
  for (const entry of [...(skillMix ?? [])].sort((a, b) => b.minNumPeople - a.minNumPeople)) {
    const members = [...expandPersonRefs([entry.people], state)].filter((p) => staffIds.has(p));
    if (members.some((p) => used.has(p))) continue;
    members.forEach((p) => used.add(p));
    groups.push(String(entry.people));
    required += entry.minNumPeople;
  }
  return groups.length >= 2 && required > max ? { groups, required, available: max } : null;
}

export const skillMixOverflowMessage = (o: SkillMixOverflow) =>
  `the skill-mix groups ${o.groups.join(" and ")} share no one, so together they need ${o.required} people, but the shift allows at most ${o.available}`;

/** Short by rules alone: everyone it counts is banned from its shifts by another named rule. */
const isRuleClash = (f: StaffingFinding) =>
  f.kind === "requirement_short" &&
  f.available === 0 &&
  f.away.length === 0 &&
  f.ruleIds.length > 1;
/**
 * The short rule and its skill-mix entry only: date ids follow the roster span and the
 * banning rules follow set order and repairs, so either would make an old clash look new.
 */
const clashKey = (f: StaffingFinding) => `${f.ruleIds[0]}|${f.mixPeople}`;

/**
 * The first requirement a change leaves unstaffable by its rules alone (leave plays no
 * part), or null. Such a change can never be met, so the assistant's Preview refuses it.
 */
export function newRuleClash(
  before: ScenarioUiState,
  after: ScenarioUiState,
): StaffingFinding | null {
  const had = new Set(findStaffingShortfalls(before).filter(isRuleClash).map(clashKey));
  return findStaffingShortfalls(after).find((f) => isRuleClash(f) && !had.has(clashKey(f))) ?? null;
}

export function ruleClashMessage(state: ScenarioUiState, f: StaffingFinding): string {
  const name = (uid: string) =>
    `"${state.cardsByKind.requirements.find((c) => c.uid === uid)?.description || uid}"`;
  const [short, ...banning] = f.ruleIds;
  return (
    `No roster could meet ${name(short)} on ${f.shiftTypes.join(", ")}` +
    `${f.iso ? `, first on ${f.iso}` : ""}: ` +
    `${banning.map(name).join(" and ")} lets only its own people work that shift, so nobody ` +
    "it needs may work it. A skill mix (at least so many from a group, others allowed too) " +
    "or a separate shift for each group would work instead. Ask which they want before " +
    "changing either rule."
  );
}

type Block = { reason: AwayReason; shifts: Set<string> | "all" };
type PersonRefs = Parameters<typeof expandPersonRefs>[0];

/**
 * One equation's numbers on one date, as `cardNeedOn` states them: the authored count
 * less a temporary cover's credit, clamped at 0 (d582, F4).
 */
interface WardCounts {
  /** The solver's floor on this date. */
  required: number;
  /** `preferredNumPeople` less her credit, never below `required`; null = the floor is exact. */
  preferred: number | null;
  /** The skill-mix floors, parallel to the authored `skillMix`. */
  mix: readonly number[];
  /** Her credit here, 0 when nothing covers this slot. */
  credit: number;
}

/** One solver staffing equation: one top-level shift selector of one card. */
interface Equation {
  ruleId: string;
  shiftTypes: Set<string>;
  qualified: Set<string>;
  dateIds: Set<string>;
  /** The solver's floor, `requiredNumPeople`: the fallback for a date the map misses. */
  required: number;
  /** Span id -> the ward's numbers that date, from `requiredNumPeopleOverrides` and cover. */
  counts: Map<string, WardCounts>;
  /**
   * The covered-date ceiling of the head equation; null = the floor is exact.
   * A skill-mix equation has no ceiling of its own: `Infinity`.
   */
  preferred: number | null;
  /** `qualifiedPeople` names a group or people: the solver bans everyone else. */
  restricts: boolean;
  /** False for coefficient-weighted cards: their bans apply, their counts are not checked. */
  counted: boolean;
  /** The skill-mix entry this equation checks, or null for a card's own head count. */
  mix: string | null;
  /** This equation's index into the card's authored `skillMix`; null for a head count. */
  mixIndex: number | null;
  /** A counted head equation's skill mix, checked for overflow against each date's ceiling. */
  skillMix: RequirementCard["skillMix"];
}

const need = (eq: Equation, dateId: string) => {
  const counts = eq.counts.get(dateId);
  if (counts === undefined) return eq.required;
  return eq.mixIndex === null ? counts.required : (counts.mix[eq.mixIndex] ?? eq.required);
};
/** The equation's ceiling on one date; a skill-mix equation has none of its own. */
const ceiling = (eq: Equation, dateId: string) =>
  eq.mixIndex === null
    ? (eq.counts.get(dateId)?.preferred ?? eq.preferred ?? need(eq, dateId))
    : Number.POSITIVE_INFINITY;
/** What temporary cover already fills of one equation on one date (d582). */
const creditOn = (eq: Equation, dateId: string) => eq.counts.get(dateId)?.credit ?? 0;

/** The finding field, present only when a cover fills part of the requirement (d582). */
const withCredit = (credit: number) => (credit > 0 ? { coverCredit: credit } : {});

/**
 * A head equation's skill mix with the cover's credit applied, so the floors an overflow is
 * measured against are the ward's, not the card's. An entry she fills to 0 drops out.
 */
const mixFloors = (eq: Equation, dateId: string): RequirementCard["skillMix"] => {
  const counts = eq.counts.get(dateId);
  if (counts === undefined || eq.skillMix === undefined) return eq.skillMix;
  return eq.skillMix
    .map((entry, k) => ({ ...entry, minNumPeople: counts.mix[k] ?? 0 }))
    .filter((entry) => entry.minNumPeople > 0);
};

/** Who can count toward one equation on one date. */
interface Assessment {
  free: Set<string>;
  away: Map<string, AwayReason>;
  /** Other skill-mix rules that ban a qualified person from all of the equation's shifts. */
  banRules: Set<string>;
}

interface Cap {
  ruleId: string;
  people: Set<string>;
  shiftTypes: Set<string>;
  dateIds: Set<string>;
  cap: number;
}

const asList = <T>(value: T | T[] | null | undefined): T[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

const isAllRef = (ref: unknown) => String(ref).toUpperCase() === RESERVED_SHIFT_TYPE.all;

const isSubset = (a: Set<string>, b: Set<string>) => [...a].every((s) => b.has(s));

/** The most shifts a hard count lets one person work, or `Infinity` when it is no hard upper bound. */
export function capOf(expression: string, target: number, weight: number): number {
  if (weight === Infinity) {
    if (expression === "x <= T" || expression === "x = T") return target;
    if (expression === "x < T") return target - 1;
  }
  if (weight === -Infinity) {
    if (expression === "x > T" || expression === "|x - T|^2") return target;
    if (expression === "x >= T") return target - 1;
  }
  return Infinity;
}

/**
 * Drop every per-date override a requirement no longer covers, keeping the cards
 * (and the overrides) that still resolve. An override is valid only while its ISO
 * date is one of the requirement's RESOLVED dates (`requirementDateIsos`); a date
 * the requirement stopped covering — a deleted/edited date group, a shrunk range
 * — would otherwise reach the solver and raise, and the run would fail with a
 * generic error instead of a named one. Pure: returns the same state when nothing
 * is dropped, so a mutation that changes no coverage makes no spurious entry.
 */
export function dropUncoveredOverrides(state: ScenarioUiState): ScenarioUiState {
  let dropped = false;
  const requirements = state.cardsByKind.requirements.map((card) => {
    const overrides = card.requiredNumPeopleOverrides;
    if (!overrides?.length) return card;
    const covered = new Set(requirementDateIsos(state, card));
    const kept = overrides.filter(([iso]) => covered.has(iso));
    if (kept.length === overrides.length) return card;
    dropped = true;
    if (kept.length === 0) {
      const { requiredNumPeopleOverrides: _uncovered, ...rest } = card;
      return rest;
    }
    return { ...card, requiredNumPeopleOverrides: kept };
  });
  return dropped ? { ...state, cardsByKind: { ...state.cardsByKind, requirements } } : state;
}

/** Greedily picks equations over pairwise-separate shifts, largest head count that date first. */
function disjoint(candidates: Equation[], dateId: string): Equation[] {
  const chosen: Equation[] = [];
  const used = new Set<string>();
  for (const eq of [...candidates].sort((a, b) => need(b, dateId) - need(a, dateId))) {
    if ([...eq.shiftTypes].some((s) => used.has(s))) continue;
    chosen.push(eq);
    eq.shiftTypes.forEach((s) => used.add(s));
  }
  return chosen;
}

export function findStaffingShortfalls(state: ScenarioUiState): StaffingFinding[] {
  const { items, allDateIds, expand } = makeDates(state);
  if (items.length === 0 || state.staff.length === 0) return [];
  const isoById = new Map(items.map((item) => [item.id, item.iso]));
  // The shifts temporary covers sit on, by date: the only slots `cardNeedOn` is asked about.
  const coveredShifts = new Map<string, Set<string>>();
  for (const cover of state.temporaryCover) {
    const shifts = coveredShifts.get(cover.date) ?? new Set<string>();
    shifts.add(String(cover.shiftType));
    coveredShifts.set(cover.date, shifts);
  }
  const staffIds = new Set(state.staff.map((person) => String(person.id)));
  const workedIds = state.shifts
    .map((shift) => String(shift.id))
    .filter((id) => !isDayStateSelector(id));
  const shiftsOf = (selector: string): Set<string> =>
    isAllRef(selector)
      ? new Set(workedIds)
      : new Set(
          [...expandShiftTypeRefs([selector], state)].filter((id) => !isDayStateSelector(id)),
        );
  const peopleOf = (refs: PersonRefs) =>
    new Set([...expandPersonRefs(refs, state)].filter((id) => staffIds.has(id)));

  const allEquations = buildEquations(state, isoById, expand, shiftsOf, peopleOf, coveredShifts);
  const equations = allEquations.filter((eq) => eq.counted);
  const restricting = allEquations.filter((eq) => eq.restricts);
  const away = buildAway(state, expand, shiftsOf, peopleOf);
  const caps = buildCaps(state, expand, shiftsOf, peopleOf);
  const findings: StaffingFinding[] = [];

  // ponytail: linear scan over skill-mix rules per (date, shift, person); index them if wards grow large.
  const bannedBy = (dateId: string, s: string, p: string) =>
    restricting
      .filter((r) => r.dateIds.has(dateId) && r.shiftTypes.has(s) && !r.qualified.has(p))
      .map((r) => r.ruleId);

  const memo = new Map<Equation, Map<string, Assessment>>();
  const assess = (eq: Equation, dateId: string): Assessment => {
    const byDate = memo.get(eq) ?? new Map<string, Assessment>();
    memo.set(eq, byDate);
    const cached = byDate.get(dateId);
    if (cached) return cached;
    const row = away.get(dateId);
    const out: Assessment = { free: new Set(), away: new Map(), banRules: new Set() };
    for (const p of eq.qualified) {
      const open = new Set<string>();
      const bans: string[] = [];
      for (const s of eq.shiftTypes) {
        const by = bannedBy(dateId, s, p);
        if (by.length === 0) open.add(s);
        else bans.push(...by);
      }
      if (open.size === 0) {
        bans.forEach((r) => out.banRules.add(r));
        continue;
      }
      const block = row?.get(p);
      if (isAway(block, open)) out.away.set(p, block!.reason);
      else out.free.add(p);
    }
    byDate.set(dateId, out);
    return out;
  };

  // An override or a covered date changes the ceiling AND the floors, so this is keyed by date.
  const overflowMemo = new Map<Equation, Map<string, SkillMixOverflow | null>>();
  const overflowOn = (eq: Equation, dateId: string): SkillMixOverflow | null => {
    const byDate = overflowMemo.get(eq) ?? new Map<string, SkillMixOverflow | null>();
    overflowMemo.set(eq, byDate);
    if (!byDate.has(dateId)) {
      byDate.set(dateId, skillMixOverflow(state, mixFloors(eq, dateId), ceiling(eq, dateId)));
    }
    return byDate.get(dateId)!;
  };

  for (const dateId of allDateIds) {
    const iso = isoById.get(dateId) ?? null;
    const today = equations.filter((eq) => eq.dateIds.has(dateId));

    // requirement_short: one equation needs more people than can count toward it.
    for (const eq of today) {
      const a = assess(eq, dateId);
      if (a.free.size >= need(eq, dateId)) continue;
      findings.push({
        kind: "requirement_short",
        dateId,
        iso,
        shiftTypes: [...eq.shiftTypes],
        ruleIds: [eq.ruleId, ...a.banRules],
        required: need(eq, dateId),
        available: a.free.size,
        away: [...a.away].map(([person, reason]) => ({ person, reason })),
        capRuleIds: [],
        skillMix: eq.restricts || eq.mix !== null || a.banRules.size > 0,
        mixPeople: eq.mix,
        ...withCredit(creditOn(eq, dateId)),
      });
    }

    // day_short: equations over separate shifts need more people than are free that day.
    // Each person works at most one shift per day, so any set of equations with disjoint
    // shift sets needs that many DIFFERENT people. Both kinds can report the same date: the
    // day-level gap can be larger than any one requirement's (repair-options uses the max).
    const chosen = disjoint(today, dateId);
    if (chosen.length >= 2) {
      const pool = new Set<string>();
      const gone = new Map<string, AwayReason>();
      const banRules = new Set<string>();
      for (const eq of chosen) {
        const a = assess(eq, dateId);
        a.free.forEach((p) => pool.add(p));
        a.away.forEach((reason, p) => gone.set(p, reason));
        a.banRules.forEach((r) => banRules.add(r));
      }
      const required = chosen.reduce((sum, eq) => sum + need(eq, dateId), 0);
      if (pool.size < required) {
        findings.push({
          kind: "day_short",
          dateId,
          iso,
          shiftTypes: chosen.flatMap((eq) => [...eq.shiftTypes]),
          ruleIds: [...new Set([...chosen.map((eq) => eq.ruleId), ...banRules])],
          required,
          available: pool.size,
          away: [...gone]
            .filter(([p]) => !pool.has(p))
            .map(([person, reason]) => ({ person, reason })),
          capRuleIds: [],
          skillMix: chosen.some((eq) => eq.restricts || eq.mix !== null) || banRules.size > 0,
          // A same-card mix equation always loses disjoint()'s pick to its own head
          // equation (same shiftTypes, required >= minNumPeople), so this only ever
          // names a mix entry from a DIFFERENT card. It is not exhaustive: a same-card
          // mix shortfall still surfaces, just on the per-equation requirement_short.
          mixPeople: chosen.find((eq) => eq.mix)?.mix ?? null,
          ...withCredit(chosen.reduce((sum, eq) => sum + creditOn(eq, dateId), 0)),
        });
      }
    }

    // requirement_conflict: requirements inside an outer one's shifts need more people
    // than the outer one allows. Everyone who counts toward an inner requirement also
    // counts toward the outer one (skill-mix bans keep everyone else off those shifts),
    // so the inner floors, summed over separate shifts, cannot exceed the outer ceiling.
    for (const outer of today) {
      const inner = disjoint(
        today.filter((eq) => eq !== outer && isSubset(eq.shiftTypes, outer.shiftTypes)),
        dateId,
      );
      const required = inner.reduce((sum, eq) => sum + need(eq, dateId), 0);
      if (required <= ceiling(outer, dateId)) continue;
      findings.push({
        kind: "requirement_conflict",
        dateId,
        iso,
        shiftTypes: [...outer.shiftTypes],
        ruleIds: [...new Set([...inner.map((eq) => eq.ruleId), outer.ruleId])],
        required,
        available: ceiling(outer, dateId),
        away: [],
        capRuleIds: [],
        skillMix:
          outer.restricts ||
          outer.mix !== null ||
          inner.some((eq) => eq.restricts || eq.mix !== null),
        // Same shadowing as day_short above: a mix equation whose own head is the
        // outer equation here can never appear as a separate inner candidate (its
        // shifts equal the outer's, so nothing else stays disjoint from it). So this
        // only ever names a mix entry from a different card than outer.
        mixPeople: inner.find((eq) => eq.mix)?.mix ?? null,
        ...withCredit(inner.reduce((sum, eq) => sum + creditOn(eq, dateId), 0)),
      });
    }

    // requirement_conflict inside one card: skill-mix groups that share no one need more
    // different people than the head count allows. disjoint() above cannot see this: the
    // mix equations share the head's shifts, so it keeps only one of them.
    for (const eq of today) {
      const overflow = overflowOn(eq, dateId);
      if (!overflow) continue;
      findings.push({
        kind: "requirement_conflict",
        dateId,
        iso,
        shiftTypes: [...eq.shiftTypes],
        ruleIds: [eq.ruleId],
        required: overflow.required,
        available: overflow.available,
        away: [],
        capRuleIds: [],
        skillMix: true,
        mixPeople: overflow.groups.join(" and "),
        ...withCredit(creditOn(eq, dateId)),
      });
    }
  }

  // cap_short: over the period, the qualified people may not work enough of these shifts.
  for (const eq of equations) {
    const dates = allDateIds.filter((d) => eq.dateIds.has(d));
    const demand = dates.reduce((sum, d) => sum + need(eq, d), 0);
    let supply = 0;
    const binding = new Set<string>();
    for (const p of eq.qualified) {
      const freeDays = dates.filter((d) => assess(eq, d).free.has(p)).length;
      const cap = caps
        .filter(
          (c) =>
            c.people.has(p) &&
            isSubset(eq.shiftTypes, c.shiftTypes) &&
            dates.every((d) => c.dateIds.has(d)),
        )
        .sort((a, b) => a.cap - b.cap)[0];
      if (cap && cap.cap < freeDays) {
        supply += Math.max(cap.cap, 0);
        binding.add(cap.ruleId);
      } else {
        supply += freeDays;
      }
    }
    if (supply >= demand || binding.size === 0) continue;
    findings.push({
      kind: "cap_short",
      dateId: null,
      iso: null,
      shiftTypes: [...eq.shiftTypes],
      ruleIds: [eq.ruleId],
      required: demand,
      available: supply,
      away: [],
      capRuleIds: [...binding],
      skillMix: eq.restricts || eq.mix !== null,
      mixPeople: eq.mix,
      ...withCredit(dates.reduce((sum, d) => sum + creditOn(eq, d), 0)),
    });
  }

  const order = new Map(allDateIds.map((id, index) => [id, index]));
  return findings.sort(
    (a, b) => (order.get(a.dateId ?? "") ?? -1) - (order.get(b.dateId ?? "") ?? -1),
  );
}

function buildEquations(
  state: ScenarioUiState,
  isoById: ReadonlyMap<string, string>,
  expand: (refs: DateRef[]) => Set<string>,
  shiftsOf: (selector: string) => Set<string>,
  peopleOf: (refs: PersonRefs) => Set<string>,
  coveredShifts: ReadonlyMap<string, ReadonlySet<string>>,
): Equation[] {
  const out: Equation[] = [];
  for (const card of state.cardsByKind.requirements) {
    if (card.disabled) continue;
    const refs = asList(card.qualifiedPeople);
    const restricts = card.qualifiedPeople != null && !refs.some(isAllRef);
    const qualified = peopleOf(card.qualifiedPeople);
    const dateIds = expand(card.date == null ? [RESERVED_SHIFT_TYPE.all] : asList(card.date));
    // ponytail: with coefficients a person can count more than once, so only the ban is used.
    const counted = !card.shiftTypeCoefficients?.length;
    // Solver: a scalar selector is one equation; each top-level list element is one
    // equation, and a group or nested list inside it aggregates its shifts.
    const selectors = Array.isArray(card.shiftType) ? card.shiftType : [card.shiftType];
    const shiftsPerSelector = selectors.map(
      (selector) =>
        new Set(flattenShiftTypeRefs(selector).flatMap((ref) => [...shiftsOf(String(ref))])),
    );
    /**
     * A shift id only selector `i` covers, so `cardNeedOn` reads THAT selector's numbers:
     * it resolves a shift id to the first selector holding it, so a shift two selectors
     * share would answer with the earlier one's count. A selector whose every shift an
     * earlier one also holds is redundant: those equations already carry those shifts.
     */
    const ownShift = (i: number) => {
      const earlier = new Set(shiftsPerSelector.slice(0, i).flatMap((ids) => [...ids]));
      return [...shiftsPerSelector[i]].find((id) => !earlier.has(id));
    };
    for (const [i, shiftTypes] of shiftsPerSelector.entries()) {
      if (shiftTypes.size === 0) continue;
      const counts = wardCounts({
        state,
        card,
        dateIds,
        isoById,
        shiftTypes,
        shiftId: ownShift(i),
        coveredShifts,
      });
      out.push({
        ruleId: card.uid,
        shiftTypes,
        qualified,
        dateIds,
        required: card.requiredNumPeople,
        counts,
        preferred: card.preferredNumPeople ?? null,
        restricts,
        counted,
        mix: null,
        mixIndex: null,
        skillMix: counted ? card.skillMix : undefined,
      });

      // Skill mix: a floor for a group AMONG this equation's staff. It bans nobody,
      // so it restricts nothing and has no ceiling of its own. It reads the same date
      // map as its head equation: a cover credits both.
      for (const [k, entry] of (card.skillMix ?? []).entries()) {
        out.push({
          ruleId: card.uid,
          shiftTypes,
          qualified: new Set([...peopleOf([entry.people])].filter((p) => qualified.has(p))),
          dateIds,
          required: entry.minNumPeople,
          counts,
          preferred: Number.POSITIVE_INFINITY,
          restricts: false,
          counted: true,
          mix: String(entry.people),
          mixIndex: k,
          skillMix: undefined,
        });
      }
    }
  }
  return out;
}

/**
 * The ward's numbers for one card-and-selector on every date it covers (`cardNeedOn`,
 * d582): the authored count with the hand-written per-date overrides and any temporary
 * cover applied, her credit clamped at 0 (F4). `shiftId` picks the selector: undefined
 * for a card with one, and see `ownShift` for the rest.
 *
 * `cardNeedOn` restates EVERY enabled card's date scope, so it is asked only where a cover
 * could reach this selector: her date, and one of her shifts among its shifts. Everywhere
 * else the card's own numbers stand, which is exactly what `cardNeedOn` returns when no
 * cover counts: a cover only ever LOWERS a count, and only for a card she reaches.
 */
function wardCounts(options: {
  state: ScenarioUiState;
  card: RequirementCard;
  dateIds: ReadonlySet<string>;
  isoById: ReadonlyMap<string, string>;
  shiftTypes: ReadonlySet<string>;
  shiftId: string | undefined;
  coveredShifts: ReadonlyMap<string, ReadonlySet<string>>;
}): Map<string, WardCounts> {
  const { state, card, dateIds, isoById, shiftTypes, shiftId, coveredShifts } = options;
  const counts = new Map<string, WardCounts>();
  for (const dateId of dateIds) {
    const iso = isoById.get(dateId);
    if (iso === undefined) continue;
    const onDate = coveredShifts.get(iso);
    const covered =
      onDate !== undefined && [...shiftTypes].some((shift) => onDate.has(shift))
        ? cardNeedOn(state, card, iso, shiftId)
        : null;
    counts.set(dateId, {
      required: covered?.required ?? requiredOn(card, iso),
      preferred: covered ? (covered.preferred ?? null) : (card.preferredNumPeople ?? null),
      mix: covered?.mix ?? (card.skillMix ?? []).map((entry) => entry.minNumPeople),
      credit: covered?.credit ?? 0,
    });
  }
  return counts;
}

function blockOf(cell: UiRequestCell, shiftsOf: (selector: string) => Set<string>): Block | null {
  if (cell.kind === "leave") return { reason: "leave", shifts: "all" };
  if (cell.kind === "off")
    return cell.weight === Infinity ? { reason: "day_off", shifts: "all" } : null;
  return cell.weight === -Infinity
    ? { reason: "never_request", shifts: shiftsOf(String(cell.shiftType)) }
    : null;
}

function mergeBlock(a: Block | undefined, b: Block): Block {
  if (!a) return b;
  if (a.shifts === "all") return a;
  if (b.shifts === "all") return b;
  return { reason: a.reason, shifts: new Set([...a.shifts, ...b.shifts]) };
}

function isAway(block: Block | undefined, shifts: Set<string>): boolean {
  if (!block) return false;
  if (block.shifts === "all") return true;
  return isSubset(shifts, block.shifts);
}

function buildAway(
  state: ScenarioUiState,
  expand: (refs: DateRef[]) => Set<string>,
  shiftsOf: (selector: string) => Set<string>,
  peopleOf: (refs: PersonRefs) => Set<string>,
): Map<string, Map<string, Block>> {
  const byDate = new Map<string, Map<string, Block>>();
  for (const cell of state.reqData) {
    const block = blockOf(cell, shiftsOf);
    if (!block) continue;
    for (const dateId of expand([cell.date])) {
      const row = byDate.get(dateId) ?? new Map<string, Block>();
      byDate.set(dateId, row);
      for (const person of peopleOf(cell.person))
        row.set(person, mergeBlock(row.get(person), block));
    }
  }
  return byDate;
}

function buildCaps(
  state: ScenarioUiState,
  expand: (refs: DateRef[]) => Set<string>,
  shiftsOf: (selector: string) => Set<string>,
  peopleOf: (refs: PersonRefs) => Set<string>,
): Cap[] {
  const caps: Cap[] = [];
  for (const card of state.cardsByKind.counts) {
    // ponytail: hours-weighted counts are skipped.
    if (card.disabled || card.countShiftTypeCoefficients?.length) continue;
    const targets = asList(card.target);
    const cap = Math.min(
      ...asList(card.expression).map((expression, i) =>
        capOf(expression, targets[i] ?? Infinity, card.weight),
      ),
    );
    if (!Number.isFinite(cap)) continue;
    caps.push({
      ruleId: card.uid,
      people: peopleOf(card.person),
      shiftTypes: new Set(asList(card.countShiftTypes).flatMap((s) => [...shiftsOf(String(s))])),
      dateIds: expand(asList(card.countDates)),
      cap,
    });
  }
  return caps;
}
