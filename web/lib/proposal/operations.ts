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
// The toggle and head-count arms restate the Guided Rules predicates rather than
// importing `components/guided-rules/mutations`, which reaches the Guided row UI;
// `operations.parity.test.ts` keeps that restatement honest. The create/edit rule
// arms need no restatement: they call each Advanced editor's own model
// (`successions-model`, `counts-model`, `requirements-model`, `requirement-patch`),
// which is React-free -- `react-free.test.ts` holds that line.
//
// A REJECTION IS A PRODUCT ANSWER, not an error. "That rule targets more than one
// shift type" is what the Preview says to the user, so the message is written for a
// ward manager and rendered verbatim by the host. Model prose never replaces it.
//
// The shift arms call the Shifts page's own pure primitives (`addItem`, `addGroup`,
// `setGroupMembers`) behind the same gates the page's Save uses
// (`validateFullEditId`, `validateWorkingTimeDraft`, numbers-only code refusal), so
// they are shared code too. All of those live in React-free modules.

import {
  applyRangeChange,
  generateDateItems,
  hasCompleteRange,
  isValidIso,
  type DateRange,
} from "@/lib/dates";
import type {
  CardsByKind,
  DateRef,
  PersonRef,
  RequirementCard,
  ScenarioUiState,
  UiRequestCell,
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
import { parseWeightInput } from "@/components/card-editor/weight-value";
import {
  buildDateScopeAutoScopes as successionAutoScopes,
  buildDateScopeDateGroups as successionDateGroups,
  buildDateScopeDateItems as successionDateItems,
  buildPatternShiftTypeOptions,
  buildPeopleTransferOptions as successionPeopleOptions,
  buildSuccessionCard,
  isEditableSuccessionCard,
  validateSuccessionForm,
  type SuccessionFormState,
} from "@/components/successions/successions-model";
import {
  buildCountCard,
  buildCountShiftTypeDomain,
  buildCountShiftTypeTransferOptions,
  buildDateScopeAutoScopes as countAutoScopes,
  buildDateScopeDateGroups as countDateGroups,
  buildDateScopeDateItems as countDateItems,
  buildPeopleTransferOptions as countPeopleOptions,
  countToForm,
  emptyCountForm,
  isEditableCountCard,
  validateCountForm,
  type CountFormState,
} from "@/components/counts/counts-model";
import { proposalDigest, stableStringify } from "./digest";
import type { AssistantCommandV1 } from "./commands";

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

/** "Shift sequence rule "Night cap"", or "The new shift sequence rule" when untitled. */
function ruleName(kind: RuleKind, title: string | undefined): string {
  const label = RULE_LABEL[kind];
  const trimmed = title?.trim();
  return trimmed ? `${label[0].toUpperCase()}${label.slice(1)} "${trimmed}"` : `The new ${label}`;
}

/**
 * A new card's uid. Deterministic, so Apply's re-derivation writes the card the Preview
 * showed; the live uids are part of the input, so asking twice for the same rule --
 * in one change or two -- yields two different ids.
 */
function newRuleUid(state: ScenarioUiState, kind: RuleKind, command: AssistantCommandV1): string {
  return proposalDigest([kind, state.cardsByKind[kind].map((card) => card.uid), command]);
}

/**
 * Carry `disabled`/`applied` onto a rebuilt card -- the edit-save rule every editor's
 * `update` applies (`use-successions.ts`, `use-counts.ts`, `requirement-patch.ts`): an
 * edit never re-enables a rule the user switched off.
 */
function keepMarkers<TCard extends { disabled?: boolean; applied?: boolean }>(
  source: TCard,
  rebuilt: TCard,
): TCard {
  const markers: { disabled?: true; applied?: true } = {};
  if (source.disabled) markers.disabled = true;
  if (source.applied) markers.applied = true;
  return markers.disabled || markers.applied ? { ...rebuilt, ...markers } : rebuilt;
}

/** Replace one kind's whole card list. */
function withCards(
  state: ScenarioUiState,
  kind: RuleKind,
  cards: readonly { uid: string }[],
): ScenarioUiState {
  return { ...state, cardsByKind: { ...state.cardsByKind, [kind]: cards } as CardsByKind };
}

/** One entry a picker offers; a disabled entry cannot be picked. */
interface PickerOption {
  value: unknown;
  disabled?: boolean;
}

/**
 * The first picked ref the manual screen's own picker does not offer. Exact identity,
 * as the pickers compare (`sameEntityId`): person `7` and person `"7"` are different.
 */
function firstUnoffered<T>(picked: readonly T[], offered: readonly PickerOption[]): T | undefined {
  return picked.find(
    (ref) => !offered.some((option) => !option.disabled && Object.is(option.value, ref)),
  );
}

/** One editor's Dates-field option builders (each model exports its own three). */
interface DateScopeBuilders {
  auto: (state: ScenarioUiState) => readonly { id: string }[];
  groups: (state: ScenarioUiState) => readonly { id: string }[];
  items: (state: ScenarioUiState) => readonly { id: string }[];
}

/**
 * What a `DateScopeField` can hold: ONE scope chip (ALL, WEEKDAY, WEEKEND, a weekday, or
 * an authored date group), or in-range dates written YYYY-MM-DD. An empty list is left
 * to the form's own validator, which owns that message.
 */
function dateScopeRejection(
  state: ScenarioUiState,
  dates: readonly string[],
  builders: DateScopeBuilders,
): { code: CommandRejectionCode; message: string } | undefined {
  if (dates.length === 0) return undefined;
  const chips = [...builders.auto(state), ...builders.groups(state)].map((option) => option.id);
  if (dates.length === 1 && chips.includes(dates[0])) return undefined;
  const inRange = new Set(builders.items(state).map((item) => item.id));
  const outside = dates.find((date) => !inRange.has(date));
  if (outside === undefined) return undefined;
  if (chips.includes(outside)) {
    return {
      code: "invalid_value",
      message: `"${outside}" stands for a whole set of dates, so it must be the only date entry`,
    };
  }
  return {
    code: "unknown_target",
    message:
      `"${outside}" is not a roster date (write dates as YYYY-MM-DD inside the roster ` +
      "period), a date group, or one of ALL, WEEKDAY, WEEKEND or a weekday name such as MONDAY",
  };
}

/** The first message a form validator reported, in the validator's own field order. */
function firstFormError(errors: object): string | undefined {
  return Object.values(errors).find((value): value is string => typeof value === "string");
}

// --- Shift sequences --------------------------------------------------------

type SuccessionFields = Omit<Extract<AssistantCommandV1, { type: "add_succession_rule" }>, "type">;

const SUCCESSION_DATES: DateScopeBuilders = {
  auto: successionAutoScopes,
  groups: successionDateGroups,
  items: successionDateItems,
};

/** The draft the Shift sequences form holds once the user has entered these values. */
function successionDraft(fields: SuccessionFields): SuccessionFormState {
  return {
    description: fields.description,
    person: [...fields.people],
    pattern: [...fields.pattern],
    date: [...fields.dates],
    weight: parseWeightInput(fields.weight),
  };
}

/** Everything the form checks before Save, plus what its pickers make impossible to pick. */
function successionRejection(
  state: ScenarioUiState,
  fields: SuccessionFields,
  name: string,
  index: number,
): OperationResult | undefined {
  const people = successionPeopleOptions(state);
  const person = firstUnoffered(fields.people, [...people.items, ...people.groups]);
  if (person !== undefined) {
    return reject(
      index,
      "unknown_target",
      `${name}: there is no person or staff group "${person}". Name each person, or an existing staff group.`,
    );
  }
  const shifts = buildPatternShiftTypeOptions(state);
  const shift = firstUnoffered(fields.pattern, [...shifts.items, ...shifts.groups]);
  if (shift !== undefined) {
    return reject(index, "unknown_target", `${name}: there is no shift or shift group "${shift}".`);
  }
  const dates = dateScopeRejection(state, fields.dates, SUCCESSION_DATES);
  if (dates) return reject(index, dates.code, `${name}: ${dates.message}.`);
  const error = firstFormError(validateSuccessionForm(successionDraft(fields)));
  if (error) return reject(index, "invalid_value", `${name}: ${error}.`);
  return undefined;
}

function applyAddSuccessionRule(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "add_succession_rule" }>,
  index: number,
): OperationResult {
  const refused = successionRejection(
    state,
    command,
    ruleName("successions", command.description),
    index,
  );
  if (refused) return refused;
  // `use-successions.ts` `add`: append `buildSuccessionCard(form)`.
  const card = buildSuccessionCard(
    successionDraft(command),
    newRuleUid(state, "successions", command),
  );
  return {
    ok: true,
    next: withCards(state, "successions", [...state.cardsByKind.successions, card]),
  };
}

function applyEditSuccessionRule(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "edit_succession_rule" }>,
  index: number,
): OperationResult {
  const source = state.cardsByKind.successions.find((card) => card.uid === command.ruleId);
  if (!source) {
    return reject(
      index,
      "unknown_target",
      "That shift sequence rule is not in this schedule any more.",
    );
  }
  const name = ruleName("successions", source.description?.trim() || source.uid);
  // The screen opens no form for such a card (`isEditableSuccessionCard` guards `openEdit`).
  if (!isEditableSuccessionCard(source)) {
    return reject(
      index,
      "unsupported_shape",
      `${name}: one step of its pattern allows several shifts, so it has to be edited on the Shift sequences screen.`,
    );
  }
  const refused = successionRejection(state, command, name, index);
  if (refused) return refused;
  const next = keepMarkers(source, buildSuccessionCard(successionDraft(command), source.uid));
  if (stableStringify(next) === stableStringify(source)) {
    return reject(index, "no_effect", `${name} already says exactly that.`);
  }
  return {
    ok: true,
    next: withCards(
      state,
      "successions",
      state.cardsByKind.successions.map((card) => (card.uid === source.uid ? next : card)),
    ),
  };
}

// --- Shift counts -------------------------------------------------------------

type CountFields = Omit<Extract<AssistantCommandV1, { type: "add_count_rule" }>, "type">;

const COUNT_DATES: DateScopeBuilders = {
  auto: countAutoScopes,
  groups: countDateGroups,
  items: countDateItems,
};

/**
 * The draft the Shift counts form holds once the user has entered these values, on top
 * of `base`: a fresh form for Add, the loaded card (`countToForm`) for Edit -- so an
 * edit keeps the coefficients the arm does not carry, exactly as the form does.
 */
function countDraft(fields: CountFields, base: CountFormState): CountFormState {
  return {
    ...base,
    description: fields.description,
    person: [...fields.people],
    countDates: [...fields.dates],
    countShiftTypes: [...fields.shiftTypes],
    expression: fields.expression,
    target: fields.target,
    weight: parseWeightInput(fields.weight),
  };
}

function countRejection(
  state: ScenarioUiState,
  fields: CountFields,
  draft: CountFormState,
  name: string,
  index: number,
): OperationResult | undefined {
  const people = countPeopleOptions(state);
  const person = firstUnoffered(fields.people, [...people.items, ...people.groups]);
  if (person !== undefined) {
    return reject(
      index,
      "unknown_target",
      `${name}: there is no person or staff group "${person}". Name each person, or an existing staff group.`,
    );
  }
  const shifts = buildCountShiftTypeTransferOptions(state);
  const shift = firstUnoffered(fields.shiftTypes, [...shifts.items, ...shifts.groups]);
  if (shift !== undefined) {
    return reject(index, "unknown_target", `${name}: there is no shift or shift group "${shift}".`);
  }
  const dates = dateScopeRejection(state, fields.dates, COUNT_DATES);
  if (dates) return reject(index, dates.code, `${name}: ${dates.message}.`);
  const error = firstFormError(validateCountForm(draft, buildCountShiftTypeDomain(state)));
  if (error) return reject(index, "invalid_value", `${name}: ${error}.`);
  return undefined;
}

function applyAddCountRule(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "add_count_rule" }>,
  index: number,
): OperationResult {
  const draft = countDraft(command, emptyCountForm());
  const refused = countRejection(
    state,
    command,
    draft,
    ruleName("counts", command.description),
    index,
  );
  if (refused) return refused;
  // `use-counts.ts` `add`: append `buildCountCard(form, domain)`.
  const card = buildCountCard(
    draft,
    buildCountShiftTypeDomain(state),
    newRuleUid(state, "counts", command),
  );
  return { ok: true, next: withCards(state, "counts", [...state.cardsByKind.counts, card]) };
}

function applyEditCountRule(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "edit_count_rule" }>,
  index: number,
): OperationResult {
  const source = state.cardsByKind.counts.find((card) => card.uid === command.ruleId);
  if (!source) {
    return reject(
      index,
      "unknown_target",
      "That shift count rule is not in this schedule any more.",
    );
  }
  const name = ruleName("counts", source.description?.trim() || source.uid);
  if (!isEditableCountCard(source)) {
    return reject(
      index,
      "unsupported_shape",
      `${name}: it is a contracted-hours or list-shaped count, so it has to be edited on the Shift counts screen.`,
    );
  }
  const domain = buildCountShiftTypeDomain(state);
  const draft = countDraft(command, countToForm(source, domain));
  const refused = countRejection(state, command, draft, name, index);
  if (refused) return refused;
  const next = keepMarkers(source, buildCountCard(draft, domain, source.uid));
  if (stableStringify(next) === stableStringify(source)) {
    return reject(index, "no_effect", `${name} already says exactly that.`);
  }
  return {
    ok: true,
    next: withCards(
      state,
      "counts",
      state.cardsByKind.counts.map((card) => (card.uid === source.uid ? next : card)),
    ),
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
    case "add_succession_rule":
      return applyAddSuccessionRule(state, command, index);
    case "edit_succession_rule":
      return applyEditSuccessionRule(state, command, index);
    case "add_count_rule":
      return applyAddCountRule(state, command, index);
    case "edit_count_rule":
      return applyEditCountRule(state, command, index);
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
