// Shared anonymization transform (T05, critique #3 — single owner).
//
// One pure ID-map + nested-reference rewrite lives here; T16 (Optimize's fixed
// options + reverse-map + XLSX ID restoration) and T17 (Save/Load 3-toggle panel)
// both consume it — there is no second copy. The transform is copy-not-mutate:
// it deep-clones the document and rewrites the clone, so live durable state is
// never touched. Only *people* identifiers are PII: people items → `P#`, people
// groups → `G#`. Shift types, dates, weights, and descriptions are left as-is
// (description/history blanking are the panel toggles T16/T17 layer on top).

import { generateDateItems, utcDayOfWeek } from "@/lib/dates/date-id";
import {
  type CanonicalDateGroup,
  type CanonicalScenarioDocument,
  type CanonicalShiftRequestPreference,
  type DateRef,
  type GroupId,
  type IsoDate,
  type NestedPersonRefList,
  type PersonId,
  type PersonRef,
} from "./types";

/** The bijective people-id map + its reverse (for XLSX restoration in T16). */
export interface AnonymizationIdMap {
  /** Original person id → anonymized `P#`. */
  people: Map<PersonId, string>;
  /** Original people-group id → anonymized `G#`. */
  groups: Map<GroupId, string>;
  /** Combined original ref → anonymized ref (people + groups). */
  forward: Map<PersonRef, PersonRef>;
  /** Anonymized ref → original ref (restore anonymized output to real ids). */
  reverse: Map<PersonRef, PersonRef>;
}

/**
 * Build a collision-safe people-id map from a canonical document. People items
 * are numbered `P1, P2, …` and people groups `G1, G2, …` in definition order.
 * Collision-safe: a generated id is skipped if it would clash with any *retained*
 * original id (a non-people id kept verbatim elsewhere), so the rewrite can never
 * alias an untouched reference onto an anonymized one. Pure — reads, never writes.
 */
export function buildIdMap(doc: Pick<CanonicalScenarioDocument, "people">): AnonymizationIdMap {
  const people = new Map<PersonId, string>();
  const groups = new Map<GroupId, string>();
  const forward = new Map<PersonRef, PersonRef>();
  const reverse = new Map<PersonRef, PersonRef>();

  // Every original id in the document's people domain, so a generated `P#`/`G#`
  // that happens to equal one of them is skipped.
  const retained = new Set<PersonRef>([
    ...doc.people.items.map((p) => p.id),
    ...(doc.people.groups ?? []).map((g) => g.id),
  ]);

  const assign = (
    originalId: PersonId | GroupId,
    prefix: "P" | "G",
    counter: { n: number },
    domain: Map<PersonId | GroupId, string>,
  ) => {
    let candidate: string;
    do {
      counter.n += 1;
      candidate = `${prefix}${counter.n}`;
    } while (retained.has(candidate) || reverse.has(candidate));
    domain.set(originalId, candidate);
    forward.set(originalId, candidate);
    reverse.set(candidate, originalId);
  };

  const personCounter = { n: 0 };
  for (const person of doc.people.items) assign(person.id, "P", personCounter, people);
  const groupCounter = { n: 0 };
  for (const group of doc.people.groups ?? []) assign(group.id, "G", groupCounter, groups);

  return { people, groups, forward, reverse };
}

/**
 * Return a NEW canonical document with every people reference rewritten through
 * `idMap.forward`. Reserved keywords (`ALL`/`OFF`/`LEAVE`) and unmapped refs pass
 * through unchanged. The input document is never mutated (deep-cloned first).
 */
export function anonymizeDocument(
  doc: CanonicalScenarioDocument,
  idMap: AnonymizationIdMap,
): CanonicalScenarioDocument {
  const clone = structuredClone(doc);

  // Consult the map FIRST: a backend-valid person/group literally named `OFF` or
  // `LEAVE` (the people domain reserves only `ALL`, which is never a mapped id)
  // must be anonymized. Unmapped refs — including the reserved all-people keyword
  // `ALL` and any shift-type selector keyword — are left unchanged naturally.
  const ref = (value: PersonRef): PersonRef => idMap.forward.get(value) ?? value;
  const refOrList = (value: PersonRef | PersonRef[]): PersonRef | PersonRef[] =>
    Array.isArray(value) ? value.map(ref) : ref(value);
  const nested = (value: NestedPersonRefList): NestedPersonRefList =>
    value.map((el) => (Array.isArray(el) ? el.map(ref) : ref(el)));

  for (const person of clone.people.items) person.id = ref(person.id);
  for (const group of clone.people.groups ?? []) {
    group.id = ref(group.id) as GroupId;
    group.members = group.members.map(ref);
  }

  for (const pref of clone.preferences) {
    switch (pref.type) {
      case "shift request":
        pref.person = refOrList(pref.person);
        break;
      case "shift type successions":
        pref.person = refOrList(pref.person);
        break;
      case "shift count":
        pref.person = refOrList(pref.person);
        break;
      case "shift type requirement":
        if (pref.qualifiedPeople !== undefined)
          pref.qualifiedPeople = refOrList(pref.qualifiedPeople);
        break;
      case "shift affinity":
        pref.people1 = nested(pref.people1);
        pref.people2 = nested(pref.people2);
        break;
      case "shift type covering":
        pref.preceptors = nested(pref.preceptors);
        pref.preceptees = nested(pref.preceptees);
        break;
    }
  }

  if (clone.export) {
    for (const rule of clone.export.formatting ?? []) {
      if (rule.type === "row" || rule.type === "people header" || rule.type === "history") {
        rule.people = rule.people.map(ref);
      } else if (rule.type === "cell") {
        rule.people = rule.people.map(ref);
      }
    }
    for (const row of clone.export.extraRows ?? []) row.countPeople = row.countPeople.map(ref);
  }

  return clone;
}

// ---------------------------------------------------------------------------
// Scatter transform (T17a-3, FR-SL-37/38, V16–V20) — developer-only.
//
// A second, orthogonal anonymize step: it hides the *shape* of a person's real
// availability by moving their concrete-date shift requests to other dates in
// the same category (WORKDAY vs NON-WORKDAY), preserving per-person category
// counts AND consecutive-run lengths. It is a separate pure transform (its own
// clone) from `anonymizeDocument`; the panel (T17.5) runs it before the id
// rewrite. Only single-person, single-shift-type concrete-date `shift request`
// preferences move — group/keyword/multi-selector requests are left as written.
// ---------------------------------------------------------------------------

/** The preferred workday / non-workday category date-group ids for scatter. */
const WORKDAY_DATE_GROUP_ID: GroupId = "WORKDAY";
const NON_WORKDAY_DATE_GROUP_ID: GroupId = "NON-WORKDAY";
/** The auto-derived weekday/weekend category ids used when either preferred group is absent. */
const WEEKDAY_DATE_GROUP_ID: GroupId = "WEEKDAY";
const WEEKEND_DATE_GROUP_ID: GroupId = "WEEKEND";

/** A pseudo-random source in `[0, 1)`; injected so tests are deterministic. */
export type Rng = () => number;

const asArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

/**
 * FR-SL-38 / V20 — report which of the preferred WORKDAY / NON-WORKDAY date
 * groups are absent, so the panel can show a non-blocking fallback warning.
 * Returning either means scatter will classify dates via WEEKDAY / WEEKEND
 * instead. This is a *warning* helper — it never throws.
 */
export function getMissingPreferredScatterDateGroups(
  dateGroups: readonly CanonicalDateGroup[],
): GroupId[] {
  const present = new Set(dateGroups.map((group) => group.id));
  return [WORKDAY_DATE_GROUP_ID, NON_WORKDAY_DATE_GROUP_ID].filter((id) => !present.has(id));
}

/** A UTC weekend day (Saturday / Sunday). */
function isWeekendIso(iso: IsoDate): boolean {
  const dow = utcDayOfWeek(iso);
  return dow === 0 || dow === 6;
}

/**
 * Map every in-range date to exactly one of two mutually-exclusive categories.
 * WORKDAY / NON-WORKDAY groups are preferred; if either is missing (FR-SL-38)
 * the whole calendar is classified via auto-derived WEEKDAY / WEEKEND instead.
 * Throws V17 for any date that is not in exactly one category — that ambiguity
 * would make preserving category counts impossible.
 */
function buildDateCategories(
  isoDates: readonly IsoDate[],
  dateGroups: readonly CanonicalDateGroup[],
): Map<IsoDate, GroupId> {
  const usePreferred = getMissingPreferredScatterDateGroups(dateGroups).length === 0;
  const [firstCategoryId, secondCategoryId] = usePreferred
    ? [WORKDAY_DATE_GROUP_ID, NON_WORKDAY_DATE_GROUP_ID]
    : [WEEKDAY_DATE_GROUP_ID, WEEKEND_DATE_GROUP_ID];

  const membersOf = (id: GroupId): Set<string> =>
    new Set((dateGroups.find((group) => group.id === id)?.members ?? []).map(String));
  const firstCategory = usePreferred
    ? membersOf(WORKDAY_DATE_GROUP_ID)
    : new Set(isoDates.filter((iso) => !isWeekendIso(iso)));
  const secondCategory = usePreferred
    ? membersOf(NON_WORKDAY_DATE_GROUP_ID)
    : new Set(isoDates.filter((iso) => isWeekendIso(iso)));

  const categories = new Map<IsoDate, GroupId>();
  for (const iso of isoDates) {
    const inFirst = firstCategory.has(iso);
    const inSecond = secondCategory.has(iso);
    // Membership must be exclusive: a date in both (or neither) cannot be moved
    // while keeping category counts stable.
    if (inFirst === inSecond) {
      throw new Error(
        `Date "${iso}" must belong to exactly one of ${firstCategoryId} or ${secondCategoryId}.`,
      );
    }
    categories.set(iso, inFirst ? firstCategoryId : secondCategoryId);
  }
  return categories;
}

/** A shuffled copy (Fisher–Yates) using the injected RNG — never mutates `values`. */
function shuffled<T>(values: readonly T[], rng: Rng): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

/** Group sorted occupied date indexes into maximal runs of consecutive positions. */
function findOccupiedRuns(occupiedIndexes: Set<number>): number[][] {
  const runs: number[][] = [];
  [...occupiedIndexes]
    .sort((a, b) => a - b)
    .forEach((index) => {
      const lastRun = runs[runs.length - 1];
      // Extend the current run when this date immediately follows it, else start
      // a new independently movable block.
      if (lastRun && lastRun[lastRun.length - 1] === index - 1) {
        lastRun.push(index);
      } else {
        runs.push([index]);
      }
    });
  return runs;
}

/**
 * Move one person's concrete-date requests, in place, onto new destination slots
 * with identical category (WORKDAY/NON-WORKDAY) totals, run-for-run. Mutates the
 * passed request objects (which belong to the already-cloned document). Throws
 * V18 when a run has no non-overlapping destination.
 */
function movePersonRequests(
  requests: CanonicalShiftRequestPreference[],
  isoDates: readonly IsoDate[],
  dateCategories: Map<IsoDate, GroupId>,
  rng: Rng,
): void {
  const indexByIso = new Map(isoDates.map((iso, index) => [iso, index]));
  // Several request records may target the same date; a Set collapses them so
  // each occupied date moves exactly once.
  const occupiedIndexes = new Set<number>(
    requests.flatMap((request) =>
      asArray(request.date).map((dateId) => indexByIso.get(String(dateId))!),
    ),
  );
  // Randomize block order so early calendar runs do not always get first pick.
  const runs = shuffled(findOccupiedRuns(occupiedIndexes), rng);
  // Newly chosen destinations. Source positions are deliberately left free so
  // runs can move into one another's old slots.
  const allocatedIndexes = new Set<number>();
  const movedDateByOriginalDate = new Map<string, string>();

  runs.forEach((run) => {
    // Count categories over the whole run. Their order may flip after moving,
    // e.g. [WORKDAY, NON-WORKDAY] → [NON-WORKDAY, WORKDAY].
    const categoryCounts = new Map<GroupId, number>();
    run.forEach((index) => {
      const category = dateCategories.get(isoDates[index])!;
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    });

    const candidateStarts = isoDates
      .map((_, index) => index)
      // Exclude starts where the run would overrun the calendar end.
      .filter((start) => start + run.length <= isoDates.length)
      .filter((start) => {
        const candidateCategoryCounts = new Map<GroupId, number>();
        for (let offset = 0; offset < run.length; offset += 1) {
          // A previously placed run already owns this slot.
          if (allocatedIndexes.has(start + offset)) return false;
          const category = dateCategories.get(isoDates[start + offset])!;
          candidateCategoryCounts.set(category, (candidateCategoryCounts.get(category) ?? 0) + 1);
        }
        // Keep only destinations with identical per-category totals.
        return [...categoryCounts].every(
          ([category, count]) => candidateCategoryCounts.get(category) === count,
        );
      });
    // Prefer an actual move; fall back to the original slot only if nothing else fits.
    const alternativeStarts = candidateStarts.filter((start) => start !== run[0]);
    const startsToChooseFrom = alternativeStarts.length > 0 ? alternativeStarts : candidateStarts;
    const targetStart = shuffled(startsToChooseFrom, rng)[0];
    if (targetStart === undefined) {
      throw new Error("Unable to scatter shift requests without overlapping consecutive runs.");
    }

    run.forEach((originalIndex, offset) => {
      allocatedIndexes.add(targetStart + offset);
      movedDateByOriginalDate.set(isoDates[originalIndex], isoDates[targetStart + offset]);
    });
  });

  requests.forEach((request) => {
    const moved = asArray(request.date)
      .map((dateId) => movedDateByOriginalDate.get(String(dateId)) ?? String(dateId))
      .sort((a, b) => indexByIso.get(a)! - indexByIso.get(b)!);
    // Preserve the original scalar-vs-array container shape.
    request.date = Array.isArray(request.date) ? moved : (moved[0] as DateRef);
  });
}

/**
 * FR-SL-37 / V16–V18 — scatter the concrete-date `shift request` preferences of a
 * canonical document, returning a NEW document (the input is deep-cloned first
 * and never mutated, so a throw leaves the caller's document untouched).
 *
 * Only single-person, single-shift-type requests whose person is a concrete
 * people item and whose dates are all concrete in-range dates move; group /
 * keyword / multi-selector requests are left as written. Each person is
 * scattered independently, preserving their WORKDAY / NON-WORKDAY counts and
 * consecutive-run lengths.
 *
 * Throws (all surfaced by the panel's alert wrapper, FR-SL-35 V19):
 *  - V16 — a `shift request` with more than one person or shift type.
 *  - V17 — a date not in exactly one category.
 *  - V18 — no non-overlapping destination for a run.
 *
 * @param rng injected `[0,1)` source (defaults to `Math.random`, which is not
 *   available in every execution context — inject it in tests and workers).
 */
export function scatterShiftRequests(
  doc: CanonicalScenarioDocument,
  rng: Rng = Math.random,
): CanonicalScenarioDocument {
  const clone = structuredClone(doc);

  const isoDates = generateDateItems({
    start: clone.dates.range.startDate,
    end: clone.dates.range.endDate,
  }).map((item) => item.iso);
  // V17 first (matching the parity reference): every in-range date must classify.
  const dateCategories = buildDateCategories(isoDates, clone.dates.groups ?? []);

  const inRangeDates = new Set(isoDates);
  const peopleItemIds = new Set(clone.people.items.map((item) => String(item.id)));

  // Group each person's movable requests so each person scatters independently.
  const movableByPerson = new Map<string, CanonicalShiftRequestPreference[]>();
  for (const pref of clone.preferences) {
    if (pref.type !== "shift request") continue;
    // V16 fires for *every* shift request, before concrete-item filtering, so an
    // un-scatterable multi-selector request still aborts the whole transform.
    if (asArray(pref.person).length !== 1 || asArray(pref.shiftType).length !== 1) {
      throw new Error(
        "Cannot scatter shift requests with multiple people or multiple shift types.",
      );
    }

    const personId = String(asArray(pref.person)[0]);
    const dates = asArray(pref.date);
    // Only scatter one concrete person over concrete in-range dates. Leave group
    // requests such as ALL, WORKDAY, or a people team exactly as written.
    if (peopleItemIds.has(personId) && dates.every((dateId) => inRangeDates.has(String(dateId)))) {
      const requests = movableByPerson.get(personId) ?? [];
      requests.push(pref);
      movableByPerson.set(personId, requests);
    }
  }

  for (const requests of movableByPerson.values()) {
    movePersonRequests(requests, isoDates, dateCategories, rng);
  }

  return clone;
}
