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
import { generateDateItems, getDateIdForRange, isValidIso } from "@/lib/dates/date-id";
import { deriveDateGroups } from "@/lib/dates/derived-groups";
import {
  expandDateRefs,
  expandPersonRefs,
  expandShiftTypeRefs,
  flattenShiftTypeRefs,
} from "./expansion";

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

type Range = { start: string; end: string };
type Block = { reason: AwayReason; shifts: Set<string> | "all" };
type PersonRefs = Parameters<typeof expandPersonRefs>[0];

/** One solver staffing equation: one top-level shift selector of one card. */
interface Equation {
  ruleId: string;
  shiftTypes: Set<string>;
  qualified: Set<string>;
  dateIds: Set<string>;
  /** The solver's floor, `requiredNumPeople`. */
  required: number;
  /** Span id -> that date's floor, from `requiredNumPeopleOverrides`. */
  overrides: Map<string, number>;
  /**
   * `preferredNumPeople`, the solver's ceiling on every date; null = the floor is exact.
   * A skill-mix equation has no ceiling of its own: `Infinity`.
   */
  preferred: number | null;
  /** `qualifiedPeople` names a group or people: the solver bans everyone else. */
  restricts: boolean;
  /** False for coefficient-weighted cards: their bans apply, their counts are not checked. */
  counted: boolean;
  /** The skill-mix entry this equation checks, or null for a card's own head count. */
  mix: string | null;
  /** A counted head equation's skill mix, checked for overflow against each date's ceiling. */
  skillMix: RequirementCard["skillMix"];
}

const need = (eq: Equation, dateId: string) => eq.overrides.get(dateId) ?? eq.required;
const ceiling = (eq: Equation, dateId: string) => eq.preferred ?? need(eq, dateId);

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

/** An in-range ISO date becomes its span id; every other ref is returned as written. */
export function toDateId(ref: DateRef, range: Range): string {
  const key = String(ref);
  return isValidIso(key) ? getDateIdForRange(key, range) : key;
}

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

/** The date fields `makeDates` reads — a `Pick`, like the expansion helpers, so a
 *  caller that holds only the date slice (the Requirements editor's store
 *  subscription) can expand a card's dates without a whole scenario. */
type DateScopeState = Pick<ScenarioUiState, "rangeStart" | "rangeEnd" | "dateGroups">;

function makeDates(state: DateScopeState) {
  const range = { start: state.rangeStart, end: state.rangeEnd };
  const items = generateDateItems(range);
  const allDateIds = items.map((item) => item.id);
  const derived = deriveDateGroups(items);
  const expand = (refs: DateRef[]) =>
    expandDateRefs(
      refs.map((ref) => toDateId(ref, range)),
      state,
      allDateIds,
      derived,
    );
  return { range, items, allDateIds, expand };
}

/** The span ids a requirement covers in this roster period. */
export function requirementDateIds(
  state: DateScopeState,
  card: Pick<RequirementCard, "date">,
): string[] {
  const { allDateIds, expand } = makeDates(state);
  const covered = expand(card.date == null ? [RESERVED_SHIFT_TYPE.all] : asList(card.date));
  return allDateIds.filter((id) => covered.has(id));
}

/** The ISO dates a requirement covers in this roster period, in order. */
export function requirementDateIsos(
  state: DateScopeState,
  card: Pick<RequirementCard, "date">,
): string[] {
  const { items, expand } = makeDates(state);
  const covered = expand(card.date == null ? [RESERVED_SHIFT_TYPE.all] : asList(card.date));
  return items.filter((item) => covered.has(item.id)).map((item) => item.iso);
}

/** A requirement's head count on one date: its override there, else `requiredNumPeople`. */
export function requiredOn(
  card: Pick<RequirementCard, "requiredNumPeople" | "requiredNumPeopleOverrides">,
  iso: string,
): number {
  return (
    card.requiredNumPeopleOverrides?.find(([date]) => date === iso)?.[1] ?? card.requiredNumPeople
  );
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
  const { range, items, allDateIds, expand } = makeDates(state);
  if (items.length === 0 || state.staff.length === 0) return [];
  const isoById = new Map(items.map((item) => [item.id, item.iso]));
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

  const allEquations = buildEquations(state, range, expand, shiftsOf, peopleOf);
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

  // Only an override date can change the ceiling, so this memo stays tiny.
  const overflowMemo = new Map<Equation, Map<number, SkillMixOverflow | null>>();
  const overflowOn = (eq: Equation, dateId: string): SkillMixOverflow | null => {
    const max = ceiling(eq, dateId);
    const byMax = overflowMemo.get(eq) ?? new Map<number, SkillMixOverflow | null>();
    overflowMemo.set(eq, byMax);
    if (!byMax.has(max)) byMax.set(max, skillMixOverflow(state, eq.skillMix, max));
    return byMax.get(max)!;
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
    });
  }

  const order = new Map(allDateIds.map((id, index) => [id, index]));
  return findings.sort(
    (a, b) => (order.get(a.dateId ?? "") ?? -1) - (order.get(b.dateId ?? "") ?? -1),
  );
}

function buildEquations(
  state: ScenarioUiState,
  range: Range,
  expand: (refs: DateRef[]) => Set<string>,
  shiftsOf: (selector: string) => Set<string>,
  peopleOf: (refs: PersonRefs) => Set<string>,
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
    const overrides = new Map(
      (card.requiredNumPeopleOverrides ?? []).map(([iso, n]) => [toDateId(iso, range), n] as const),
    );
    // Solver: a scalar selector is one equation; each top-level list element is one
    // equation, and a group or nested list inside it aggregates its shifts.
    const selectors = Array.isArray(card.shiftType) ? card.shiftType : [card.shiftType];
    for (const selector of selectors) {
      const shiftTypes = new Set(
        flattenShiftTypeRefs(selector).flatMap((ref) => [...shiftsOf(String(ref))]),
      );
      if (shiftTypes.size === 0) continue;
      out.push({
        ruleId: card.uid,
        shiftTypes,
        qualified,
        dateIds,
        required: card.requiredNumPeople,
        overrides,
        preferred: card.preferredNumPeople ?? null,
        restricts,
        counted,
        mix: null,
        skillMix: counted ? card.skillMix : undefined,
      });

      // Skill mix: a floor for a group AMONG this equation's staff. It bans nobody,
      // so it restricts nothing and has no ceiling of its own.
      for (const entry of card.skillMix ?? []) {
        out.push({
          ruleId: card.uid,
          shiftTypes,
          qualified: new Set([...peopleOf([entry.people])].filter((p) => qualified.has(p))),
          dateIds,
          required: entry.minNumPeople,
          overrides: new Map(),
          preferred: Number.POSITIVE_INFINITY,
          restricts: false,
          counted: true,
          mix: String(entry.people),
          skillMix: undefined,
        });
      }
    }
  }
  return out;
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
