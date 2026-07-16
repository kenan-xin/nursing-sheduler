// Delete cascade (T07) — `deleteEntity(state, domain, id)` removes an entity or
// group and reconciles every reference: it prunes the id from every dependent
// field, drops preferences/export rows whose required fields became empty, and
// returns a NEW immutable `ScenarioUiState` (spec 06 FR-RI-08..12/14; design
// review finding #3 — the prototype's prune gap; finding #4 — Export Layout).
//
// Prune passes, per domain: the entity/group definition + same-domain group
// members (emptied groups are LEFT for normal empty-group validation — FR-RI-17);
// the five preference cards (filter fields → drop when a required field empties);
// the person×date matrix (a cell losing its person/date/worked-shift is dropped);
// people history (deleted shift-type ids blank to `""`, positions preserved —
// FR-RI-09); and the Export Layout rows (filter → drop emptied — FR-RI-12).

import type {
  CoefficientEntry,
  ExportLayout,
  ScenarioUiState,
  UiPerson,
  UiRequestCell,
} from "@/lib/scenario";
import type { EntityDomain, EntityRef } from "./domain";
import {
  CARD_COEFFICIENT_FIELD,
  CARD_REF_FIELDS,
  CARD_REQUIRED_FIELDS,
  type CardKind,
} from "./card-fields";
import { isEmptyRefField, pruneRefTree, type RefLeaf, type RefTree } from "./reference-tree";

/** Prune deleted ids from every domain-referencing field on one card. For a
 *  covering, an emptied `date` is *omitted* (= all dates, DL08 / finding #18),
 *  never left as `date: []`. */
function pruneCardFields<T extends object>(
  card: T,
  kind: CardKind,
  domain: EntityDomain,
  deleted: ReadonlySet<RefLeaf>,
): T {
  const next = { ...card } as Record<string, unknown>;
  for (const field of CARD_REF_FIELDS[kind][domain]) {
    if (next[field] !== undefined) {
      next[field] = pruneRefTree(next[field] as RefTree, deleted);
    }
  }
  if (domain === "shift") {
    const coefficientField = CARD_COEFFICIENT_FIELD[kind];
    if (coefficientField && next[coefficientField] !== undefined) {
      next[coefficientField] = (next[coefficientField] as CoefficientEntry[]).filter(
        ([id]) => !deleted.has(id),
      );
    }
  }
  if (kind === "coverings" && domain === "date" && isEmptyRefField(next.date as RefTree)) {
    delete next.date;
  }
  return next as T;
}

/** Whether a card keeps every required field non-empty after pruning (FR-RI-11). */
function cardSurvives(card: object, kind: CardKind): boolean {
  const record = card as Record<string, unknown>;
  return CARD_REQUIRED_FIELDS[kind].every((field) => !isEmptyRefField(record[field] as RefTree));
}

/** Map + drop the cards of one kind for the delete cascade. */
function pruneCards<T extends object>(
  cards: T[],
  kind: CardKind,
  domain: EntityDomain,
  deleted: ReadonlySet<RefLeaf>,
): T[] {
  return cards
    .map((card) => pruneCardFields(card, kind, domain, deleted))
    .filter((card) => cardSurvives(card, kind));
}

/**
 * Drop matrix cells that lost their referenced entity. A shift-request is
 * single-valued in person/date/worked-shift, so deleting any of them removes the
 * cell (FR-RI-11 for shift requests). Leave/off cells carry no `shiftType`, so a
 * worked-shift delete leaves them untouched.
 */
function pruneReqData(
  reqData: UiRequestCell[],
  domain: EntityDomain,
  deleted: ReadonlySet<RefLeaf>,
): UiRequestCell[] {
  return reqData.filter((cell) => {
    if (domain === "person") return !deleted.has(cell.person);
    if (domain === "date") return !deleted.has(cell.date);
    return !(cell.kind === "request" && deleted.has(cell.shiftType));
  });
}

/** Blank deleted shift-type ids in history to `""`, preserving positions (FR-RI-09). */
function pruneHistory(staff: UiPerson[], deleted: ReadonlySet<RefLeaf>): UiPerson[] {
  return staff.map((person) =>
    person.history?.some((h) => deleted.has(h))
      ? { ...person, history: person.history.map((h) => (deleted.has(h) ? "" : h)) }
      : person,
  );
}

/** Prune deleted ids from Export Layout rows and drop rows emptied of a present
 *  reference array (finding #4, FR-RI-12). Rules keep their uid. */
function pruneExportLayout(
  layout: ExportLayout,
  domain: EntityDomain,
  deleted: ReadonlySet<RefLeaf>,
): ExportLayout {
  const prune = (ids: RefLeaf[]): RefLeaf[] => ids.filter((id) => !deleted.has(id));
  return {
    formatting: layout.formatting
      .map((rule) => {
        if (domain === "person" && "people" in rule) return { ...rule, people: prune(rule.people) };
        if (domain === "date" && "dates" in rule) return { ...rule, dates: prune(rule.dates) };
        if (domain === "shift" && "shiftTypes" in rule) {
          return { ...rule, shiftTypes: prune(rule.shiftTypes) };
        }
        return rule;
      })
      // Drop a rule when ANY reference array present on it emptied — a cell rule
      // carries people+dates+shiftTypes, so deleting one kind can empty it even
      // though another domain's array was the one filtered (spec 06 edge case).
      .filter((rule) => {
        if ("people" in rule && rule.people.length === 0) return false;
        if ("dates" in rule && rule.dates.length === 0) return false;
        if ("shiftTypes" in rule && rule.shiftTypes.length === 0) return false;
        return true;
      }),
    extraColumns: layout.extraColumns
      .map((column) => {
        if (domain === "date") return { ...column, countDates: prune(column.countDates) };
        if (domain === "shift") {
          return {
            ...column,
            countShiftTypes: prune(column.countShiftTypes),
            countShiftTypeCoefficients: column.countShiftTypeCoefficients?.filter(
              ([id]) => !deleted.has(id),
            ),
          };
        }
        return column;
      })
      .filter((column) => column.countDates.length > 0 && column.countShiftTypes.length > 0),
    extraRows: layout.extraRows
      .map((row) => {
        if (domain === "person") return { ...row, countPeople: prune(row.countPeople) };
        if (domain === "shift") return { ...row, countShiftTypes: prune(row.countShiftTypes) };
        return row;
      })
      .filter((row) => row.countPeople.length > 0 && row.countShiftTypes.length > 0),
  };
}

/**
 * Remove the deleted entity/group from its container and prune the id from every
 * same-domain group's members. An emptied group is left in place for normal
 * empty-group validation (FR-RI-17); the cascade never flattens it. For a
 * shift-type delete this also blanks history (FR-RI-09).
 */
function pruneDefinitions(
  state: ScenarioUiState,
  domain: EntityDomain,
  deleted: ReadonlySet<RefLeaf>,
): Partial<ScenarioUiState> {
  const pruneGroup = <G extends { id: string; members: RefLeaf[] }>(group: G): G =>
    group.members.some((m) => deleted.has(m))
      ? { ...group, members: group.members.filter((m) => !deleted.has(m)) }
      : group;
  const keepGroup = <G extends { id: string }>(group: G): boolean => !deleted.has(group.id);

  switch (domain) {
    case "person":
      return {
        staff: state.staff.filter((p) => !deleted.has(p.id)),
        staffGroups: state.staffGroups.filter(keepGroup).map(pruneGroup),
      };
    case "shift":
      return {
        shifts: state.shifts.filter((s) => !deleted.has(s.id)),
        shiftGroups: state.shiftGroups.filter(keepGroup).map(pruneGroup),
        staff: pruneHistory(state.staff, deleted),
      };
    case "date":
      return { dateGroups: state.dateGroups.filter(keepGroup).map(pruneGroup) };
  }
}

/**
 * Delete an entity or group and cascade the removal everywhere it is referenced,
 * pruning any preference/export row whose required fields became empty. Pure:
 * returns a new `ScenarioUiState`, never mutating the input.
 */
export function deleteEntity(
  state: ScenarioUiState,
  domain: EntityDomain,
  id: EntityRef,
): ScenarioUiState {
  const deleted = new Set<RefLeaf>([id]);
  const cards = state.cardsByKind;
  return {
    ...state,
    ...pruneDefinitions(state, domain, deleted),
    cardsByKind: {
      requirements: pruneCards(cards.requirements, "requirements", domain, deleted),
      successions: pruneCards(cards.successions, "successions", domain, deleted),
      counts: pruneCards(cards.counts, "counts", domain, deleted),
      affinities: pruneCards(cards.affinities, "affinities", domain, deleted),
      coverings: pruneCards(cards.coverings, "coverings", domain, deleted),
    },
    reqData: pruneReqData(state.reqData, domain, deleted),
    exportLayout: pruneExportLayout(state.exportLayout, domain, deleted),
  };
}

/** Acceptance-matrix alias for {@link deleteEntity} (`applyDelete(state, …)`). */
export const applyDelete = deleteEntity;
