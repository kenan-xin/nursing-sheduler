// The HOST operation layer for assistant commands (T07).
//
// Every arm is a pure, total function of `(document, command)`. It either returns
// the next document or a typed rejection; it never throws, never partially applies,
// and never reaches storage. That shape is what lets the SAME code run in three
// places that must agree: preparing a Preview, re-checking it before Apply, and
// re-deriving it inside the Apply transaction.
//
// VALIDATION PARITY WITH THE MANUAL PATH. The `set_roster_range` arm calls the same
// `applyRangeChange` the Dates screen commits, so that arm is shared code outright.
// The rule arms restate their predicates rather than importing
// `components/guided-rules/mutations`: that module reaches the Guided mappers, which
// reach a `"use client"` React field component, and pulling React into a layer the
// projection adapter imports would drag the whole component graph into the node-env
// scenario suites. The drift that import would have prevented is prevented instead
// by `operations.parity.test.tsx`, which drives the MANUAL adapters and these
// operations with the same inputs and asserts they accept, reject and produce
// identical documents -- the same technique `lib/capability/commands.ts` already
// uses to keep its restated list honest.
//
// A REJECTION IS A PRODUCT ANSWER, not an error. "That rule targets more than one
// shift type" is what the Preview says to the user, so the message is written for a
// ward manager and rendered verbatim by the host. Model prose never replaces it.
//
// The shift arms call the Shifts page's own pure primitives (`addItem`, `addGroup`,
// `setGroupMembers`) behind the same gates the page's Save uses
// (`validateFullEditId`, `validateWorkingTimeDraft`, numbers-only code refusal), so
// they are shared code too. All of those live in React-free modules.
//
// The leave/request arms are one quick-paint gesture each and run the page's own
// fold (`foldPaintIntents`, `lib/store/paint-fold.ts`, store- and React-free). The
// only difference is the uid minter: the page mints random ids, the host mints
// deterministic ones so Apply reproduces the Preview exactly.

import {
  applyRangeChange,
  generateDateItems,
  hasCompleteRange,
  isValidIso,
  type DateRange,
} from "@/lib/dates";
import {
  RESERVED_SHIFT_TYPE,
  type CardsByKind,
  type DateRef,
  type IsoDate,
  type PersonRef,
  type RequirementCard,
  type ScenarioUiState,
  type UiRequestCell,
  type Weight,
} from "@/lib/scenario";
import {
  addGroup,
  addItem,
  paidMinutesFor,
  setGroupMembers,
  validateFullEditId,
  validateWorkingTimeDraft,
} from "@/components/entity-editor/core";
import { shiftTypesDescriptor } from "@/components/shift-types/shift-types-descriptor";
import { foldPaintIntents, type MintCellUid } from "@/lib/store/paint-fold";
import { paintCellKey, type StagedCoordinate } from "@/lib/store/types";
import type { AssistantCommandV1, RequestWeight } from "./commands";
import { proposalDigest, stableStringify } from "./digest";

/** Why a command cannot be prepared. Exhaustive: every refusal is one of these. */
export type CommandRejectionCode =
  /** The named record does not exist in this document. */
  | "unknown_target"
  /** The value itself is not legal for that field. */
  | "invalid_value"
  /** The record exists but its shape is outside what this operation can express. */
  | "unsupported_shape"
  /** The document already says this. Applying it would spend an Undo entry on nothing. */
  | "no_effect"
  /** The downstream consequence could not be computed, so nothing may be previewed. */
  | "cascade_unavailable";

export interface CommandRejection {
  code: CommandRejectionCode;
  /** Nurse-readable, rendered verbatim by the Preview. */
  message: string;
  /** Which command in the batch was refused (0-based). */
  index: number;
}

export type OperationResult =
  | { ok: true; next: ScenarioUiState }
  | { ok: false; rejection: CommandRejection };

// ---------------------------------------------------------------------------
// Shared coordinate helpers (the request matrix)
// ---------------------------------------------------------------------------

/** Whether a matrix cell sits at exactly this person×date coordinate. */
function atCoordinate(cell: UiRequestCell, person: PersonRef, date: DateRef): boolean {
  return cell.person === person && cell.date === date;
}

/** The cells currently authored at one coordinate. */
export function cellsAtCoordinate(
  reqData: readonly UiRequestCell[],
  person: PersonRef,
  date: DateRef,
): UiRequestCell[] {
  return reqData.filter((cell) => atCoordinate(cell, person, date));
}

/**
 * Replace everything at one coordinate with `cells` -- the manual cell editor's own
 * semantic (a saved cell is the whole coordinate, not a merge), and the reason a
 * move onto an occupied date shows the displaced requests as a cascade rather than
 * silently keeping them.
 */
export function withCoordinateCells(
  reqData: readonly UiRequestCell[],
  person: PersonRef,
  date: DateRef,
  cells: readonly UiRequestCell[],
): UiRequestCell[] {
  return [...reqData.filter((cell) => !atCoordinate(cell, person, date)), ...cells];
}

// ---------------------------------------------------------------------------
// Rule helpers
// ---------------------------------------------------------------------------

type RuleKind = keyof CardsByKind;

/** Human wording for a rule family, for refusal messages a ward manager reads. */
const RULE_LABEL: Record<RuleKind, string> = {
  requirements: "staffing requirement",
  successions: "shift sequence rule",
  counts: "shift count rule",
  affinities: "pairing rule",
  coverings: "supervision rule",
};

function findRule(state: ScenarioUiState, kind: RuleKind, ruleId: string) {
  return state.cardsByKind[kind].find((card) => card.uid === ruleId);
}

/**
 * Whether a requirement targets exactly one shift type.
 *
 * The SAME boundary the Guided Rules screen uses to decide whether its inline
 * "Required people" control appears at all. A multi-target requirement has no single
 * head count the plain-English surface can honestly edit, so neither surface offers
 * it -- see the parity test.
 */
function targetsOneShiftType(card: RequirementCard): boolean {
  const flatten = (node: unknown): unknown[] =>
    Array.isArray(node) ? node.flatMap(flatten) : [node];
  return flatten(card.shiftType).length === 1;
}

/** Set or clear a card's UI-only `disabled` marker, exactly as the manual toggle does. */
function withEnabled<TCard extends { disabled?: boolean }>(card: TCard, enabled: boolean): TCard {
  if (!enabled) return { ...card, disabled: true };
  const rest: Record<string, unknown> = { ...card };
  delete rest.disabled;
  return rest as TCard;
}

/** Replace one card, keeping every other kind untouched. */
function withRule<TCard extends { uid: string }>(
  state: ScenarioUiState,
  kind: RuleKind,
  ruleId: string,
  next: TCard,
): ScenarioUiState {
  const cards = state.cardsByKind[kind] as readonly { uid: string }[];
  return {
    ...state,
    cardsByKind: {
      ...state.cardsByKind,
      [kind]: cards.map((card) => (card.uid === ruleId ? next : card)),
    } as CardsByKind,
  };
}

// ---------------------------------------------------------------------------
// The arms
// ---------------------------------------------------------------------------

function reject(index: number, code: CommandRejectionCode, message: string): OperationResult {
  return { ok: false, rejection: { index, code, message } };
}

function applySetRosterRange(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "set_roster_range" }>,
  index: number,
): OperationResult {
  const range: DateRange = { start: command.start, end: command.end };
  if (!isValidIso(command.start) || !isValidIso(command.end)) {
    return reject(index, "invalid_value", "Those are not real calendar dates.");
  }
  if (!hasCompleteRange(range)) {
    return reject(index, "invalid_value", "The end date must be on or after the start date.");
  }
  if (state.rangeStart === command.start && state.rangeEnd === command.end) {
    // The holiday re-import alone is still a change, so it is not folded in here.
    if (!command.importPublicHolidays) {
      return reject(index, "no_effect", "The roster period is already those dates.");
    }
  }
  return {
    ok: true,
    next: applyRangeChange(state, range, {
      importSingaporeHolidays: command.importPublicHolidays,
    }),
  };
}

function applySetRuleEnabled(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "set_rule_enabled" }>,
  index: number,
): OperationResult {
  const card = findRule(state, command.ruleKind, command.ruleId);
  if (!card) {
    return reject(
      index,
      "unknown_target",
      `That ${RULE_LABEL[command.ruleKind]} is not in this schedule any more.`,
    );
  }
  if (!card.disabled === command.enabled) {
    return reject(
      index,
      "no_effect",
      `That ${RULE_LABEL[command.ruleKind]} is already ${command.enabled ? "on" : "off"}.`,
    );
  }
  return {
    ok: true,
    next: withRule(state, command.ruleKind, command.ruleId, withEnabled(card, command.enabled)),
  };
}

function applySetRequirementPeople(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "set_staffing_requirement_people" }>,
  index: number,
): OperationResult {
  const card = state.cardsByKind.requirements.find((entry) => entry.uid === command.ruleId);
  if (!card) {
    return reject(
      index,
      "unknown_target",
      "That staffing requirement is not in this schedule any more.",
    );
  }
  if (!targetsOneShiftType(card)) {
    return reject(
      index,
      "unsupported_shape",
      "That requirement covers more than one shift type, so it has no single head count to change. It has to be edited on the Staffing requirements screen.",
    );
  }
  // The Guided quick field's own rule, restated (see the parity test): a finite,
  // non-negative number. Deliberately NOT stricter -- an assistant that refused what
  // the manual control accepts would be a second, quieter definition of "valid".
  if (!(Number.isFinite(command.requiredNumPeople) && command.requiredNumPeople >= 0)) {
    return reject(index, "invalid_value", "Required people must be zero or more.");
  }
  if (card.requiredNumPeople === command.requiredNumPeople) {
    return reject(index, "no_effect", "That requirement already asks for that many people.");
  }
  return {
    ok: true,
    next: withRule(state, "requirements", command.ruleId, {
      ...card,
      requiredNumPeople: command.requiredNumPeople,
    }),
  };
}

function applyMoveLeave(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "move_leave" }>,
  index: number,
): OperationResult {
  if (!state.staff.some((person) => person.id === command.personId)) {
    return reject(index, "unknown_target", "That person is not on this schedule.");
  }
  if (command.fromDate === command.toDate) {
    return reject(index, "no_effect", "That leave is already on that date.");
  }

  const range: DateRange = { start: state.rangeStart, end: state.rangeEnd };
  if (!hasCompleteRange(range)) {
    return reject(
      index,
      "cascade_unavailable",
      "This schedule has no roster period yet, so leave dates cannot be checked.",
    );
  }
  const inRange = new Set<DateRef>(generateDateItems(range).map((item) => item.id));
  if (!inRange.has(command.fromDate) || !inRange.has(command.toDate)) {
    return reject(index, "unknown_target", "Those dates are not both inside the roster period.");
  }

  const source = cellsAtCoordinate(state.reqData, command.personId, command.fromDate).find(
    (cell) => cell.kind === "leave",
  );
  if (!source) {
    return reject(index, "unknown_target", "There is no leave on that date to move.");
  }

  // The leave KEEPS ITS IDENTITY across the move: it is the same agreement on a
  // different day, and preserving `uid` is also what makes this operation
  // deterministic -- a minted id would make the applied document differ from the
  // previewed one in a field nobody can see.
  const moved: UiRequestCell = { ...source, date: command.toDate };
  const cleared = withCoordinateCells(state.reqData, command.personId, command.fromDate, []);
  return {
    ok: true,
    next: {
      ...state,
      reqData: withCoordinateCells(cleared, command.personId, command.toDate, [moved]),
    },
  };
}

function applyAddShiftType(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "add_shift_type" }>,
  index: number,
): OperationResult {
  const d = shiftTypesDescriptor;
  const idCheck = validateFullEditId(d, d.readItems(state), d.readGroups(state), command.code);
  if (!idCheck.ok) {
    return reject(index, "invalid_value", `Shift "${command.code.trim()}": ${idCheck.message}.`);
  }
  // The Shifts page forbids a numbers-only code (`shift-type-grid.tsx`, `codeNumericOnly`).
  if (/^\d+$/.test(idCheck.id)) {
    return reject(
      index,
      "invalid_value",
      `Shift "${idCheck.id}": a shift code must contain a letter.`,
    );
  }
  // The same derived value the working-time sub-form produces (`deriveValue` in
  // `working-time-fields.tsx`): rest 0 is stored as absent, paid = span - rest. An
  // invalid rest leaves duration unset, and the validator reports the rest itself.
  const restMinutes = command.restMinutes === 0 ? undefined : command.restMinutes;
  const workingTime = {
    startTime: command.startTime,
    endTime: command.endTime,
    restMinutes,
    durationMinutes: paidMinutesFor(command.startTime, command.endTime, restMinutes) ?? undefined,
  };
  const timeCheck = validateWorkingTimeDraft(workingTime);
  if (!timeCheck.ok) {
    return reject(index, "invalid_value", `Shift "${idCheck.id}": ${timeCheck.issues[0].message}`);
  }
  return {
    ok: true,
    next: addItem(state, d, {
      id: idCheck.id,
      description: command.name.trim() || undefined,
      extra: workingTime,
    }),
  };
}

function applyAddShiftGroup(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "add_shift_group" }>,
  index: number,
): OperationResult {
  const d = shiftTypesDescriptor;
  const items = d.readItems(state);
  const idCheck = validateFullEditId(d, items, d.readGroups(state), command.groupId, true);
  if (!idCheck.ok) {
    return reject(
      index,
      "invalid_value",
      `Shift group "${command.groupId.trim()}": ${idCheck.message}.`,
    );
  }
  const members = [...new Set(command.members)];
  const missing = members.find((member) => !items.some((item) => item.id === member));
  if (missing !== undefined) {
    return reject(
      index,
      "unknown_target",
      `Shift group "${idCheck.id}": there is no shift "${missing}". Add the shift earlier in the same change, or use an existing code.`,
    );
  }
  const withGroup = addGroup(state, d, { id: idCheck.id });
  return { ok: true, next: setGroupMembers(withGroup, d, idCheck.id, members) };
}

/**
 * The roster date ids from `start` to `end` (calendar dates, inclusive), or why not.
 * Shared with `diff.ts`, which names the same coordinates as asked-for.
 */
export function rosterDatesBetween(
  state: ScenarioUiState,
  start: IsoDate,
  end: IsoDate,
): { ok: true; ids: DateRef[] } | { ok: false; code: CommandRejectionCode; message: string } {
  const range: DateRange = { start: state.rangeStart, end: state.rangeEnd };
  if (!hasCompleteRange(range)) {
    return {
      ok: false,
      code: "cascade_unavailable",
      message:
        "This schedule has no roster period yet, so leave and request dates cannot be checked.",
    };
  }
  // The wire schema's regex only checks YYYY-MM-DD shape, so it lets impossible
  // dates like 2026-02-30 through; isValidIso catches those here.
  if (!isValidIso(start) || !isValidIso(end)) {
    return { ok: false, code: "invalid_value", message: "Those are not real calendar dates." };
  }
  if (end < start) {
    return {
      ok: false,
      code: "invalid_value",
      message: "The end date must be on or after the start date.",
    };
  }
  if (start < range.start || end > range.end) {
    const asked = start === end ? start : `${start} to ${end}`;
    return {
      ok: false,
      code: "unknown_target",
      message: `${asked} is not inside the roster period (${range.start} to ${range.end}).`,
    };
  }
  // ISO strings compare correctly as text.
  const ids = generateDateItems(range)
    .filter((item) => item.iso >= start && item.iso <= end)
    .map((item) => item.id);
  return { ok: true, ids };
}

/**
 * The host's uid minter for new request cells: deterministic, so preparing and
 * applying the same change produce the same document, and unique within `reqData`
 * (a moved leave keeps its old uid, so a digest of the coordinate alone could clash).
 */
export function assistantCellUids(reqData: readonly UiRequestCell[]): MintCellUid {
  const used = new Set(reqData.flatMap((cell) => (cell.uid ? [cell.uid] : [])));
  return (person, date, selector) => {
    for (let n = 0; ; n += 1) {
      const uid = `assistant-${proposalDigest({ person, date, selector, n })}`;
      if (!used.has(uid)) {
        used.add(uid);
        return uid;
      }
    }
  };
}

type RequestPaintCommand = Extract<
  AssistantCommandV1,
  { type: "add_leave" | "set_off_request" | "set_shift_request" | "clear_requests" }
>;

function toWeight(weight: RequestWeight): Weight {
  if (weight === "must") return Infinity;
  if (weight === "never") return -Infinity;
  return weight;
}

const NOTHING_TO_CHANGE: Record<RequestPaintCommand["type"], (who: string) => string> = {
  add_leave: (who) => `${who} is already on leave on every one of those dates.`,
  set_off_request: (who) => `${who} already has that day-off request on every one of those dates.`,
  set_shift_request: (who) =>
    `Nothing would change: ${who} already has that request, or has leave or a day off, on ` +
    "every one of those dates. A shift request never replaces leave or a day off, so clear " +
    "those dates first.",
  clear_requests: (who) => `${who} has nothing recorded on those dates.`,
};

/** The one paint selection this command is, or the refusal. */
function paintIntent(
  state: ScenarioUiState,
  command: RequestPaintCommand,
  index: number,
): { ok: true; intent: StagedCoordinate } | { ok: false; refusal: OperationResult } {
  switch (command.type) {
    case "add_leave":
      return { ok: true, intent: { mode: "day-state", dayState: { kind: "leave" } } };
    case "set_off_request":
      return {
        ok: true,
        intent: { mode: "day-state", dayState: { kind: "off", weight: toWeight(command.weight) } },
      };
    case "clear_requests":
      return { ok: true, intent: { mode: "erase" } };
    case "set_shift_request": {
      const { shiftType } = command;
      if (shiftType === RESERVED_SHIFT_TYPE.off || shiftType === RESERVED_SHIFT_TYPE.leave) {
        return {
          ok: false,
          refusal: reject(
            index,
            "invalid_value",
            "A day off or leave is not a shift request; record it as a day off or as leave instead.",
          ),
        };
      }
      // The page's paint targets minus OFF/LEAVE (`requests-editor.tsx`, `paintTargets`).
      const selectable = [
        ...state.shifts.map((shift) => String(shift.id)),
        ...state.shiftGroups.map((group) => group.id),
        RESERVED_SHIFT_TYPE.all,
      ];
      if (!selectable.includes(shiftType)) {
        return {
          ok: false,
          refusal: reject(
            index,
            "unknown_target",
            `There is no shift or shift group "${shiftType}".`,
          ),
        };
      }
      return {
        ok: true,
        intent: { mode: "requests", deltas: new Map([[shiftType, toWeight(command.weight)]]) },
      };
    }
  }
}

function applyRequestPaint(
  state: ScenarioUiState,
  command: RequestPaintCommand,
  index: number,
): OperationResult {
  const who = String(command.personId);
  // The matrix rows: people and staff groups, exact identity.
  const isRow =
    state.staff.some((person) => person.id === command.personId) ||
    state.staffGroups.some((group) => group.id === command.personId);
  if (!isRow) {
    return reject(
      index,
      "unknown_target",
      `There is no person or staff group "${who}" on this schedule.`,
    );
  }
  const span = rosterDatesBetween(state, command.startDate, command.endDate);
  if (!span.ok) return reject(index, span.code, span.message);
  const selection = paintIntent(state, command, index);
  if (!selection.ok) return selection.refusal;

  // Staged in date order, exactly as a drag across those cells stages them.
  const staged = new Map(
    span.ids.map((date) => [paintCellKey(command.personId, date), selection.intent] as const),
  );
  const reqData = foldPaintIntents(state.reqData, staged, assistantCellUids(state.reqData));

  // The fold regroups the matrix, so compare only the painted coordinates, order-free.
  const dates = new Set(span.ids);
  const painted = (cells: readonly UiRequestCell[]) =>
    cells
      .filter((cell) => cell.person === command.personId && dates.has(cell.date))
      .map(stableStringify)
      .sort()
      .join("\n");
  if (painted(reqData) === painted(state.reqData)) {
    return reject(index, "no_effect", NOTHING_TO_CHANGE[command.type](who));
  }
  return { ok: true, next: { ...state, reqData } };
}

/** Validate and apply exactly one command against `state`. */
export function applyAssistantCommand(
  state: ScenarioUiState,
  command: AssistantCommandV1,
  index = 0,
): OperationResult {
  switch (command.type) {
    case "set_roster_range":
      return applySetRosterRange(state, command, index);
    case "set_rule_enabled":
      return applySetRuleEnabled(state, command, index);
    case "set_staffing_requirement_people":
      return applySetRequirementPeople(state, command, index);
    case "move_leave":
      return applyMoveLeave(state, command, index);
    case "add_shift_type":
      return applyAddShiftType(state, command, index);
    case "add_shift_group":
      return applyAddShiftGroup(state, command, index);
    case "add_leave":
    case "set_off_request":
    case "set_shift_request":
    case "clear_requests":
      return applyRequestPaint(state, command, index);
  }
}

/**
 * Fold a whole batch, each command validated against the document the PREVIOUS one
 * produced -- the same queue-head discipline the manual command bus uses, so a batch
 * that moves leave onto a date an earlier command just vacated is checked against
 * reality rather than against the starting snapshot.
 *
 * Fails closed on the first refusal: a partially-applied batch is not a thing the
 * user reviewed.
 */
export function applyAssistantCommands(
  state: ScenarioUiState,
  commands: readonly AssistantCommandV1[],
): OperationResult {
  let next = state;
  for (const [index, command] of commands.entries()) {
    const result = applyAssistantCommand(next, command, index);
    if (!result.ok) return result;
    next = result.next;
  }
  return { ok: true, next };
}
