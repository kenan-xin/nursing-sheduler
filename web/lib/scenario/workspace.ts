// Flat Workspace V1 contract (T17, tech-plan §4; DL12/DL13) — the TypeScript half
// of the shared, cross-language boundary whose Python half is T19's
// `WorkspaceSchedulingDataV1` model + `convert_workspace_to_strict`. The two
// implementations are deliberately independent (DL13 decision 1) and held
// together by the bidirectional golden fixtures in `./differential`.
//
// Workspace YAML is a flat *superset* of the strict backend document: same
// top-level `apiVersion`/`dates`/`people`/`shiftTypes`/`preferences`/`export`,
// plus authoring state the strict solver model never sees — a `workspaceVersion`
// tag, incomplete (`null`) dates, per-preference `workspaceId` + `enabled`,
// top-level `guidedRules`, and a last-positioned `appVersion` provenance stamp
// (DL13 decisions 1–3). There is no `scenario`/`ui` wrapper.
//
// Responsibilities, in dependency order:
//   1. source selection      — dispatch from the *lossless* YAML version scalar so
//                              only an integer scalar exactly equal to `1` selects
//                              V1 (`1.0`, `01`, `"1"`, booleans, null are not V1),
//                              matching Python's `int == 1` rule.
//   2. structural validation — exact V1 schemas that reuse the strict producer's
//                              entity/container/export/preference shapes (adding
//                              `workspaceId`/`enabled` and an optional weight), so
//                              an unknown field at ANY nesting level — including in
//                              a disabled record — is rejected in both languages.
//   3. optimize readiness    — incomplete dates/entities, missing/duplicate
//                              `workspaceId`, and the Guided rule kind/source
//                              relationship, reported with the structured contract.
//   4. strict projection     — a ready Workspace projects to the exact
//                              `CanonicalScenarioDocument` the strict producer
//                              emits (filter disabled, strip Workspace-only
//                              identity/guided metadata, fill default weights).
//   5. serialization         — durable UI state → flat Workspace V1 YAML backup.
//   6. hydration bridge       — a Workspace file → keyless-but-identity-bearing
//                              `ImportNormalizationTarget` (cards keep their
//                              `uid`/`disabled`, pins are fully restored).

import { z } from "zod";
import { parse, parseDocument, isAlias, isScalar, stringify } from "yaml";
import type { Scalar } from "yaml";
import { currentAppVersion } from "./app-version";
import { projectScenarioDocument } from "./canonical";
import {
  DEFAULT_WEIGHT,
  inferPreferenceType,
  normalizeAffinity,
  normalizeCount,
  normalizeCovering,
  normalizeDateGroup,
  normalizeIsoDate,
  normalizePeopleGroup,
  normalizePerson,
  normalizeRequirement,
  normalizeShiftRequest,
  normalizeShiftType,
  normalizeShiftTypeGroup,
  normalizeSuccession,
} from "./import-scenario";
import { validateScenario, type ScenarioValidationIssue } from "./serialize";
import { PREFERENCE_TYPE } from "./types";
import type {
  CanonicalDateGroup,
  CanonicalExportConfig,
  CanonicalPeopleContainer,
  CanonicalPreference,
  CanonicalScenarioDocument,
  CanonicalShiftTypesContainer,
  GuidedRuleConstraintKind,
  GuidedRulePin,
  ImportCardsByKind,
  ImportNormalizationTarget,
  IsoDate,
  ScenarioUiState,
  UiRequestCell,
} from "./types";
import {
  producerAffinity,
  producerCovering,
  producerDateGroup,
  producerExportConfig,
  producerMaxOneShiftPerDay,
  producerPeopleContainer,
  producerRequirement,
  producerShiftCount,
  producerShiftRequest,
  producerShiftTypesContainer,
  producerSuccessions,
} from "./schemas/producer";
import { zIsoDate, zWeight } from "./schemas/primitives";

/** The only Workspace document version this build understands. */
export const WORKSPACE_VERSION = 1 as const;

/**
 * The stable `workspaceId` stamped on the structurally-required, singleton
 * "at most one shift per day" preference. It has no authoring card of its own, so
 * — unlike every other preference, which carries its store card/cell `uid` — it
 * needs a fixed, collision-free identity to satisfy the "every record has a unique
 * workspaceId" rule.
 */
export const MAX_ONE_SHIFT_PER_DAY_WORKSPACE_ID = "max-one-shift-per-day";

/** The five pinnable constraint kinds and the strict preference `type` each pins. */
export const GUIDED_CONSTRAINT_KIND_TO_TYPE: Record<GuidedRuleConstraintKind, string> = {
  requirements: PREFERENCE_TYPE.shiftTypeRequirement,
  successions: PREFERENCE_TYPE.shiftTypeSuccessions,
  counts: PREFERENCE_TYPE.shiftCount,
  affinities: PREFERENCE_TYPE.shiftAffinity,
  coverings: PREFERENCE_TYPE.shiftTypeCovering,
};

// ---------------------------------------------------------------------------
// Emitted document shape
// ---------------------------------------------------------------------------

/** A Workspace preference record: a canonical preference body plus authoring id/flag. */
export type WorkspacePreferenceRecord = {
  workspaceId: string;
  enabled: boolean;
} & Record<string, unknown>;

/**
 * A top-level Guided rule — the exact, lossless serialization of the durable
 * store pin type (T14 `GuidedRulePin`): the pin `id`, the pinned constraint's
 * kind + id, the shortcut category, the required quick fields, and an optional
 * description. `id` and `quickFields` are required (no defaults), so the wire
 * record cannot accept a document the durable type could never author. Stripped
 * before solving.
 */
export interface WorkspaceGuidedRule {
  id: string;
  constraintKind: GuidedRuleConstraintKind;
  constraintId: string;
  category: string;
  quickFields: string[];
  description?: string;
}

/**
 * The flat Workspace V1 document the frontend emits for backup/sharing. Field
 * order here is the emitted YAML order: `workspaceVersion` first, `appVersion`
 * last (build provenance, never scheduling semantics — tech-plan §4).
 */
export interface WorkspaceDocumentV1 {
  workspaceVersion: typeof WORKSPACE_VERSION;
  apiVersion: string;
  description?: string;
  dates: {
    range: { startDate: IsoDate | null; endDate: IsoDate | null };
    groups?: CanonicalDateGroup[];
  };
  country?: string;
  people: CanonicalPeopleContainer;
  shiftTypes: CanonicalShiftTypesContainer;
  preferences: WorkspacePreferenceRecord[];
  guidedRules: WorkspaceGuidedRule[];
  export?: CanonicalExportConfig;
  appVersion?: string;
}

// ---------------------------------------------------------------------------
// Exact structural schema (reuses the strict producer's shapes; rejects unknowns)
// ---------------------------------------------------------------------------

// A Workspace preference is a strict producer preference body plus the two
// authoring keys, with the weight OPTIONAL (a backend default fills it). Reusing
// the producer variants keeps body validation — including unknown-field rejection
// in a DISABLED record — exactly aligned with the strict model and with Python's
// per-type authoring models. `workspaceId` is REQUIRED on every variant (including
// request cells), matching the Python `WorkspacePreference` model: a V1 record
// without a durable id is structurally invalid on both sides, never a store that
// silently mints a replacement identity (T17r review P1). `enabled` stays optional
// (an absent flag reads as enabled).
const zAuthoring = { workspaceId: z.string(), enabled: z.boolean().optional() };
const zOptionalWeight = { weight: zWeight.optional() };

const zWorkspacePreference = z.discriminatedUnion("type", [
  producerMaxOneShiftPerDay.extend(zAuthoring),
  producerShiftRequest.extend(zOptionalWeight).extend(zAuthoring),
  producerSuccessions.extend(zOptionalWeight).extend(zAuthoring),
  producerRequirement.extend(zOptionalWeight).extend(zAuthoring),
  producerShiftCount.extend(zOptionalWeight).extend(zAuthoring),
  producerAffinity.extend(zOptionalWeight).extend(zAuthoring),
  producerCovering.extend(zOptionalWeight).extend(zAuthoring),
]);

const zWorkspaceGuidedRule = z.strictObject({
  id: z.string(),
  constraintKind: z.enum(["requirements", "successions", "counts", "affinities", "coverings"]),
  constraintId: z.string(),
  category: z.string(),
  quickFields: z.array(z.string()),
  description: z.string().optional(),
});

// Dates carry a required range whose bounds may be null while setup is
// incomplete. `items` is backend-generated and ignored here; `groups` reuse the
// exact producer date-group schema.
const zWorkspaceDates = z.strictObject({
  range: z.strictObject({
    startDate: zIsoDate.nullish(),
    endDate: zIsoDate.nullish(),
  }),
  items: z.array(zIsoDate).optional(),
  groups: z.array(producerDateGroup).optional(),
});

/**
 * The strict Workspace V1 root schema. Every known boundary — entities,
 * containers, groups, export, and preference bodies — is validated with the exact
 * producer shapes (which reject unknown keys), so a known Workspace version cannot
 * smuggle an unknown field at any nesting level, including inside a disabled
 * preference (validated here, before disabled filtering).
 */
export const workspaceRootSchema = z.strictObject({
  workspaceVersion: z.literal(WORKSPACE_VERSION),
  apiVersion: z.string(),
  description: z.string().optional(),
  dates: zWorkspaceDates,
  country: z.string().optional(),
  people: producerPeopleContainer,
  shiftTypes: producerShiftTypesContainer,
  preferences: z.array(zWorkspacePreference).default([]),
  guidedRules: z.array(zWorkspaceGuidedRule).default([]),
  export: producerExportConfig.optional(),
  appVersion: z.string().optional(),
});

/** The parsed, structurally-valid Workspace document (schema output). */
export type ParsedWorkspace = z.infer<typeof workspaceRootSchema>;

// ---------------------------------------------------------------------------
// Structured issues (mirrors the Python normative issue codes, tech-plan §4)
// ---------------------------------------------------------------------------

/** Machine-readable issue codes shared with the Python `/optimize` envelope. */
export type WorkspaceIssueCode =
  | "workspace_incomplete"
  | "duplicate_workspace_id"
  | "unresolved_workspace_reference"
  | "unknown_field"
  | "missing_field"
  | "invalid_value"
  | "unsupported_value";

/** One deterministic location-and-reason entry, matching the Python issue shape. */
export interface WorkspaceIssue {
  path: Array<string | number>;
  code: WorkspaceIssueCode;
  message: string;
}

/** Sort issues by encoded path, then code, then message (Python `_sorted_issues`). */
function sortIssues(issues: WorkspaceIssue[]): WorkspaceIssue[] {
  return [...issues].sort((a, b) => {
    const pathA = JSON.stringify(a.path);
    const pathB = JSON.stringify(b.path);
    if (pathA !== pathB) return pathA < pathB ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.message !== b.message) return a.message < b.message ? -1 : 1;
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Source selection from the lossless YAML version scalar (tech-plan §4)
// ---------------------------------------------------------------------------

/** The submission source a document selects. */
export type WorkspaceSource =
  | { kind: "legacy" }
  | { kind: "v1" }
  | { kind: "unsupported"; value: unknown; display: string };

/** The YAML 1.2 core `int` tag URI (the only explicit scalar tag that selects V1). */
const INT_TAG = "tag:yaml.org,2002:int";

/**
 * Resolve a scalar's raw source text through the *same* integer rules the
 * authoritative Python `ruamel.yaml` safe loader applies (verified empirically),
 * returning the integer value or `null` when the source is not an integer literal.
 * Supports a leading sign, `_` digit separators, and decimal / leading-zero-octal
 * (`01`) / `0o` / `0x` / `0b` radices — so `1`, `+1`, `01`, `0o1`, `0x1`, `0b1`
 * all resolve, while a float (`1.0`), a quoted or non-numeric token resolves to
 * `null`. The presence of any non-integer character (a `.`, letters outside a
 * radix body) yields `null`, matching Python's `isinstance(value, int)` gate.
 */
function resolveRuamelInt(source: string): number | null {
  let s = source.trim();
  if (s === "") return null;
  let sign = 1;
  if (s[0] === "+" || s[0] === "-") {
    if (s[0] === "-") sign = -1;
    s = s.slice(1);
  }
  s = s.replace(/_/g, "");
  if (s === "") return null;
  let magnitude: number;
  if (/^0b[01]+$/.test(s)) magnitude = parseInt(s.slice(2), 2);
  else if (/^0x[0-9a-fA-F]+$/.test(s)) magnitude = parseInt(s.slice(2), 16);
  else if (/^0o[0-7]+$/.test(s)) magnitude = parseInt(s.slice(2), 8);
  else if (/^0[0-7]+$/.test(s)) magnitude = parseInt(s, 8);
  else if (/^(0|[1-9][0-9]*)$/.test(s)) magnitude = parseInt(s, 10);
  else return null;
  return Number.isNaN(magnitude) ? null : sign * magnitude;
}

/** Resolve an alias node to its anchored target; pass any other node through. */
function resolveVersionNode(
  document: ReturnType<typeof parseDocument>,
  node: unknown,
): Scalar | null {
  const target = isAlias(node) ? node.resolve(document) : node;
  return isScalar(target) ? (target as Scalar) : null;
}

/**
 * Select the strict-legacy or Workspace V1 path from raw YAML text, matching the
 * authoritative Python `ruamel.yaml` safe loader's resolution of the
 * `workspaceVersion` scalar (verified empirically against the vendored backend).
 * An absent key selects legacy. V1 is selected when the scalar — after resolving
 * an alias — is an *implicitly-typed plain scalar or an explicit `!!int`* whose
 * source resolves, under Python's integer rules, to exactly `1`. Every other form
 * (float `1.0`, quoted `"1"`, an explicit non-`int` tag, boolean, null, and any
 * unsupported integer) is unsupported, carrying the scalar's own source display.
 */
export function classifyWorkspaceSource(text: string): WorkspaceSource {
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(text, { keepSourceTokens: true });
  } catch {
    // A malformed document has no dispatchable version; treat it as legacy so the
    // legacy parser produces the canonical YAML syntax error.
    return { kind: "legacy" };
  }
  if (!document.has("workspaceVersion")) return { kind: "legacy" };

  const scalar = resolveVersionNode(document, document.get("workspaceVersion", true));
  const value = scalar ? scalar.value : undefined;
  const source = scalar && typeof scalar.source === "string" ? scalar.source : undefined;
  const display = source ?? String(value);

  if (scalar !== null && source !== undefined) {
    // Only a plain (unquoted) scalar or an explicit `!!int` is eligible; an
    // explicit non-`int` tag (e.g. `!!str 1`) or a quoted scalar is never V1.
    const eligible =
      scalar.tag === INT_TAG ||
      (scalar.tag === undefined && (scalar.type === undefined || scalar.type === "PLAIN"));
    if (eligible && resolveRuamelInt(source) === WORKSPACE_VERSION) {
      return { kind: "v1" };
    }
  }
  return { kind: "unsupported", value, display };
}

/** Parse Workspace (or legacy) YAML text into a raw JS value (no validation). */
export function parseWorkspaceYaml(text: string): unknown {
  return parse(text);
}

/**
 * Parse a document already dispatched to Workspace V1, normalizing its
 * `workspaceVersion` scalar to the canonical integer `1`. `classifyWorkspaceSource`
 * is the authority on the version (it accepts every ruamel-integer form Python
 * does — e.g. `01`, `0b1`, `+1`, `!!int 1`), but the plain YAML-1.2 `parse` here
 * leaves some of those scalars as a non-`1` value (a binary `0b1` becomes the
 * string `"0b1"`), which the structural `z.literal(1)` guard would then wrongly
 * reject on a correctly-dispatched V1 file. Coercing the version — only ever on the
 * v1 branch, after the classifier resolved it to `1` — keeps the two loaders in
 * parity without loosening any other field. A non-object parse is returned
 * unchanged so the structural schema still rejects it.
 */
export function parseWorkspaceV1Document(text: string): unknown {
  const parsed = parseWorkspaceYaml(text);
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    (parsed as Record<string, unknown>).workspaceVersion = WORKSPACE_VERSION;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Optimize readiness — incomplete dates/entities, workspaceId + Guided integrity
// ---------------------------------------------------------------------------

/**
 * Empty preference `workspaceId` across every card and request variant, matching
 * the Python authority's falsy-id readiness rule (`not workspace_id`,
 * `core/nurse_scheduling/server/workspace.py`): a present-but-empty durable id is
 * treated as missing. The schema requires the id KEY, so an ABSENT id is a
 * structural `invalid` (like Python's Pydantic `missing_field`); an empty string
 * passes the schema on both sides, so it is caught HERE as `workspace_incomplete`
 * rather than structurally — preserving the same rejection CATEGORY as Python
 * (`workspace_not_ready`, not `invalid`). No trimming: only the exact empty string
 * is falsy, exactly as Python's `not workspace_id` (a whitespace id is truthy on
 * both sides).
 */
function emptyPreferenceIdIssues(workspace: ParsedWorkspace): WorkspaceIssue[] {
  const issues: WorkspaceIssue[] = [];
  workspace.preferences.forEach((preference, index) => {
    if (preference.workspaceId === "") {
      issues.push({
        path: ["preferences", index, "workspaceId"],
        code: "workspace_incomplete",
        message: "The preference is missing a workspaceId.",
      });
    }
  });
  return issues;
}

/**
 * Duplicate preference `workspaceId` across EVERY card and request variant. An
 * empty id is reported as missing by `emptyPreferenceIdIssues` and, exactly like
 * Python's readiness loop (which `continue`s on a falsy id), is skipped here so two
 * empty ids read as two missing-id issues, never a spurious duplicate. Mirrors
 * Python's `duplicate_workspace_id` readiness issue and is the shared source of
 * truth for both the load path (`checkWorkspaceIdentityIntegrity`) and optimize
 * readiness.
 */
function duplicatePreferenceIdIssues(workspace: ParsedWorkspace): WorkspaceIssue[] {
  const issues: WorkspaceIssue[] = [];
  const seenIds = new Set<string>();
  workspace.preferences.forEach((preference, index) => {
    const workspaceId = preference.workspaceId;
    if (workspaceId === "") return;
    if (seenIds.has(workspaceId)) {
      issues.push({
        path: ["preferences", index, "workspaceId"],
        code: "duplicate_workspace_id",
        message: `Duplicate preference workspaceId: ${workspaceId}.`,
      });
    }
    seenIds.add(workspaceId);
  });
  return issues;
}

/**
 * Structural Workspace identity integrity, independent of optimize readiness: an
 * empty OR duplicate preference `workspaceId` (across cards AND request cells) must
 * block a Load (hydration) before `normalizeWorkspaceToImportTarget`/`loadScenario`
 * can carry it into durable state — otherwise an empty id reaches `ensureCellUid`
 * and is silently replaced with a minted UUID, or two records collide on one
 * durable id, and only a later export detects it (T17r review P1). An ABSENT id is
 * already rejected structurally by the required-`workspaceId` schema. Mirrors the
 * identity half of Python's readiness check, which runs before strict projection.
 */
export function checkWorkspaceIdentityIntegrity(workspace: ParsedWorkspace): WorkspaceIssue[] {
  return sortIssues([
    ...emptyPreferenceIdIssues(workspace),
    ...duplicatePreferenceIdIssues(workspace),
  ]);
}

/**
 * Collect Workspace readiness issues: incomplete dates, empty people/shift-type
 * collections, duplicate preference `workspaceId`, and Guided rule integrity
 * (unique rule id, resolvable `constraintId`, and a `constraintKind` that matches
 * the pinned preference's type). This mirrors the workspace-structural half of
 * Python's `_readiness_issues`; full scheduling reference resolution
 * (person/shift/date) is delegated to the strict producer and backend boundary.
 */
export function checkWorkspaceReadiness(workspace: ParsedWorkspace): WorkspaceIssue[] {
  const issues: WorkspaceIssue[] = [];

  if (workspace.dates.range.startDate == null) {
    issues.push({
      path: ["dates", "range", "startDate"],
      code: "workspace_incomplete",
      message: "The schedule start date is not set.",
    });
  }
  if (workspace.dates.range.endDate == null) {
    issues.push({
      path: ["dates", "range", "endDate"],
      code: "workspace_incomplete",
      message: "The schedule end date is not set.",
    });
  }
  if (workspace.people.items.length === 0) {
    issues.push({
      path: ["people", "items"],
      code: "workspace_incomplete",
      message: "At least one person is required.",
    });
  }
  if (workspace.shiftTypes.items.length === 0) {
    issues.push({
      path: ["shiftTypes", "items"],
      code: "workspace_incomplete",
      message: "At least one shift type is required.",
    });
  }

  // The schema requires the id key, so the two remaining identity defects a
  // valid-shaped document can carry are an empty id and a duplicate id. An empty id
  // is skipped from the declared-type map, exactly as Python's readiness loop
  // `continue`s past a falsy id.
  const declaredTypes = new Map<string, string>();
  for (const preference of workspace.preferences) {
    if (preference.workspaceId === "") continue;
    declaredTypes.set(preference.workspaceId, preference.type);
  }
  issues.push(...emptyPreferenceIdIssues(workspace));
  issues.push(...duplicatePreferenceIdIssues(workspace));
  issues.push(...guidedRuleIssues(workspace, declaredTypes));
  return sortIssues(issues);
}

/**
 * Validate each Guided rule's uniqueness and kind/source relationship: a unique
 * pin `id`, at most one rule per `(constraintKind, constraintId)` source (the
 * durable T14 one-pin-per-source invariant), a resolvable `constraintId`, and a
 * `constraintKind` that matches the pinned preference's type.
 */
function guidedRuleIssues(
  workspace: ParsedWorkspace,
  declaredTypes: Map<string, string>,
): WorkspaceIssue[] {
  const issues: WorkspaceIssue[] = [];
  const seenRuleIds = new Set<string>();
  const seenSources = new Set<string>();
  workspace.guidedRules.forEach((rule, ruleIndex) => {
    if (seenRuleIds.has(rule.id)) {
      issues.push({
        path: ["guidedRules", ruleIndex, "id"],
        code: "duplicate_workspace_id",
        message: `Duplicate guided rule id: ${rule.id}.`,
      });
    }
    seenRuleIds.add(rule.id);

    const source = `${rule.constraintKind}\u0000${rule.constraintId}`;
    if (seenSources.has(source)) {
      issues.push({
        path: ["guidedRules", ruleIndex, "constraintId"],
        code: "duplicate_workspace_id",
        message: `Duplicate guided rule source: (${rule.constraintKind}, ${rule.constraintId}).`,
      });
    }
    seenSources.add(source);

    const pinnedType = declaredTypes.get(rule.constraintId);
    if (pinnedType === undefined) {
      issues.push({
        path: ["guidedRules", ruleIndex, "constraintId"],
        code: "unresolved_workspace_reference",
        message: `Guided rule references unknown preference workspaceId: ${rule.constraintId}.`,
      });
      return;
    }
    if (pinnedType !== GUIDED_CONSTRAINT_KIND_TO_TYPE[rule.constraintKind]) {
      issues.push({
        path: ["guidedRules", ruleIndex, "constraintKind"],
        code: "unresolved_workspace_reference",
        message: `Guided rule constraintKind '${rule.constraintKind}' does not match the pinned preference '${rule.constraintId}'.`,
      });
    }
  });
  return issues;
}

/**
 * Structural Guided-record integrity, independent of optimize readiness: a
 * duplicate pin `id` or a duplicate `(constraintKind, constraintId)` source both
 * corrupt the durable T14 one-pin-per-source invariant, so they must block a Load
 * (hydration) even though a Workspace backup otherwise preserves incomplete work
 * (DL12 §2). Reference resolution and kind/source-type matching stay a readiness
 * concern (they depend on the pinned preference existing). Mirrors the identity
 * half of Python's `_guided_rule_issues`, which runs before `_strict_dict`.
 */
export function checkWorkspaceGuidedIntegrity(workspace: ParsedWorkspace): WorkspaceIssue[] {
  const issues: WorkspaceIssue[] = [];
  const seenRuleIds = new Set<string>();
  const seenSources = new Set<string>();
  workspace.guidedRules.forEach((rule, ruleIndex) => {
    if (seenRuleIds.has(rule.id)) {
      issues.push({
        path: ["guidedRules", ruleIndex, "id"],
        code: "duplicate_workspace_id",
        message: `Duplicate guided rule id: ${rule.id}.`,
      });
    }
    seenRuleIds.add(rule.id);

    const source = `${rule.constraintKind}\u0000${rule.constraintId}`;
    if (seenSources.has(source)) {
      issues.push({
        path: ["guidedRules", ruleIndex, "constraintId"],
        code: "duplicate_workspace_id",
        message: `Duplicate guided rule source: (${rule.constraintKind}, ${rule.constraintId}).`,
      });
    }
    seenSources.add(source);
  });
  return sortIssues(issues);
}

// ---------------------------------------------------------------------------
// Strict projection (filter disabled, strip Workspace-only identity/guided data)
// ---------------------------------------------------------------------------

/**
 * Project a Workspace document into the backend-facing `CanonicalScenarioDocument`
 * the strict producer consumes: drop `enabled: false` preferences and strip each
 * survivor's `workspaceId`/`enabled`; drop `workspaceVersion` and `guidedRules`
 * entirely. Field order and canonicalization match the strict producer, so a
 * Workspace round-trip and a direct strict projection converge on identical bytes.
 * An absent weight is filled with the backend default so an externally-authored
 * Workspace validates identically to its legacy equivalent.
 */
export function projectWorkspaceToStrict(workspace: ParsedWorkspace): CanonicalScenarioDocument {
  const preferences: CanonicalPreference[] = [];
  for (const preference of workspace.preferences) {
    if (preference.enabled === false) continue;
    const body: Record<string, unknown> = { ...preference };
    delete body.workspaceId;
    delete body.enabled;
    const type = body.type;
    if (typeof type === "string" && body.weight === undefined && type in DEFAULT_WEIGHT) {
      body.weight = DEFAULT_WEIGHT[type];
    }
    preferences.push(body as unknown as CanonicalPreference);
  }

  const doc: CanonicalScenarioDocument = {
    appVersion: workspace.appVersion,
    apiVersion: workspace.apiVersion,
    description: workspace.description,
    dates: {
      range: {
        startDate: workspace.dates.range.startDate as IsoDate,
        endDate: workspace.dates.range.endDate as IsoDate,
      },
      ...(workspace.dates.groups && workspace.dates.groups.length > 0
        ? { groups: workspace.dates.groups as CanonicalDateGroup[] }
        : {}),
    },
    country: workspace.country,
    people: workspace.people as unknown as CanonicalPeopleContainer,
    shiftTypes: workspace.shiftTypes as unknown as CanonicalShiftTypesContainer,
    preferences,
    export: workspace.export as CanonicalExportConfig | undefined,
  };

  for (const key of ["appVersion", "description", "country", "export"] as const) {
    if (doc[key] === undefined) delete doc[key];
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Orchestrated optimize conversion (source select → validate → ready → strict)
// ---------------------------------------------------------------------------

/** The outcome of converting a document for optimization. */
export type WorkspaceConversionResult =
  | { status: "ok"; document: CanonicalScenarioDocument }
  | { status: "legacy" }
  | { status: "unsupported_version"; value: unknown; issues: WorkspaceIssue[] }
  | { status: "not_ready"; issues: WorkspaceIssue[] }
  | { status: "invalid"; issues: WorkspaceIssue[] };

/**
 * Convert raw YAML toward the strict scheduling model, following the same fixed
 * stages as the Python boundary: lossless source selection → structural validation
 * → readiness → strict producer preflight. A document with no `workspaceVersion`
 * returns `legacy` so the caller routes it through the existing strict/import path
 * unchanged.
 */
export function convertWorkspaceForOptimize(text: string): WorkspaceConversionResult {
  const source = classifyWorkspaceSource(text);
  if (source.kind === "legacy") return { status: "legacy" };
  if (source.kind === "unsupported") {
    const message = `Unsupported workspaceVersion: ${source.display}.`;
    return {
      status: "unsupported_version",
      value: source.value,
      issues: [{ path: ["workspaceVersion"], code: "unsupported_value", message }],
    };
  }

  const structural = workspaceRootSchema.safeParse(parseWorkspaceV1Document(text));
  if (!structural.success) return { status: "invalid", issues: zodIssues(structural.error) };
  const workspace = structural.data;

  const readiness = checkWorkspaceReadiness(workspace);
  if (readiness.length > 0) return { status: "not_ready", issues: readiness };

  const strict = projectWorkspaceToStrict(workspace);
  const validation = validateScenario(strict);
  if (!validation.ok) return { status: "invalid", issues: producerIssues(validation.issues) };
  return { status: "ok", document: validation.document };
}

/** Translate a producer validation issue (dotted path) into a Workspace issue. */
function producerIssues(issues: ScenarioValidationIssue[]): WorkspaceIssue[] {
  return sortIssues(
    issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.split(".") : [],
      code: "invalid_value" as const,
      message: issue.message,
    })),
  );
}

/** Translate a Zod error into Workspace issues, expanding unknown-key groups. */
function zodIssues(error: z.ZodError): WorkspaceIssue[] {
  const issues: WorkspaceIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        issues.push({
          path: [...issue.path.map(pathSegment), key],
          code: "unknown_field",
          message: `Unrecognized field: ${key}.`,
        });
      }
      continue;
    }
    const raw = issue as { input?: unknown };
    const missing = issue.code === "invalid_type" && raw.input === undefined;
    issues.push({
      path: issue.path.map(pathSegment),
      code: missing ? "missing_field" : "invalid_value",
      message: issue.message,
    });
  }
  return sortIssues(issues);
}

function pathSegment(segment: PropertyKey): string | number {
  return typeof segment === "number" ? segment : String(segment);
}

// ---------------------------------------------------------------------------
// Serialization: durable UI state → flat Workspace V1 YAML
// ---------------------------------------------------------------------------

/**
 * Build the flat Workspace V1 document from durable UI state, preserving authoring
 * state the strict projection drops: incomplete (`null`) dates, disabled
 * preferences (as `enabled: false`), each preference's stable `workspaceId`, and
 * the full Guided pins. Preference bodies and their emission order come from the
 * shared canonical projection with disabled cards force-included, so this builder's
 * field mapping stays in lockstep with the strict producer's (drift is caught by
 * the differential gate). Emitted preference `workspaceId`s are asserted unique.
 */
export function buildWorkspaceDocument(state: ScenarioUiState): WorkspaceDocumentV1 {
  const canonical = projectScenarioDocument(withAllCardsEnabled(state));
  const meta = preferenceMeta(state);
  const preferences: WorkspacePreferenceRecord[] = canonical.preferences.map(
    (preference, index) => ({
      workspaceId: meta[index].workspaceId,
      enabled: meta[index].enabled,
      ...preference,
    }),
  );

  const document: WorkspaceDocumentV1 = {
    workspaceVersion: WORKSPACE_VERSION,
    apiVersion: state.meta.apiVersion,
    ...(state.meta.description !== undefined ? { description: state.meta.description } : {}),
    dates: {
      range: {
        startDate: state.rangeStart ? state.rangeStart : null,
        endDate: state.rangeEnd ? state.rangeEnd : null,
      },
      ...(canonical.dates.groups ? { groups: canonical.dates.groups } : {}),
    },
    ...(state.meta.country !== undefined ? { country: state.meta.country } : {}),
    people: canonical.people,
    shiftTypes: canonical.shiftTypes,
    preferences,
    guidedRules: buildGuidedRules(state),
    ...(canonical.export ? { export: canonical.export } : {}),
    appVersion: currentAppVersion(),
  };
  return document;
}

/**
 * Serialize durable UI state to Workspace V1 YAML for backup/sharing. The dump is
 * YAML 1.2 with a deterministic key order (`workspaceVersion` first, `appVersion`
 * last), Unicode preserved, anchors/aliases disabled, LF newlines, and a single
 * trailing newline — the same wire conventions as the canonical strict dumper, so
 * the Python `YAML(typ="safe")` loader parses it identically. Backups preserve
 * incomplete work (DL12 D2): a null date or a disabled record serializes cleanly.
 */
export function serializeWorkspace(state: ScenarioUiState): string {
  return serializeWorkspaceDocument(buildWorkspaceDocument(state));
}

/**
 * Dump an already-built Workspace document to YAML 1.2 with the canonical wire
 * conventions (deterministic order, no aliases, LF, one trailing newline), after
 * asserting its emitted preference identity is unique. The seam the anonymised
 * backup path reuses so a transformed document serializes exactly like a plain one.
 */
export function serializeWorkspaceDocument(document: WorkspaceDocumentV1): string {
  assertUniqueWorkspaceIds(document.preferences);
  return stringify(document, { version: "1.2", aliasDuplicateObjects: false });
}

/** Map durable Guided rule pins to the lossless shared `guidedRules` records. */
function buildGuidedRules(state: ScenarioUiState): WorkspaceGuidedRule[] {
  return state.guidedRulePins.map((pin) => ({
    id: pin.id,
    constraintKind: pin.constraintKind,
    constraintId: pin.constraintId,
    category: pin.category,
    quickFields: pin.quickFields,
    ...(pin.description !== undefined ? { description: pin.description } : {}),
  }));
}

/** A shallow clone of `state` with every card's guided `disabled` flag cleared. */
function withAllCardsEnabled(state: ScenarioUiState): ScenarioUiState {
  const enable = <T extends { disabled?: boolean }>(cards: T[]): T[] =>
    cards.map((card) => ({ ...card, disabled: false }));
  return {
    ...state,
    cardsByKind: {
      requirements: enable(state.cardsByKind.requirements),
      successions: enable(state.cardsByKind.successions),
      counts: enable(state.cardsByKind.counts),
      affinities: enable(state.cardsByKind.affinities),
      coverings: enable(state.cardsByKind.coverings),
    },
  };
}

/**
 * The per-preference `workspaceId` + `enabled` list, in the exact order the shared
 * canonical projection emits preferences: the singleton max-one-shift-per-day
 * first, then each card kind carrying its store `uid`, then the matrix request
 * cells carrying their durable `uid`. Aligning this order with `mapPreferences`
 * lets `buildWorkspaceDocument` zip identity onto the canonical bodies by index.
 */
function preferenceMeta(state: ScenarioUiState): Array<{ workspaceId: string; enabled: boolean }> {
  const meta: Array<{ workspaceId: string; enabled: boolean }> = [
    { workspaceId: MAX_ONE_SHIFT_PER_DAY_WORKSPACE_ID, enabled: true },
  ];
  const cards = state.cardsByKind;
  for (const kind of [
    "requirements",
    "successions",
    "counts",
    "affinities",
    "coverings",
  ] as const) {
    for (const card of cards[kind]) {
      meta.push({ workspaceId: card.uid, enabled: card.disabled !== true });
    }
  }
  for (const cell of state.reqData) {
    meta.push({ workspaceId: requestCellWorkspaceId(cell), enabled: true });
  }
  return meta;
}

/**
 * A matrix request cell's durable `workspaceId` — its store `uid`, allocated at
 * every creation path (paint, Normal-mode edit) and preserved across edits, and
 * assigned to any legacy/external cell during hydration (`ensureCellUid`). By the
 * time durable state is serialized every cell must carry a `uid`; a missing one is
 * an identity bug, not a fallback to synthesize (T17r review P1 — no content-based
 * emission authority). Emission-time collisions are still caught downstream by
 * `assertUniqueWorkspaceIds`.
 */
function requestCellWorkspaceId(cell: UiRequestCell): string {
  if (!cell.uid) {
    throw new Error(
      `Request cell (${String(cell.person)}, ${String(cell.date)}) is missing a durable uid at emission.`,
    );
  }
  return cell.uid;
}

/** Throw if two emitted preferences share a `workspaceId` (an identity bug). */
function assertUniqueWorkspaceIds(preferences: WorkspacePreferenceRecord[]): void {
  const seen = new Set<string>();
  for (const preference of preferences) {
    if (seen.has(preference.workspaceId)) {
      throw new Error(`Duplicate Workspace preference workspaceId: ${preference.workspaceId}.`);
    }
    seen.add(preference.workspaceId);
  }
}

// ---------------------------------------------------------------------------
// Hydration bridge: Workspace file → identity-bearing import target
// ---------------------------------------------------------------------------

/**
 * Normalize a validated Workspace document into an `ImportNormalizationTarget` that
 * preserves authoring identity — cards carry their `uid` (from `workspaceId`) and
 * `disabled` (from `enabled: false`), matrix cells carry their `uid`, and Guided
 * pins are fully reconstructed — so a Download → Load round-trip restores the
 * complete authoring state (DL12). Incomplete (`null`) dates load as empty strings.
 * Preference bodies reuse the shared legacy normalizers; only identity is re-attached.
 */
export function normalizeWorkspaceToImportTarget(
  workspace: ParsedWorkspace,
): ImportNormalizationTarget {
  const cardsByKind: ImportCardsByKind = {
    requirements: [],
    successions: [],
    counts: [],
    affinities: [],
    coverings: [],
  };
  const reqData: UiRequestCell[] = [];
  let maxOneShiftPerDay: { description?: string } | undefined;

  for (const preference of workspace.preferences) {
    const record = preference as Record<string, unknown>;
    const disabled = preference.enabled === false;
    const workspaceId =
      typeof preference.workspaceId === "string" ? preference.workspaceId : undefined;
    switch (inferPreferenceType(record)) {
      case PREFERENCE_TYPE.maxOneShiftPerDay:
        maxOneShiftPerDay =
          typeof record.description === "string" ? { description: record.description } : {};
        break;
      case PREFERENCE_TYPE.shiftTypeRequirement:
        cardsByKind.requirements.push(
          withIdentity(normalizeRequirement(record), workspaceId, disabled),
        );
        break;
      case PREFERENCE_TYPE.shiftTypeSuccessions:
        cardsByKind.successions.push(
          withIdentity(normalizeSuccession(record), workspaceId, disabled),
        );
        break;
      case PREFERENCE_TYPE.shiftCount:
        cardsByKind.counts.push(withIdentity(normalizeCount(record), workspaceId, disabled));
        break;
      case PREFERENCE_TYPE.shiftAffinity:
        cardsByKind.affinities.push(withIdentity(normalizeAffinity(record), workspaceId, disabled));
        break;
      case PREFERENCE_TYPE.shiftTypeCovering:
        cardsByKind.coverings.push(withIdentity(normalizeCovering(record), workspaceId, disabled));
        break;
      case PREFERENCE_TYPE.shiftRequest:
        reqData.push(...withCellIdentity(normalizeShiftRequest(record), workspaceId));
        break;
    }
  }

  const target: ImportNormalizationTarget = {
    meta: cleanMeta({
      apiVersion: workspace.apiVersion,
      appVersion: workspace.appVersion,
      description: workspace.description,
      country: workspace.country,
    }),
    staff: workspace.people.items.map((item) => normalizePerson(item as never)),
    staffGroups: (workspace.people.groups ?? []).map((group) =>
      normalizePeopleGroup(group as never),
    ),
    shifts: workspace.shiftTypes.items.map((item) => normalizeShiftType(item as never)),
    shiftGroups: (workspace.shiftTypes.groups ?? []).map((group) =>
      normalizeShiftTypeGroup(group as never),
    ),
    rangeStart: isoOrEmpty(workspace.dates.range.startDate),
    rangeEnd: isoOrEmpty(workspace.dates.range.endDate),
    dateGroups: (workspace.dates.groups ?? []).map((group) => normalizeDateGroup(group as never)),
    reqData,
    exportLayout: {
      formatting: (workspace.export?.formatting ??
        []) as unknown as ImportNormalizationTarget["exportLayout"]["formatting"],
      extraColumns: (workspace.export?.extraColumns ??
        []) as unknown as ImportNormalizationTarget["exportLayout"]["extraColumns"],
      extraRows: (workspace.export?.extraRows ??
        []) as unknown as ImportNormalizationTarget["exportLayout"]["extraRows"],
    },
    cardsByKind,
    guidedRulePins: workspace.guidedRules.map(
      (rule): GuidedRulePin => ({
        id: rule.id,
        constraintKind: rule.constraintKind,
        constraintId: rule.constraintId,
        category: rule.category,
        quickFields: rule.quickFields,
        ...(rule.description !== undefined ? { description: rule.description } : {}),
      }),
    ),
  };
  if (maxOneShiftPerDay !== undefined) target.maxOneShiftPerDay = maxOneShiftPerDay;
  return target;
}

/** Attach a card body's restored `uid`/`disabled` (both omitted when absent/false). */
function withIdentity<Body extends object>(
  body: Body,
  workspaceId: string | undefined,
  disabled: boolean,
): Body & { uid?: string; disabled?: boolean } {
  return {
    ...body,
    ...(workspaceId !== undefined ? { uid: workspaceId } : {}),
    ...(disabled ? { disabled: true } : {}),
  };
}

/**
 * Attach the restored `uid` to a shift-request's matrix cell(s). A frontend backup
 * emits one cell per request preference, so identity is preserved 1:1; an
 * externally-authored list request that expands to several cells suffixes the extra
 * ones so every cell still gets a unique, non-positional id.
 */
function withCellIdentity(
  cells: UiRequestCell[],
  workspaceId: string | undefined,
): UiRequestCell[] {
  if (workspaceId === undefined) return cells;
  return cells.map((cell, index) => ({
    ...cell,
    uid: cells.length === 1 ? workspaceId : `${workspaceId}#${index}`,
  }));
}

function cleanMeta<T extends Record<string, unknown>>(meta: T): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(meta)) {
    if (meta[key] !== undefined && meta[key] !== null) out[key] = meta[key];
  }
  return out as T;
}

function isoOrEmpty(value: IsoDate | null | undefined): IsoDate {
  return typeof value === "string" ? normalizeIsoDate(value) : "";
}
