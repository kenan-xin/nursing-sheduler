"use client";

// The guided add/edit form for a Contracted-Hours shift count (T12 M2a-3). The
// full guided editor that authors the marked card end-to-end: a policy toggle
// (Exact / Range), the target on the half-hour grid (authored as integer
// half-hours in the UI, stored in the draft as human hours via the codec), the
// shared per-shift-type coefficient sub-editor wired over the CONCRETE day-state
// expansion, and ONE collapsible "Solver details & overrides" section that shows
// the concrete expression the card will serialize and the locked `+∞` weight.
// Save is gated by the SHARED coverage validator (`validateContractedCommit` →
// `validateContractedHoursContract`): a draft with incomplete/extra/invalid
// coverage is blocked with the error in place and the draft stays recoverable,
// never silently dropped.
//
// The layout follows the guided prototype (docs/design_prototype/source/
// ScreenCards.dc.html:55-77,93-133,398-419): the "IN PLAIN ENGLISH" panel with
// the Refresh-from-Shift-Types action in its header and the pending preview
// directly beneath it, then a FULL-WIDTH policy/target cell whose target is the
// prototype's friendly-hours slider + large `{h}h` readout over a raw half-hour
// number input. The slider is decorative — it carries no handler and is
// `aria-hidden` — because the number input is the control, exactly as in the
// prototype. The readout/slider scale is display-only (see SLIDER_CAP_HALF_HOURS).
//
// Expression and weight are LOCKED by policy — changing them requires converting to
// a generic Shift Count (the Convert action itself is M2a-4; only the note lives
// here). Refresh-from-Shift-Types derivation is M2a-5; coefficients are entered
// MANUALLY here.

import { useEffect, useMemo, useRef, useState } from "react";
import { formatUncreditedLeaveWarning, type ScenarioUiState } from "@/lib/scenario";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import {
  FaArrowRotateRight,
  FaChevronRight,
  FaLock,
  FaPlus,
  FaTriangleExclamation,
} from "@/components/icons";
import { CardEditorForm } from "@/components/card-editor/card-editor-shell";
import { TransferList } from "@/components/entity-editor/transfer-list";
import { entityKey, sameEntityId } from "@/components/entity-editor/core";
import { DateScopeField } from "@/components/card-editor/date-scope-field";
import {
  CoefficientFields,
  syncCoefficientPairs,
} from "@/components/card-editor/coefficient-fields";
import { FieldShell } from "@/components/card-editor/field-shell";
import {
  buildCountShiftTypeTransferOptions,
  buildDateScopeAutoScopes,
  buildDateScopeDateGroups,
  buildDateScopeDateItems,
  buildPeopleTransferOptions,
  summarizeRefs,
  toggleInSelection,
} from "./counts-model";
import {
  addLeaveCreditToContractDraft,
  buildContractedCoefficientDomain,
  contractedCoefficientIds,
  findContractedDraftLeaveAdvisory,
  hasContractedErrors,
  validateContractedCommit,
  type ContractedErrors,
  type ContractedFormState,
} from "./contracted-model";
import {
  applyContractedRefresh,
  deriveContractedRefresh,
  type RefreshCategory,
  type RefreshPreview,
  type RefreshRow,
} from "./refresh-model";
import {
  formatHalfHours,
  HALF_HOURS_PER_HOUR,
  LEAVE_CREDIT_HALF_HOURS,
  parseHalfHours,
  parseRawHalfHours,
} from "./half-hour-codec";

interface ContractedFormProps {
  state: ScenarioUiState;
  mode: "add" | "edit";
  initialForm: ContractedFormState;
  /** Whether the source card is enabled (`!sourceCard.disabled`; always true for a
   *  fresh "Add"). A disabled/absent source suppresses the uncredited-leave advisory
   *  and its Add-LEAVE action, matching the saved badge (qq0.23-UI critique P2). */
  isEnabled: boolean;
  onSave: (form: ContractedFormState) => void;
  onCancel: () => void;
}

/**
 * The Exact / Range policy segmented toggle. Selecting a policy locks the
 * expression/weight encoding downstream (`buildContractedCard`).
 *
 * THE SELECTED SEGMENT'S FOREGROUND IS THE WHOLE POINT HERE. A user reported the
 * selected "Exact x = T" segment as unreadable, and it was two separate mistakes
 * compounding on one control:
 *
 *   1. the fill was `--brand` but the label took `--brandink`, which is
 *      `color-mix(--brand 82%, black)` — a DARKENED version of the very colour
 *      behind it, so the label was near-black-on-teal by construction. `--onbrand`
 *      is the token that exists for exactly this pairing, and it flips per theme
 *      (`#ffffff` light / `#111816` dark) precisely so a solid brand fill stays
 *      legible in both;
 *   2. the formula child then set `--ink3` unconditionally, so even fixing the
 *      parent would have left the `x = T` half of the label opted out.
 *
 * The fix is the canonical pair on the segment and NO descendant foreground
 * override on it at all — the hint inherits. The unselected segment keeps `--ink3`
 * on its hint, which is correct: it sits on the well track, not on a brand fill.
 * DESIGN.md §6: "Don't hardcode white on a semantic fill; use the paired --on-*
 * token" — and, symmetrically, don't let a child opt out of it.
 *
 * Geometry follows DESIGN.md §5, which names segmented controls in the pill row:
 * a `--panel` well track carrying pill segments, rather than the old square
 * hairline box. Both segments are real 44px targets on a coarse pointer.
 */
function PolicyToggle({
  policy,
  onChange,
}: {
  policy: "exact" | "range";
  onChange: (next: "exact" | "range") => void;
}) {
  const options: { value: "exact" | "range"; label: string; hint: string }[] = [
    { value: "exact", label: "Exact", hint: "x = T" },
    { value: "range", label: "Range", hint: "min ≤ x ≤ max" },
  ];
  return (
    <div
      className="inline-flex gap-1 rounded-pill bg-panel p-1 shadow-well"
      role="group"
      aria-label="Contract policy"
    >
      {options.map((option) => {
        const active = policy === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            data-testid={`contracted-policy-${option.value}`}
            onClick={() => onChange(option.value)}
            className={`flex items-center gap-2 rounded-pill px-3.5 py-2 text-meta font-semibold transition-[background-color,box-shadow] duration-fast pointer-coarse:min-h-touch pointer-coarse:min-w-touch ${
              active
                ? "bg-brand text-onbrand shadow-1"
                : "text-ink2 hover:bg-panel-alt hover:shadow-1"
            }`}
          >
            {option.label}
            {/* Deliberately NO colour class on the selected side: it inherits
                `--onbrand` from the segment. A `text-ink3` here is the exact
                regression the user reported. */}
            <span className={`font-mono text-label ${active ? "" : "text-ink3"}`}>
              {option.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The policy's lock hint (ScreenCards:99-101): the weight is a hard rule and the
 *  expression follows the policy, so neither is free to edit here. It sits directly
 *  under the policy toggle it constrains rather than in a panel of its own — the
 *  concrete expression and weight are shown where they are read, in Solver
 *  details. */
function PolicyLockHint({ policy }: { policy: "exact" | "range" }) {
  return (
    <p className="flex items-start gap-2 text-meta leading-[1.45] text-ink3">
      <FaLock className="mt-0.5 size-2.5 flex-none" />
      <span>
        Hard requirement — the solver must satisfy it. Weight is fixed at +∞
        {policy === "range" ? " and the expression becomes a pair of bounds." : "."}
      </span>
    </p>
  );
}

/** Half-hours at the slider track's right edge (the prototype's `cap`,
 *  ScreenCards:870). The track is a DISPLAY scale only: the number input below it
 *  is the control, so the cap can never make a value unreachable — a target beyond
 *  it simply pins the thumb to the end of the track. */
const SLIDER_CAP_HALF_HOURS = 500;

/** A target's position on the display track, clamped to `[0, 100]` percent. */
function sliderPct(halfHours: number | null): number {
  if (halfHours === null) return 0;
  return Math.max(0, Math.min(100, (halfHours / SLIDER_CAP_HALF_HOURS) * 100));
}

/** An integer half-hour count as the prototype's hours text: `320 → "160"`, with an
 *  em-dash for an unparsable/empty target (ScreenCards:868 `hh`). */
function halfHoursText(halfHours: number | null): string {
  return halfHours === null ? "—" : String(halfHours / HALF_HOURS_PER_HOUR);
}

/**
 * The prototype's hours slider (ScreenCards:106-110,117-122): a 4px `--line2`
 * track, a `--brand` fill and square 18px `--surface` thumbs ringed in `--brand`.
 *
 * IT IS DECORATIVE AND SAYS SO. The prototype binds no handler to it and neither
 * does this: the half-hour number input is the control, so the track is
 * `aria-hidden` rather than an unlabelled widget a screen reader could focus and
 * nothing would happen on. A real draggable slider is a behaviour the product has
 * not specified (which half-hour does a pixel map to, and does dragging commit?) —
 * this batch is fidelity to the recorded design, not a new control.
 */
function HoursSlider({
  from,
  to,
  thumbs,
  testId,
}: {
  from: number;
  to: number;
  thumbs: readonly number[];
  testId: string;
}) {
  return (
    <div className="relative mx-2.5 h-[22px]" aria-hidden="true" data-testid={testId}>
      <div className="absolute inset-x-0 top-[9px] h-1 bg-line2" />
      <div
        className="absolute top-[9px] h-1 bg-brand"
        style={{ left: `${from}%`, width: `${Math.max(0, to - from)}%` }}
      />
      {thumbs.map((pct, index) => (
        <div
          key={index}
          className="absolute top-[2px] size-[18px] -translate-x-1/2 border-2 border-brand bg-surface"
          style={{ left: `${pct}%` }}
        />
      ))}
    </div>
  );
}

/**
 * The guided target control (ScreenCards:103-129): the prototype's large `{h}h`
 * readout over a decorative hours slider, then a RAW half-hour number input on the
 * half-hour grid — replacing the human-hours text fields.
 *
 * THE DRAFT ENCODING IS UNCHANGED. `ContractedFormState` still holds human-hours
 * STRINGS and only the presentation is half-hours; every edit round-trips through
 * the codec (`formatHalfHours`), which is lossless for on-grid values. Keeping the
 * shared draft shape means the validator, the card build and the Refresh derivation
 * are untouched by this re-skin.
 *
 * A malformed or empty entry is held, not truncated: `parseRawHalfHours` rejects
 * `"3.5"`/`"1e3"`/negatives, so a typo can never silently rewrite the target.
 *
 * The readout is MONO, not the prototype's display face: DESIGN.md §3 reserves the
 * monospace face for "IDs, counts, hours and solver expressions — so a number
 * always reads as data", and DESIGN.md is canon over a prototype example.
 */
function HoursTargetField({
  form,
  onHalfChange,
}: {
  form: ContractedFormState;
  onHalfChange: (key: "targetExact" | "targetRangeMin" | "targetRangeMax", raw: string) => void;
}) {
  const exactHalf = parseHalfHours(form.targetExact);
  const minHalf = parseHalfHours(form.targetRangeMin);
  const maxHalf = parseHalfHours(form.targetRangeMax);

  if (form.policy === "exact") {
    return (
      <div className="flex flex-col gap-3" data-testid="contracted-target">
        <div className="flex justify-end">
          <span
            className="font-mono text-title font-bold text-brandink"
            data-testid="contracted-target-readout"
          >
            {halfHoursText(exactHalf)}h
          </span>
        </div>
        <HoursSlider
          from={0}
          to={sliderPct(exactHalf)}
          thumbs={[sliderPct(exactHalf)]}
          testId="contracted-target-slider"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="number"
            min={0}
            step={1}
            data-testid="contracted-target-exact"
            aria-label="Contracted hours in half-hours"
            value={exactHalf ?? ""}
            onChange={(e) => onHalfChange("targetExact", e.target.value)}
            className="w-24 font-mono font-bold"
          />
          <span className="font-mono text-label font-medium text-ink3">
            half-hours · 30-min steps
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="contracted-target">
      <div className="flex justify-end">
        <span
          className="font-mono text-title font-bold text-brandink"
          data-testid="contracted-target-readout"
        >
          {halfHoursText(minHalf)}h – {halfHoursText(maxHalf)}h
        </span>
      </div>
      <HoursSlider
        from={sliderPct(minHalf)}
        to={sliderPct(maxHalf)}
        thumbs={[sliderPct(minHalf), sliderPct(maxHalf)]}
        testId="contracted-target-slider"
      />
      <div className="flex flex-wrap items-center gap-2.5">
        <Input
          type="number"
          min={0}
          step={1}
          data-testid="contracted-target-min"
          aria-label="Minimum contracted hours in half-hours"
          value={minHalf ?? ""}
          onChange={(e) => onHalfChange("targetRangeMin", e.target.value)}
          className="w-[90px] text-center font-mono font-bold"
        />
        <span className="font-bold text-ink3">–</span>
        <Input
          type="number"
          min={0}
          step={1}
          data-testid="contracted-target-max"
          aria-label="Maximum contracted hours in half-hours"
          value={maxHalf ?? ""}
          onChange={(e) => onHalfChange("targetRangeMax", e.target.value)}
          className="w-[90px] text-center font-mono font-bold"
        />
        <span className="font-mono text-label font-medium text-ink3">
          half-hours stored · 30-min steps
        </span>
      </div>
    </div>
  );
}

/** The prototype's `contractSentence` (ScreenCards:1028-1029) over the CURRENT
 *  draft: the policy/target as human hours, the date scope as its label, and the
 *  fixed paid-leave credit. Reworded only enough to read as a sentence the author
 *  just authored — every value in it is the draft's. */
function contractedSentence(form: ContractedFormState): string {
  const creditHours = LEAVE_CREDIT_HALF_HOURS / HALF_HOURS_PER_HOUR;
  const range =
    form.policy === "range"
      ? `between ${halfHoursText(parseHalfHours(form.targetRangeMin))}h and ${halfHoursText(parseHalfHours(form.targetRangeMax))}h`
      : `exactly ${halfHoursText(parseHalfHours(form.targetExact))}h`;
  const dates = form.countDates.length > 0 ? summarizeRefs(form.countDates) : "ALL";
  return `Every nurse works ${range} across ${dates}. A paid-leave day credits ${creditHours}h toward that total; a rest day (OFF) counts 0.`;
}

/**
 * The "IN PLAIN ENGLISH" panel (ScreenCards:55-62): the same rule restated as one
 * sentence, with the Refresh-from-Shift-Types action in the panel header. The
 * sentence is derived from the live draft, so it tracks the policy, the target and
 * the date scope as the author edits — it is a reading of the draft, not a stored
 * field.
 */
function InPlainEnglishPanel({ sentence, onRefresh }: { sentence: string; onRefresh: () => void }) {
  return (
    <Surface
      level="well"
      geometry="control"
      className="flex flex-col gap-2 p-4"
      data-testid="contracted-plain-english"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="flex-1 text-label font-semibold uppercase tracking-[0.04em] text-ink3">
          In plain English
        </span>
        <Button
          variant="outline"
          size="sm"
          data-testid="contracted-refresh-button"
          onClick={onRefresh}
        >
          <FaArrowRotateRight /> Refresh from Shift Types
        </Button>
      </div>
      <p
        className="text-body font-semibold leading-[1.5] text-ink"
        data-testid="contracted-plain-english-sentence"
      >
        {sentence}
      </p>
    </Surface>
  );
}

/**
 * Solver details & overrides (DL09 D10, ScreenCards:398-419): ONE collapsed section
 * showing the exact expression and weight the card will serialize. Both are locked
 * by the policy, so they are presented as read-only chips with the concrete
 * half-hour target substituted in (`x = 320`, `300 ≤ x ≤ 340`) rather than as an
 * abstract `x = T` — and the section is where that lock is explained.
 */
function SolverDetails({ form, errors }: { form: ContractedFormState; errors: ContractedErrors }) {
  const isRange = form.policy === "range";
  const exactHalf = parseHalfHours(form.targetExact);
  const minHalf = parseHalfHours(form.targetRangeMin);
  const maxHalf = parseHalfHours(form.targetRangeMax);
  const exprText = isRange
    ? `${minHalf ?? "—"} ≤ x ≤ ${maxHalf ?? "—"}`
    : `x = ${exactHalf ?? "—"}`;
  // The encoding errors are defensive — expression and weight are derived from the
  // policy, never authored — but they used to be displayed beside the locked rows, so
  // they are still shown here rather than dropped on the floor. The section expands
  // itself when one appears, because a collapsed control would hide the only reason
  // the save did nothing.
  const lockError = errors.expression ?? errors.weight;

  return (
    <details
      className="group overflow-hidden rounded-control border border-line2 bg-panel"
      data-testid="contracted-solver-details"
      open={lockError ? true : undefined}
    >
      <summary
        className="flex cursor-pointer items-center gap-2 px-3.5 py-2.5"
        data-testid="contracted-solver-details-toggle"
      >
        <FaChevronRight className="size-3 flex-none text-ink3 transition-transform duration-fast group-open:rotate-90" />
        <span className="flex-1 text-label font-semibold uppercase tracking-[0.04em] text-ink2">
          Solver details &amp; overrides
        </span>
        <span
          className="font-mono text-label font-semibold text-ink3"
          data-testid="contracted-solver-summary"
        >
          {exprText} · +∞
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-line2 p-3.5">
        <div className="flex flex-col gap-1.5">
          <span className="text-label font-semibold uppercase tracking-[0.04em] text-ink3">
            Expression
          </span>
          <Surface
            level="well"
            geometry="control"
            emphasis="hairline"
            className="inline-flex w-fit items-center gap-2 px-3 py-2"
          >
            <FaLock className="size-2.5 text-ink3" />
            <span
              className="font-mono text-body font-bold text-ink2"
              data-testid="contracted-raw-encoding"
            >
              {exprText}
            </span>
          </Surface>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-label font-semibold uppercase tracking-[0.04em] text-ink3">
            Weight
          </span>
          <Surface
            level="well"
            geometry="control"
            emphasis="hairline"
            className="inline-flex w-fit items-center gap-2 px-3 py-2"
          >
            <FaLock className="size-2.5 text-ink3" />
            <span
              className="font-mono text-body font-bold text-ink2"
              data-testid="contracted-locked-weight"
            >
              +∞
            </span>
          </Surface>
        </div>
        {lockError && (
          <p className="text-meta font-semibold text-error" role="alert">
            {lockError}
          </p>
        )}
        <p className="text-meta italic text-ink3">
          Expression &amp; weight are locked while this is a contract. Convert to a generic shift
          count to edit them freely.
        </p>
      </div>
    </details>
  );
}

/** Human labels + copy for each Refresh preview category, in display order. */
const REFRESH_CATEGORIES: { key: RefreshCategory; label: string; hint: string }[] = [
  { key: "added", label: "Added", hint: "Filled in from the shift's working time." },
  { key: "changed", label: "Changed", hint: "Replaces the current manual value." },
  { key: "unchanged", label: "Unchanged", hint: "Already matches the derived value." },
  {
    key: "non-derivable",
    label: "Non-derivable",
    hint: "No valid working time — the existing value is kept; enter one manually.",
  },
  { key: "removed", label: "Removed", hint: "No longer a selected shift type — dropped." },
];

/** One previewed value as display text: the derived coefficient, or the kept manual
 *  value for a non-derivable/removed row (blank ⇒ an em-dash placeholder). */
function refreshRowValueText(row: RefreshRow): string {
  if (row.derived !== null) return String(row.derived);
  return row.current === "" ? "—" : `${row.current} (kept)`;
}

/**
 * The Refresh-from-Shift-Types preview (ScreenCards:63-77): a non-mutating panel
 * that opens with the aggregate counts banner ("Shift Types changed — review before
 * applying") and then categorizes every concrete coefficient id against its
 * Shift-Type-derived value (added / changed / unchanged / non-derivable / removed).
 * "Apply update" applies the derivation to the draft; "Cancel preview" dismisses it
 * without applying anything. Explicit-only — it never runs on mount or selector
 * change.
 *
 * The per-category rows go BEYOND the prototype, which shows only the four
 * aggregate counts. A count without the ids behind it leaves the author unable to
 * see what a coefficient is about to become before applying, so the rows are kept
 * and the aggregate banner is added on top of them.
 */
function RefreshPanel({
  preview,
  onConfirm,
  onCancel,
}: {
  preview: RefreshPreview;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const countOf = (key: RefreshCategory) =>
    preview.rows.filter((row) => row.category === key).length;
  return (
    <Surface
      level="well"
      geometry="control"
      className="flex flex-col gap-3 p-4"
      data-testid="contracted-refresh-preview"
    >
      <div className="flex items-center gap-2">
        <FaArrowRotateRight className="size-3 flex-none text-brandink" />
        <span className="text-body font-bold text-brandink">
          Shift Types changed — review before applying
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-label font-semibold">
        <span className="text-successink" data-testid="contracted-refresh-count-added">
          + {countOf("added")} added
        </span>
        <span className="text-errorink" data-testid="contracted-refresh-count-removed">
          − {countOf("removed")} removed
        </span>
        <span className="text-warnink" data-testid="contracted-refresh-count-changed">
          ✎ {countOf("changed")} changed
        </span>
        <span className="text-ink3" data-testid="contracted-refresh-count-unchanged">
          {countOf("unchanged")} unchanged
        </span>
      </div>
      {REFRESH_CATEGORIES.map(({ key, label, hint }) => {
        const rows = preview.rows.filter((row) => row.category === key);
        if (rows.length === 0) return null;
        return (
          <div
            key={key}
            className="flex flex-col gap-1.5"
            data-testid={`contracted-refresh-${key}`}
          >
            <span className="text-label font-semibold text-ink3">
              {label} ({rows.length})
            </span>
            <span className="text-meta italic text-ink3">{hint}</span>
            <div className="flex flex-wrap gap-2">
              {rows.map((row) => (
                <span
                  key={row.id}
                  className="rounded-chip border border-line2 bg-surface px-2 py-1 font-mono text-meta text-ink"
                  data-testid={`contracted-refresh-row-${row.id}`}
                  data-category={row.category}
                >
                  {row.id}: {refreshRowValueText(row)}
                </span>
              ))}
            </div>
          </div>
        );
      })}
      {preview.unresolved.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="contracted-refresh-unresolved">
          <span className="text-label font-semibold text-ink3">
            Non-derivable — unresolved ({preview.unresolved.length})
          </span>
          <span className="text-meta italic text-ink3">
            These selected shift types can&apos;t be resolved — fix the selection.
          </span>
          <div className="flex flex-wrap gap-2">
            {preview.unresolved.map((id) => (
              <span
                key={id}
                className="rounded-chip border border-warn bg-warntint px-2 py-1 font-mono text-meta text-warnink"
                data-testid={`contracted-refresh-unresolved-${id}`}
              >
                {id}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-2">
        {/* `--brand` fill with `--brandink` text was the same defect as the policy
            toggle: a darkened brand on brand. The Button `default` variant is the
            canonical `--brand` + `--onbrand` pair. */}
        <Button size="sm" data-testid="contracted-refresh-confirm" onClick={onConfirm}>
          Apply update
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-testid="contracted-refresh-cancel"
          onClick={onCancel}
        >
          Cancel preview
        </Button>
      </div>
    </Surface>
  );
}

/**
 * The non-blocking uncredited-leave advisory shown inside the contracted editor
 * (qq0.23d, ported from the old app's `LeaveCreditAdvisory` and the prototype's
 * warn panel). It names the affected people (scenario order) through the SHARED
 * `formatUncreditedLeaveWarning`, so it words the policy identically to the import
 * banner, and offers the one-click `Add LEAVE · 16` repair. It never gates Update.
 */
function LeaveCreditAdvisory({
  affectedNames,
  onAddLeave,
}: {
  affectedNames: string[];
  onAddLeave: () => void;
}) {
  return (
    // The tint pairs with `--warnink`, not `--warn`: the two coincide in light mode
    // but diverge in dark, so a `--warn` heading left this advisory carrying its
    // status by colour alone the moment the theme flipped (the Redundant Signal
    // Rule, DESIGN.md §2). The repair action is an ordinary outline Button rather
    // than a second warn-tinted box nested inside the first — stacking the same
    // tint made the button read as part of the panel instead of as pressable.
    <div
      className="flex items-start gap-2.5 rounded-control border border-warn bg-warntint p-3.5"
      role="status"
      aria-live="polite"
      data-testid="contracted-leave-advisory"
    >
      <FaTriangleExclamation className="mt-0.5 size-4 flex-shrink-0 text-warnink" />
      <div className="flex flex-1 flex-col gap-2">
        <span className="text-meta font-semibold text-warnink">Leave not credited</span>
        <p className="text-meta text-ink2" data-testid="contracted-leave-advisory-text">
          {formatUncreditedLeaveWarning(affectedNames)}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          data-testid="contracted-add-leave"
          onClick={onAddLeave}
        >
          <FaPlus />
          Add LEAVE · {LEAVE_CREDIT_HALF_HOURS}
        </Button>
      </div>
    </div>
  );
}

export function ContractedForm({
  state,
  mode,
  initialForm,
  isEnabled,
  onSave,
  onCancel,
}: ContractedFormProps) {
  const [form, setForm] = useState<ContractedFormState>(initialForm);
  const [errors, setErrors] = useState<ContractedErrors>({});
  // The pending Refresh preview (M2a-5). Non-null only between an explicit Refresh
  // click and its Confirm/Cancel — the derivation NEVER runs on mount or selector
  // change, and Confirm is the only path that mutates the draft's coefficients.
  const [refreshPreview, setRefreshPreview] = useState<RefreshPreview | null>(null);

  // A fresh draft (add vs edit-of-another-card) resets the local state.
  useEffect(() => {
    setForm(initialForm);
    setErrors({});
    setRefreshPreview(null);
  }, [initialForm]);

  const people = buildPeopleTransferOptions(state);
  const shiftTypes = buildCountShiftTypeTransferOptions(state);
  const autoScopes = buildDateScopeAutoScopes(state);
  const dateGroups = buildDateScopeDateGroups(state);
  const dateItems = buildDateScopeDateItems(state);
  const noPeople = people.items.length === 0 && people.groups.length === 0;
  const noDates = autoScopes.length === 0 && dateGroups.length === 0 && dateItems.length === 0;

  // The CONCRETE coefficient domain (backend expansion, leaf sources only) — the
  // exact day-state set the coverage bijection is defined over. Its own ids are the
  // `selection` the sub-editor eligibility is derived from.
  const coefficientDomain = useMemo(
    () => buildContractedCoefficientDomain(state, form.countShiftTypes),
    [state, form.countShiftTypes],
  );
  const coefficientSelection = useMemo(
    () => contractedCoefficientIds(coefficientDomain),
    [coefficientDomain],
  );

  // The draft-aware uncredited-leave advisory (qq0.23d): recomputed from the CURRENT
  // draft selectors and the LIVE scenario pins through the shared detector whenever
  // the draft or scenario entities/requests change — never the saved-card finding.
  // `null` when the source card is disabled/absent or no resolved leave pin overlaps.
  const leaveAdvisoryNames = useMemo(
    () => findContractedDraftLeaveAdvisory(form, state, isEnabled),
    [form, state, isEnabled],
  );

  function clearCoefficientErrors(prev: ContractedErrors): ContractedErrors {
    return prev.coefficientErrorsById || prev.coefficientAggregate
      ? { ...prev, coefficientErrorsById: undefined, coefficientAggregate: undefined }
      : prev;
  }

  // A half-hour target edit lands in the draft's human-hours string, so the rest of
  // the form (and the saved card) keeps its existing encoding. Empty clears the
  // field — the required error then surfaces on save — while anything that is not a
  // clean half-hour integer is REJECTED rather than truncated, so a typo can never
  // silently rewrite the target to a different value.
  function setHalfTarget(
    key: "targetExact" | "targetRangeMin" | "targetRangeMax",
    raw: string,
  ): void {
    let value = "";
    if (raw !== "") {
      const half = parseRawHalfHours(raw);
      if (half === null) return;
      value = formatHalfHours(half);
    }
    if (key === "targetExact") {
      setForm((prev) => ({ ...prev, targetExact: value }));
      setErrors((prev) => (prev.targetExact ? { ...prev, targetExact: undefined } : prev));
    } else if (key === "targetRangeMin") {
      setForm((prev) => ({ ...prev, targetRangeMin: value }));
      setErrors((prev) => (prev.targetRangeMin ? { ...prev, targetRangeMin: undefined } : prev));
    } else {
      setForm((prev) => ({ ...prev, targetRangeMax: value }));
      setErrors((prev) => (prev.targetRangeMax ? { ...prev, targetRangeMax: undefined } : prev));
    }
  }

  // One error line for the target cell (the prototype's single `policyErr` slot,
  // ScreenCards:129). An empty range reports BOTH bounds missing, and the message is
  // the same for each, so identical messages collapse to one line while a distinct
  // second error (the min > max ordering) still shows as a second clause.
  const targetError =
    form.policy === "range"
      ? Array.from(
          new Set([errors.targetRangeMin, errors.targetRangeMax].filter(Boolean) as string[]),
        ).join(" ")
      : errors.targetExact;

  function submit() {
    const nextErrors = validateContractedCommit(form, state);
    if (hasContractedErrors(nextErrors)) {
      setErrors(nextErrors);
      return;
    }
    onSave(form);
  }

  // FR-PR-05 parity with the ordinary form: while VISIBLE, Enter saves (even with
  // modifiers held) and Escape cancels; IME composition is skipped. Latest
  // submit/cancel are read through refs so the listener registers once.
  const submitRef = useRef(submit);
  const cancelRef = useRef(onCancel);
  submitRef.current = submit;
  cancelRef.current = onCancel;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        submitRef.current();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelRef.current();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <CardEditorForm
      heading={mode === "add" ? "Add Contracted Hours" : "Edit Contracted Hours"}
      submitLabel={mode === "add" ? "Add contract" : "Update contract"}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <FieldShell label="Description">
        <Input
          data-testid="contracted-desc"
          aria-label="Description"
          value={form.description}
          onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
          placeholder="e.g., Monthly contracted hours"
        />
      </FieldShell>

      <div className="flex flex-col gap-3">
        <InPlainEnglishPanel
          sentence={contractedSentence(form)}
          onRefresh={() => setRefreshPreview(deriveContractedRefresh(form, state))}
        />
        {refreshPreview && (
          <RefreshPanel
            preview={refreshPreview}
            onConfirm={() => {
              setForm((prev) => applyContractedRefresh(prev, refreshPreview));
              setErrors((prev) => clearCoefficientErrors(prev));
              setRefreshPreview(null);
            }}
            onCancel={() => setRefreshPreview(null)}
          />
        )}
      </div>

      <FieldShell label="Policy">
        <div className="flex flex-col gap-3">
          <PolicyToggle
            policy={form.policy}
            onChange={(policy) =>
              setForm((prev) => ({
                ...prev,
                policy,
              }))
            }
          />
          <PolicyLockHint policy={form.policy} />
        </div>
      </FieldShell>

      <FieldShell
        // The prototype's own inner heading for the target cell (ScreenCards:104,115).
        label={form.policy === "range" ? "Hours per nurse" : "Target hours per nurse"}
        required
        error={targetError}
      >
        <HoursTargetField form={form} onHalfChange={setHalfTarget} />
      </FieldShell>

      <FieldShell label="People" required error={errors.person}>
        <TransferList<string | number>
          idPrefix="contracted-people"
          keyOf={entityKey}
          sameValue={sameEntityId}
          items={people.items}
          groups={people.groups}
          selected={form.person}
          onToggle={(ref) => {
            setForm((prev) => ({ ...prev, person: toggleInSelection(prev.person, ref) }));
            setErrors((prev) => (prev.person ? { ...prev, person: undefined } : prev));
          }}
          itemLabel="NURSES"
          searchPlaceholder="Search people"
          selectedTitle="PEOPLE"
          selectedTestKey="contracted-people"
          availableEmpty={noPeople ? "No people set up — add some on the Staff screen." : undefined}
          addAria={(l) => `Add ${l} to people`}
          removeAria={(l) => `Remove ${l} from people`}
        />
      </FieldShell>

      <FieldShell
        label="Count shift types"
        required
        hint="Each selected worked shift and LEAVE needs a half-hour coefficient below"
        error={errors.countShiftTypes}
      >
        <TransferList<string | number>
          idPrefix="contracted-shift-types"
          keyOf={entityKey}
          sameValue={sameEntityId}
          items={shiftTypes.items}
          groups={shiftTypes.groups}
          selected={form.countShiftTypes}
          onToggle={(ref) => {
            // Disabled (numeric-id) options never fire `onToggle`, so this is
            // always a genuine string `ShiftTypeRef` at runtime.
            const shiftRef = ref as string;
            setForm((prev) => {
              const nextShiftTypes = toggleInSelection(prev.countShiftTypes, shiftRef);
              // Re-sync coefficient pairs to the newly-eligible CONCRETE ids in the
              // same update (FR-PR-73 parity with count-form) so re-adding a source
              // yields a fresh blank row and coverage lines up with the bijection.
              const nextDomain = buildContractedCoefficientDomain(state, nextShiftTypes);
              return {
                ...prev,
                countShiftTypes: nextShiftTypes,
                countShiftTypeCoefficients: syncCoefficientPairs(
                  contractedCoefficientIds(nextDomain),
                  prev.countShiftTypeCoefficients,
                  nextDomain,
                ),
              };
            });
            setErrors((prev) => {
              const cleared = clearCoefficientErrors(prev);
              return cleared.countShiftTypes ? { ...cleared, countShiftTypes: undefined } : cleared;
            });
            // A pending preview was derived against the OLD selection — dismiss it so
            // Confirm can never apply a stale derivation to the new concrete domain.
            setRefreshPreview(null);
          }}
          itemLabel="SHIFT TYPES"
          searchPlaceholder="Search shift types"
          selectedTitle="COUNT SHIFT TYPES"
          selectedTestKey="contracted-shift-types"
          availableEmpty={
            shiftTypes.items.length === 0 && shiftTypes.groups.length === 0
              ? "No shift types set up — add some on the Shifts screen."
              : undefined
          }
          addAria={(l) => `Add ${l} to count shift types`}
          removeAria={(l) => `Remove ${l} from count shift types`}
        />
      </FieldShell>

      {coefficientSelection.length > 0 && (
        <p className="text-meta italic text-ink3" data-testid="contracted-expanded-ids">
          Concrete coverage: {coefficientSelection.join(", ")}
        </p>
      )}

      <CoefficientFields
        selection={coefficientSelection}
        pairs={form.countShiftTypeCoefficients}
        domain={coefficientDomain}
        label="Shift Type"
        heading="Derived coefficients · half-hours"
        note="Each worked shift contributes its working time ÷ 30 min. A paid-leave day credits 8h. Values are editable; a shift type with no working time must be set by hand."
        testId="contracted-coefficient-fields"
        errorsById={errors.coefficientErrorsById}
        // Always surface the aggregate. Unlike count-form (where the aggregate is the
        // mutually-exclusive overlap message), the contracted helper can emit a per-id
        // error AND a simultaneous incomplete/extra-coverage aggregate — they are
        // distinct concerns, so suppressing the aggregate would drop a required error.
        aggregateError={errors.coefficientAggregate}
        onChange={(next) => {
          setForm((prev) => ({ ...prev, countShiftTypeCoefficients: next }));
          setErrors((prev) => clearCoefficientErrors(prev));
          // A pending preview was derived against the pre-edit coefficients; dismiss
          // it so a stale snapshot can never be Confirmed over the manual edit.
          setRefreshPreview(null);
        }}
      />

      {leaveAdvisoryNames !== null && (
        <LeaveCreditAdvisory
          affectedNames={leaveAdvisoryNames}
          onAddLeave={() => {
            // Repair mutates the DRAFT only — append direct LEAVE + one [LEAVE, 16]
            // coefficient row. Persistence still happens through the single existing
            // Update → `updateContracted` mutation (one undo step); Cancel is a no-op.
            setForm((prev) => addLeaveCreditToContractDraft(prev, state));
            setErrors((prev) => clearCoefficientErrors(prev));
            // A pending Refresh preview was derived against the pre-repair coefficients.
            setRefreshPreview(null);
          }}
        />
      )}

      <FieldShell label="Count dates" required error={errors.countDates}>
        {noDates ? (
          <p className="rounded-control bg-panel px-3.5 py-3 text-center text-meta italic text-ink3 shadow-well">
            No dates available. Please set up dates in the Dates screen first.
          </p>
        ) : (
          <DateScopeField
            autoScopes={autoScopes}
            dateGroups={dateGroups}
            dateItems={dateItems}
            allValue={["ALL"]}
            value={form.countDates}
            onChange={(next) => {
              setForm((prev) => ({ ...prev, countDates: next }));
              setErrors((prev) => (prev.countDates ? { ...prev, countDates: undefined } : prev));
            }}
          />
        )}
      </FieldShell>

      <SolverDetails form={form} errors={errors} />
    </CardEditorForm>
  );
}
