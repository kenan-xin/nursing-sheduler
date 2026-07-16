// Lenient *import* schema (T05) — the structural gate for the Load/import path.
//
// "Lenient" means it accepts every backend-valid *form* (C1 CON-YAML-14/15): the
// preference union is NOT discriminated, so `type` may be omitted and is resolved
// by field shape; selectors accept scalar OR list OR nested trees; optional fields
// may be absent/null. It is NOT permissive about *validity*: like the binding
// Pydantic models (`extra="forbid"`), objects reject unknown keys, each preference
// variant enforces its required fields, and an unknown explicit `type` is rejected
// rather than silently dropped. Semantic acceptance is proven by the differential
// round-trip harness, not by this schema.

import { z } from "zod";
import { PREFERENCE_TYPE } from "../types";
import { zClock, zHexColor, zLooseNumber, zWeight } from "./primitives";
import { validateWorkingTime } from "./working-time";

// A YAML date may arrive as an ISO string or (defensively) a `Date`. The string
// arm is calendar-valid (zod 4 `z.iso.date()`), matching the Pydantic `date`
// field: `2026-99-99` is rejected here, not merely after normalization.
const zImportDate = z.union([z.iso.date(), z.date()]);
// Import refs stay lenient on int-vs-string but reject fractional numeric ids
// (the backend does too); Dates are tolerated only where dates may appear.
const zImportRef = z.union([z.number().int(), z.string()]);
const zImportDateRef = z.union([z.number().int(), z.string(), z.date()]);
const zRefOrList = z.union([zImportRef, z.array(zImportRef)]);
const zDateRefOrList = z.union([zImportDateRef, z.array(zImportDateRef)]);
const zShiftSelectorOrList = z.union([z.string(), z.array(z.string())]);
const zNestedRefList = z.array(z.union([zImportRef, z.array(zImportRef)]));
const zNestedShiftRefList = z.array(z.union([z.string(), z.array(z.string())]));
// Weight reuses the backend-faithful primitive: an integer soft weight, or the
// only permitted non-integers `±Infinity` (mirrors `models.validate_weight`).
const zImportWeight = zWeight;

const zImportPerson = z.strictObject({
  id: zImportRef,
  description: z.string().nullish(),
  history: z.array(z.string()).nullish(),
});

const zImportPeopleGroup = z.strictObject({
  id: z.string(),
  description: z.string().nullish(),
  members: z.array(zImportRef),
});

const zImportShiftType = z
  .strictObject({
    id: zImportRef,
    description: z.string().nullish(),
    durationMinutes: z.number().int().nullish(),
    startTime: zClock.nullish(),
    endTime: zClock.nullish(),
    restMinutes: z.number().int().nullish(),
  })
  .superRefine((st, ctx) => validateWorkingTime(st, ctx));

const zImportShiftTypeGroup = z.strictObject({
  id: z.string(),
  description: z.string().nullish(),
  members: z.array(zImportRef),
});

const zImportDateGroup = z.strictObject({
  id: z.string(),
  description: z.string().nullish(),
  members: z.array(zImportDateRef),
});

const zCoefficientEntry = z.tuple([z.string(), z.number().int()]);

// ---------------------------------------------------------------------------
// Preference variants — a non-discriminated union mirroring the backend models.
// `type` is optional per variant (omitted → resolved by shape) but, when present,
// must equal that variant's literal; every variant enforces its required fields.
// ---------------------------------------------------------------------------

const zImportMaxOneShiftPerDay = z.strictObject({
  // The only identifying signal is the type itself, so it is required here (a
  // bare `{}` is not silently treated as this preference).
  type: z.literal(PREFERENCE_TYPE.maxOneShiftPerDay),
  description: z.string().nullish(),
});

const zImportShiftRequest = z.strictObject({
  type: z.literal(PREFERENCE_TYPE.shiftRequest).optional(),
  description: z.string().nullish(),
  person: zRefOrList,
  date: zDateRefOrList,
  shiftType: zShiftSelectorOrList,
  weight: zImportWeight.optional(),
});

const zImportSuccessions = z.strictObject({
  type: z.literal(PREFERENCE_TYPE.shiftTypeSuccessions).optional(),
  description: z.string().nullish(),
  person: zRefOrList,
  pattern: zNestedShiftRefList,
  date: zDateRefOrList.nullish(),
  weight: zImportWeight.optional(),
});

const zImportRequirement = z.strictObject({
  type: z.literal(PREFERENCE_TYPE.shiftTypeRequirement).optional(),
  description: z.string().nullish(),
  shiftType: z.union([z.string(), zNestedShiftRefList]),
  shiftTypeCoefficients: z.array(zCoefficientEntry).nullish(),
  requiredNumPeople: z.number().int(),
  qualifiedPeople: zRefOrList.nullish(),
  preferredNumPeople: z.number().int().nullish(),
  date: zDateRefOrList.nullish(),
  weight: zImportWeight.optional(),
});

const zImportHoursContract = z.strictObject({
  unit: z.literal("half-hour"),
  policy: z.enum(["exact", "range"]),
});

const zImportCount = z.strictObject({
  type: z.literal(PREFERENCE_TYPE.shiftCount).optional(),
  description: z.string().nullish(),
  person: zRefOrList,
  countDates: zDateRefOrList,
  countShiftTypes: zShiftSelectorOrList,
  countShiftTypeCoefficients: z.array(zCoefficientEntry).nullish(),
  expression: z.union([z.string(), z.array(z.string())]),
  target: z.union([z.number().int(), z.array(z.number().int())]),
  hoursContract: zImportHoursContract.nullish(),
  weight: zImportWeight.optional(),
});

const zImportAffinity = z.strictObject({
  type: z.literal(PREFERENCE_TYPE.shiftAffinity).optional(),
  description: z.string().nullish(),
  date: zDateRefOrList,
  people1: zNestedRefList,
  people2: zNestedRefList,
  shiftTypes: zNestedShiftRefList,
  weight: zImportWeight.optional(),
});

const zImportCovering = z.strictObject({
  type: z.literal(PREFERENCE_TYPE.shiftTypeCovering).optional(),
  description: z.string().nullish(),
  date: zDateRefOrList.nullish(),
  preceptors: zNestedRefList,
  preceptees: zNestedRefList,
  shiftTypes: zNestedShiftRefList,
  weight: zImportWeight.optional(),
});

// Order: most field-specific variants first so shape resolution of a `type`-less
// preference is unambiguous. `maxOneShiftPerDay` (type-required) is last.
const zImportPreference = z.union([
  zImportRequirement,
  zImportCount,
  zImportCovering,
  zImportAffinity,
  zImportSuccessions,
  zImportShiftRequest,
  zImportMaxOneShiftPerDay,
]);

// ---------------------------------------------------------------------------
// Export config — strict objects mirroring the Pydantic export models (all use
// `extra="forbid"` and a `type`-discriminated union). "Lenient" import does NOT
// extend to accepting unknown keys or missing discriminators here.
// ---------------------------------------------------------------------------

const zImportBaseFormatting = {
  description: z.string().nullish(),
  backgroundColor: zHexColor.nullish(),
  bottomBorderColor: zHexColor.nullish(),
  rightBorderColor: zHexColor.nullish(),
  fontColor: zHexColor.nullish(),
};

const zImportExportPersonRule = z.strictObject({
  ...zImportBaseFormatting,
  type: z.enum(["row", "people header", "history"]),
  people: z.array(zImportRef),
});
const zImportExportDateRule = z.strictObject({
  ...zImportBaseFormatting,
  type: z.enum(["column", "date header"]),
  dates: z.array(zImportRef),
});
const zImportExportHistoryHeaderRule = z.strictObject({
  ...zImportBaseFormatting,
  type: z.literal("history header"),
});
const zImportExportCellRule = z.strictObject({
  ...zImportBaseFormatting,
  type: z.literal("cell"),
  appendText: z.string().nullish(),
  note: z.strictObject({ text: z.string() }).nullish(),
  people: z.array(zImportRef),
  dates: z.array(zImportRef),
  shiftTypes: z.array(zImportRef),
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
          .nullish(),
        satisfied: z.boolean().nullish(),
        weightRange: z.array(zLooseNumber).nullish(),
      }),
    })
    .nullish(),
});
const zImportExportFormattingRule = z.discriminatedUnion("type", [
  zImportExportPersonRule,
  zImportExportDateRule,
  zImportExportHistoryHeaderRule,
  zImportExportCellRule,
]);

const zImportExportExtraColumn = z.strictObject({
  description: z.string().nullish(),
  rightBorderColor: zHexColor.nullish(),
  type: z.literal("count"),
  header: z.string(),
  countShiftTypes: z.array(zImportRef),
  countShiftTypeCoefficients: z.array(zCoefficientEntry).nullish(),
  countDates: z.array(zImportRef),
});

const zImportExportExtraRow = z.strictObject({
  description: z.string().nullish(),
  bottomBorderColor: zHexColor.nullish(),
  type: z.literal("count"),
  header: z.string(),
  countShiftTypes: z.array(zImportRef),
  countPeople: z.array(zImportRef),
});

/**
 * The lenient import root schema. Validates container/entity/preference structure
 * (rejecting unknown keys and unknown preference types); `normalizeImport`
 * (import-scenario.ts) turns the result into the T18 `ImportNormalizationTarget`.
 */
export const importScenarioSchema = z.strictObject({
  appVersion: z.string().nullish(),
  apiVersion: z.string(),
  description: z.string().nullish(),
  dates: z.strictObject({
    range: z.strictObject({ startDate: zImportDate, endDate: zImportDate }),
    // Auto-generated by the backend; accepted only absent/empty, never non-empty
    // (models.py rejects a supplied items list).
    items: z.array(zImportDate).max(0).optional(),
    groups: z.array(zImportDateGroup).optional(),
  }),
  country: z.string().nullish(),
  people: z.strictObject({
    items: z.array(zImportPerson),
    groups: z.array(zImportPeopleGroup).optional(),
  }),
  shiftTypes: z.strictObject({
    items: z.array(zImportShiftType),
    groups: z.array(zImportShiftTypeGroup).optional(),
  }),
  preferences: z.array(zImportPreference),
  export: z
    .strictObject({
      formatting: z.array(zImportExportFormattingRule).optional(),
      extraColumns: z.array(zImportExportExtraColumn).optional(),
      extraRows: z.array(zImportExportExtraRow).optional(),
    })
    .optional(),
});

export type ImportScenarioParsed = z.infer<typeof importScenarioSchema>;
