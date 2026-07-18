// Canonical projection (T18) — the pure, deterministic map from a scenario's
// durable/importable state to the backend-facing `CanonicalScenarioDocument`.
//
// Per the tech-plan §4 flow (`UI state → toCanonicalScenarioDocument (strip F2
// fields, map markers) → producer schema + refinements → YAML`), this function
// does exactly three things and no more:
//
//   1. Strip F2-only fields (`_k`, `uid`, `disabled`, `applied`, card markers,
//      request `kind`).
//   2. Map markers (`tag: "contracted_hours"` → `hoursContract`).
//   3. Structurally reshape the UI slices into the canonical containers.
//
// It deliberately does NOT apply value refinements (implicit→explicit `ALL`,
// zero-rest omission, etc.) — those belong to T05's producer schema, which
// consumes this output. The function is side-effect-free and order-preserving.
//
// The projection reads only backend-facing *body* fields (never a card's F2
// `uid`), so it is generalized (`projectScenarioDocument`) over both durable UI
// state and the keyless import target. `toCanonicalScenarioDocument` keeps its
// `ScenarioUiState` signature as the thin, unchanged public entry (T04 store,
// serializer, and fingerprint all call it); `projectImportTarget` (T17b) reuses
// the same generalized core on the keyless `ImportNormalizationTarget` without
// inventing any uids, keeping the pre-commit load projection pure/deterministic.

import {
  isDayStateSelector,
  LEAVE_PIN_WEIGHT,
  PREFERENCE_TYPE,
  RESERVED_SHIFT_TYPE,
  type AffinityCardBody,
  type CanonicalDateGroup,
  type CanonicalExportConfig,
  type CanonicalPeopleGroup,
  type CanonicalPerson,
  type CanonicalPreference,
  type CanonicalScenarioDocument,
  type CanonicalShiftCountPreference,
  type CanonicalShiftType,
  type CanonicalShiftTypeGroup,
  type CountCardBody,
  type CoveringCardBody,
  type ExportLayout,
  type RequirementCardBody,
  type ScenarioStateShared,
  type ScenarioUiState,
  type SuccessionCardBody,
  type UiDateGroup,
  type UiPeopleGroup,
  type UiPerson,
  type UiShiftType,
  type UiShiftTypeGroup,
} from "./types";

// A projectable card is a keyless backend body plus the *optional* guided
// `disabled` marker the projection consults. Both a full `…Card` (marker + body,
// from `ScenarioUiState`) and a bare `…CardBody` (from the import target) satisfy
// it, and neither the projection nor this type ever reads a card's `uid`.
type Projectable<Body> = Body & { disabled?: boolean };

/** The card collection the projection accepts — durable cards or keyless bodies. */
export interface ProjectableCardsByKind {
  requirements: Projectable<RequirementCardBody>[];
  successions: Projectable<SuccessionCardBody>[];
  counts: Projectable<CountCardBody>[];
  affinities: Projectable<AffinityCardBody>[];
  coverings: Projectable<CoveringCardBody>[];
}

/**
 * The generalized projection source: every field shared by durable UI state and
 * the keyless import target, with card bodies that carry no store identity. Both
 * `ScenarioUiState` and `ImportNormalizationTarget` structurally satisfy it.
 */
export type ProjectableScenario = ScenarioStateShared & {
  cardsByKind: ProjectableCardsByKind;
};

/** Drop `undefined`-valued keys so canonical objects carry no absent fields. */
function compact<T extends object>(obj: T): T {
  const source = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out as T;
}

function mapPerson(person: UiPerson): CanonicalPerson {
  return compact({
    id: person.id,
    description: person.description,
    history: person.history,
  });
}

function mapPeopleGroup(group: UiPeopleGroup): CanonicalPeopleGroup {
  return compact({
    id: group.id,
    description: group.description,
    members: group.members,
  });
}

function mapShiftType(shiftType: UiShiftType): CanonicalShiftType {
  return compact({
    id: shiftType.id,
    description: shiftType.description,
    durationMinutes: shiftType.durationMinutes,
    startTime: shiftType.startTime,
    endTime: shiftType.endTime,
    restMinutes: shiftType.restMinutes,
  });
}

function mapShiftTypeGroup(group: UiShiftTypeGroup): CanonicalShiftTypeGroup {
  return compact({
    id: group.id,
    description: group.description,
    members: group.members,
  });
}

function mapDateGroup(group: UiDateGroup): CanonicalDateGroup {
  return compact({
    id: group.id,
    description: group.description,
    members: group.members,
  });
}

// Fixed, deterministic preference emission order: the backend-required
// max-one-shift-per-day first, then each card kind, then matrix requests.
function mapPreferences(source: ProjectableScenario): CanonicalPreference[] {
  const preferences: CanonicalPreference[] = [];

  preferences.push(
    compact({
      type: PREFERENCE_TYPE.maxOneShiftPerDay,
      description: source.maxOneShiftPerDay?.description,
    }),
  );

  const cards: ProjectableCardsByKind = source.cardsByKind;

  for (const card of cards.requirements) {
    if (card.disabled) continue;
    preferences.push(
      compact({
        type: PREFERENCE_TYPE.shiftTypeRequirement,
        description: card.description,
        shiftType: card.shiftType,
        shiftTypeCoefficients: card.shiftTypeCoefficients,
        requiredNumPeople: card.requiredNumPeople,
        qualifiedPeople: card.qualifiedPeople,
        preferredNumPeople: card.preferredNumPeople,
        date: card.date,
        weight: card.weight,
      }),
    );
  }

  for (const card of cards.successions) {
    if (card.disabled) continue;
    preferences.push(
      compact({
        type: PREFERENCE_TYPE.shiftTypeSuccessions,
        description: card.description,
        person: card.person,
        pattern: card.pattern,
        date: card.date,
        weight: card.weight,
      }),
    );
  }

  for (const card of cards.counts) {
    if (card.disabled) continue;
    // Marker map: a contracted-hours card (`tag` + `policy` are both required by
    // the discriminated `CountCard` union, so no partial marker can reach here)
    // → the backend `hoursContract` marker. The UI-only `unit`/`tag`/`applied`
    // markers are dropped; the canonical `unit` is always "half-hour".
    const hoursContract =
      card.tag === "contracted_hours"
        ? { unit: "half-hour" as const, policy: card.policy }
        : undefined;
    const count: CanonicalShiftCountPreference = compact({
      type: PREFERENCE_TYPE.shiftCount,
      description: card.description,
      person: card.person,
      countDates: card.countDates,
      countShiftTypes: card.countShiftTypes,
      countShiftTypeCoefficients: card.countShiftTypeCoefficients,
      expression: card.expression,
      target: card.target,
      hoursContract,
      weight: card.weight,
    });
    preferences.push(count);
  }

  for (const card of cards.affinities) {
    if (card.disabled) continue;
    preferences.push(
      compact({
        type: PREFERENCE_TYPE.shiftAffinity,
        description: card.description,
        date: card.date,
        people1: card.people1,
        people2: card.people2,
        shiftTypes: card.shiftTypes,
        weight: card.weight,
      }),
    );
  }

  for (const card of cards.coverings) {
    if (card.disabled) continue;
    preferences.push(
      compact({
        type: PREFERENCE_TYPE.shiftTypeCovering,
        description: card.description,
        date: card.date,
        preceptors: card.preceptors,
        preceptees: card.preceptees,
        shiftTypes: card.shiftTypes,
        weight: card.weight,
      }),
    );
  }

  // The person×date matrix folds into shift-request preferences. `kind` is the
  // single authority: the backend selector and weight are *derived* from it, so
  // a leave cell can never serialize as a worked shift.
  for (const cell of source.reqData) {
    let shiftType: string;
    let weight: number;
    switch (cell.kind) {
      case "leave":
        shiftType = RESERVED_SHIFT_TYPE.leave;
        weight = LEAVE_PIN_WEIGHT;
        break;
      case "off":
        shiftType = RESERVED_SHIFT_TYPE.off;
        weight = cell.weight;
        break;
      case "request":
        // A worked-shift request must not carry a reserved *day-state* selector
        // (OFF/LEAVE) directly — those are authored via `kind`. Reject here
        // (before `kind` is dropped) so `{ kind: "request", shiftType: "LEAVE" }`
        // can never serialize as a worked-shift request with an editable weight.
        // String literals cannot be excluded from `ShiftTypeRef` at the type
        // level, so the projection is this invariant's enforcement boundary.
        //
        // `ALL` is intentionally allowed: `shiftType: ALL` is a backend-valid
        // "work any shift" worked-day request. Group selectors whose expansion
        // includes OFF/LEAVE are NOT detected here — that is a C3-class semantic
        // refinement (needs group_map expansion) and is T05's producer-validation
        // responsibility, fully detectable post-projection from the canonical
        // doc's `shiftTypes.groups` + the selector.
        if (isDayStateSelector(cell.shiftType)) {
          throw new Error(
            `A "request" matrix cell must target a worked shift type or group, not the ` +
              `reserved day-state "${cell.shiftType}". Author leave/off via kind: "leave" | "off".`,
          );
        }
        shiftType = cell.shiftType;
        weight = cell.weight;
        break;
    }
    preferences.push(
      compact({
        type: PREFERENCE_TYPE.shiftRequest,
        description: cell.description,
        person: cell.person,
        date: cell.date,
        shiftType,
        weight,
      }),
    );
  }

  return preferences;
}

function mapExport(layout: ExportLayout): CanonicalExportConfig | undefined {
  const formatting = layout.formatting.map(({ uid: _uid, ...rule }) => compact(rule));
  const extraColumns = layout.extraColumns.map(({ uid: _uid, ...column }) => compact(column));
  const extraRows = layout.extraRows.map(({ uid: _uid, ...row }) => compact(row));

  if (formatting.length === 0 && extraColumns.length === 0 && extraRows.length === 0) {
    return undefined;
  }

  return compact({
    formatting: formatting.length > 0 ? formatting : undefined,
    extraColumns: extraColumns.length > 0 ? extraColumns : undefined,
    extraRows: extraRows.length > 0 ? extraRows : undefined,
  });
}

/**
 * Project any projectable scenario (durable UI state OR the keyless import
 * target) into the backend-facing canonical document. Pure and deterministic:
 * same input ⇒ identical output, arrays kept in source order, F2-only fields
 * stripped, contracted-hours markers mapped. Never reads a card `uid`, so it
 * needs none — the keyless import target projects without inventing identity.
 * Empty group collections and an empty export layout are omitted (minimal-dump
 * parity).
 */
export function projectScenarioDocument(source: ProjectableScenario): CanonicalScenarioDocument {
  const peopleGroups = source.staffGroups.map(mapPeopleGroup);
  const shiftTypeGroups = source.shiftGroups.map(mapShiftTypeGroup);
  const dateGroups = source.dateGroups.map(mapDateGroup);

  const doc: CanonicalScenarioDocument = {
    appVersion: source.meta.appVersion,
    apiVersion: source.meta.apiVersion,
    description: source.meta.description,
    dates: compact({
      range: { startDate: source.rangeStart, endDate: source.rangeEnd },
      groups: dateGroups.length > 0 ? dateGroups : undefined,
    }),
    country: source.meta.country,
    people: compact({
      items: source.staff.map(mapPerson),
      groups: peopleGroups.length > 0 ? peopleGroups : undefined,
    }),
    shiftTypes: compact({
      items: source.shifts.map(mapShiftType),
      groups: shiftTypeGroups.length > 0 ? shiftTypeGroups : undefined,
    }),
    preferences: mapPreferences(source),
    export: mapExport(source.exportLayout),
  };

  return compact(doc);
}

/**
 * Project durable UI state into the backend-facing canonical document. The
 * unchanged public entry (T04 store, serializer, fingerprint) — a thin,
 * type-narrowed call into the generalized `projectScenarioDocument`.
 */
export function toCanonicalScenarioDocument(state: ScenarioUiState): CanonicalScenarioDocument {
  return projectScenarioDocument(state);
}

/**
 * Construct an empty durable scenario state — the zero value the import path and
 * "New scenario" reset build from. `apiVersion` defaults to the backend's
 * current schema version; the range is left blank for the caller to fill.
 */
export function createEmptyScenarioUiState(apiVersion = "alpha"): ScenarioUiState {
  return {
    meta: { apiVersion },
    staff: [],
    staffGroups: [],
    shifts: [],
    shiftGroups: [],
    rangeStart: "",
    rangeEnd: "",
    dateGroups: [],
    cardsByKind: {
      requirements: [],
      successions: [],
      counts: [],
      affinities: [],
      coverings: [],
    },
    reqData: [],
    exportLayout: { formatting: [], extraColumns: [], extraRows: [] },
  };
}
