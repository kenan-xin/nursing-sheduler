"use client";

// Shared 6-expression selector + Target + "reads as" preview (T12 seed, Counts-
// specific but extracted to card-editor/ per the ticket plan since it is likely
// reused). Ground truth for the exact expression set/order and the target-
// substitution card copy is the historical `SUPPORTED_EXPRESSIONS`
// (core/nurse_scheduling/preference_types.py) and `shift-counts/page.tsx`
// (`describeExpressionTarget`); the option copy (title/help per glyph) follows the
// design prototype's `EXPR_OPS` (ScreenCards.dc.html / Nurse Scheduling.dc.html),
// translated to the exact ASCII backend strings (spec 05 FR-PR-52, AC-PR-12).

import * as React from "react";
import { FaCircleCheck, FaCircleExclamation, FaCircleInfo } from "@/components/icons";

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

export interface ExpressionFieldProps extends ExpressionFieldValue {
  onChange: (next: ExpressionFieldValue) => void;
  error?: string;
  testId?: string;
}

export function ExpressionField({
  expression,
  target,
  onChange,
  error,
  testId = "expression-field",
}: ExpressionFieldProps) {
  const previewTarget = target === "" || target == null ? "T" : String(target);
  const preview = expression.replace(/T/g, previewTarget);

  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <div className="flex items-start gap-2 border border-line2 bg-panel p-2.5 text-meta text-ink2">
        <FaCircleInfo className="mt-0.5 flex-none text-brandink" />
        <span>
          <b className="font-mono">x</b> is this person&apos;s count — the selected shift types over
          the selected dates, each weighted by its coefficient. Pick how{" "}
          <b className="font-mono">x</b> should relate to your target <b className="font-mono">T</b>
          .
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {EXPRESSION_OPS.map((op) => {
          const selected = op.value === expression;
          return (
            <button
              key={op.id}
              type="button"
              data-testid={`${testId}-op-${op.id}`}
              aria-pressed={selected}
              onClick={() => onChange({ expression: op.value, target })}
              className={`flex items-center gap-3 border px-3 py-2.5 text-left ${
                selected ? "border-brand bg-brandtint" : "border-line bg-surface"
              }`}
            >
              <span
                className={`min-w-[74px] flex-none whitespace-nowrap border px-3 py-1.5 text-center font-mono text-label-md font-bold ${
                  selected
                    ? "border-brand bg-surface text-brandink"
                    : "border-line2 bg-panel text-ink2"
                }`}
              >
                {op.value}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-semibold text-ink">{op.title}</span>
                <span className="text-meta text-ink3">{op.help}</span>
              </span>
              {selected && <FaCircleCheck className="ml-auto size-4 flex-none text-brand" />}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            Target value (T)
          </span>
          <input
            type="number"
            min={0}
            step={1}
            data-testid={`${testId}-target`}
            aria-label="Target value"
            value={target}
            onChange={(e) => {
              const raw = e.target.value;
              const numValue = Number(raw);
              const nextTarget: ExpressionTargetValue =
                raw === "" ? "" : Number.isInteger(numValue) ? numValue : raw;
              onChange({ expression, target: nextTarget });
            }}
            placeholder="e.g. 5"
            className="h-10 w-[132px] border border-line bg-surface px-3 font-mono font-bold"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            Reads as
          </span>
          <span
            className="border border-brand bg-brandtint px-3.5 py-2 font-mono font-bold text-brandink"
            data-testid={`${testId}-preview`}
          >
            {preview}
          </span>
        </label>
      </div>
      <p
        className="flex items-start gap-2 text-meta text-ink3"
        data-testid={`${testId}-target-note`}
      >
        <FaCircleInfo className="mt-0.5 flex-none text-brandink" />
        <span>
          {isSquaredExpression(expression)
            ? "T is the ideal count. |x − T|² pushes x toward T from both sides — pair it with a negative or −∞ weight (a positive weight is rejected)."
            : "T is a whole number in the same unit as the coefficients — e.g. a 160h contract in half-hour units is 320."}
        </span>
      </p>
      {error && (
        <p className="flex items-center gap-1.5 text-meta font-semibold text-error" role="alert">
          <FaCircleExclamation className="size-3 flex-none" /> {error}
        </p>
      )}
    </div>
  );
}
