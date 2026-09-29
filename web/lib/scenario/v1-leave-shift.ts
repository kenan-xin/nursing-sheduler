// v1 "Leave" shift import conversion (nursing-sheduler-objg, audit finding T5).
//
// v1 reserved only ALL and OFF, so a v1 file could define its own worked shift
// type called "Leave" (any case). v2 reserves LEAVE as the paid-leave hard pin,
// so that file fails the producer's reserved-id check. This pure step runs on the
// RAW parsed document, before the lenient import, and plans a conversion:
//
//   - positive-weight shift requests on that shift  -> LEAVE pins
//   - zero / negative-weight ones                    -> dropped (a pin cannot say "avoid")
//   - history entries naming it                      -> the reserved LEAVE history code
//   - the shift type itself                          -> removed
//
// Any other reference (a rule, a shift group, an export count, or a request that
// lists it next to other shifts) treats it as a worked shift, so the plan carries
// those as blockers and the caller must refuse the conversion.

import { inferPreferenceType } from "./import-scenario";
import { PREFERENCE_TYPE, RESERVED_SHIFT_TYPE } from "./types";

export interface V1LeaveShiftPlan {
  /** The shift type id exactly as spelled in the file (e.g. "Leave"). */
  shiftId: string;
  /** Index of the shift type in `shiftTypes.items`, for the issue path. */
  shiftIndex: number;
  /** Positive-weight shift requests that become LEAVE pins. */
  convertedRequests: number;
  /** Zero / negative-weight shift requests that are dropped. */
  droppedRequests: number;
  /** History entries rewritten to LEAVE. */
  historyEntries: number;
  /** References that need it to stay a worked shift; non-empty => refuse conversion. */
  blockers: string[];
  /** The converted raw document (only meaningful when `blockers` is empty). */
  doc: unknown;
}

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/** Whether `value` (a selector, a nested selector tree, or coefficient pairs) names `id`. */
function mentions(value: unknown, id: string): boolean {
  return Array.isArray(value) ? value.some((v) => mentions(v, id)) : value === id;
}

// Fields that hold shift-type references, per preference / export entry.
const SHIFT_FIELDS = [
  "shiftType",
  "shiftTypes",
  "pattern",
  "countShiftTypes",
  "shiftTypeCoefficients",
  "countShiftTypeCoefficients",
];

function label(entry: Rec, kind: string, index: number): string {
  const description = typeof entry.description === "string" ? entry.description : "";
  return description ? `${kind} "${description}"` : `${kind} #${index + 1}`;
}

/**
 * Plan the conversion of a v1 shift type named "Leave" (case-insensitive).
 * Returns `null` when the document has no such shift type. Never mutates `raw`.
 */
export function planV1LeaveShiftConversion(raw: unknown): V1LeaveShiftPlan | null {
  if (!isRec(raw) || !isRec(raw.shiftTypes) || !Array.isArray(raw.shiftTypes.items)) return null;
  const items = raw.shiftTypes.items;
  const shiftIndex = items.findIndex(
    (item) => isRec(item) && String(item.id).toUpperCase() === RESERVED_SHIFT_TYPE.leave,
  );
  if (shiftIndex < 0) return null;
  const shiftId = String((items[shiftIndex] as Rec).id);
  const refers = (entry: Rec) => SHIFT_FIELDS.some((field) => mentions(entry[field], shiftId));

  const blockers: string[] = [];
  let convertedRequests = 0;
  let droppedRequests = 0;
  let historyEntries = 0;

  const groups = Array.isArray(raw.shiftTypes.groups) ? raw.shiftTypes.groups : [];
  for (const group of groups) {
    if (isRec(group) && mentions(group.members, shiftId))
      blockers.push(`shift type group "${String(group.id)}"`);
  }

  const preferences: unknown[] = [];
  (Array.isArray(raw.preferences) ? raw.preferences : []).forEach((pref, i) => {
    if (!isRec(pref)) return void preferences.push(pref);
    const type = inferPreferenceType(pref);
    if (type !== PREFERENCE_TYPE.shiftRequest) {
      if (refers(pref)) blockers.push(label(pref, type, i));
      return void preferences.push(pref);
    }
    const selectors = asList(pref.shiftType);
    if (!selectors.includes(shiftId)) return void preferences.push(pref);
    if (selectors.length > 1) {
      blockers.push(`${label(pref, type, i)} (asks for it alongside other shifts)`);
      return void preferences.push(pref);
    }
    // Backend default request weight is +1 when omitted.
    const weight = typeof pref.weight === "number" ? pref.weight : 1;
    if (weight > 0) {
      convertedRequests++;
      // A LEAVE pin is hard: the import normalizer drops the weight.
      preferences.push({ ...pref, shiftType: RESERVED_SHIFT_TYPE.leave });
    } else {
      droppedRequests++;
    }
  });

  if (isRec(raw.export)) {
    const exportEntries = ["formatting", "extraColumns", "extraRows"].flatMap((key) =>
      Array.isArray((raw.export as Rec)[key]) ? ((raw.export as Rec)[key] as unknown[]) : [],
    );
    if (exportEntries.some((entry) => isRec(entry) && refers(entry)))
      blockers.push("export layout");
  }

  const people = isRec(raw.people) ? raw.people : undefined;
  const personItems = Array.isArray(people?.items) ? (people.items as unknown[]) : [];
  const convertedPeople = personItems.map((person) => {
    if (!isRec(person) || !Array.isArray(person.history)) return person;
    const history = person.history.map((entry) => {
      if (entry !== shiftId) return entry;
      historyEntries++;
      return RESERVED_SHIFT_TYPE.leave;
    });
    return { ...person, history };
  });

  const doc = {
    ...raw,
    shiftTypes: { ...raw.shiftTypes, items: items.filter((_, i) => i !== shiftIndex) },
    ...(people ? { people: { ...people, items: convertedPeople } } : {}),
    ...(Array.isArray(raw.preferences) ? { preferences } : {}),
  };
  return {
    shiftId,
    shiftIndex,
    convertedRequests,
    droppedRequests,
    historyEntries,
    blockers,
    doc,
  };
}

/** The blocking load issue for a v1 Leave shift that is not (or cannot be) converted. */
export function v1LeaveShiftIssue(plan: V1LeaveShiftPlan): { path: string; message: string } {
  const usedBy =
    plan.blockers.length > 0
      ? ` It cannot become paid leave because it is used as a worked shift by: ${plan.blockers.join(", ")}.`
      : "";
  return {
    path: `shiftTypes.items.${plan.shiftIndex}.id`,
    message:
      `Shift type "${plan.shiftId}" clashes with the built-in LEAVE (paid leave), so the file cannot load.${usedBy} ` +
      `To keep it as a worked shift, rename it: open Edit YAML, paste the file, replace every "${plan.shiftId}" ` +
      `with a new name (for example "AL"), then Apply.`,
  };
}
