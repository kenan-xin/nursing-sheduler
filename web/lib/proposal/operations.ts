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
//
// The leave/request arms are one quick-paint gesture each and run the page's own
// fold (`foldPaintIntents`, `lib/store/paint-fold.ts`, store- and React-free). The
// only difference is the uid minter: the page mints random ids, the host mints
// deterministic ones so Apply reproduces the Preview exactly.
//
// The Staff-screen arms call the same primitives the Staff table and the groups
// section commit (`people-table.tsx`, `groups-section.tsx`) over `peopleDescriptor`,
// behind the same `validateFullEditId` gate. Remove cascades exactly as the screen's
// Delete does -- no block -- and `deriveAssumptions` asks about any leave it destroys.

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
  deleteGroup,
  deleteItem,
  isReservedKeyword,
  paidMinutesFor,
  renameGroup,
  renameItem,
  setGroupMembers,
  updateGroupFields,
  validateFullEditId,
  validateWorkingTimeDraft,
  writeGroupMembers,
  writeItemGroups,
} from "@/components/entity-editor/core";
import { peopleDescriptor } from "@/components/people/people-descriptor";
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
import {
  buildDateScopeAutoScopes as requirementAutoScopes,
  buildDateScopeDateGroups as requirementDateGroups,
  buildDateScopeDateItems as requirementDateItems,
  buildQualifiedPeopleTransferOptions,
  buildRequirementShiftTypeDomain,
  buildRequirementShiftTypeOptions,
  emptyRequirementForm,
  requirementToForm,
  validateRequirementForm,
  type RequirementFormState,
} from "@/components/requirements/requirements-model";
import { applyRequirementPatch } from "@/components/requirements/requirement-patch";
import { RenameCollisionError } from "@/lib/cascade";
import { foldPaintIntents, type MintCellUid } from "@/lib/store/paint-fold";
import { paintCellKey, type StagedCoordinate } from "@/lib/store/types";
import type { AssistantCommandV1, RequestWeight } from "./commands";
import {
  everyoneGroups,
  idLabel,
  meansEveryone,
  offeredChoices,
  peopleChoices,
  ruleChoices,
} from "./choices";
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
  return {
    ...state,
    cardsByKind: { ...state.cardsByKind, [kind]: cards } as CardsByKind,
  };
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

/**
 * The first person ref neither offered nor already on the edited card. An edit form
 * loads the card's own refs (`successionToForm` / `countToForm`), so a rule scoped to
 * ALL keeps ALL on Save although the picker never offers it.
 */
function firstUnofferedPerson(
  picked: readonly PersonRef[],
  offered: readonly PickerOption[],
  held: unknown,
): PersonRef | undefined {
  const kept: unknown[] = held === undefined ? [] : [held].flat(Infinity);
  return firstUnoffered(
    picked.filter((ref) => !kept.some((own) => Object.is(own, ref))),
    offered,
  );
}

/**
 * The refusal for a person ref a rule's People picker does not offer.
 *
 * "Everyone" gets its own answer. These pickers never offer the synthetic ALL, and the
 * live failure was a model inventing names for "apply this to everyone". Naming a group
 * that already holds everyone, or else the people to list, is the one-retry fix.
 */
function rulePersonRefusal(
  state: ScenarioUiState,
  name: string,
  person: PersonRef,
  offered: readonly PickerOption[],
  index: number,
): OperationResult {
  if (meansEveryone(person)) {
    const groups = everyoneGroups(state);
    const how =
      groups.length > 0
        ? `Use the staff group ${groups.map(idLabel).join(" or ")}, which holds everyone`
        : "List each person, or add a staff group that holds everyone earlier in the same change";
    return reject(
      index,
      "unknown_target",
      `${name}: this rule cannot say "everyone" directly. ${how}. ${peopleChoices(state)}`,
    );
  }
  return reject(
    index,
    "unknown_target",
    `${name}: there is no person or staff group ${idLabel(person)}. Name each person, or an existing staff group. ${offeredChoices(offered)}`,
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
  held?: unknown,
): OperationResult | undefined {
  const people = successionPeopleOptions(state);
  const offeredPeople = [...people.items, ...people.groups];
  const person = firstUnofferedPerson(fields.people, offeredPeople, held);
  if (person !== undefined) return rulePersonRefusal(state, name, person, offeredPeople, index);
  const shifts = buildPatternShiftTypeOptions(state);
  const offeredShifts = [...shifts.items, ...shifts.groups];
  const shift = firstUnoffered(fields.pattern, offeredShifts);
  if (shift !== undefined) {
    return reject(
      index,
      "unknown_target",
      `${name}: there is no shift or shift group ${idLabel(shift)}. ${offeredChoices(offeredShifts)}`,
    );
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
      `That shift sequence rule is not in this schedule any more. ${ruleChoices(state, "successions")}`,
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
  const refused = successionRejection(state, command, name, index, source.person);
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
  held?: unknown,
): OperationResult | undefined {
  const people = countPeopleOptions(state);
  const offeredPeople = [...people.items, ...people.groups];
  const person = firstUnofferedPerson(fields.people, offeredPeople, held);
  if (person !== undefined) return rulePersonRefusal(state, name, person, offeredPeople, index);
  const shifts = buildCountShiftTypeTransferOptions(state);
  const offeredShifts = [...shifts.items, ...shifts.groups];
  const shift = firstUnoffered(fields.shiftTypes, offeredShifts);
  if (shift !== undefined) {
    return reject(
      index,
      "unknown_target",
      `${name}: there is no shift or shift group ${idLabel(shift)}. ${offeredChoices(offeredShifts)}`,
    );
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
  return {
    ok: true,
    next: withCards(state, "counts", [...state.cardsByKind.counts, card]),
  };
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
      `That shift count rule is not in this schedule any more. ${ruleChoices(state, "counts")}`,
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
  const refused = countRejection(state, command, draft, name, index, source.person);
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

// --- Staffing requirements -----------------------------------------------------

type RequirementFields = Omit<
  Extract<AssistantCommandV1, { type: "add_staffing_requirement" }>,
  "type"
>;

const REQUIREMENT_DATES: DateScopeBuilders = {
  auto: requirementAutoScopes,
  groups: requirementDateGroups,
  items: requirementDateItems,
};

/** The Staffing requirements form after the user entered these values, over `base`. */
function requirementDraft(
  fields: RequirementFields,
  base: RequirementFormState,
): RequirementFormState {
  return {
    ...base,
    description: fields.description,
    shiftType: [fields.shiftType],
    requiredNumPeople: fields.requiredNumPeople,
    qualifiedPeople: [...fields.qualifiedPeople],
    date: [...fields.dates],
  };
}

function requirementRejection(
  state: ScenarioUiState,
  fields: RequirementFields,
  draft: RequirementFormState,
  name: string,
  index: number,
): OperationResult | undefined {
  const shifts = buildRequirementShiftTypeOptions(state);
  const offeredShifts = [...shifts.items, ...shifts.groups];
  if (firstUnoffered([fields.shiftType], offeredShifts) !== undefined) {
    return reject(
      index,
      "unknown_target",
      `${name}: "${fields.shiftType}" is not a shift or shift group that can be staffed. Use a shift code, or a group made only of shifts. ${offeredChoices(offeredShifts)}`,
    );
  }
  const people = buildQualifiedPeopleTransferOptions(state);
  const offeredPeople = [...people.items, ...people.groups];
  const person = firstUnoffered(fields.qualifiedPeople, offeredPeople);
  if (person !== undefined) {
    return reject(
      index,
      "unknown_target",
      `${name}: there is no person or staff group ${idLabel(person)}. ${offeredChoices(offeredPeople)}`,
    );
  }
  const dates = dateScopeRejection(state, fields.dates, REQUIREMENT_DATES);
  if (dates) return reject(index, dates.code, `${name}: ${dates.message}.`);
  const error = firstFormError(
    validateRequirementForm(draft, buildRequirementShiftTypeDomain(state)),
  );
  if (error) return reject(index, "invalid_value", `${name}: ${error}.`);
  return undefined;
}

function applyAddStaffingRequirement(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "add_staffing_requirement" }>,
  index: number,
): OperationResult {
  const draft = requirementDraft(command, emptyRequirementForm());
  const refused = requirementRejection(
    state,
    command,
    draft,
    ruleName("requirements", command.description),
    index,
  );
  if (refused) return refused;
  return {
    ok: true,
    next: applyRequirementPatch(state, {
      type: "add",
      form: draft,
      uid: newRuleUid(state, "requirements", command),
    }),
  };
}

function applyEditStaffingRequirement(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "edit_staffing_requirement" }>,
  index: number,
): OperationResult {
  const source = state.cardsByKind.requirements.find((card) => card.uid === command.ruleId);
  if (!source) {
    return reject(
      index,
      "unknown_target",
      `That staffing requirement is not in this schedule any more. ${ruleChoices(state, "requirements")}`,
    );
  }
  const name = ruleName("requirements", source.description?.trim() || source.uid);
  const draft = requirementDraft(
    command,
    requirementToForm(source, buildRequirementShiftTypeDomain(state)),
  );
  const refused = requirementRejection(state, command, draft, name, index);
  if (refused) return refused;
  // `applyRequirementPatch` update keeps the uid and the disabled/applied markers itself.
  const next = applyRequirementPatch(state, {
    type: "update",
    uid: source.uid,
    form: draft,
  });
  const after = next.cardsByKind.requirements.find((card) => card.uid === source.uid);
  if (stableStringify(after) === stableStringify(source)) {
    return reject(index, "no_effect", `${name} already says exactly that.`);
  }
  return { ok: true, next };
}

// --- Remove (every family) -----------------------------------------------------

function applyRemoveRule(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "remove_rule" }>,
  index: number,
): OperationResult {
  if (!findRule(state, command.ruleKind, command.ruleId)) {
    return reject(
      index,
      "unknown_target",
      `That ${RULE_LABEL[command.ruleKind]} is not in this schedule any more. ${ruleChoices(state, command.ruleKind)}`,
    );
  }
  // Every editor's `remove`: `current.filter((card) => card.uid !== uid)`.
  const cards = state.cardsByKind[command.ruleKind] as readonly {
    uid: string;
  }[];
  return {
    ok: true,
    next: withCards(
      state,
      command.ruleKind,
      cards.filter((card) => card.uid !== command.ruleId),
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
      `That ${RULE_LABEL[command.ruleKind]} is not in this schedule any more. ${ruleChoices(state, command.ruleKind)}`,
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
      `That staffing requirement is not in this schedule any more. ${ruleChoices(state, "requirements")}`,
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
    return {
      ok: false,
      code: "invalid_value",
      message: "Those are not real calendar dates.",
    };
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
  {
    type: "add_leave" | "set_off_request" | "set_shift_request" | "clear_requests";
  }
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
      return {
        ok: true,
        intent: { mode: "day-state", dayState: { kind: "leave" } },
      };
    case "set_off_request":
      return {
        ok: true,
        intent: {
          mode: "day-state",
          dayState: { kind: "off", weight: toWeight(command.weight) },
        },
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
        intent: {
          mode: "requests",
          deltas: new Map([[shiftType, toWeight(command.weight)]]),
        },
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

// ---------------------------------------------------------------------------
// Staff screen: people and staff groups
// ---------------------------------------------------------------------------

const PERSON_ID_HINT = "Use the id exactly as the staff list shows it -- a number stays a number.";

/** The person with exactly this id (`1` and `"1"` are different people). */
function findPerson(state: ScenarioUiState, personId: PersonRef) {
  return state.staff.find((person) => person.id === personId);
}

function unknownPersonMessage(personId: PersonRef): string {
  return `Person "${String(personId)}": not on the staff list. ${PERSON_ID_HINT}`;
}

/** Refuse a group the Staff row's toggles could not have picked. */
function missingStaffGroup(
  state: ScenarioUiState,
  label: string,
  groups: readonly string[],
  index: number,
): OperationResult | null {
  const missing = groups.find((id) => !state.staffGroups.some((group) => group.id === id));
  if (missing === undefined) return null;
  if (isReservedKeyword(peopleDescriptor.reservedKeywords, missing)) {
    return reject(
      index,
      "unknown_target",
      `${label}: everyone is in "${missing}" automatically -- leave it out of the groups.`,
    );
  }
  return reject(
    index,
    "unknown_target",
    `${label}: there is no staff group "${missing}". Add the group earlier in the same change, or use an existing group name.`,
  );
}

/** Refuse a member the group form's picker could not have offered. */
function missingMember(
  state: ScenarioUiState,
  label: string,
  members: readonly PersonRef[],
  index: number,
): OperationResult | null {
  const missing = members.find((member) => !findPerson(state, member));
  if (missing === undefined) return null;
  return reject(
    index,
    "unknown_target",
    `${label}: there is no person "${String(missing)}". Add the person earlier in the same change. ${PERSON_ID_HINT}`,
  );
}

/** An edit that leaves the document as it was would spend an Undo entry on nothing. */
function unchanged(before: ScenarioUiState, after: ScenarioUiState): boolean {
  return after === before || stableStringify(after) === stableStringify(before);
}

function applyAddPerson(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "add_person" }>,
  index: number,
): OperationResult {
  const d = peopleDescriptor;
  const idCheck = validateFullEditId(d, d.readItems(state), d.readGroups(state), command.name);
  if (!idCheck.ok) {
    return reject(index, "invalid_value", `Person "${command.name.trim()}": ${idCheck.message}.`);
  }
  const groups = [...new Set(command.groups)];
  const refused = missingStaffGroup(state, `Person "${idCheck.id}"`, groups, index);
  if (refused) return refused;
  return {
    ok: true,
    next: writeItemGroups(addItem(state, d, { id: idCheck.id }), d, idCheck.id, groups),
  };
}

function applyEditPerson(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "edit_person" }>,
  index: number,
): OperationResult {
  const d = peopleDescriptor;
  const person = findPerson(state, command.personId);
  if (!person) return reject(index, "unknown_target", unknownPersonMessage(command.personId));
  const label = `Person "${String(person.id)}"`;

  // The Staff row's own rule (`people-table.tsx`, `nameChanged`): only changed name
  // TEXT is a rename, so an unchanged numeric id stays numeric.
  let renameTo: string | null = null;
  if (command.name !== String(person.id)) {
    const idCheck = validateFullEditId(
      d,
      d.readItems(state),
      d.readGroups(state),
      command.name,
      false,
      person.id,
    );
    if (!idCheck.ok) {
      return reject(
        index,
        "invalid_value",
        `${label}: cannot be renamed to "${command.name.trim()}": ${idCheck.message}.`,
      );
    }
    renameTo = idCheck.id;
  }
  const groups = [...new Set(command.groups)];
  const refused = missingStaffGroup(state, label, groups, index);
  if (refused) return refused;

  let next: ScenarioUiState;
  try {
    const renamed = renameTo === null ? state : renameItem(state, d, person.id, renameTo);
    next = writeItemGroups(renamed, d, renameTo ?? person.id, groups);
  } catch (error) {
    // Backstop only: `validateFullEditId` above refuses every collision first.
    if (!(error instanceof RenameCollisionError)) throw error;
    return reject(index, "invalid_value", `${label}: ${error.message}`);
  }
  if (unchanged(state, next)) {
    return reject(index, "no_effect", `${label}: already has that name and those groups.`);
  }
  return { ok: true, next };
}

function applyRemovePerson(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "remove_person" }>,
  index: number,
): OperationResult {
  const person = findPerson(state, command.personId);
  if (!person) return reject(index, "unknown_target", unknownPersonMessage(command.personId));
  return { ok: true, next: deleteItem(state, peopleDescriptor, person.id) };
}

function applyAddPeopleGroup(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "add_people_group" }>,
  index: number,
): OperationResult {
  const d = peopleDescriptor;
  const idCheck = validateFullEditId(
    d,
    d.readItems(state),
    d.readGroups(state),
    command.groupId,
    true,
  );
  if (!idCheck.ok) {
    return reject(
      index,
      "invalid_value",
      `Staff group "${command.groupId.trim()}": ${idCheck.message}.`,
    );
  }
  const members = [...new Set(command.members)];
  const refused = missingMember(state, `Staff group "${idCheck.id}"`, members, index);
  if (refused) return refused;
  const withGroup = addGroup(state, d, {
    id: idCheck.id,
    description: command.description.trim() || undefined,
  });
  return {
    ok: true,
    next: writeGroupMembers(withGroup, d, idCheck.id, members),
  };
}

function applyEditPeopleGroup(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "edit_people_group" }>,
  index: number,
): OperationResult {
  const d = peopleDescriptor;
  const group = state.staffGroups.find((g) => g.id === command.groupId);
  if (!group) {
    return reject(
      index,
      "unknown_target",
      `Staff group "${command.groupId}": there is no such staff group.`,
    );
  }
  const label = `Staff group "${group.id}"`;
  // The group form's own rule: only changed id TEXT is a rename.
  let gid = group.id;
  const idChanged = command.newGroupId !== group.id;
  if (idChanged) {
    const idCheck = validateFullEditId(
      d,
      d.readItems(state),
      d.readGroups(state),
      command.newGroupId,
      true,
      group.id,
    );
    if (!idCheck.ok) {
      return reject(
        index,
        "invalid_value",
        `${label}: cannot be renamed to "${command.newGroupId.trim()}": ${idCheck.message}.`,
      );
    }
    gid = idCheck.id;
  }
  const members = [...new Set(command.members)];
  const refused = missingMember(state, label, members, index);
  if (refused) return refused;

  let next: ScenarioUiState;
  try {
    next = idChanged ? renameGroup(state, d, group.id, gid) : state;
  } catch (error) {
    if (!(error instanceof RenameCollisionError)) throw error;
    return reject(index, "invalid_value", `${label}: ${error.message}`);
  }
  next = updateGroupFields(next, d, gid, {
    description: command.description.trim() || undefined,
  });
  next = writeGroupMembers(next, d, gid, members);
  if (unchanged(state, next)) {
    return reject(
      index,
      "no_effect",
      `${label}: already has that name, description and those members.`,
    );
  }
  return { ok: true, next };
}

function applyRemovePeopleGroup(
  state: ScenarioUiState,
  command: Extract<AssistantCommandV1, { type: "remove_people_group" }>,
  index: number,
): OperationResult {
  if (!state.staffGroups.some((group) => group.id === command.groupId)) {
    return reject(
      index,
      "unknown_target",
      `Staff group "${command.groupId}": there is no such staff group.`,
    );
  }
  return {
    ok: true,
    next: deleteGroup(state, peopleDescriptor, command.groupId),
  };
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
    case "add_succession_rule":
      return applyAddSuccessionRule(state, command, index);
    case "edit_succession_rule":
      return applyEditSuccessionRule(state, command, index);
    case "add_count_rule":
      return applyAddCountRule(state, command, index);
    case "edit_count_rule":
      return applyEditCountRule(state, command, index);
    case "add_staffing_requirement":
      return applyAddStaffingRequirement(state, command, index);
    case "edit_staffing_requirement":
      return applyEditStaffingRequirement(state, command, index);
    case "remove_rule":
      return applyRemoveRule(state, command, index);
    case "add_person":
      return applyAddPerson(state, command, index);
    case "edit_person":
      return applyEditPerson(state, command, index);
    case "remove_person":
      return applyRemovePerson(state, command, index);
    case "add_people_group":
      return applyAddPeopleGroup(state, command, index);
    case "edit_people_group":
      return applyEditPeopleGroup(state, command, index);
    case "remove_people_group":
      return applyRemovePeopleGroup(state, command, index);
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
