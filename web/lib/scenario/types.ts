// Scenario contract — shared domain types (T18).
//
// This is the single TypeScript source of truth for scenario state that both the
// state store (T04) and the validator/serializer (T05) import *unchanged*. It has
// no runtime dependencies and pulls in no libraries (zod lives in T05).
//
// Two shapes are modelled here, and the split is the F2 serialization boundary
// (design README §"Serialization boundary", tech-plan §4):
//
//   • `ScenarioUiState`            — the durable UI/authoring state. Carries F2-only
//                                    fields (React keys, guided on/off flags, card
//                                    UI markers) that never reach the backend.
//   • `CanonicalScenarioDocument`  — the backend-facing shape. It mirrors the
//                                    vendored Python `NurseSchedulingData`
//                                    (core/nurse_scheduling/models.py) exactly —
//                                    this is the binding C1 contract, the object a
//                                    YAML 1.2 dump in T05 serializes.
//
// The pure projection between them lives in `./canonical`; the dirty-baseline
// fingerprint over the canonical shape lives in `./hash`.

// ---------------------------------------------------------------------------
// Primitive reference aliases (kept faithful to the Python model unions).
// ---------------------------------------------------------------------------

/** Person / people-group id. `Person.id` is `int | str` in the backend model. */
export type PersonId = number | string;
/** Shift-type id. `ShiftType.id` is `int | str` in the backend model. */
export type ShiftTypeId = number | string;
/** People / shift-type / date group id — always a string in the backend model. */
export type GroupId = string;
/** A calendar date as an ISO `YYYY-MM-DD` string (the YAML dump form). */
export type IsoDate = string;

/** A reference to a person or a people-group by id (`int | str`). */
export type PersonRef = number | string;
/**
 * A reference to a shift type or shift-type-group by id. Preference *selectors*
 * are typed `str` in the backend (never bare `int`), so refs are strings even
 * though a shift-type id may itself be numeric.
 */
export type ShiftTypeRef = string;
/**
 * A shift-type reference in the *export* layout. Unlike preference selectors, the
 * backend export models accept `list[int | str]` (`ExportCellFormattingRule`,
 * `ExportExtraColumn`, `ExportExtraRow`), so numeric shift ids are valid here.
 */
export type ExportShiftTypeRef = number | string;
/**
 * A date reference: a day-of-month/day-index integer, an id/keyword/range string
 * (e.g. `"WEEKDAY"`, `"2026-02-01~2026-02-07"`, a date-group id), or an ISO date.
 */
export type DateRef = number | string;

/** Shift-type-group member — references a shift-type id or nested group id. */
export type ShiftTypeGroupMember = number | string;
/** Date-group member — a date id, a group id, or a concrete date. */
export type DateGroupMember = number | string | IsoDate;

/**
 * A preference weight. Integers are ordinary soft weights; the only permitted
 * non-integers are `Infinity` / `-Infinity` (hard constraints), matching the
 * backend rule that float weights may only be `.inf` / `-.inf`.
 */
export type Weight = number;

/** A `[shiftTypeId, coefficient]` pair — the backend's `tuple[str, int]`. */
export type CoefficientEntry = [ShiftTypeRef, number];

/** A person-ref list that may contain nested aggregate groups. */
export type NestedPersonRefList = Array<PersonRef | PersonRef[]>;
/** A shift-type-ref list that may contain nested aggregate groups. */
export type NestedShiftTypeRefList = Array<ShiftTypeRef | ShiftTypeRef[]>;

// ---------------------------------------------------------------------------
// Canonical document (backend-facing) — mirrors core/nurse_scheduling/models.py.
// ---------------------------------------------------------------------------

/** Canonical preference `type` discriminants (backend constant strings). */
export const PREFERENCE_TYPE = {
  maxOneShiftPerDay: "at most one shift per day",
  shiftTypeRequirement: "shift type requirement",
  shiftRequest: "shift request",
  shiftTypeSuccessions: "shift type successions",
  shiftCount: "shift count",
  shiftAffinity: "shift affinity",
  shiftTypeCovering: "shift type covering",
} as const;

/** Reserved shift-type selectors (see core/nurse_scheduling/constants.py). */
export const RESERVED_SHIFT_TYPE = {
  all: "ALL",
  off: "OFF",
  leave: "LEAVE",
} as const;

/**
 * The single, non-editable weight a LEAVE pin serializes with. LEAVE is a hard
 * leave pin honoured regardless of weight (C3 INV3); the UI does not expose an
 * editable weight for it (T11), so the projection stamps this constant.
 */
export const LEAVE_PIN_WEIGHT: Weight = Infinity;

/** All reserved shift-type keywords (`ALL`/`OFF`/`LEAVE`), as a lookup set. */
export const RESERVED_SHIFT_TYPE_VALUES: readonly string[] = [
  RESERVED_SHIFT_TYPE.all,
  RESERVED_SHIFT_TYPE.off,
  RESERVED_SHIFT_TYPE.leave,
];

/** Whether `selector` is any reserved keyword (`ALL`/`OFF`/`LEAVE`). */
export function isReservedShiftTypeSelector(selector: string): boolean {
  return RESERVED_SHIFT_TYPE_VALUES.includes(selector);
}

/**
 * The reserved day-state selectors `OFF`/`LEAVE`. These are authored via a
 * matrix cell's `kind`, so a `kind: "request"` cell must never target one
 * directly. `ALL` is deliberately excluded: `shiftType: ALL` is a backend-valid
 * "work any shift" worked-day request (`preference_types.py`), not a day-state.
 */
export const DAY_STATE_SELECTOR_VALUES: readonly string[] = [
  RESERVED_SHIFT_TYPE.off,
  RESERVED_SHIFT_TYPE.leave,
];

/** Whether `selector` is a reserved day-state (`OFF`/`LEAVE`). */
export function isDayStateSelector(selector: string): boolean {
  return DAY_STATE_SELECTOR_VALUES.includes(selector);
}

export interface CanonicalPerson {
  id: PersonId;
  description?: string;
  history?: string[];
}

export interface CanonicalPeopleGroup {
  id: GroupId;
  description?: string;
  members: PersonRef[];
}

export interface CanonicalShiftType {
  id: ShiftTypeId;
  description?: string;
  /** Authoring-only paid working minutes (Option B); ignored by the solver. */
  durationMinutes?: number;
  /** 30-minute-grid `"HH:00"`/`"HH:30"` clock time. */
  startTime?: string;
  /** 30-minute-grid `"HH:00"`/`"HH:30"` clock time. */
  endTime?: string;
  /** Unpaid break in minutes; absence is the only persisted zero-rest form. */
  restMinutes?: number;
}

export interface CanonicalShiftTypeGroup {
  id: GroupId;
  description?: string;
  members: ShiftTypeGroupMember[];
}

export interface CanonicalDateGroup {
  id: GroupId;
  description?: string;
  members: DateGroupMember[];
}

export interface CanonicalDateRange {
  startDate: IsoDate;
  endDate: IsoDate;
}

export interface CanonicalDateContainer {
  // The backend's `items` field is auto-generated from `range` and rejected if
  // supplied, so it is intentionally absent from this producer type.
  range: CanonicalDateRange;
  /** Authored, optional date groups (emitted when non-empty). */
  groups?: CanonicalDateGroup[];
}

export interface CanonicalPeopleContainer {
  items: CanonicalPerson[];
  groups?: CanonicalPeopleGroup[];
}

export interface CanonicalShiftTypesContainer {
  items: CanonicalShiftType[];
  groups?: CanonicalShiftTypeGroup[];
}

/** Contracted-hours marker; `unit` is fixed to `"half-hour"` (DL09 D1/D4). */
export interface HoursContractMetadata {
  unit: "half-hour";
  policy: "exact" | "range";
}

export interface CanonicalMaxOneShiftPerDayPreference {
  type: typeof PREFERENCE_TYPE.maxOneShiftPerDay;
  description?: string;
}

export interface CanonicalShiftRequestPreference {
  type: typeof PREFERENCE_TYPE.shiftRequest;
  description?: string;
  person: PersonRef | PersonRef[];
  date: DateRef | DateRef[];
  shiftType: ShiftTypeRef | ShiftTypeRef[];
  weight: Weight;
}

export interface CanonicalShiftTypeSuccessionsPreference {
  type: typeof PREFERENCE_TYPE.shiftTypeSuccessions;
  description?: string;
  person: PersonRef | PersonRef[];
  pattern: NestedShiftTypeRefList;
  date?: DateRef | DateRef[];
  weight: Weight;
}

export interface CanonicalShiftTypeRequirementPreference {
  type: typeof PREFERENCE_TYPE.shiftTypeRequirement;
  description?: string;
  shiftType: ShiftTypeRef | NestedShiftTypeRefList;
  shiftTypeCoefficients?: CoefficientEntry[];
  requiredNumPeople: number;
  qualifiedPeople?: PersonRef | PersonRef[];
  preferredNumPeople?: number;
  date?: DateRef | DateRef[];
  weight: Weight;
}

export interface CanonicalShiftCountPreference {
  type: typeof PREFERENCE_TYPE.shiftCount;
  description?: string;
  person: PersonRef | PersonRef[];
  countDates: DateRef | DateRef[];
  countShiftTypes: ShiftTypeRef | ShiftTypeRef[];
  countShiftTypeCoefficients?: CoefficientEntry[];
  expression: string | string[];
  target: number | number[];
  /** Authoring-only marker (accept-and-ignore by the solver). */
  hoursContract?: HoursContractMetadata;
  weight: Weight;
}

export interface CanonicalShiftAffinityPreference {
  type: typeof PREFERENCE_TYPE.shiftAffinity;
  description?: string;
  date: DateRef | DateRef[];
  people1: NestedPersonRefList;
  people2: NestedPersonRefList;
  shiftTypes: NestedShiftTypeRefList;
  weight: Weight;
}

export interface CanonicalShiftTypeCoveringPreference {
  type: typeof PREFERENCE_TYPE.shiftTypeCovering;
  description?: string;
  /** Absent / `None` means all dates. */
  date?: DateRef | DateRef[];
  preceptors: NestedPersonRefList;
  preceptees: NestedPersonRefList;
  shiftTypes: NestedShiftTypeRefList;
  weight: Weight;
}

export type CanonicalPreference =
  | CanonicalMaxOneShiftPerDayPreference
  | CanonicalShiftRequestPreference
  | CanonicalShiftTypeSuccessionsPreference
  | CanonicalShiftTypeRequirementPreference
  | CanonicalShiftCountPreference
  | CanonicalShiftAffinityPreference
  | CanonicalShiftTypeCoveringPreference;

// Export layout (canonical) — mirrors ExportConfig and its rule union.

/** Six-hex-digit `#rrggbb` color string. */
export type HexColor = string;

export interface CanonicalBaseFormattingRule {
  description?: string;
  backgroundColor?: HexColor;
  bottomBorderColor?: HexColor;
  rightBorderColor?: HexColor;
  fontColor?: HexColor;
}

export interface CanonicalExportPersonFormattingRule extends CanonicalBaseFormattingRule {
  type: "row" | "people header" | "history";
  people: PersonRef[];
}

export interface CanonicalExportDateFormattingRule extends CanonicalBaseFormattingRule {
  type: "column" | "date header";
  dates: DateRef[];
}

export interface CanonicalExportHistoryHeaderFormattingRule extends CanonicalBaseFormattingRule {
  type: "history header";
}

export interface CanonicalExportPreferenceCondition {
  types: Array<"shift request">;
  requestShape?: Array<
    | "person-item-to-date-item"
    | "people-group-to-date-item"
    | "person-item-to-date-group"
    | "people-group-to-date-group"
    | "ALL"
  >;
  satisfied?: boolean;
  weightRange?: number[];
}

export interface CanonicalExportFormattingCondition {
  preference: CanonicalExportPreferenceCondition;
}

export interface CanonicalExportFormattingNote {
  text: string;
}

export interface CanonicalExportCellFormattingRule extends CanonicalBaseFormattingRule {
  type: "cell";
  appendText?: string;
  note?: CanonicalExportFormattingNote;
  people: PersonRef[];
  dates: DateRef[];
  shiftTypes: ExportShiftTypeRef[];
  when?: CanonicalExportFormattingCondition;
}

export type CanonicalExportFormattingRule =
  | CanonicalExportPersonFormattingRule
  | CanonicalExportDateFormattingRule
  | CanonicalExportHistoryHeaderFormattingRule
  | CanonicalExportCellFormattingRule;

export interface CanonicalExportExtraColumn {
  description?: string;
  rightBorderColor?: HexColor;
  type: "count";
  header: string;
  countShiftTypes: ExportShiftTypeRef[];
  countShiftTypeCoefficients?: CoefficientEntry[];
  countDates: DateRef[];
}

export interface CanonicalExportExtraRow {
  description?: string;
  bottomBorderColor?: HexColor;
  type: "count";
  header: string;
  countShiftTypes: ExportShiftTypeRef[];
  countPeople: PersonRef[];
}

export interface CanonicalExportConfig {
  formatting?: CanonicalExportFormattingRule[];
  extraColumns?: CanonicalExportExtraColumn[];
  extraRows?: CanonicalExportExtraRow[];
}

/**
 * The backend-facing scenario document. Field-for-field identical to the Python
 * `NurseSchedulingData` root model. Optional containers/fields are *omitted*
 * (not `null`) when empty, matching a minimal YAML dump and the backend's
 * `default_factory` behaviour.
 */
export interface CanonicalScenarioDocument {
  appVersion?: string;
  apiVersion: string;
  description?: string;
  dates: CanonicalDateContainer;
  country?: string;
  people: CanonicalPeopleContainer;
  shiftTypes: CanonicalShiftTypesContainer;
  preferences: CanonicalPreference[];
  export?: CanonicalExportConfig;
}

// ---------------------------------------------------------------------------
// UI / authoring state (F2 producer side) — the store's durable slice.
// ---------------------------------------------------------------------------

// F2-only fields (design README): `_k`/`uid` React keys, the guided on/off
// `disabled` flag, and the card UI markers `unit`/`tag`/`applied`. None of these
// reach the canonical document — `toCanonicalScenarioDocument` drops them.
//
// `guidedShortcuts` is deliberately *not* modelled here: it is a UI projection
// over the real records, not durable scenario data or a backend concept.

/** Scenario-level metadata (the non-collection canonical fields). */
export interface ScenarioMeta {
  /** Backend schema version, e.g. `"alpha"`. */
  apiVersion: string;
  appVersion?: string;
  description?: string;
  country?: string;
}

export interface UiPerson {
  /** F2 React key. */
  _k?: string;
  id: PersonId;
  description?: string;
  history?: string[];
}

export interface UiPeopleGroup {
  _k?: string;
  id: GroupId;
  description?: string;
  members: PersonRef[];
}

export interface UiShiftType {
  _k?: string;
  id: ShiftTypeId;
  description?: string;
  durationMinutes?: number;
  startTime?: string;
  endTime?: string;
  restMinutes?: number;
}

export interface UiShiftTypeGroup {
  _k?: string;
  id: GroupId;
  description?: string;
  members: ShiftTypeGroupMember[];
}

export interface UiDateGroup {
  _k?: string;
  id: GroupId;
  description?: string;
  members: DateGroupMember[];
}

/** F2 markers shared by every rule card. */
export interface CardMarkers {
  /** F2 React key / stable card handle. */
  uid: string;
  /** Guided on/off flag — a disabled card is excluded from the canonical doc. */
  disabled?: boolean;
  /** Guided-layer "applied/pinned" UI marker. */
  applied?: boolean;
}

// Card *bodies* hold the backend-facing preference fields only — no F2 markers.
// A durable card is a body + `CardMarkers` (store-assigned `uid`, guided flags);
// the keyless bodies are exactly what the import path (T05) normalizes into,
// before T04 hydrates them with identity. The backend preference models carry no
// UID (models.py), so the import target must not require one.

export interface RequirementCardBody {
  description?: string;
  shiftType: ShiftTypeRef | NestedShiftTypeRefList;
  shiftTypeCoefficients?: CoefficientEntry[];
  requiredNumPeople: number;
  qualifiedPeople?: PersonRef | PersonRef[];
  preferredNumPeople?: number;
  date?: DateRef | DateRef[];
  weight: Weight;
}
export interface RequirementCard extends CardMarkers, RequirementCardBody {}

export interface SuccessionCardBody {
  description?: string;
  person: PersonRef | PersonRef[];
  pattern: NestedShiftTypeRefList;
  date?: DateRef | DateRef[];
  weight: Weight;
}
export interface SuccessionCard extends CardMarkers, SuccessionCardBody {}

export interface CountCardBodyBase {
  description?: string;
  person: PersonRef | PersonRef[];
  countDates: DateRef | DateRef[];
  countShiftTypes: ShiftTypeRef | ShiftTypeRef[];
  countShiftTypeCoefficients?: CoefficientEntry[];
  expression: string | string[];
  target: number | number[];
  weight: Weight;
}
/** An ordinary shift count — the contracted-hours markers are forbidden. */
export interface OrdinaryCountCardBody extends CountCardBodyBase {
  tag?: undefined;
  policy?: undefined;
  unit?: undefined;
}
/**
 * A contracted-hours shift count. `tag` + `policy` are *both* required so a
 * partial marker cannot exist and be silently downgraded on projection; `tag`
 * maps to the backend `hoursContract` marker (`unit` is a UI-only display hint).
 */
export interface ContractedHoursCountCardBody extends CountCardBodyBase {
  tag: "contracted_hours";
  policy: "exact" | "range";
  unit?: string;
}
export type CountCardBody = OrdinaryCountCardBody | ContractedHoursCountCardBody;
export type OrdinaryCountCard = CardMarkers & OrdinaryCountCardBody;
export type ContractedHoursCountCard = CardMarkers & ContractedHoursCountCardBody;
export type CountCard = OrdinaryCountCard | ContractedHoursCountCard;

export interface AffinityCardBody {
  description?: string;
  date: DateRef | DateRef[];
  people1: NestedPersonRefList;
  people2: NestedPersonRefList;
  shiftTypes: NestedShiftTypeRefList;
  weight: Weight;
}
export interface AffinityCard extends CardMarkers, AffinityCardBody {}

export interface CoveringCardBody {
  description?: string;
  date?: DateRef | DateRef[];
  preceptors: NestedPersonRefList;
  preceptees: NestedPersonRefList;
  shiftTypes: NestedShiftTypeRefList;
  weight: Weight;
}
export interface CoveringCard extends CardMarkers, CoveringCardBody {}

/** The five Advanced card editors (durable, store-keyed), keyed by kind. */
export interface CardsByKind {
  requirements: RequirementCard[];
  successions: SuccessionCard[];
  counts: CountCard[];
  affinities: AffinityCard[];
  coverings: CoveringCard[];
}

/** The keyless card bodies the import path produces (no store identity yet). */
export interface ImportCardsByKind {
  requirements: RequirementCardBody[];
  successions: SuccessionCardBody[];
  counts: CountCardBody[];
  affinities: AffinityCardBody[];
  coverings: CoveringCardBody[];
}

// A person×date matrix cell — a discriminated union with a single source of
// truth (`kind`). The backend selector/weight are *derived* from `kind` on
// projection, so a leave cell can never silently serialize as a worked shift:
//   leave   → selector "LEAVE", hard `LEAVE_PIN_WEIGHT` (no editable weight)
//   off     → selector "OFF", soft `weight`
//   request → an authored worked `shiftType` + signed `weight`
export type RequestKind = "request" | "leave" | "off";

export interface UiRequestCellBase {
  /** F2 React key. */
  uid?: string;
  person: PersonRef;
  date: DateRef;
  description?: string;
}
export interface UiLeaveRequestCell extends UiRequestCellBase {
  kind: "leave";
}
export interface UiOffRequestCell extends UiRequestCellBase {
  kind: "off";
  weight: Weight;
}
export interface UiShiftRequestCell extends UiRequestCellBase {
  kind: "request";
  /**
   * A worked shift-type / group selector, or `ALL` ("work any shift"). Never a
   * reserved day-state (`OFF`/`LEAVE`) — those are authored via `kind`. TS
   * cannot subtract the day-state literals from `ShiftTypeRef` (`string`), so
   * the projection rejects them here (see `toCanonicalScenarioDocument`).
   */
  shiftType: ShiftTypeRef;
  weight: Weight;
}
export type UiRequestCell = UiLeaveRequestCell | UiOffRequestCell | UiShiftRequestCell;

/** An export-layout row carrying an F2 React key over its canonical rule. */
export type ExportFormattingRuleUi = CanonicalExportFormattingRule & { uid?: string };
export type ExportExtraColumnUi = CanonicalExportExtraColumn & { uid?: string };
export type ExportExtraRowUi = CanonicalExportExtraRow & { uid?: string };

export interface ExportLayout {
  formatting: ExportFormattingRuleUi[];
  extraColumns: ExportExtraColumnUi[];
  extraRows: ExportExtraRowUi[];
}

/** Fields shared by durable UI state and the keyless import target. */
export interface ScenarioStateShared {
  meta: ScenarioMeta;
  staff: UiPerson[];
  staffGroups: UiPeopleGroup[];
  shifts: UiShiftType[];
  shiftGroups: UiShiftTypeGroup[];
  /** Roster range start, ISO `YYYY-MM-DD`. */
  rangeStart: IsoDate;
  /** Roster range end, ISO `YYYY-MM-DD`. */
  rangeEnd: IsoDate;
  dateGroups: UiDateGroup[];
  reqData: UiRequestCell[];
  exportLayout: ExportLayout;
  /**
   * The backend-required, structurally-locked "at most one shift per day"
   * preference. Always emitted into the canonical document; only its optional
   * description is authorable.
   */
  maxOneShiftPerDay?: { description?: string };
}

/** The constraint kinds a Guided rule pin can reference — same union as `CardKind`. */
export type GuidedRuleConstraintKind = keyof CardsByKind;

/**
 * Durable shortcut metadata pinning an existing Advanced constraint card into
 * Guided Rules (T14, tech-plan §3). `constraintId` is the source card's stable
 * `uid` — the same identity T17's Workspace boundary calls `workspaceId` — never
 * a duplicated constraint value. Unpinning removes only this shortcut; the
 * pinned constraint is untouched. `category`/`description` are shortcut display
 * metadata (renaming the displayed rule title updates the source constraint's
 * own description when the mapper supports it — T14b). `quickFields` names which
 * of the source card's mapper-declared numeric fields the pin exposes as an
 * inline Adjust control.
 */
export interface GuidedRulePin {
  id: string;
  constraintKind: GuidedRuleConstraintKind;
  constraintId: string;
  category: string;
  description?: string;
  quickFields: string[];
}

/**
 * Durable scenario/authoring state — the persisted slice (T04) and the producer
 * source (T05). Everything here projects to a `CanonicalScenarioDocument` via
 * `toCanonicalScenarioDocument`, dropping the F2-only fields above.
 *
 * `guidedRulePins` is intentionally NOT part of `ScenarioStateShared`: it is
 * local-store-only durable metadata (IndexedDB + zundo), not yet part of the
 * import/export boundary — `ImportNormalizationTarget` has no pin field until
 * T17 wires the Workspace YAML `guidedRules` contract (tech-plan §4).
 */
export interface ScenarioUiState extends ScenarioStateShared {
  cardsByKind: CardsByKind;
  guidedRulePins: GuidedRulePin[];
}

/**
 * The exact shape T05's import schema normalizes *into*. Load/import parses raw
 * YAML and produces this **keyless** target: card bodies with no store-assigned
 * `uid` (the backend YAML has none). T04 then hydrates it into `ScenarioUiState`
 * by assigning identity. Entity/request/export `uid`s are already optional, so
 * only the cards differ from `ScenarioUiState`.
 */
export interface ImportNormalizationTarget extends ScenarioStateShared {
  cardsByKind: ImportCardsByKind;
}
