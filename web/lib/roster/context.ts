// Deriving the viewer context from the immutable submission (F3).
//
// `context` is a CACHE, and this module is its definition: everything in it is
// rebuilt from `submission.canonicalYaml` + `submission.reverseMap` and nothing
// else. There is no fallback data anywhere — a field the submission does not fix
// comes back absent (an optional canonical field), `unavailable` (a shift with no
// unique simple baseline), or `null` (`leaveCreditMinutes`). Nothing is invented.
//
// Selector semantics are NOT re-implemented here. Weekend/holiday membership and
// the baseline requirement match resolve through the shared, backend-faithful,
// fail-closed resolver (`scenario/leave-guard/resolution`), so a scenario the
// solver read one way can never be read another way by the viewer.

import {
  buildScenarioResolutionContext,
  canonicalizeScenarioDocument,
  parseScenarioYaml,
  producerScenarioSchema,
  PREFERENCE_TYPE,
  RESERVED_SHIFT_TYPE,
  isReservedShiftTypeSelector,
  type CanonicalScenarioDocument,
  type CanonicalShiftTypeRequirementPreference,
  type PersonId,
  type ReverseMapTuple,
} from "@/lib/scenario";
import { generateDateItems, utcDayOfWeek } from "@/lib/dates";
import { SINGAPORE_PH_GROUP_ID } from "@/lib/dates";
import { isTypedId, typedIdKey } from "./day-state";
import type {
  RosterBaselineMinimum,
  RosterCalendarDay,
  RosterContext,
  RosterContextPerson,
  RosterContextShiftType,
  RosterSubmission,
} from "./types";

/** Three-letter weekday labels indexed by UTC day-of-week (0 = Sunday). */
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Minutes per half-hour grid step — the `hoursContract` coefficient unit. */
const MINUTES_PER_HALF_HOUR = 30;

/** A derived context, or the specific reason the submission could not produce one. */
export type DeriveContextResult =
  | { ok: true; context: RosterContext; document: CanonicalScenarioDocument }
  | { ok: false; reason: string };

/**
 * Parse the exact submitted YAML back into its canonical document. The submission
 * is the strict producer document the backend accepted, so it is validated with
 * the same strict producer schema rather than the lenient import path — a
 * submission that no longer parses strictly is a corrupt document, not something
 * to be leniently coerced.
 */
export function parseSubmissionDocument(
  canonicalYaml: string,
): { ok: true; document: CanonicalScenarioDocument } | { ok: false; reason: string } {
  if (typeof canonicalYaml !== "string" || canonicalYaml.length === 0) {
    return { ok: false, reason: "submission.canonicalYaml is empty" };
  }
  let raw: unknown;
  try {
    raw = parseScenarioYaml(canonicalYaml);
  } catch (error) {
    return {
      ok: false,
      reason: `submission.canonicalYaml is not parseable YAML: ${String(error)}`,
    };
  }
  const parsed = producerScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".") ?? "";
    return {
      ok: false,
      reason:
        `submission.canonicalYaml is not a valid canonical scenario` +
        `${path ? ` (${path}: ${first?.message})` : ""}`,
    };
  }
  // Canonicalize so the implicit-all forms the producer normalizes are already
  // explicit `ALL` before the baseline rule reads them.
  return {
    ok: true,
    document: canonicalizeScenarioDocument(parsed.data as CanonicalScenarioDocument),
  };
}

/**
 * De-anonymize the submitted people axis. An empty reverse map means the
 * submission was plain and its ids are already real. A non-empty map must cover
 * EVERY submitted person id exactly — a partial map would silently leave a `P#`
 * placeholder in a shared file where a real nurse name belongs.
 */
function deanonymizePeople(
  document: CanonicalScenarioDocument,
  reverseMap: readonly ReverseMapTuple[],
): { ok: true; people: RosterContextPerson[] } | { ok: false; reason: string } {
  const items = document.people.items;
  const people: RosterContextPerson[] = [];

  if (reverseMap.length === 0) {
    for (const item of items) {
      if (!isTypedId(item.id)) {
        return {
          ok: false,
          reason: `submitted person id ${String(item.id)} is not a usable typed id`,
        };
      }
      people.push(pickPerson(item.id, item));
    }
    return { ok: true, people };
  }

  if (reverseMap.length !== items.length) {
    return {
      ok: false,
      reason: `submission.reverseMap covers ${reverseMap.length} people for ${items.length} submitted people`,
    };
  }
  const originalById = new Map<string, PersonId>();
  for (const [anonymizedId, originalId] of reverseMap) {
    originalById.set(anonymizedId, originalId);
  }
  for (const item of items) {
    // Anonymized ids are always strings (`P#`), so a numeric submitted id here
    // means the map does not describe this document.
    const anonymized = typeof item.id === "string" ? item.id : null;
    const original = anonymized === null ? undefined : originalById.get(anonymized);
    if (original === undefined) {
      return {
        ok: false,
        reason: `submission.reverseMap has no entry for submitted person id ${String(item.id)}`,
      };
    }
    if (!isTypedId(original)) {
      return {
        ok: false,
        reason: `submission.reverseMap maps ${String(item.id)} to an unusable id`,
      };
    }
    people.push(pickPerson(original, item));
  }
  return { ok: true, people };
}

/** Copy only the REAL canonical person fields; never invent `name`/`role`. */
function pickPerson(
  id: PersonId,
  item: { description?: string; history?: readonly string[] },
): RosterContextPerson {
  // Built as a mutable draft and widened on return: the public type is deeply
  // readonly, so optional fields cannot be assigned after construction.
  const draft: { id: PersonId; description?: string; history?: string[] } = { id };
  if (item.description !== undefined) draft.description = item.description;
  if (item.history !== undefined) draft.history = [...item.history];
  return draft;
}

/** Copy only the REAL canonical shift-type fields. */
function pickShiftType(
  item: CanonicalScenarioDocument["shiftTypes"]["items"][number],
): RosterContextShiftType {
  const draft: {
    id: RosterContextShiftType["id"];
    description?: string;
    durationMinutes?: number;
    startTime?: string;
    endTime?: string;
    restMinutes?: number;
  } = { id: item.id };
  if (item.description !== undefined) draft.description = item.description;
  if (item.durationMinutes !== undefined) draft.durationMinutes = item.durationMinutes;
  if (item.startTime !== undefined) draft.startTime = item.startTime;
  if (item.endTime !== undefined) draft.endTime = item.endTime;
  if (item.restMinutes !== undefined) draft.restMinutes = item.restMinutes;
  return draft;
}

/**
 * Build the calendar axis by expanding the submitted range, then marking each day
 * from the submission's OWN selectors: `weekend` from the backend `WEEKEND`
 * keyword, `holiday` from the submission's `PH` date group. A submission carrying
 * no `PH` group asserts no public holidays — no external holiday dataset is
 * consulted, because a shared file must render identically for every recipient
 * regardless of which dataset their build happens to ship.
 */
function buildCalendar(document: CanonicalScenarioDocument): RosterCalendarDay[] {
  const { startDate, endDate } = document.dates.range;
  const items = generateDateItems({ start: startDate, end: endDate });
  const resolver = buildScenarioResolutionContext({
    staff: document.people.items,
    staffGroups: document.people.groups ?? [],
    shifts: document.shiftTypes.items,
    shiftGroups: document.shiftTypes.groups ?? [],
    rangeStart: startDate,
    rangeEnd: endDate,
    dateGroups: document.dates.groups ?? [],
  });

  const weekend = resolver.resolveDates("WEEKEND");
  const holidays = resolver.resolveDates(SINGAPORE_PH_GROUP_ID);

  return items.map((item, dateIdx) => ({
    iso: item.iso,
    weekday: WEEKDAY_LABELS[utcDayOfWeek(item.iso)],
    weekend: weekend.resolved ? weekend.values.has(dateIdx) : false,
    holiday: holidays.resolved ? holidays.values.has(dateIdx) : false,
  }));
}

/**
 * Whether a requirement's optional scope field is UNSCOPED under the frozen
 * baseline rule: absent, or exactly the scalar `ALL`. The canonical serializer
 * emits scalar `ALL` for the ordinary full-range/unqualified case, so this accepts
 * exactly what a producer document actually contains — and deliberately rejects
 * arrays, groups, and every other selector, however all-covering they may happen
 * to be. The rule has to be decidable without re-deriving coverage semantics.
 */
function isUnscoped(value: unknown): boolean {
  return value === undefined || value === RESERVED_SHIFT_TYPE.all;
}

/**
 * Compute the per-shift baseline minimums.
 *
 * A requirement R is the baseline for shift S iff ALL of:
 *   • `R.shiftType` is a plain scalar selector — not a list/nested list, not a
 *     reserved keyword, not a shift-type GROUP id — that resolves to exactly S;
 *   • `R.date` is unscoped (absent or scalar `ALL`);
 *   • `R.qualifiedPeople` is unscoped (absent or scalar `ALL`);
 *   • `R.shiftTypeCoefficients` is absent (a non-default coefficient changes what
 *     is being counted, so the number would not be a headcount minimum).
 *
 * Zero or more than one eligible requirement leaves S explicitly `unavailable`.
 * `preferredNumPeople`/`weight` never affect the minimum.
 */
function buildBaselineMinimums(document: CanonicalScenarioDocument): RosterBaselineMinimum[] {
  const items = document.shiftTypes.items;
  const groupIds = new Set((document.shiftTypes.groups ?? []).map((group) => group.id));
  const resolver = buildScenarioResolutionContext({
    staff: document.people.items,
    staffGroups: document.people.groups ?? [],
    shifts: items,
    shiftGroups: document.shiftTypes.groups ?? [],
    rangeStart: document.dates.range.startDate,
    rangeEnd: document.dates.range.endDate,
    dateGroups: document.dates.groups ?? [],
  });

  // shift-type item index -> the eligible requirements found for it.
  const eligible = items.map<{ required: number; source: string }[]>(() => []);

  document.preferences.forEach((preference, preferenceIndex) => {
    if (preference.type !== PREFERENCE_TYPE.shiftTypeRequirement) return;
    const requirement = preference as CanonicalShiftTypeRequirementPreference;
    if (Array.isArray(requirement.shiftType)) return;
    const selector = requirement.shiftType;
    if (typeof selector !== "string" || isReservedShiftTypeSelector(selector)) return;
    if (groupIds.has(selector)) return;
    if (requirement.shiftTypeCoefficients !== undefined) return;
    if (!isUnscoped(requirement.date)) return;
    if (!isUnscoped(requirement.qualifiedPeople)) return;
    if (!Number.isSafeInteger(requirement.requiredNumPeople)) return;

    const resolved = resolver.resolveShiftTypes(selector);
    if (!resolved.resolved || resolved.values.size !== 1) return;
    const [shiftIndex] = [...resolved.values];
    if (shiftIndex < 0 || shiftIndex >= items.length) return;
    eligible[shiftIndex].push({
      required: requirement.requiredNumPeople,
      source: `preferences[${preferenceIndex}]`,
    });
  });

  return items.map((item, index) => {
    const matches = eligible[index];
    if (matches.length !== 1) return { shiftId: item.id, unavailable: true };
    return { shiftId: item.id, required: matches[0].required, source: matches[0].source };
  });
}

/**
 * The paid-leave credit the submission fixes, in minutes.
 *
 * Leave credit is only well-defined where the submission states it: the `LEAVE`
 * coefficient of a contracted-hours shift count, whose unit is fixed to half-hours
 * (`hoursContract.unit`). One distinct value across every contracted-hours count
 * yields that value; zero contracted-hours counts, or two counts that disagree,
 * yield `null` — not a default.
 */
function deriveLeaveCreditMinutes(document: CanonicalScenarioDocument): number | null {
  const halfHours = new Set<number>();
  for (const preference of document.preferences) {
    if (preference.type !== PREFERENCE_TYPE.shiftCount) continue;
    if (preference.hoursContract === undefined) continue;
    for (const [selector, coefficient] of preference.countShiftTypeCoefficients ?? []) {
      if (selector !== RESERVED_SHIFT_TYPE.leave) continue;
      if (!Number.isSafeInteger(coefficient) || coefficient < 0) return null;
      halfHours.add(coefficient);
    }
  }
  if (halfHours.size !== 1) return null;
  const [credit] = [...halfHours];
  return credit * MINUTES_PER_HALF_HOUR;
}

/**
 * Derive the whole viewer context from a submission. Fails closed with a specific
 * reason; there is no partially-derived context.
 */
export function deriveRosterContext(
  submission: Pick<RosterSubmission, "canonicalYaml" | "reverseMap">,
): DeriveContextResult {
  const parsed = parseSubmissionDocument(submission.canonicalYaml);
  if (!parsed.ok) return parsed;
  const document = parsed.document;

  const people = deanonymizePeople(document, submission.reverseMap);
  if (!people.ok) return people;
  if (people.people.length === 0) {
    return { ok: false, reason: "the submission has no people" };
  }

  const seenPeople = new Set<string>();
  for (const person of people.people) {
    const key = typedIdKey(person.id);
    if (seenPeople.has(key)) {
      return { ok: false, reason: `duplicate person id ${String(person.id)} on the roster axis` };
    }
    seenPeople.add(key);
  }

  const shiftTypes = document.shiftTypes.items.map(pickShiftType);
  const seenShifts = new Set<string>();
  for (const shiftType of shiftTypes) {
    if (!isTypedId(shiftType.id)) {
      return {
        ok: false,
        reason: `shift type id ${String(shiftType.id)} is not a usable typed id`,
      };
    }
    const key = typedIdKey(shiftType.id);
    if (seenShifts.has(key)) {
      return { ok: false, reason: `duplicate shift type id ${String(shiftType.id)}` };
    }
    seenShifts.add(key);
  }

  const calendar = buildCalendar(document);
  if (calendar.length === 0) {
    return { ok: false, reason: "the submission has no dates" };
  }

  return {
    ok: true,
    document,
    context: {
      people: people.people,
      shiftTypes,
      calendar,
      baselineMinimums: buildBaselineMinimums(document),
      leaveCreditMinutes: deriveLeaveCreditMinutes(document),
    },
  };
}
