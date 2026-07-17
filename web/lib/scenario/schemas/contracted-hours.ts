// Shared marked-contract (Contracted-Hours shift count) expand/validate helper.
//
// This is the pure core of the coverage-bijection + policy-encoding rules that
// mirror the backend's `group_map._validate_policy_encoding` +
// `_validate_coverage` (DL09 D4). It is extracted from the producer schema's
// private `validateContractedHours` so both the strict producer preflight (T05)
// and the editor commit path can share one source of truth: the producer schema
// translates each returned error into a Zod issue, and the editor can render the
// same errors plus the concrete `expanded` coverage set.
//
// Behavior contract: for any given input the set, order, and message text of the
// returned errors is byte-identical to what the producer schema emitted inline.

import { RESERVED_SHIFT_TYPE, type ShiftTypeGroupMember } from "../types";
import { expandShiftTypeSelector, OFF_SID, type ShiftTypeMapKey } from "./shift-type-map";

/** One marked Contracted-Hours shift count, reduced to the fields the rules read. */
export interface ContractedHoursInput {
  weight: number;
  expression: unknown; // scalar string or 2-tuple
  target: number | [number, number];
  policy: "exact" | "range"; // from hoursContract.policy
  countShiftTypes: ShiftTypeGroupMember | ShiftTypeGroupMember[];
  countShiftTypeCoefficients?: ReadonlyArray<readonly [string, number]>;
}

/** The slot an error attaches to — a Zod path suffix and an editor field id. */
export type ContractedHoursField =
  | "weight"
  | "expression"
  | "target"
  | "countShiftTypes"
  | "countShiftTypeCoefficients";

export interface ContractedHoursError {
  field: ContractedHoursField; // maps to path-suffix (Zod) AND editor slot
  message: string; // EXACT current message text
  shiftTypeId?: string; // for per-coefficient errors (editor per-id slot)
}

export interface ContractedHoursValidation {
  expanded: number[]; // sorted concrete day-state indices (the coverage set)
  errors: ContractedHoursError[];
}

/**
 * Validate a single marked contract, returning the concrete expansion and the
 * structured errors. Preserves the exact ordering and early-returns of the
 * original inline validator so the emitted issue set never changes.
 */
export function validateContractedHoursContract(
  input: ContractedHoursInput,
  map: Map<ShiftTypeMapKey, number[]>,
  groupIds: ReadonlySet<unknown>,
): ContractedHoursValidation {
  const errors: ContractedHoursError[] = [];
  const addError = (field: ContractedHoursField, message: string, shiftTypeId?: string): void => {
    errors.push(shiftTypeId === undefined ? { field, message } : { field, message, shiftTypeId });
  };

  // Policy encoding.
  if (input.weight !== Infinity)
    addError(
      "weight",
      `A contracted-hours shift count must use weight '.inf', but got ${input.weight}.`,
    );
  if (input.policy === "exact") {
    if (input.expression !== "x = T")
      addError("expression", "An exact contracted-hours shift count must use expression 'x = T'.");
    if (Array.isArray(input.target))
      addError("target", "An exact contracted-hours shift count must use a scalar target.");
    else if (input.target < 0)
      addError("target", `Contracted-hours target must be non-negative, but got ${input.target}.`);
  } else {
    if (
      !Array.isArray(input.expression) ||
      input.expression[0] !== "x >= T" ||
      input.expression[1] !== "x <= T" ||
      input.expression.length !== 2
    )
      addError(
        "expression",
        "A range contracted-hours shift count must use expression ['x >= T', 'x <= T'].",
      );
    if (!Array.isArray(input.target) || input.target.length !== 2)
      addError(
        "target",
        "A range contracted-hours shift count must use a two-element [minimum, maximum] target.",
      );
    else {
      const [min, max] = input.target;
      if (min < 0 || max < 0)
        addError(
          "target",
          `Contracted-hours range targets must be non-negative, but got [${min}, ${max}].`,
        );
      else if (min > max)
        addError(
          "target",
          `Contracted-hours range minimum must not exceed maximum, but got [${min}, ${max}].`,
        );
    }
  }

  // Coverage: expanded selectors must equal the explicit coefficient set exactly.
  const selectors = Array.isArray(input.countShiftTypes)
    ? input.countShiftTypes
    : [input.countShiftTypes];
  if (selectors.length === 0) {
    addError(
      "countShiftTypes",
      "A contracted-hours shift count requires non-empty countShiftTypes.",
    );
    return { expanded: [], errors };
  }
  const expanded = new Set<number>();
  let unknownSelector = false;
  for (const selector of selectors) {
    const indices = expandShiftTypeSelector(selector, map);
    if (indices == null) {
      addError("countShiftTypes", `Unknown shift type ID: ${selector}`);
      unknownSelector = true;
      continue;
    }
    for (const s of indices) expanded.add(s);
  }
  if (unknownSelector) return { expanded: sortAscending(expanded), errors };
  if (expanded.size === 0)
    addError(
      "countShiftTypes",
      "A contracted-hours shift count must select at least one shift type.",
    );
  if (expanded.has(OFF_SID))
    addError("countShiftTypes", "'OFF' is not allowed in a contracted-hours shift count.");

  const coefficientSids = new Set<number>();
  for (const [shiftTypeId, coefficient] of input.countShiftTypeCoefficients ?? []) {
    if (coefficient < 1) {
      addError(
        "countShiftTypeCoefficients",
        `Contracted-hours coefficient for '${shiftTypeId}' must be at least 1.`,
        shiftTypeId,
      );
      continue;
    }
    if (shiftTypeId === RESERVED_SHIFT_TYPE.off) {
      addError(
        "countShiftTypeCoefficients",
        "'OFF' is not allowed in a contracted-hours shift count.",
        shiftTypeId,
      );
      continue;
    }
    if (shiftTypeId === RESERVED_SHIFT_TYPE.all || groupIds.has(shiftTypeId)) {
      addError(
        "countShiftTypeCoefficients",
        `Contracted-hours coefficient '${shiftTypeId}' must be a concrete shift type or 'LEAVE', not a group or 'ALL'.`,
        shiftTypeId,
      );
      continue;
    }
    const indices = expandShiftTypeSelector(shiftTypeId, map);
    if (indices == null || indices.length !== 1) {
      addError("countShiftTypeCoefficients", `Unknown shift type ID: ${shiftTypeId}`, shiftTypeId);
      continue;
    }
    const sid = indices[0];
    if (coefficientSids.has(sid)) {
      addError(
        "countShiftTypeCoefficients",
        `Duplicate contracted-hours coefficient for '${shiftTypeId}'.`,
        shiftTypeId,
      );
      continue;
    }
    coefficientSids.add(sid);
  }
  if ([...expanded].some((s) => !coefficientSids.has(s)))
    addError(
      "countShiftTypeCoefficients",
      "A contracted-hours shift count must list an explicit coefficient for every selected shift type (including LEAVE); coverage is incomplete.",
    );
  if ([...coefficientSids].some((s) => !expanded.has(s)))
    addError(
      "countShiftTypeCoefficients",
      "A contracted-hours coefficient does not correspond to any selected shift type.",
    );

  return { expanded: sortAscending(expanded), errors };
}

function sortAscending(indices: Set<number>): number[] {
  return [...indices].sort((a, b) => a - b);
}
