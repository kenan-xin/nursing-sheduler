// Load / import path (T05) — raw YAML → lenient import schema → T18
// `ImportNormalizationTarget`. This is the first-class inbound boundary the
// tech-plan §4 flagged as previously missing. The normalizer reverses the
// producer projection: preferences fold back into `cardsByKind` (keyless bodies)
// and the person×date matrix (`reqData`); scalar/list/omitted forms are accepted
// and backend defaults are filled in. T04 later hydrates the keyless target with
// store identity.

import { parse } from "yaml";
import { importScenarioSchema, type ImportScenarioParsed } from "./schemas/import";
import {
  PREFERENCE_TYPE,
  RESERVED_SHIFT_TYPE,
  type AffinityCardBody,
  type CoveringCardBody,
  type CountCardBody,
  type DateRef,
  type ImportCardsByKind,
  type ImportNormalizationTarget,
  type PersonRef,
  type RequirementCardBody,
  type SuccessionCardBody,
  type UiDateGroup,
  type UiPeopleGroup,
  type UiPerson,
  type UiRequestCell,
  type UiShiftType,
  type UiShiftTypeGroup,
  type Weight,
} from "./types";
import type { z } from "zod";
import type { ScenarioValidationIssue } from "./serialize";

export type ImportResult =
  | { ok: true; target: ImportNormalizationTarget }
  | { ok: false; issues: ScenarioValidationIssue[] };

/** Parse a YAML 1.2 string into a raw JS value (no validation). */
export function parseScenarioYaml(text: string): unknown {
  return parse(text);
}

/** Backend default weights per preference type (models.py `Field(default=...)`). */
export const DEFAULT_WEIGHT: Record<string, Weight> = {
  [PREFERENCE_TYPE.shiftRequest]: 1,
  [PREFERENCE_TYPE.shiftTypeSuccessions]: 1,
  [PREFERENCE_TYPE.shiftTypeRequirement]: -1,
  [PREFERENCE_TYPE.shiftCount]: -1,
  [PREFERENCE_TYPE.shiftAffinity]: 1,
  [PREFERENCE_TYPE.shiftTypeCovering]: 1,
};

/**
 * Import a backend-valid YAML string into the keyless `ImportNormalizationTarget`.
 * A YAML syntax error, structural failure, or unknown preference type all come
 * back through the `ImportResult` error channel (never thrown); on success the
 * preferences have been folded back into cards + matrix cells.
 */
export function importScenarioYaml(text: string): ImportResult {
  let raw: unknown;
  try {
    raw = parseScenarioYaml(text);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: "", message: `YAML parse error: ${(error as Error).message}` }],
    };
  }
  return importScenarioValue(raw);
}

/** Import an already-parsed raw value (used by tests and the round-trip harness). */
export function importScenarioValue(raw: unknown): ImportResult {
  const parsed = importScenarioSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: toIssues(parsed.error) };
  return { ok: true, target: normalizeImport(parsed.data) };
}

function toIssues(error: z.ZodError): ScenarioValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

function isoDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function clean<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out as T;
}

function asList<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

function normalizeImport(data: ImportScenarioParsed): ImportNormalizationTarget {
  const cardsByKind: ImportCardsByKind = {
    requirements: [],
    successions: [],
    counts: [],
    affinities: [],
    coverings: [],
  };
  const reqData: UiRequestCell[] = [];
  let maxOneShiftPerDay: { description?: string } | undefined;

  for (const pref of data.preferences) {
    const type = inferPreferenceType(pref);
    switch (type) {
      case PREFERENCE_TYPE.maxOneShiftPerDay:
        maxOneShiftPerDay = clean({ description: str(pref.description) });
        break;
      case PREFERENCE_TYPE.shiftRequest:
        reqData.push(...normalizeShiftRequest(pref));
        break;
      case PREFERENCE_TYPE.shiftTypeRequirement:
        cardsByKind.requirements.push(normalizeRequirement(pref));
        break;
      case PREFERENCE_TYPE.shiftTypeSuccessions:
        cardsByKind.successions.push(normalizeSuccession(pref));
        break;
      case PREFERENCE_TYPE.shiftCount:
        cardsByKind.counts.push(normalizeCount(pref));
        break;
      case PREFERENCE_TYPE.shiftAffinity:
        cardsByKind.affinities.push(normalizeAffinity(pref));
        break;
      case PREFERENCE_TYPE.shiftTypeCovering:
        cardsByKind.coverings.push(normalizeCovering(pref));
        break;
    }
  }

  const target: ImportNormalizationTarget = {
    meta: clean({
      apiVersion: data.apiVersion,
      appVersion: str(data.appVersion),
      description: str(data.description),
      country: str(data.country),
    }),
    staff: data.people.items.map(normalizePerson),
    staffGroups: (data.people.groups ?? []).map(normalizePeopleGroup),
    shifts: data.shiftTypes.items.map(normalizeShiftType),
    shiftGroups: (data.shiftTypes.groups ?? []).map(normalizeShiftTypeGroup),
    rangeStart: isoDate(data.dates.range.startDate),
    rangeEnd: isoDate(data.dates.range.endDate),
    dateGroups: (data.dates.groups ?? []).map(normalizeDateGroup),
    reqData,
    exportLayout: {
      formatting: (data.export?.formatting ??
        []) as unknown as ImportNormalizationTarget["exportLayout"]["formatting"],
      extraColumns: (data.export?.extraColumns ??
        []) as unknown as ImportNormalizationTarget["exportLayout"]["extraColumns"],
      extraRows: (data.export?.extraRows ??
        []) as unknown as ImportNormalizationTarget["exportLayout"]["extraRows"],
    },
    cardsByKind,
    // The legacy backend YAML carries no Guided metadata, so a legacy import
    // restores no pins; the Workspace V1 path populates these from `guidedRules`.
    guidedRulePins: [],
  };
  if (maxOneShiftPerDay !== undefined) target.maxOneShiftPerDay = maxOneShiftPerDay;
  return target;
}

// ---------------------------------------------------------------------------
// `type`-omitted inference (mirrors the backend's non-discriminated union)
// ---------------------------------------------------------------------------

type LoosePref = Record<string, unknown>;

function inferPreferenceType(pref: LoosePref): string {
  if (typeof pref.type === "string" && pref.type.length > 0) return pref.type;
  // Backend-valid docs may omit `type`; infer from the discriminating fields.
  if ("requiredNumPeople" in pref) return PREFERENCE_TYPE.shiftTypeRequirement;
  if ("pattern" in pref) return PREFERENCE_TYPE.shiftTypeSuccessions;
  if ("countDates" in pref || "expression" in pref) return PREFERENCE_TYPE.shiftCount;
  if ("preceptors" in pref || "preceptees" in pref) return PREFERENCE_TYPE.shiftTypeCovering;
  if ("people1" in pref || "people2" in pref) return PREFERENCE_TYPE.shiftAffinity;
  if ("shiftType" in pref && "person" in pref && "date" in pref)
    return PREFERENCE_TYPE.shiftRequest;
  return PREFERENCE_TYPE.maxOneShiftPerDay;
}

// ---------------------------------------------------------------------------
// Entity normalizers
// ---------------------------------------------------------------------------

function normalizePerson(p: ImportScenarioParsed["people"]["items"][number]): UiPerson {
  return clean({ id: p.id, description: str(p.description), history: p.history ?? undefined });
}
function normalizePeopleGroup(g: {
  id: string;
  description?: string | null;
  members: unknown[];
}): UiPeopleGroup {
  return clean({ id: g.id, description: str(g.description), members: g.members as PersonRef[] });
}
function normalizeShiftType(s: ImportScenarioParsed["shiftTypes"]["items"][number]): UiShiftType {
  return clean({
    id: s.id,
    description: str(s.description),
    durationMinutes: num(s.durationMinutes),
    startTime: str(s.startTime),
    endTime: str(s.endTime),
    restMinutes: num(s.restMinutes),
  });
}
function normalizeShiftTypeGroup(g: {
  id: string;
  description?: string | null;
  members: unknown[];
}): UiShiftTypeGroup {
  return clean({
    id: g.id,
    description: str(g.description),
    members: g.members as UiShiftTypeGroup["members"],
  });
}
function normalizeDateGroup(g: {
  id: string;
  description?: string | null;
  members: unknown[];
}): UiDateGroup {
  return clean({
    id: g.id,
    description: str(g.description),
    members: (g.members as (string | number | Date)[]).map((m) =>
      m instanceof Date ? isoDate(m) : m,
    ) as UiDateGroup["members"],
  });
}

// ---------------------------------------------------------------------------
// Preference normalizers
// ---------------------------------------------------------------------------

function weightOf(pref: LoosePref, type: string): Weight {
  return typeof pref.weight === "number" ? pref.weight : DEFAULT_WEIGHT[type];
}

function normalizeRequirement(pref: LoosePref): RequirementCardBody {
  return clean({
    description: str(pref.description),
    shiftType: pref.shiftType as RequirementCardBody["shiftType"],
    shiftTypeCoefficients:
      pref.shiftTypeCoefficients as RequirementCardBody["shiftTypeCoefficients"],
    requiredNumPeople: pref.requiredNumPeople as number,
    qualifiedPeople: pref.qualifiedPeople as RequirementCardBody["qualifiedPeople"],
    preferredNumPeople: num(pref.preferredNumPeople as number | null | undefined),
    date: pref.date as DateRef | DateRef[] | undefined,
    weight: weightOf(pref, PREFERENCE_TYPE.shiftTypeRequirement),
  });
}

function normalizeSuccession(pref: LoosePref): SuccessionCardBody {
  return clean({
    description: str(pref.description),
    person: pref.person as SuccessionCardBody["person"],
    pattern: pref.pattern as SuccessionCardBody["pattern"],
    date: pref.date as DateRef | DateRef[] | undefined,
    weight: weightOf(pref, PREFERENCE_TYPE.shiftTypeSuccessions),
  });
}

function normalizeCount(pref: LoosePref): CountCardBody {
  const hoursContract = pref.hoursContract as { policy?: "exact" | "range" } | undefined | null;
  const base = clean({
    description: str(pref.description),
    person: pref.person as CountCardBody["person"],
    countDates: pref.countDates as CountCardBody["countDates"],
    countShiftTypes: pref.countShiftTypes as CountCardBody["countShiftTypes"],
    countShiftTypeCoefficients:
      pref.countShiftTypeCoefficients as CountCardBody["countShiftTypeCoefficients"],
    expression: pref.expression as CountCardBody["expression"],
    target: pref.target as CountCardBody["target"],
    weight: weightOf(pref, PREFERENCE_TYPE.shiftCount),
  });
  // A `hoursContract` marker maps to the durable contracted-hours card fields
  // (`tag` + `policy`); the backend `unit` is always "half-hour" (UI-only hint).
  if (hoursContract && hoursContract.policy) {
    return { ...base, tag: "contracted_hours", policy: hoursContract.policy };
  }
  return base;
}

function normalizeAffinity(pref: LoosePref): AffinityCardBody {
  return clean({
    description: str(pref.description),
    date: pref.date as AffinityCardBody["date"],
    people1: pref.people1 as AffinityCardBody["people1"],
    people2: pref.people2 as AffinityCardBody["people2"],
    shiftTypes: pref.shiftTypes as AffinityCardBody["shiftTypes"],
    weight: weightOf(pref, PREFERENCE_TYPE.shiftAffinity),
  });
}

function normalizeCovering(pref: LoosePref): CoveringCardBody {
  return clean({
    description: str(pref.description),
    date: pref.date as DateRef | DateRef[] | undefined,
    preceptors: pref.preceptors as CoveringCardBody["preceptors"],
    preceptees: pref.preceptees as CoveringCardBody["preceptees"],
    shiftTypes: pref.shiftTypes as CoveringCardBody["shiftTypes"],
    weight: weightOf(pref, PREFERENCE_TYPE.shiftTypeCovering),
  });
}

/**
 * Fold a shift-request preference into per-cell matrix requests. A cell holds a
 * single (person, date, shiftType); list/scalar person & date expand cartesian,
 * and a shiftType list expands one cell per element (semantically identical to
 * the backend's per-`s` objective loop). OFF/LEAVE selectors become off/leave
 * cells; every other selector (incl. `ALL` and group ids) becomes a request cell.
 */
function normalizeShiftRequest(pref: LoosePref): UiRequestCell[] {
  const persons = asList(pref.person as PersonRef | PersonRef[]);
  const dates = asList(pref.date as DateRef | DateRef[]);
  const selectors = asList(pref.shiftType as string | string[]);
  const weight = weightOf(pref, PREFERENCE_TYPE.shiftRequest);
  const description = str(pref.description);
  const cells: UiRequestCell[] = [];

  for (const person of persons) {
    for (const date of dates) {
      for (const selector of selectors) {
        if (selector === RESERVED_SHIFT_TYPE.off) {
          cells.push(clean({ kind: "off", person, date, weight, description }));
        } else if (selector === RESERVED_SHIFT_TYPE.leave) {
          cells.push(clean({ kind: "leave", person, date, description }));
        } else {
          cells.push(
            clean({ kind: "request", person, date, shiftType: selector, weight, description }),
          );
        }
      }
    }
  }
  return cells;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

// Reused by the Workspace V1 hydration bridge (T17r): a Workspace preference is a
// legacy preference body plus `workspaceId`/`enabled`, so the same per-type body
// normalizers reconstruct its card/cell — the Workspace path then re-attaches the
// durable identity (`uid`) and `disabled` flag the legacy path drops.
export {
  isoDate as normalizeIsoDate,
  inferPreferenceType,
  normalizePerson,
  normalizePeopleGroup,
  normalizeShiftType,
  normalizeShiftTypeGroup,
  normalizeDateGroup,
  normalizeRequirement,
  normalizeSuccession,
  normalizeCount,
  normalizeAffinity,
  normalizeCovering,
  normalizeShiftRequest,
};
