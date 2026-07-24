import {
  RESERVED_SHIFT_TYPE,
  isDayStateSelector,
  type RequirementCard,
  type ScenarioUiState,
  type ShiftTypeId,
  type UiShiftType,
} from "@/lib/scenario";
import {
  flattenShiftTypeRefs,
  isAllDates,
  isAllScope,
  requirementsForShiftType,
  type RequirementMatch,
} from "@/lib/rules";
import {
  addItem,
  renameItem,
  updateItemFields,
  type EntityId,
  type WorkingTimeValue,
} from "@/components/entity-editor/core";
import {
  buildRequirementShiftTypeDomain,
  emptyRequirementForm,
  requirementToForm,
  validateRequirementForm,
  type RequirementErrors,
  type RequirementFormState,
  type RequirementNumberValue,
} from "@/components/requirements/requirements-model";
import {
  applyRequirementPatch,
  type RequirementPatch,
} from "@/components/requirements/requirement-patch";
import { shiftTypesDescriptor } from "./shift-types-descriptor";

export interface ShiftCardFields {
  code: string;
  name: string;
  workingTime: WorkingTimeValue;
}

export interface StaffingBaselineToken {
  /** `null` means the form opened in the safe "no active coverage" create state. */
  baselineUid: string | null;
  /** Object identity from the form-open render. */
  baselineCard: RequirementCard | null;
}

export type StaffingSaveDraft =
  | { type: "none" }
  | {
      type: "editable";
      token: StaffingBaselineToken;
      required: RequirementNumberValue;
      preferred: RequirementNumberValue;
    };

export type SaveShiftTypeCardInput =
  | {
      mode: "add";
      fields: ShiftCardFields;
      staffing: StaffingSaveDraft;
    }
  | {
      mode: "edit";
      shiftTypeId: EntityId;
      fields: ShiftCardFields;
      staffing: StaffingSaveDraft;
    };

export interface SaveShiftTypeCardResult {
  effectiveId: EntityId;
  requirement: "created" | "updated" | "unchanged";
  preferredCollapsed: boolean;
}

export type MutateScenario = (
  updater: (state: ScenarioUiState) => Partial<ScenarioUiState>,
) => void;

export class ReservedShiftTypeError extends Error {
  constructor(id: EntityId) {
    super(`“${String(id)}” is a reserved day-state and cannot have staffing.`);
    this.name = "ReservedShiftTypeError";
  }
}

export class NumericShiftTypeStaffingError extends Error {
  constructor() {
    super("Give this shift a text code to set staffing here.");
    this.name = "NumericShiftTypeStaffingError";
  }
}

export class StaleShiftRequirementError extends Error {
  constructor() {
    super("This staffing requirement changed elsewhere. Reopen the shift and try again.");
    this.name = "StaleShiftRequirementError";
  }
}

export class ShiftRequirementValidationError extends Error {
  readonly errors: RequirementErrors;

  constructor(errors: RequirementErrors) {
    const message =
      errors.requiredNumPeople ??
      errors.preferredNumPeople ??
      errors.shiftType ??
      errors.qualifiedPeople ??
      errors.date ??
      errors.weight ??
      errors.coefficients ??
      "Fix the staffing requirement errors first.";
    super(message);
    this.name = "ShiftRequirementValidationError";
    this.errors = errors;
  }
}

export type StaffingCardState =
  | { kind: "none"; reason: "reserved" }
  | { kind: "numeric"; explanation: string }
  | {
      kind: "editable";
      baseline: RequirementCard | null;
      token: StaffingBaselineToken;
      matches: RequirementMatch[];
      contextChips: string[];
      hasContext: boolean;
    }
  | {
      kind: "readonly";
      primary: RequirementMatch;
      matches: RequirementMatch[];
      ruleSummary: string;
      explanation: string;
    };

function dateContext(state: ScenarioUiState) {
  return {
    range: { start: state.rangeStart, end: state.rangeEnd },
    dateGroups: state.dateGroups,
  };
}

function isEditableBaseline(state: ScenarioUiState, match: RequirementMatch): boolean {
  return (
    match.kind === "DIRECT-SIMPLE" &&
    isAllScope(match.card.qualifiedPeople) &&
    isAllDates(match.card.date, dateContext(state))
  );
}

function refLabels(ref: unknown): string[] {
  if (ref == null) return [];
  if (Array.isArray(ref)) return ref.flatMap((value) => refLabels(value));
  return [String(ref)];
}

function pluralNurses(value: number): string {
  return `${value} nurse${value === 1 ? "" : "s"}`;
}

function describeRule(state: ScenarioUiState, match: RequirementMatch): string {
  const card = match.card;
  const required = pluralNurses(card.requiredNumPeople);
  const directRefs = flattenShiftTypeRefs(card.shiftType).map(String);

  if (match.kind === "GROUP-DERIVED") {
    return `Set by the ${directRefs.join(" + ")} group — it staffs every shift in the group together (${required}).`;
  }
  if (match.kind === "MULTI-TARGET") {
    return `Set by a rule that staffs ${match.coveredShiftTypes.join(" + ")} together (${required}).`;
  }
  if (!isAllScope(card.qualifiedPeople)) {
    return `Set by a skill rule (${refLabels(card.qualifiedPeople).join(" + ")}: ${required}).`;
  }
  if (!isAllDates(card.date, dateContext(state))) {
    return `Set by a date rule (${refLabels(card.date).join(" + ")}: ${required}).`;
  }
  return `Set by requirement ${match.index + 1} (${required}).`;
}

function contextChips(
  state: ScenarioUiState,
  baseline: RequirementCard,
  matches: RequirementMatch[],
): string[] {
  const others = matches.filter((match) => match.card.uid !== baseline.uid);
  const chips: string[] = [];

  for (const match of others) {
    if (!isAllScope(match.card.qualifiedPeople)) {
      for (const label of refLabels(match.card.qualifiedPeople)) chips.push(`${label} only`);
    }
  }

  const dateVariants = others.filter(
    (match) => !isAllDates(match.card.date, dateContext(state)),
  ).length;
  if (dateVariants > 0) {
    chips.push(`+${dateVariants} date variant${dateVariants === 1 ? "" : "s"}`);
  }

  for (const match of others) {
    if (match.kind === "GROUP-DERIVED") {
      chips.push(`${flattenShiftTypeRefs(match.card.shiftType).map(String).join(" + ")} group`);
    } else if (match.kind === "MULTI-TARGET") {
      chips.push(`${match.coveredShiftTypes.length} shifts`);
    }
  }

  const duplicateBaselines = others.filter((match) => isEditableBaseline(state, match)).length;
  if (duplicateBaselines > 0) {
    chips.push(`+${duplicateBaselines} overlapping baseline${duplicateBaselines === 1 ? "" : "s"}`);
  }

  return [...new Set(chips)];
}

/**
 * Resolve the staffing region from ACTIVE coverage, never from raw rule count.
 * Disabled cards have already been excluded by `requirementsForShiftType`.
 */
export function resolveStaffingCardState(
  state: ScenarioUiState,
  id: ShiftTypeId,
): StaffingCardState {
  const stringId = String(id);
  if (isDayStateSelector(stringId.toUpperCase())) return { kind: "none", reason: "reserved" };
  if (typeof id === "number") {
    return {
      kind: "numeric",
      explanation: "Give this shift a text code to set staffing here.",
    };
  }

  const matches = requirementsForShiftType(state, id);
  const baselineMatch = matches.find((match) => isEditableBaseline(state, match));
  if (baselineMatch) {
    const chips = contextChips(state, baselineMatch.card, matches);
    return {
      kind: "editable",
      baseline: baselineMatch.card,
      token: { baselineUid: baselineMatch.card.uid, baselineCard: baselineMatch.card },
      matches,
      contextChips: chips,
      hasContext: matches.some((match) => match.card.uid !== baselineMatch.card.uid),
    };
  }

  if (matches.length === 0) {
    return {
      kind: "editable",
      baseline: null,
      token: { baselineUid: null, baselineCard: null },
      matches,
      contextChips: [],
      hasContext: false,
    };
  }

  const primary = matches[0];
  return {
    kind: "readonly",
    primary,
    matches,
    ruleSummary: describeRule(state, primary),
    explanation:
      "You can't set this shift on its own here because another rule already covers it — two rules asking for different numbers would make the roster impossible to build. Open Staffing Requirements to change that rule, or (for a group rule) remove this shift from the group there to staff it on its own.",
  };
}

function workingTimeExtra(value: WorkingTimeValue): WorkingTimeValue {
  const out: WorkingTimeValue = {};
  if (value.startTime) out.startTime = value.startTime;
  if (value.endTime) out.endTime = value.endTime;
  if (value.restMinutes) out.restMinutes = value.restMinutes;
  if (value.durationMinutes != null) out.durationMinutes = value.durationMinutes;
  return out;
}

function workingTimePatch(
  value: WorkingTimeValue,
): Pick<UiShiftType, "startTime" | "endTime" | "restMinutes" | "durationMinutes"> {
  return {
    startTime: value.startTime || undefined,
    endTime: value.endTime || undefined,
    restMinutes: value.restMinutes || undefined,
    durationMinutes: value.durationMinutes ?? undefined,
  };
}

function hasErrors(errors: RequirementErrors): boolean {
  return Object.keys(errors).length > 0;
}

function assertFormOpenIdentity(
  live: ScenarioUiState,
  id: ShiftTypeId,
  token: StaffingBaselineToken,
): void {
  const current = resolveStaffingCardState(live, id);
  if (token.baselineUid === null) {
    if (current.kind !== "editable" || current.baseline !== null) {
      throw new StaleShiftRequirementError();
    }
    return;
  }

  const liveCard = live.cardsByKind.requirements.find((card) => card.uid === token.baselineUid);
  if (
    liveCard !== token.baselineCard ||
    current.kind !== "editable" ||
    current.baseline?.uid !== token.baselineUid
  ) {
    throw new StaleShiftRequirementError();
  }
}

/**
 * Save shift fields and the inline staffing baseline in exactly ONE live-state
 * mutation. Rename order is load-bearing: cascade first, then resolve and rebuild
 * the requirement with the post-rename id.
 */
export function saveShiftTypeCard(
  mutateScenario: MutateScenario,
  input: SaveShiftTypeCardInput,
): SaveShiftTypeCardResult {
  const originalId: EntityId = input.mode === "edit" ? input.shiftTypeId : input.fields.code;
  if (isDayStateSelector(String(originalId).toUpperCase())) {
    throw new ReservedShiftTypeError(originalId);
  }
  if (
    input.mode === "edit" &&
    typeof input.shiftTypeId === "number" &&
    input.staffing.type === "editable"
  ) {
    throw new NumericShiftTypeStaffingError();
  }

  let result: SaveShiftTypeCardResult = {
    effectiveId: originalId,
    requirement: "unchanged",
    preferredCollapsed: false,
  };

  mutateScenario((live) => {
    if (input.mode === "edit" && input.staffing.type === "editable") {
      assertFormOpenIdentity(live, input.shiftTypeId, input.staffing.token);
    }

    let next = live;
    let effectiveId: EntityId;

    if (input.mode === "add") {
      effectiveId = input.fields.code;
      next = addItem(next, shiftTypesDescriptor, {
        id: input.fields.code,
        description: input.fields.name.trim() || undefined,
        extra: workingTimeExtra(input.fields.workingTime) as Omit<
          Partial<UiShiftType>,
          "id" | "description"
        >,
      });
    } else {
      effectiveId = input.shiftTypeId;
      if (input.fields.code !== String(input.shiftTypeId)) {
        next = renameItem(next, shiftTypesDescriptor, input.shiftTypeId, input.fields.code);
        effectiveId = input.fields.code;
      }
      next = updateItemFields(next, shiftTypesDescriptor, effectiveId, {
        description: input.fields.name.trim() || undefined,
        ...workingTimePatch(input.fields.workingTime),
      });
    }

    if (input.staffing.type === "none") {
      result = { ...result, effectiveId };
      return next;
    }
    if (typeof effectiveId !== "string") throw new NumericShiftTypeStaffingError();

    const postRename = resolveStaffingCardState(next, effectiveId);
    const token = input.staffing.token;
    let form: RequirementFormState;
    let patch: RequirementPatch;
    let hadPreferred = false;

    if (token.baselineUid !== null) {
      if (postRename.kind !== "editable" || postRename.baseline?.uid !== token.baselineUid) {
        throw new StaleShiftRequirementError();
      }
      hadPreferred = postRename.baseline.preferredNumPeople !== undefined;
      const domain = buildRequirementShiftTypeDomain(next);
      form = requirementToForm(postRename.baseline, domain);
      patch = { type: "update", uid: token.baselineUid, form };
    } else {
      if (postRename.kind !== "editable" || postRename.baseline !== null) {
        throw new StaleShiftRequirementError();
      }
      if (input.staffing.required === "" && input.staffing.preferred === "") {
        result = { ...result, effectiveId };
        return next;
      }
      form = {
        ...emptyRequirementForm(),
        shiftType: [effectiveId],
        qualifiedPeople: [RESERVED_SHIFT_TYPE.all],
        date: [RESERVED_SHIFT_TYPE.all],
        weight: -50,
      };
      patch = { type: "add", form };
    }

    form = {
      ...form,
      requiredNumPeople: input.staffing.required,
      preferredNumPeople: input.staffing.preferred,
    };
    patch = { ...patch, form };

    const errors = validateRequirementForm(form, buildRequirementShiftTypeDomain(next));
    if (hasErrors(errors)) throw new ShiftRequirementValidationError(errors);

    const preferredDiffers =
      typeof form.preferredNumPeople === "number" &&
      form.preferredNumPeople !== form.requiredNumPeople;
    result = {
      effectiveId,
      requirement: patch.type === "add" ? "created" : "updated",
      preferredCollapsed: hadPreferred && !preferredDiffers,
    };
    return applyRequirementPatch(next, patch);
  });

  return result;
}
