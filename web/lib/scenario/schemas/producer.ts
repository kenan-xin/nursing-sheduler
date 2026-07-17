// Strict *producer* schema (T05) — the client-side preflight over a canonical
// scenario document, and a faithful (but non-authoritative) mirror of the binding
// rules in core/nurse_scheduling/models.py + group_map.py + preference_types.py.
//
// It is deliberately strict: it rejects unknown keys (`z.strictObject`), the
// working-time whole-shapes the backend rejects (equal start/end, partial clock,
// off-grid — review findings 6/7), reserved/duplicate ids, out-of-order date
// ranges, off-grid date-group ids, incomplete contracted-hours coefficient
// coverage, and — the T18 carry-forward this ticket owns — a shift-request
// selector naming a group whose expansion reaches the reserved OFF/LEAVE
// day-states (which the backend would otherwise accept silently).
//
// zod is preflight, NOT the C3/C5 authority: the three differential harnesses run
// the actual vendored Python. Every cross-field rule here is confirmed against
// that source and re-checked by the harness (a "zod-pass but backend-reject" case
// proves the gap is caught there, not here).

import { z } from "zod";
import { DAY_STATE_SELECTOR_VALUES, PREFERENCE_TYPE, RESERVED_SHIFT_TYPE } from "../types";
import { validateContractedHoursContract } from "./contracted-hours";
import {
  buildShiftTypeIndexMap,
  expandShiftTypeSelector,
  LEAVE_SID,
  OFF_SID,
  ShiftTypeMapError,
} from "./shift-type-map";
import {
  zClock,
  zCoefficientEntry,
  zHexColor,
  zIsoDate,
  zNestedRefList,
  zNestedShiftRefList,
  zRef,
  zLooseNumber,
  zRefOrList,
  zShiftSelectorOrList,
  zShiftTypeSelector,
  zWeight,
} from "./primitives";
import { validateWorkingTime } from "./working-time";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const zPerson = z.strictObject({
  id: zRef,
  description: z.string().optional(),
  history: z.array(z.string()).optional(),
});

const zPeopleGroup = z.strictObject({
  id: z.string(),
  description: z.string().optional(),
  members: z.array(zRef),
});

const zShiftType = z
  .strictObject({
    id: zRef,
    description: z.string().optional(),
    durationMinutes: z.number().int().optional(),
    startTime: zClock.optional(),
    endTime: zClock.optional(),
    restMinutes: z.number().int().optional(),
  })
  .superRefine((st, ctx) => validateWorkingTime(st, ctx));

const zShiftTypeGroup = z.strictObject({
  id: z.string(),
  description: z.string().optional(),
  members: z.array(zRef),
});

const zDateGroup = z.strictObject({
  id: z.string(),
  description: z.string().optional(),
  members: z.array(z.union([zRef, zIsoDate])),
});

const zDateRange = z.strictObject({ startDate: zIsoDate, endDate: zIsoDate });

// The canonical container intentionally has no `items` field (the backend
// generates it and rejects it if supplied); `z.strictObject` rejects it too.
const zDateContainer = z.strictObject({
  range: zDateRange,
  groups: z.array(zDateGroup).optional(),
});

const zPeopleContainer = z.strictObject({
  items: z.array(zPerson),
  groups: z.array(zPeopleGroup).optional(),
});

const zShiftTypesContainer = z.strictObject({
  items: z.array(zShiftType),
  groups: z.array(zShiftTypeGroup).optional(),
});

// ---------------------------------------------------------------------------
// Preferences (canonical documents always carry an explicit `type`)
// ---------------------------------------------------------------------------

const zHoursContract = z.strictObject({
  unit: z.literal("half-hour"),
  policy: z.enum(["exact", "range"]),
});

const zMaxOneShiftPerDay = z.strictObject({
  type: z.literal(PREFERENCE_TYPE.maxOneShiftPerDay),
  description: z.string().optional(),
});

const zShiftRequest = z.strictObject({
  type: z.literal(PREFERENCE_TYPE.shiftRequest),
  description: z.string().optional(),
  person: zRefOrList,
  date: zRefOrList,
  shiftType: zShiftSelectorOrList,
  weight: zWeight,
});

const zSuccessions = z.strictObject({
  type: z.literal(PREFERENCE_TYPE.shiftTypeSuccessions),
  description: z.string().optional(),
  person: zRefOrList,
  pattern: zNestedShiftRefList,
  date: zRefOrList.optional(),
  weight: zWeight,
});

const zRequirement = z.strictObject({
  type: z.literal(PREFERENCE_TYPE.shiftTypeRequirement),
  description: z.string().optional(),
  shiftType: z.union([zShiftTypeSelector, zNestedShiftRefList]),
  shiftTypeCoefficients: z.array(zCoefficientEntry).optional(),
  requiredNumPeople: z.number().int(),
  qualifiedPeople: zRefOrList.optional(),
  preferredNumPeople: z.number().int().optional(),
  date: zRefOrList.optional(),
  weight: zWeight,
});

const zShiftCount = z.strictObject({
  type: z.literal(PREFERENCE_TYPE.shiftCount),
  description: z.string().optional(),
  person: zRefOrList,
  countDates: zRefOrList,
  countShiftTypes: zShiftSelectorOrList,
  countShiftTypeCoefficients: z.array(zCoefficientEntry).optional(),
  expression: z.union([z.string(), z.array(z.string())]),
  target: z.union([z.number().int(), z.array(z.number().int())]),
  hoursContract: zHoursContract.optional(),
  weight: zWeight,
});

const zAffinity = z.strictObject({
  type: z.literal(PREFERENCE_TYPE.shiftAffinity),
  description: z.string().optional(),
  date: zRefOrList,
  people1: zNestedRefList,
  people2: zNestedRefList,
  shiftTypes: zNestedShiftRefList,
  weight: zWeight,
});

const zCovering = z.strictObject({
  type: z.literal(PREFERENCE_TYPE.shiftTypeCovering),
  description: z.string().optional(),
  date: zRefOrList.optional(),
  preceptors: zNestedRefList,
  preceptees: zNestedRefList,
  shiftTypes: zNestedShiftRefList,
  weight: zWeight,
});

const zPreference = z.discriminatedUnion("type", [
  zMaxOneShiftPerDay,
  zShiftRequest,
  zSuccessions,
  zRequirement,
  zShiftCount,
  zAffinity,
  zCovering,
]);

// ---------------------------------------------------------------------------
// Export config
// ---------------------------------------------------------------------------

const zBaseFormatting = {
  description: z.string().optional(),
  backgroundColor: zHexColor.optional(),
  bottomBorderColor: zHexColor.optional(),
  rightBorderColor: zHexColor.optional(),
  fontColor: zHexColor.optional(),
};

const zExportPersonRule = z.strictObject({
  ...zBaseFormatting,
  type: z.enum(["row", "people header", "history"]),
  people: z.array(zRef),
});
const zExportDateRule = z.strictObject({
  ...zBaseFormatting,
  type: z.enum(["column", "date header"]),
  dates: z.array(zRef),
});
const zExportHistoryHeaderRule = z.strictObject({
  ...zBaseFormatting,
  type: z.literal("history header"),
});
const zExportCellRule = z.strictObject({
  ...zBaseFormatting,
  type: z.literal("cell"),
  appendText: z.string().optional(),
  note: z.strictObject({ text: z.string() }).optional(),
  people: z.array(zRef),
  dates: z.array(zRef),
  shiftTypes: z.array(zRef),
  when: z
    .strictObject({
      preference: z.strictObject({
        types: z.array(z.literal("shift request")),
        requestShape: z
          .array(
            z.enum([
              "person-item-to-date-item",
              "people-group-to-date-item",
              "person-item-to-date-group",
              "people-group-to-date-group",
              "ALL",
            ]),
          )
          .optional(),
        satisfied: z.boolean().optional(),
        weightRange: z.array(zLooseNumber).optional(),
      }),
    })
    .optional(),
});

const zExportFormattingRule = z.discriminatedUnion("type", [
  zExportPersonRule,
  zExportDateRule,
  zExportHistoryHeaderRule,
  zExportCellRule,
]);

const zExportExtraColumn = z.strictObject({
  description: z.string().optional(),
  rightBorderColor: zHexColor.optional(),
  type: z.literal("count"),
  header: z.string(),
  countShiftTypes: z.array(zRef),
  countShiftTypeCoefficients: z.array(zCoefficientEntry).optional(),
  countDates: z.array(zRef),
});

const zExportExtraRow = z.strictObject({
  description: z.string().optional(),
  bottomBorderColor: zHexColor.optional(),
  type: z.literal("count"),
  header: z.string(),
  countShiftTypes: z.array(zRef),
  countPeople: z.array(zRef),
});

const zExportConfig = z.strictObject({
  formatting: z.array(zExportFormattingRule).optional(),
  extraColumns: z.array(zExportExtraColumn).optional(),
  extraRows: z.array(zExportExtraRow).optional(),
});

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/**
 * The strict producer schema for a `CanonicalScenarioDocument`. Structural shape
 * only; the cross-field/semantic rules run in the `.superRefine` below.
 */
export const producerScenarioSchema = z
  .strictObject({
    appVersion: z.string().optional(),
    apiVersion: z.string(),
    description: z.string().optional(),
    dates: zDateContainer,
    country: z.string().optional(),
    people: zPeopleContainer,
    shiftTypes: zShiftTypesContainer,
    preferences: z.array(zPreference),
    export: zExportConfig.optional(),
  })
  .superRefine((doc, ctx) => validateScenarioCrossFields(doc, ctx));

// ---------------------------------------------------------------------------
// Working-time whole-shape validation — shared with the import schema via
// `./working-time` (mirrors models.ShiftType._validate_working_time).
// ---------------------------------------------------------------------------

type ProducerDoc = z.infer<typeof producerScenarioSchema>;

const WEEKDAY_IDS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const DATE_KEYWORD_IDS = ["ALL", "WEEKDAY", "WEEKEND"];

function validateScenarioCrossFields(doc: ProducerDoc, ctx: z.RefinementCtx): void {
  const addIssue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: "custom", message, path });

  // Required preferences.
  const found = new Set(doc.preferences.map((p) => p.type));
  if (!found.has(PREFERENCE_TYPE.maxOneShiftPerDay)) {
    addIssue(`Missing required preference: '${PREFERENCE_TYPE.maxOneShiftPerDay}'.`, [
      "preferences",
    ]);
  }

  // Date range order.
  if (doc.dates.range.endDate < doc.dates.range.startDate) {
    addIssue("endDate must be after or equal to startDate.", ["dates", "range", "endDate"]);
  }

  // Shift-type ids: duplicates + reserved.
  const shiftReserved = new Set([
    RESERVED_SHIFT_TYPE.all,
    RESERVED_SHIFT_TYPE.off,
    RESERVED_SHIFT_TYPE.leave,
  ]);
  const shiftTypeIds = new Set<unknown>();
  doc.shiftTypes.items.forEach((st, i) => {
    if (shiftTypeIds.has(st.id))
      addIssue(`Duplicated shift type ID: ${quote(st.id)}.`, ["shiftTypes", "items", i, "id"]);
    if (shiftReserved.has(String(st.id).toUpperCase() as never))
      addIssue(`Shift type ID ${quote(st.id)} cannot be a reserved value (ALL/OFF/LEAVE).`, [
        "shiftTypes",
        "items",
        i,
        "id",
      ]);
    shiftTypeIds.add(st.id);
  });
  const shiftGroupIds = new Set<unknown>();
  (doc.shiftTypes.groups ?? []).forEach((g, i) => {
    if (shiftTypeIds.has(g.id) || shiftGroupIds.has(g.id))
      addIssue(`Duplicated shift type group (or shift type) ID: ${quote(g.id)}.`, [
        "shiftTypes",
        "groups",
        i,
        "id",
      ]);
    if (shiftReserved.has(g.id.toUpperCase() as never))
      addIssue(`Shift type group ID ${quote(g.id)} cannot be a reserved value (ALL/OFF/LEAVE).`, [
        "shiftTypes",
        "groups",
        i,
        "id",
      ]);
    shiftGroupIds.add(g.id);
  });

  // People ids: duplicates + reserved + history integrity.
  const personAndGroupIds = new Set<unknown>();
  doc.people.items.forEach((person, i) => {
    if (personAndGroupIds.has(person.id))
      addIssue(`Duplicated person ID: ${quote(person.id)}.`, ["people", "items", i, "id"]);
    if (String(person.id).toUpperCase() === RESERVED_SHIFT_TYPE.all)
      addIssue(`Person ID ${quote(person.id)} cannot be the reserved value 'ALL'.`, [
        "people",
        "items",
        i,
        "id",
      ]);
    (person.history ?? []).forEach((h, hi) => {
      if (h === RESERVED_SHIFT_TYPE.all)
        addIssue("History must not include 'ALL'.", ["people", "items", i, "history", hi]);
      else if (shiftGroupIds.has(h))
        addIssue(`History must not include group ID ${quote(h)}.`, [
          "people",
          "items",
          i,
          "history",
          hi,
        ]);
      else if (
        h !== RESERVED_SHIFT_TYPE.off &&
        h !== RESERVED_SHIFT_TYPE.leave &&
        !shiftTypeIds.has(h)
      )
        addIssue(`Unknown shift type ID in history: ${quote(h)}.`, [
          "people",
          "items",
          i,
          "history",
          hi,
        ]);
    });
    personAndGroupIds.add(person.id);
  });
  (doc.people.groups ?? []).forEach((g, i) => {
    if (personAndGroupIds.has(g.id))
      addIssue(`Duplicated people group (or person) ID: ${quote(g.id)}.`, [
        "people",
        "groups",
        i,
        "id",
      ]);
    if (g.id.toUpperCase() === RESERVED_SHIFT_TYPE.all)
      addIssue(`People group ID ${quote(g.id)} cannot be the reserved value 'ALL'.`, [
        "people",
        "groups",
        i,
        "id",
      ]);
    personAndGroupIds.add(g.id);
  });

  // Date group ids: duplicates + reserved + off-grid pattern.
  const dateReserved = new Set([...WEEKDAY_IDS, ...DATE_KEYWORD_IDS]);
  const dateGroupIds = new Set<string>();
  (doc.dates.groups ?? []).forEach((g, i) => {
    if (dateGroupIds.has(g.id))
      addIssue(`Duplicated date group ID: ${quote(g.id)}.`, ["dates", "groups", i, "id"]);
    if (dateReserved.has(g.id.toUpperCase()))
      addIssue(`Date group ID ${quote(g.id)} cannot be a reserved value.`, [
        "dates",
        "groups",
        i,
        "id",
      ]);
    if (/^\d{1,2}$/.test(g.id) || /^\d{2}-\d{2}$/.test(g.id) || /^\d{4}-\d{2}-\d{2}$/.test(g.id))
      addIssue(
        `Date group ID ${quote(g.id)} must not be in the format of YYYY-MM-DD, MM-DD, or D.`,
        ["dates", "groups", i, "id"],
      );
    dateGroupIds.add(g.id);
  });

  // Contracted-hours (marked shift counts): policy encoding + coefficient coverage.
  const map = buildAndReportShiftTypeMap(doc, ctx);
  if (map) {
    validateContractedHours(doc, map, shiftGroupIds, ctx);
    validateShiftRequestReservedExpansion(doc, map, ctx);
  }
}

/** Build the ordered shift-type map; surface a forward-ref/cycle as an issue. */
function buildAndReportShiftTypeMap(doc: ProducerDoc, ctx: z.RefinementCtx) {
  try {
    return buildShiftTypeIndexMap(doc.shiftTypes.items, doc.shiftTypes.groups ?? []);
  } catch (error) {
    if (error instanceof ShiftTypeMapError) {
      ctx.addIssue({ code: "custom", message: error.message, path: ["shiftTypes", "groups"] });
      return null;
    }
    throw error;
  }
}

// Thin adapter over the shared marked-contract helper (DL09 D4): mirrors
// group_map._validate_policy_encoding + _validate_coverage by translating each
// structured `ContractedHoursError` into the exact Zod issue emitted before.
function validateContractedHours(
  doc: ProducerDoc,
  map: Map<number | string, number[]>,
  groupIds: Set<unknown>,
  ctx: z.RefinementCtx,
): void {
  doc.preferences.forEach((pref, prefIndex) => {
    if (pref.type !== PREFERENCE_TYPE.shiftCount || !pref.hoursContract) return;
    const { errors } = validateContractedHoursContract(
      {
        weight: pref.weight,
        expression: pref.expression,
        target: pref.target,
        policy: pref.hoursContract.policy,
        countShiftTypes: pref.countShiftTypes,
        countShiftTypeCoefficients: pref.countShiftTypeCoefficients,
      },
      map,
      groupIds,
    );
    for (const { field, message } of errors)
      ctx.addIssue({ code: "custom", message, path: ["preferences", prefIndex, field] });
  });
}

/**
 * The T18 carry-forward this ticket owns: reject a shift-request selector naming a
 * *group* whose expansion reaches OFF/LEAVE. The backend accepts this silently
 * (`mixed:[D, LEAVE]` → indices `[-2, 0]` → the request hard-pins leave — verified
 * against the vendored Python), so this is the only guard.
 *
 * A **direct** `OFF`/`LEAVE` selector is explicitly NOT flagged here: it is the
 * legitimate, canonical serialization of an off/leave matrix cell (the T18
 * projection emits exactly this from a `kind: "off"` / `kind: "leave"` cell). Only
 * a group whose expansion *includes* OFF/LEAVE is a footgun — a plain worked id
 * expands to a single worked index and `ALL` expands to worked shifts only, so a
 * non-reserved selector reaching `-1`/`-2` can only be such a group.
 */
function validateShiftRequestReservedExpansion(
  doc: ProducerDoc,
  map: Map<number | string, number[]>,
  ctx: z.RefinementCtx,
): void {
  doc.preferences.forEach((pref, prefIndex) => {
    if (pref.type !== PREFERENCE_TYPE.shiftRequest) return;
    const selectors = Array.isArray(pref.shiftType) ? pref.shiftType : [pref.shiftType];
    selectors.forEach((selector) => {
      // A direct OFF/LEAVE day-state selector is a valid worked/day-state request.
      if (DAY_STATE_SELECTOR_VALUES.includes(selector)) return;
      const indices = expandShiftTypeSelector(selector, map);
      if (indices == null) return; // Unknown-id is a separate concern; the harness/backend own it.
      if (indices.includes(OFF_SID) || indices.includes(LEAVE_SID)) {
        ctx.addIssue({
          code: "custom",
          message:
            `Shift-request selector '${selector}' names a group whose expansion includes the reserved ` +
            `OFF/LEAVE day-state; the backend would silently pin leave/off. Author leave/off via a ` +
            `leave/off matrix cell instead.`,
          path: ["preferences", prefIndex, "shiftType"],
        });
      }
    });
  });
}

function quote(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : String(value);
}
