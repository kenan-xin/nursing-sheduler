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
// people history (truncated at the newest deleted shift-type id, keeping the
// usable suffix — FR-RI-09, decision D7); and the Export Layout rows (filter →
// drop emptied — FR-RI-12). A date-GROUP delete also drops any per-date
// requirement override on a date the group no longer contributes (ze1).

import type {
  CardsByKind,
  CoefficientEntry,
  ExportLayout,
  ScenarioUiState,
  SkillMixEntry,
  UiPerson,
  UiRequestCell,
} from "@/lib/scenario";
// Deep import: the history rule (FR-RI-09) is shared with the import path's
// repair of blank slots, so it lives beside the scenario contract it defines.
import { truncateHistoryAfterUnusable } from "@/lib/scenario/person-history";
// Deep import: the override-scope rule (a requirement's overrides must be dates it
// still resolves) is shared with the date-group membership edit, so it lives
// beside `requirementDateIsos`, its authority.
import { dropUncoveredOverrides } from "@/lib/rules/shortfalls";
import type { EntityDomain, EntityRef } from "./domain";
import {
  CARD_COEFFICIENT_FIELD,
  CARD_REF_FIELDS,
  CARD_REQUIRED_FIELDS,
  type CardKind,
} from "./card-fields";
import { isEmptyRefField, pruneRefTree, type RefLeaf, type RefTree } from "./reference-tree";

/** Prune deleted ids from every domain-referencing field on one card. An emptied
 *  `date` stays empty so FR-RI-11 drops the card: omitting it would widen the rule
 *  to every date (bug hunt A-06). */
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
  if (kind === "requirements" && domain === "person" && Array.isArray(next.skillMix)) {
    const kept = (next.skillMix as SkillMixEntry[]).filter((entry) => !deleted.has(entry.people));
    if (kept.length) next.skillMix = kept;
    else delete next.skillMix;
  }
  if (domain === "shift") {
    const coefficientField = CARD_COEFFICIENT_FIELD[kind];
    if (coefficientField && next[coefficientField] !== undefined) {
      next[coefficientField] = (next[coefficientField] as CoefficientEntry[]).filter(
        ([id]) => !deleted.has(id),
      );
    }
  }
  // A sequence that loses a whole step is a different rule ("no N then D" would
  // become "never N"), so empty the pattern and let FR-RI-11 drop the card.
  if (
    kind === "successions" &&
    Array.isArray(next.pattern) &&
    next.pattern.length < (card as { pattern: unknown[] }).pattern.length
  ) {
    next.pattern = [];
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

/** Truncate each person's history at the newest deleted shift-type id (FR-RI-09).
 *  History is right-anchored, so only the suffix newer than that id stays usable;
 *  a blank slot would be rejected by the producer and core (D7). */
function pruneHistory(staff: UiPerson[], deleted: ReadonlySet<RefLeaf>): UiPerson[] {
  return staff.map((person) =>
    person.history?.some((h) => deleted.has(h))
      ? {
          ...person,
          history: truncateHistoryAfterUnusable(person.history, (h) => deleted.has(h)),
        }
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
 * shift-type delete this also truncates history (FR-RI-09).
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
  const nextCardsByKind: CardsByKind = {
    requirements: pruneCards(cards.requirements, "requirements", domain, deleted),
    successions: pruneCards(cards.successions, "successions", domain, deleted),
    counts: pruneCards(cards.counts, "counts", domain, deleted),
    affinities: pruneCards(cards.affinities, "affinities", domain, deleted),
    coverings: pruneCards(cards.coverings, "coverings", domain, deleted),
  };
  const next: ScenarioUiState = {
    ...state,
    ...pruneDefinitions(state, domain, deleted),
    cardsByKind: nextCardsByKind,
    reqData: pruneReqData(state.reqData, domain, deleted),
    exportLayout: pruneExportLayout(state.exportLayout, domain, deleted),
  };
  // Deleting an authored date group shrinks the dates every requirement naming it
  // resolves to, so a per-date override on a date only that group contributed is
  // now stale — drop it rather than let it reach the solver and fail generically.
  // Date ids themselves are never deleted here (the range cascade removes them and
  // reconciles separately), so this is scoped to authored groups.
  return domain === "date" && isAuthoredDateGroup(state, id) ? dropUncoveredOverrides(next) : next;
}

/** Whether `id` names an authored date group (not a generated in-range date id). */
function isAuthoredDateGroup(state: ScenarioUiState, id: EntityRef): boolean {
  return state.dateGroups.some((group) => group.id === id);
}

/** What a delete drops: whole rules, request cells (leave pins apart), history
 *  entries, and per-date staffing exceptions (requirement overrides). */
export interface DeleteImpact {
  rules: number;
  /** The descriptions of the dropped rules that have one, so the confirm names them. */
  ruleNames: string[];
  requests: number;
  leave: number;
  history: number;
  overrides: number;
}

/** Count what {@link deleteEntity} would drop, by running it and diffing — so the
 *  confirm can never disagree with the cascade. */
export function deleteImpact(
  state: ScenarioUiState,
  domain: EntityDomain,
  id: EntityRef,
): DeleteImpact {
  const next = deleteEntity(state, domain, id);
  const rules = (s: ScenarioUiState) =>
    Object.values(s.cardsByKind).reduce((sum, cards) => sum + cards.length, 0);
  const history = (s: ScenarioUiState) =>
    s.staff.reduce((sum, person) => sum + (person.history?.length ?? 0), 0);
  const leave = (s: ScenarioUiState) => s.reqData.filter((cell) => cell.kind === "leave").length;
  const overrides = (s: ScenarioUiState) =>
    s.cardsByKind.requirements.reduce(
      (sum, card) => sum + (card.requiredNumPeopleOverrides?.length ?? 0),
      0,
    );
  const leaveDropped = leave(state) - leave(next);
  const kept = new Set(
    Object.values(next.cardsByKind)
      .flat()
      .map((card) => card.uid),
  );
  return {
    rules: rules(state) - rules(next),
    ruleNames: Object.values(state.cardsByKind)
      .flat()
      .filter((card) => !kept.has(card.uid) && card.description?.trim())
      .map((card) => card.description!.trim()),
    requests: state.reqData.length - next.reqData.length - leaveDropped,
    leave: leaveDropped,
    history: history(state) - history(next),
    // Overrides on a DROPPED rule go with it; count only those on a surviving one.
    overrides: overrides(state) - overrides(next) - droppedOverrides(state, next),
  };
}

/** Overrides carried by requirement cards the delete removed entirely. */
function droppedOverrides(state: ScenarioUiState, next: ScenarioUiState): number {
  const kept = new Set(next.cardsByKind.requirements.map((card) => card.uid));
  return state.cardsByKind.requirements
    .filter((card) => !kept.has(card.uid))
    .reduce((sum, card) => sum + (card.requiredNumPeopleOverrides?.length ?? 0), 0);
}

/** The non-zero parts of an impact as confirm lines ("3 rules", "4 history entries"). */
export function describeDeleteImpact(impact: DeleteImpact): string[] {
  const part = (count: number, one: string, many: string) =>
    count > 0 ? [`${count} ${count === 1 ? one : many}`] : [];
  const names = impact.ruleNames.map((name) => `“${name}”`).join(", ");
  return [
    ...part(impact.rules, "rule", "rules").map((line) => (names ? `${line} (${names})` : line)),
    ...part(impact.requests, "request", "requests"),
    ...part(impact.leave, "leave pin", "leave pins"),
    ...part(impact.history, "history entry", "history entries"),
    ...part(impact.overrides, "date exception", "date exceptions"),
  ];
}

/** Acceptance-matrix alias for {@link deleteEntity} (`applyDelete(state, …)`). */
export const applyDelete = deleteEntity;
