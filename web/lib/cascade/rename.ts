// Rename cascade (T07) — `renameEntity(state, domain, oldId, newId)` rewrites the
// id everywhere it is referenced and returns a NEW immutable `ScenarioUiState`
// (spec 06 FR-RI-03..07/13; tech-plan §4). A collision (item↔item, item↔group,
// reserved) throws before any state is built, so the input is left untouched —
// atomic (design review finding #5).
//
// Surfaces rewritten, per domain: the entity/group definition + same-domain group
// members; the five preference cards + coefficient tuples; the person×date matrix;
// people history (shift-type renames only); and the Export Layout rows (finding
// #4 — the prototype gap). Each op is one pure transform; the store wires the
// single undo/persist entry (T04 `mutateScenario`).

import type {
  CoefficientEntry,
  ExportLayout,
  ScenarioUiState,
  UiPerson,
  UiRequestCell,
} from "@/lib/scenario";
import { assertNoRenameCollision, type EntityDomain, type EntityRef } from "./domain";
import { CARD_COEFFICIENT_FIELD, CARD_REF_FIELDS, type CardKind } from "./card-fields";
import { renameRefTree, sameRef, type RefLeaf, type RefTree } from "./reference-tree";

/** Rename the id element of every coefficient tuple equal to `oldId`. */
function renameCoefficients(
  coefficients: CoefficientEntry[] | undefined,
  oldId: EntityRef,
  newId: string,
): CoefficientEntry[] | undefined {
  return coefficients?.map(([id, coefficient]) =>
    sameRef(id, oldId) ? [newId, coefficient] : [id, coefficient],
  );
}

/** Rewrite every domain-referencing field (and shift coefficients) on one card. */
function renameCard<T extends object>(
  card: T,
  kind: CardKind,
  domain: EntityDomain,
  oldId: EntityRef,
  newId: string,
): T {
  const next = { ...card } as Record<string, unknown>;
  for (const field of CARD_REF_FIELDS[kind][domain]) {
    if (next[field] !== undefined) {
      next[field] = renameRefTree(next[field] as RefTree, oldId, newId);
    }
  }
  if (domain === "shift") {
    const coefficientField = CARD_COEFFICIENT_FIELD[kind];
    if (coefficientField && next[coefficientField] !== undefined) {
      next[coefficientField] = renameCoefficients(
        next[coefficientField] as CoefficientEntry[],
        oldId,
        newId,
      );
    }
  }
  return next as T;
}

/** Rewrite the matrix cell field for `domain` (shiftType only on request cells). */
function renameReqData(
  reqData: UiRequestCell[],
  domain: EntityDomain,
  oldId: EntityRef,
  newId: string,
): UiRequestCell[] {
  return reqData.map((cell) => {
    if (domain === "person") {
      return sameRef(cell.person, oldId) ? { ...cell, person: newId } : cell;
    }
    if (domain === "date") {
      return sameRef(cell.date, oldId) ? { ...cell, date: newId } : cell;
    }
    // shift: only a worked-shift request carries a `shiftType`; leave/off cells
    // derive the reserved LEAVE/OFF selector and are never rename targets.
    if (cell.kind === "request" && sameRef(cell.shiftType, oldId)) {
      return { ...cell, shiftType: newId };
    }
    return cell;
  });
}

/**
 * Rewrite people history (shift-type renames only — spec 06 FR-RI-04). A
 * missing/undefined history becomes `[]` (FR-RI-04, matching the prototype's
 * `history?.map(...) || []`), so every person carries an explicit history array
 * after a shift-type rename.
 */
function renameHistory(staff: UiPerson[], oldId: EntityRef, newId: string): UiPerson[] {
  return staff.map((person) => ({
    ...person,
    history: (person.history ?? []).map((h) => (sameRef(h, oldId) ? newId : h)),
  }));
}

/** Rewrite Export Layout rows for `domain` (finding #4). Rules keep their uid. */
function renameExportLayout(
  layout: ExportLayout,
  domain: EntityDomain,
  oldId: EntityRef,
  newId: string,
): ExportLayout {
  const rename = (ids: RefLeaf[]): RefLeaf[] => ids.map((id) => (sameRef(id, oldId) ? newId : id));
  return {
    formatting: layout.formatting.map((rule) => {
      if (domain === "person" && "people" in rule) return { ...rule, people: rename(rule.people) };
      if (domain === "date" && "dates" in rule) return { ...rule, dates: rename(rule.dates) };
      if (domain === "shift" && "shiftTypes" in rule) {
        return { ...rule, shiftTypes: rename(rule.shiftTypes) };
      }
      return rule;
    }),
    extraColumns: layout.extraColumns.map((column) => {
      if (domain === "date") return { ...column, countDates: rename(column.countDates) };
      if (domain === "shift") {
        return {
          ...column,
          countShiftTypes: rename(column.countShiftTypes),
          countShiftTypeCoefficients: renameCoefficients(
            column.countShiftTypeCoefficients,
            oldId,
            newId,
          ),
        };
      }
      return column;
    }),
    extraRows: layout.extraRows.map((row) => {
      if (domain === "person") return { ...row, countPeople: rename(row.countPeople) };
      if (domain === "shift") return { ...row, countShiftTypes: rename(row.countShiftTypes) };
      return row;
    }),
  };
}

/**
 * Rewrite the entity/group definition (its own id) and any same-domain group
 * members that reference it — nested group references cascade in place with member
 * positions preserved (spec 06 FR-RI-16/17, AC-RI-19). Returns the domain's
 * definition slices as a partial to merge into the new state.
 */
function renameDefinitions(
  state: ScenarioUiState,
  domain: EntityDomain,
  oldId: EntityRef,
  newId: string,
): Partial<ScenarioUiState> {
  const renameGroup = <G extends { id: string; members: RefLeaf[] }>(group: G): G => {
    let next = group;
    if (sameRef(group.id, oldId)) next = { ...next, id: newId };
    if (next.members.some((m) => sameRef(m, oldId))) {
      next = { ...next, members: next.members.map((m) => (sameRef(m, oldId) ? newId : m)) };
    }
    return next;
  };
  switch (domain) {
    case "person":
      return {
        staff: state.staff.map((p) => (sameRef(p.id, oldId) ? { ...p, id: newId } : p)),
        staffGroups: state.staffGroups.map(renameGroup),
      };
    case "shift":
      return {
        shifts: state.shifts.map((s) => (sameRef(s.id, oldId) ? { ...s, id: newId } : s)),
        shiftGroups: state.shiftGroups.map(renameGroup),
        // Shift-type renames also rewrite the shift-type ids stored in history.
        staff: renameHistory(state.staff, oldId, newId),
      };
    case "date":
      return { dateGroups: state.dateGroups.map(renameGroup) };
  }
}

/**
 * Rename an entity or group and cascade the id everywhere it is referenced.
 * Throws {@link RenameCollisionError} (state untouched) when `newId` collides with
 * an existing id in `domain` or a reserved keyword. Rename-to-self is a no-op.
 * Pure: returns a new `ScenarioUiState`, never mutating the input.
 */
export function renameEntity(
  state: ScenarioUiState,
  domain: EntityDomain,
  oldId: EntityRef,
  newId: string,
): ScenarioUiState {
  assertNoRenameCollision(state, domain, oldId, newId);
  if (sameRef(oldId, newId)) return state;

  const cards = state.cardsByKind;
  return {
    ...state,
    ...renameDefinitions(state, domain, oldId, newId),
    cardsByKind: {
      requirements: cards.requirements.map((c) =>
        renameCard(c, "requirements", domain, oldId, newId),
      ),
      successions: cards.successions.map((c) => renameCard(c, "successions", domain, oldId, newId)),
      counts: cards.counts.map((c) => renameCard(c, "counts", domain, oldId, newId)),
      affinities: cards.affinities.map((c) => renameCard(c, "affinities", domain, oldId, newId)),
      coverings: cards.coverings.map((c) => renameCard(c, "coverings", domain, oldId, newId)),
    },
    reqData: renameReqData(state.reqData, domain, oldId, newId),
    exportLayout: renameExportLayout(state.exportLayout, domain, oldId, newId),
  };
}

/** Acceptance-matrix alias for {@link renameEntity} (`applyRename(state, …)`). */
export const applyRename = renameEntity;

/**
 * Remap a batch of date-id references old-id → new-id across the three span-id
 * surfaces — the person×date matrix (`reqData`), the export-layout date rows/
 * columns, and date-group members — WITHOUT the {@link renameEntity} collision
 * assertion. `renameEntity` cannot be used here: `assertNoRenameCollision`
 * (`domain.ts` `DATE_LITERAL_PATTERNS`) reads every date literal (`DD`/`MM-DD`/
 * `YYYY-MM-DD`) as a reserved id and throws `RenameCollisionError("reserved")` on
 * every date target. The range-change cascade uses this to migrate the dates that
 * stay in range but are re-keyed when the roster span class changes.
 *
 * Only generated-id → generated-id pairs belong in `remap`: keyword group members
 * (`WEEKEND`/weekday names/`ALL`) and imported range-literals (`"01~15"`) are
 * span-independent, never appear as keys, and pass through untouched; full-ISO
 * preference-card date fields are not span ids and are deliberately NOT a surface
 * here. The `DD`/`MM-DD`/`YYYY-MM-DD` id-spaces are disjoint, so no new-id ever
 * equals another pair's old-id — applying the pairs in sequence never chains.
 * Pure: returns a new `ScenarioUiState`, never mutating the input.
 */
export function remapDateReferences(
  state: ScenarioUiState,
  remap: ReadonlyMap<string, string>,
): ScenarioUiState {
  if (remap.size === 0) return state;
  let reqData = state.reqData;
  let exportLayout = state.exportLayout;
  let dateGroups = state.dateGroups;
  for (const [oldId, newId] of remap) {
    reqData = renameReqData(reqData, "date", oldId, newId);
    exportLayout = renameExportLayout(exportLayout, "date", oldId, newId);
    dateGroups =
      renameDefinitions({ ...state, dateGroups }, "date", oldId, newId).dateGroups ?? dateGroups;
  }
  return { ...state, reqData, exportLayout, dateGroups };
}
