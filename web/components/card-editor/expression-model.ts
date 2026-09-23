// The six count expressions and their pure helpers, moved verbatim out of
// `expression-field.tsx` so React-free callers can share them. The component file
// re-exports every name.

export interface ExpressionOp {
  id: "sq" | "ge" | "le" | "gt" | "lt" | "eq";
  /** The exact backend-persisted `expression` string (SUPPORTED_EXPRESSIONS order). */
  value: string;
  title: string;
  help: string;
}

/** The six supported expressions, in the EXACT backend order (spec 05 FR-PR-52,
 *  AC-PR-12): `|x - T|^2, x >= T, x <= T, x > T, x < T, x = T`. */
export const EXPRESSION_OPS: readonly ExpressionOp[] = [
  {
    id: "sq",
    value: "|x - T|^2",
    title: "Close to target",
    help: "Penalizes how far the count lands from T — the bigger the gap, the bigger the penalty. Needs a non-positive weight.",
  },
  {
    id: "ge",
    value: "x >= T",
    title: "At least T",
    help: "The count must be at least the target.",
  },
  {
    id: "le",
    value: "x <= T",
    title: "At most T",
    help: "The count must be no more than the target.",
  },
  {
    id: "gt",
    value: "x > T",
    title: "More than T",
    help: "The count must be strictly greater than the target.",
  },
  {
    id: "lt",
    value: "x < T",
    title: "Fewer than T",
    help: "The count must be strictly fewer than the target.",
  },
  {
    id: "eq",
    value: "x = T",
    title: "Exactly T",
    help: "The count must equal the target exactly.",
  },
];

/** The backend-persisted expression strings, in canonical order. */
export const SUPPORTED_EXPRESSIONS: readonly string[] = EXPRESSION_OPS.map((op) => op.value);

/** Whether `expression` is a value this field recognizes. */
export function isSupportedExpression(expression: string): boolean {
  return SUPPORTED_EXPRESSIONS.includes(expression);
}

/** Whether `expression` is the squared "close to target" form — the one requiring
 *  a non-positive weight (spec 05 FR-PR-626/AC-PR-12). */
export function isSquaredExpression(expression: string): boolean {
  return expression === "|x - T|^2";
}

/** Substitute the target value into an expression string for display (FR-PR-55,
 *  the historical `describeExpressionTarget`). */
export function substituteTarget(expression: string, target: number): string {
  return expression.replace(/T/g, String(target));
}

/** A target-value draft: an integer, `""` (blank), or raw invalid text kept
 *  verbatim (mirrors the historical `NumberInput` target handler). */
export type ExpressionTargetValue = number | string;

export interface ExpressionFieldValue {
  expression: string;
  target: ExpressionTargetValue;
}
