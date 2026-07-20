// Total, ordered C3 selector resolution for the uncredited-leave guard (qq0.23a,
// tech-plan §1). This is the zero-side-effect scenario-domain layer every qq0.23
// consumer resolves people/date/shift selectors through.
//
// It is a faithful TypeScript port of the vendored backend's context construction
// (core/nurse_scheduling/scheduler.py) and `utils.parse_dates`/`parse_pids`, plus
// the shared shift-type map helper. Two invariants are load-bearing:
//
//   • Identity is preserved. People and shift maps are keyed by the RAW typed id
//     (a `Map`, not a stringified object), so numeric `1` and string `"1"` remain
//     distinct exactly as `ctx.map_pid_p` / `map_sid_s` keep them distinct. The
//     `String(...)` coercion the backend applies lives ONLY inside date parsing
//     (`utils.parse_dates`), never in the people/shift path.
//   • Results are total and fail-closed. Every resolver returns a binary
//     `Resolution<T>`; there is never a partial value. If a domain map cannot be
//     built (a missing/forward/cyclic group member, an invalid range), that whole
//     domain resolves `{ resolved: false }` for every dependent selector. If a
//     single selector is malformed/unknown in an otherwise-valid domain, only
//     that selector is unresolved. The guard never guesses.

import {
  RESERVED_SHIFT_TYPE,
  type PersonRef,
  type ShiftTypeGroupMember,
  type DateGroupMember,
  type DateRef,
  type IsoDate,
  type UiPerson,
  type UiPeopleGroup,
  type UiShiftType,
  type UiShiftTypeGroup,
  type UiDateGroup,
} from "../types";
import {
  buildShiftTypeIndexMap,
  expandShiftTypeSelector,
  type ShiftTypeMapKey,
} from "../schemas/shift-type-map";
import { hasCompleteRange, isValidIso, isoToUtcMs, utcDayOfWeek } from "@/lib/dates/date-id";

/**
 * The deliberately binary result of every resolver. A resolved selector carries
 * its backend-equivalent index set (people/date/shift-type indices, NOT display
 * strings); an unresolved selector carries no values at all — a partial answer is
 * never evidence of overlap (tech-plan §1).
 */
export type Resolution<T> = { resolved: true; values: ReadonlySet<T> } | { resolved: false };

/** A raw typed map key (person or shift-type id) — a number or a string, kept as-is. */
export type TypedMapKey = number | string;

/**
 * One ordered, lossless map-entry observation. Unlike a JSON object keyed by
 * `String(k)`, this preserves the original key TYPE and value, so numeric `1` and
 * string `"1"` produce two distinct records. This is the transport the lossless
 * differential oracle compares against (tech-plan §1 "Lossless differential-oracle
 * boundary").
 */
export interface TypedKeyRecord {
  keyType: "number" | "string";
  key: TypedMapKey;
  indices: readonly number[];
}

/** The `ALL` selector keyword (core/nurse_scheduling/constants.py `ALL`). */
const ALL = RESERVED_SHIFT_TYPE.all;

// C3 date keywords in backend insertion order (constants.py
// `MAP_DATE_KEYWORD_TO_FILTER` — `ALL`/`WEEKDAY`/`WEEKEND` — then
// `MAP_WEEKDAY_TO_STR`). `WEEKDAY`/`WEEKEND` and the weekday names are computed
// against Python's `date.weekday()` convention (Monday = 0 … Sunday = 6), which
// `pyWeekday` derives from the UTC day-of-week.
const WEEKDAY_NAMES = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;

const DAY_MS = 86_400_000;

/** Python `date.weekday()` (Mon = 0 … Sun = 6) for an ISO date. */
function pyWeekday(iso: IsoDate): number {
  // `utcDayOfWeek` is JS convention (Sun = 0 … Sat = 6); shift so Monday is 0.
  return (utcDayOfWeek(iso) + 6) % 7;
}

/** Normalize a scalar-or-list selector to an array, mirroring `utils.ensure_list`. */
function ensureList<T>(value: T | readonly T[]): readonly T[] {
  return Array.isArray(value) ? value : [value as T];
}

function sortedUnique(indices: Iterable<number>): number[] {
  return [...new Set(indices)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// People map + resolver — mirrors scheduler.py `ctx.map_pid_p` construction.
// ---------------------------------------------------------------------------

/** Raised when people-map construction fails (missing/forward/cyclic member). */
export class PeopleMapError extends Error {}

/**
 * Build the ordered person-id → `[indices]` map, exactly in scheduler order:
 * each person item's RAW typed id at its item index, then `ALL` over every index,
 * then people groups in declaration order resolving through the map built so far
 * (so a forward reference / cycle / unknown member fails immediately). Numeric `1`
 * and string `"1"` stay distinct `Map` keys, matching `ctx.map_pid_p`. An empty
 * group resolves to an empty set (matching the backend `set().union(*[])`).
 */
export function buildPeopleIndexMap(
  staff: readonly Pick<UiPerson, "id">[],
  groups: readonly Pick<UiPeopleGroup, "id" | "members">[] = [],
): Map<TypedMapKey, number[]> {
  const map = new Map<TypedMapKey, number[]>();
  const nPeople = staff.length;
  for (let p = 0; p < nPeople; p++) {
    map.set(staff[p].id, [p]);
  }
  map.set(
    ALL,
    Array.from({ length: nPeople }, (_, i) => i),
  );
  for (const group of groups) {
    const indices = new Set<number>();
    for (const member of group.members) {
      if (!map.has(member)) {
        throw new PeopleMapError(
          `People group ${quote(group.id)} references undefined person or group ID ` +
            `${quote(member)} (forward reference, cycle, or unknown id).`,
        );
      }
      for (const index of map.get(member)!) indices.add(index);
    }
    map.set(group.id, sortedUnique(indices));
  }
  return map;
}

/**
 * Resolve a person selector through a prebuilt people map, mirroring
 * `utils.parse_pids`: every raw typed key is looked up, the whole selector fails
 * on the first missing key, and otherwise the sorted union of indices is returned.
 */
export function resolvePeopleSelector(
  map: Map<TypedMapKey, number[]>,
  selector: PersonRef | readonly PersonRef[],
): Resolution<number> {
  return resolveViaExactMap(map, ensureList(selector));
}

// ---------------------------------------------------------------------------
// Shift-type resolver — reuses the shared ordered shift-type map helper.
// ---------------------------------------------------------------------------

/**
 * Resolve a shift-type selector through a prebuilt shift-type map (built by the
 * shared `buildShiftTypeIndexMap`). Each raw key is looked up and unioned; any
 * unknown selector makes the whole selector unresolved. Reserved `OFF`/`LEAVE`
 * sentinels and `ALL`/group expansion are already encoded in the map, so a group
 * containing `LEAVE` resolves to a set that includes the leave sentinel.
 */
export function resolveShiftTypeSelector(
  map: Map<ShiftTypeMapKey, number[]>,
  selector: ShiftTypeGroupMember | readonly ShiftTypeGroupMember[],
): Resolution<number> {
  const tokens = ensureList(selector);
  const values = new Set<number>();
  for (const token of tokens) {
    const indices = expandShiftTypeSelector(token, map);
    if (indices == null) return { resolved: false };
    for (const index of indices) values.add(index);
  }
  return { resolved: true, values: new Set(sortedUnique(values)) };
}

/** Shared raw-map lookup for people (shift types use the helper's own lookup). */
function resolveViaExactMap(
  map: Map<TypedMapKey, number[]>,
  tokens: readonly TypedMapKey[],
): Resolution<number> {
  const values = new Set<number>();
  for (const token of tokens) {
    const indices = map.get(token);
    if (indices === undefined) return { resolved: false };
    for (const index of indices) values.add(index);
  }
  return { resolved: true, values: new Set(sortedUnique(values)) };
}

// ---------------------------------------------------------------------------
// Date map, parser, and resolver — mirrors scheduler.py `ctx.map_did_d`
// construction plus `utils.parse_dates` / `_parse_single_date`.
// ---------------------------------------------------------------------------

/** Raised when date-map construction fails (invalid range, bad group member). */
export class DateMapError extends Error {}

/**
 * Build the ordered date-string → `[day index]` map, mirroring scheduler.py:
 *
 *  1. Enumerate each inclusive calendar date to its zero-based day index and
 *     insert its ISO spelling.
 *  2. Insert the C3 date-filter keywords (`ALL`/`WEEKDAY`/`WEEKEND`) then the
 *     weekday-name keywords, in backend order.
 *  3. Process date groups in declaration order. For each raw member, try a direct
 *     map lookup FIRST (against the map built so far); only on a miss parse it
 *     through the scalar date algorithm. Union/dedupe/sort, then insert the group
 *     id — a group id equal to an existing key overwrites it, as the backend dict
 *     does, and a later group may reference only an already-built group.
 *
 * Any invalid range, malformed member, or out-of-range produced date throws — the
 * caller then treats the whole date domain as unresolved. There is no best-effort
 * subset.
 */
export function buildDateIndexMap(
  rangeStart: IsoDate,
  rangeEnd: IsoDate,
  groups: readonly Pick<UiDateGroup, "id" | "members">[] = [],
): Map<string, number[]> {
  if (!hasCompleteRange({ start: rangeStart, end: rangeEnd })) {
    throw new DateMapError(
      `Invalid date range: start ${quote(rangeStart)}, end ${quote(rangeEnd)}.`,
    );
  }
  if (!isPythonSupportedIsoYear(rangeStart) || !isPythonSupportedIsoYear(rangeEnd)) {
    // JavaScript accepts ISO year `0000` as a real calendar date, but Python's
    // `datetime.date` has no year zero (MINYEAR is 1), so the backend oracle
    // cannot build this domain. Reject it here so both sides fail closed instead
    // of diverging at the year boundary (qq0.23a fixup, closure-review P1).
    throw new DateMapError(
      `Date range year is not a Python-supported calendar year (0001-9999): ` +
        `start ${quote(rangeStart)}, end ${quote(rangeEnd)}.`,
    );
  }
  const map = new Map<string, number[]>();
  const startMs = isoToUtcMs(rangeStart);
  const endMs = isoToUtcMs(rangeEnd);
  const nDays = Math.round((endMs - startMs) / DAY_MS) + 1;
  const isoByIndex: IsoDate[] = [];
  for (let d = 0; d < nDays; d++) {
    const iso = isoFromOffset(startMs, d);
    isoByIndex.push(iso);
    map.set(iso, [d]);
  }
  // Date-filter keywords, in `MAP_DATE_KEYWORD_TO_FILTER` order.
  map.set(
    ALL,
    Array.from({ length: nDays }, (_, i) => i),
  );
  map.set(
    "WEEKDAY",
    isoByIndex.flatMap((iso, d) => (pyWeekday(iso) < 5 ? [d] : [])),
  );
  map.set(
    "WEEKEND",
    isoByIndex.flatMap((iso, d) => (pyWeekday(iso) >= 5 ? [d] : [])),
  );
  // Weekday-name keywords: keyword index is the Python `date.weekday()` value.
  for (let w = 0; w < WEEKDAY_NAMES.length; w++) {
    map.set(
      WEEKDAY_NAMES[w],
      isoByIndex.flatMap((iso, d) => (pyWeekday(iso) === w ? [d] : [])),
    );
  }
  // Date groups, in declaration order (direct-lookup-then-parse per member).
  for (const group of groups) {
    const indices = new Set<number>();
    for (const member of group.members) {
      if (map.has(member as string)) {
        // Direct hit against the map built so far — a keyword, an ISO date, or an
        // earlier group id. A numeric member never matches a string key (matching
        // the backend `member in ctx.map_did_d`), so it falls through to parsing.
        for (const index of map.get(member as string)!) indices.add(index);
      } else {
        for (const index of parseDateTokens([member], map, rangeStart, rangeEnd)) {
          indices.add(index);
        }
      }
    }
    map.set(group.id, sortedUnique(indices));
  }
  return map;
}

/**
 * Resolve a date selector through a prebuilt (fully constructed) date map,
 * mirroring `utils.parse_dates`. Each supplied reference is stringified first
 * (the backend's intentional `str(...)` boundary), then resolved by direct map
 * lookup, `start~end` range parsing, or a single C3 literal — with the backend's
 * out-of-range and reversed-range behavior. Any malformed or out-of-range token
 * makes the whole selector unresolved.
 */
export function resolveDateSelector(
  map: Map<string, number[]>,
  rangeStart: IsoDate,
  rangeEnd: IsoDate,
  selector: DateRef | readonly DateRef[],
): Resolution<number> {
  try {
    const indices = parseDateTokens(ensureList(selector), map, rangeStart, rangeEnd);
    return { resolved: true, values: new Set(indices) };
  } catch {
    return { resolved: false };
  }
}

/**
 * The core `utils.parse_dates` algorithm over already-stringified tokens: direct
 * map lookup, else `start~end` range, else a single date literal — accumulating
 * day indices, range-checking every produced date, and returning a sorted unique
 * list. Throws (as the backend raises `ValueError`) on any malformed or
 * out-of-range token.
 */
function parseDateTokens(
  refs: readonly DateGroupMember[],
  map: ReadonlyMap<string, number[]>,
  rangeStart: IsoDate,
  rangeEnd: IsoDate,
): number[] {
  const startMs = isoToUtcMs(rangeStart);
  const endMs = isoToUtcMs(rangeEnd);
  const indices: number[] = [];

  const pushChecked = (dateMs: number): void => {
    if (dateMs < startMs || dateMs > endMs) {
      throw new DateMapError(
        `Date '${isoFromOffset(dateMs, 0)}' is out of the range of start date and end date.`,
      );
    }
    indices.push(Math.round((dateMs - startMs) / DAY_MS));
  };

  for (const ref of refs) {
    const token = String(ref);
    const direct = map.get(token);
    if (direct !== undefined) {
      // Direct-hit indices are already valid in-range offsets.
      for (const index of direct) indices.push(index);
      continue;
    }
    const rangeMatch = /^([\d-]+)~([\d-]+)$/.exec(token);
    if (rangeMatch) {
      const rangeStartMs = parseSingleDate(rangeMatch[1], rangeStart, rangeEnd);
      const rangeEndMs = parseSingleDate(rangeMatch[2], rangeStart, rangeEnd);
      // Inclusive; a reversed range yields no dates (empty), matching Python's
      // `range((end - start).days + 1)` with a negative span.
      for (let ms = rangeStartMs; ms <= rangeEndMs; ms += DAY_MS) pushChecked(ms);
      continue;
    }
    pushChecked(parseSingleDate(token, rangeStart, rangeEnd));
  }
  return sortedUnique(indices);
}

/**
 * Parse one date literal to its UTC-midnight milliseconds, mirroring
 * `utils._parse_single_date`. Accepts the backend's day-of-month (`D`), `MM-DD`,
 * and `YYYY-MM-DD` forms, including the same-month restriction for `D` and the
 * same-year restriction for `MM-DD`. Rejects any other shape and any produced
 * date that is not a real calendar date.
 */
function parseSingleDate(token: string, rangeStart: IsoDate, rangeEnd: IsoDate): number {
  const startYear = rangeStart.slice(0, 4);
  const startMonth = rangeStart.slice(5, 7);
  const endYear = rangeEnd.slice(0, 4);
  const endMonth = rangeEnd.slice(5, 7);

  if (/^\d{1,2}$/.test(token)) {
    if (startYear !== endYear || startMonth !== endMonth) {
      throw new DateMapError(
        "Pure day format (D) is not allowed when start date and end date are not in the same month.",
      );
    }
    return isoToMsStrict(`${startYear}-${startMonth}-${token.padStart(2, "0")}`);
  }
  const monthDay = /^(\d{2})-(\d{2})$/.exec(token);
  if (monthDay) {
    if (startYear !== endYear) {
      throw new DateMapError(
        "Pure month-day format (MM-DD) is not allowed when start date and end date are not in the same year.",
      );
    }
    return isoToMsStrict(`${startYear}-${monthDay[1]}-${monthDay[2]}`);
  }
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
  if (full) {
    return isoToMsStrict(`${full[1]}-${full[2]}-${full[3]}`);
  }
  throw new DateMapError(`Date '${token}' is not in the format of YYYY-MM-DD, MM-DD, or D.`);
}

/** UTC ms for an ISO date, rejecting any non-real calendar date (e.g. `02-31`). */
function isoToMsStrict(iso: string): number {
  if (!isValidIso(iso)) {
    throw new DateMapError(`Date '${iso}' is not a valid calendar date.`);
  }
  return isoToUtcMs(iso);
}

/** ISO `YYYY-MM-DD` for `dayOffset` whole days after the UTC-ms `baseMs`. */
function isoFromOffset(baseMs: number, dayOffset: number): IsoDate {
  return new Date(baseMs + dayOffset * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Whether an ISO date's year is one Python's `datetime.date` supports (1–9999).
 * The 4-digit ISO grammar only ever admits `0000` outside that band, and the
 * backend raises constructing `date(0, …)`; rejecting it keeps the resolver total
 * against the real oracle at the year boundary.
 */
function isPythonSupportedIsoYear(iso: IsoDate): boolean {
  return iso.slice(0, 4) !== "0000";
}

// ---------------------------------------------------------------------------
// Prebuilt, fail-closed resolution context — the single object every consumer
// resolves through (tech-plan §1).
// ---------------------------------------------------------------------------

/** The scenario entities a resolution context is built from (keyless-safe). */
export interface ResolutionContextInput {
  staff: readonly Pick<UiPerson, "id">[];
  staffGroups: readonly Pick<UiPeopleGroup, "id" | "members">[];
  shifts: readonly Pick<UiShiftType, "id">[];
  shiftGroups: readonly Pick<UiShiftTypeGroup, "id" | "members">[];
  rangeStart: IsoDate;
  rangeEnd: IsoDate;
  dateGroups: readonly Pick<UiDateGroup, "id" | "members">[];
}

/**
 * A prebuilt, zero-side-effect resolution context. Each domain map is constructed
 * once and fail-closed: if a domain map cannot be built, that domain resolves
 * `{ resolved: false }` for every selector, without recursively repairing groups
 * or using a partial map. The three resolvers expose backend-equivalent indices.
 */
export interface ScenarioResolutionContext {
  resolvePeople(selector: PersonRef | readonly PersonRef[]): Resolution<number>;
  resolveDates(selector: DateRef | readonly DateRef[]): Resolution<number>;
  resolveShiftTypes(
    selector: ShiftTypeGroupMember | readonly ShiftTypeGroupMember[],
  ): Resolution<number>;
}

/**
 * Build the prebuilt resolution context. Each domain is constructed independently
 * and any construction failure marks only that domain unresolved (fail-closed per
 * domain, tech-plan §1). No exception escapes.
 */
export function buildScenarioResolutionContext(
  input: ResolutionContextInput,
): ScenarioResolutionContext {
  const peopleMap = tryBuild(() => buildPeopleIndexMap(input.staff, input.staffGroups));
  const shiftMap = tryBuild(() => buildShiftTypeIndexMap(input.shifts, input.shiftGroups));
  const dateMap = tryBuild(() =>
    buildDateIndexMap(input.rangeStart, input.rangeEnd, input.dateGroups),
  );

  // The three domain maps stay closed over here; only the resolver functions are
  // published, so no consumer can mutate a constructed map (`readonly` protects a
  // reference, not `Map.set`/`delete`/`clear`) and silently alter later results.
  return {
    resolvePeople(selector) {
      if (peopleMap === null) return { resolved: false };
      return resolvePeopleSelector(peopleMap, selector);
    },
    resolveShiftTypes(selector) {
      if (shiftMap === null) return { resolved: false };
      return resolveShiftTypeSelector(shiftMap, selector);
    },
    resolveDates(selector) {
      if (dateMap === null) return { resolved: false };
      return resolveDateSelector(dateMap, input.rangeStart, input.rangeEnd, selector);
    },
  };
}

function tryBuild<T>(build: () => T): T | null {
  try {
    return build();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lossless tagged-record transport (differential-oracle boundary, tech-plan §1).
// ---------------------------------------------------------------------------

/**
 * Project a raw typed map into ordered, lossless key records — one per entry in
 * insertion order, preserving each key's original type and value. This is the
 * TypeScript half of the differential protocol: numeric `1` and string `"1"`
 * become two distinct records rather than colliding under `String(k)`.
 */
export function toTypedKeyRecords(
  map: ReadonlyMap<TypedMapKey, readonly number[]>,
): TypedKeyRecord[] {
  return [...map.entries()].map(([key, indices]) => ({
    keyType: typeof key === "number" ? "number" : "string",
    key,
    indices: [...indices],
  }));
}

function quote(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : String(value);
}
