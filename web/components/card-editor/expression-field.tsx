"use client";

// Shared 6-expression selector + Target + "reads as" preview (T12 seed, Counts-
// specific but extracted to card-editor/ per the ticket plan since it is likely
// reused). Ground truth for the exact expression set/order and the target-
// substitution card copy is the historical `SUPPORTED_EXPRESSIONS`
// (core/nurse_scheduling/preference_types.py) and `shift-counts/page.tsx`
// (`describeExpressionTarget`); the option copy (title/help per glyph) follows the
// design prototype's `EXPR_OPS` (ScreenCards.dc.html:540),
// translated to the exact ASCII backend strings (spec 05 FR-PR-52, AC-PR-12).

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Surface } from "@/components/ui/surface";
import { FaCircleCheck, FaCircleExclamation, FaCircleInfo } from "@/components/icons";

import {
  EXPRESSION_OPS,
  isSquaredExpression,
  type ExpressionFieldValue,
  type ExpressionTargetValue,
} from "./expression-model";

export {
  EXPRESSION_OPS,
  SUPPORTED_EXPRESSIONS,
  isSquaredExpression,
  isSupportedExpression,
  substituteTarget,
  type ExpressionFieldValue,
  type ExpressionOp,
  type ExpressionTargetValue,
} from "./expression-model";

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
      <Surface level="well" geometry="control" className="flex items-start gap-2 p-2.5">
        <FaCircleInfo className="mt-0.5 flex-none text-brandink" />
        <span className="text-meta text-ink2">
          <b className="font-mono">x</b> is this person&apos;s count — the selected shift types over
          the selected dates, each weighted by its coefficient. Pick how{" "}
          <b className="font-mono">x</b> should relate to your target <b className="font-mono">T</b>
          .
        </span>
      </Surface>
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
              className={`flex items-center gap-3 rounded-control border px-3 py-2.5 text-left transition-[background-color,box-shadow] duration-fast pointer-coarse:min-h-touch ${
                selected
                  ? "border-brand bg-brandtint shadow-2"
                  : "border-line bg-surface shadow-1 hover:bg-panel-alt hover:shadow-2"
              }`}
            >
              <span
                className={`min-w-[74px] flex-none whitespace-nowrap rounded-chip border px-3 py-1.5 text-center font-mono text-label-md font-bold ${
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
          <Input
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
            className="w-[132px] font-mono font-bold"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            Reads as
          </span>
          {/* A read-only echo of the chosen expression, so it is an inset well
              rather than the `--brandtint` + `--brand` box DESIGN.md §6 reserves
              for selection. The accent stays, carried by `--brandink` text. */}
          <span
            className="rounded-control bg-panel px-3.5 py-2 font-mono font-bold text-brandink shadow-well"
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
