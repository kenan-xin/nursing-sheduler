"use client";

// One Guided rule row — re-skinned for v2 "Mint Canvas, Warm Ink" (R3). It stays
// faithful to docs/design_prototype/source/ScreenRules.dc.html rows 108-193
// wherever that prototype and the live product agree: a switch, title, summary,
// an Advanced link, an ON/OFF config chip and the Adjust/Rename actions, with the
// inline Adjust panel as a dashed-top band beneath the row.
//
// Three v2 decisions are load-bearing here.
//
// 1. The row is deliberately NOT a `surfaceVariants` consumer. It sits inside the
//    category card's L1 plane and its only structure is a single hairline TOP
//    EDGE — a divider, which DESIGN.md §5 keeps square and which the recipe (a
//    box contract: tone + border + elevation) has no role for.
// 2. A switched-off row recedes in TONE to `--panel` instead of fading to
//    `opacity`. Opacity dims the row's text along with its box and costs every
//    label in it the contrast it just cleared; tone-first is the v2 answer and
//    the ON/OFF chip is the redundant signal beside it (the same call R4 made on
//    a disabled card).
// 3. Every affordance in the row is a real control at the coarse-pointer floor.
//    The v1 row shipped four hand-rolled boxes — two bare text buttons at `p-0`
//    and two `h-9` (32.4px at the 0.9 baseline) ±∞ boxes — none of which could
//    reach 44px on touch. The ±∞ pair is now the shared `Button` contract; the
//    two text links keep their inline treatment and take the explicit
//    `pointer-coarse` floor, never a pseudo-element hitbox (T8).
//
// Rename is offered on EVERY row — locked and "Set in Advanced only" ones
// included — because a ward-legible label is never the constraint's shape. The
// draft lives in the screen above, which owns the losable-draft guard.

import * as React from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { parseWeightInput } from "@/components/card-editor/weight-field";
import {
  FaArrowRight,
  FaCheck,
  FaLock,
  FaPen,
  FaShieldHalved,
  FaSliders,
} from "@/components/icons";
import type { GuidedRuleRow } from "./types";

/** The inline text-link affordances (Rename, ↳ constraint, Edit in Advanced).
 *  DESIGN.md §5 gives a text-only affordance no box, so the 44px coarse-pointer
 *  minimum has to be asked for on the control itself — `Button`'s variants carry
 *  it, a bare `<button>` does not. Same treatment R4's pattern-builder uses. */
const INLINE_LINK =
  "inline-flex items-center gap-1.5 bg-transparent p-0 text-label font-semibold uppercase tracking-[0.03em] hover:underline pointer-coarse:min-h-touch pointer-coarse:min-w-touch";

export interface RuleRowProps {
  row: GuidedRuleRow;
  adjustOpen: boolean;
  onToggleAdjust: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onOpenAdvanced: () => void;
  /** Whether this row's title is currently being edited in place. */
  renaming: boolean;
  renameDraft: string;
  onRenameStart: () => void;
  onRenameDraftChange: (value: string) => void;
  onRenameCancel: () => void;
  onRenameSubmit: () => void;
  /** Returns a validation error, or `undefined` on success (already committed). */
  onAdjustField: (key: string, value: number) => string | undefined;
}

export function RuleRow({
  row,
  adjustOpen,
  onToggleAdjust,
  onToggleEnabled,
  onOpenAdvanced,
  renaming,
  renameDraft,
  onRenameStart,
  onRenameDraftChange,
  onRenameCancel,
  onRenameSubmit,
  onAdjustField,
}: RuleRowProps) {
  const canAdjust = row.quickFields.length > 0 && row.enabled && !row.locked;
  const adjustPanelId = `rule-adjust-panel-${row.id}`;

  return (
    <li
      // Tone-first disabled state; the hairline divider is a single edge and stays
      // square, so neither belongs in the surface recipe (see the file header).
      className={cn("border-t border-line2 first:border-t-0", !row.enabled && "bg-panel")}
      data-testid={`rule-row-${row.id}`}
      data-disabled={row.enabled ? undefined : "true"}
    >
      <div className="flex items-start gap-3.5 px-5 py-4">
        <Switch
          aria-label={`Toggle ${row.title}`}
          checked={row.enabled}
          disabled={row.locked}
          onCheckedChange={onToggleEnabled}
          data-testid={`rule-toggle-${row.id}`}
        />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex flex-wrap items-center gap-2">
              {/* No height override: v1 forced `h-8`, which the repaired
                  tailwind-merge now really applies as 28.8px at the 0.9 baseline —
                  below the 32px floor and off-token. The field's own `h-control`
                  (36px) and `pointer-coarse:min-h-touch` are the contract. */}
              <Input
                autoFocus
                aria-label={`Rename ${row.title}`}
                className="w-full max-w-[32ch] font-bold"
                value={renameDraft}
                data-testid={`rule-rename-input-${row.id}`}
                onChange={(e) => onRenameDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onRenameSubmit();
                  }
                  if (e.key === "Escape") onRenameCancel();
                }}
              />
              <Button size="sm" onClick={onRenameSubmit} data-testid={`rule-rename-save-${row.id}`}>
                <FaCheck /> Save
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onRenameCancel}
                data-testid={`rule-rename-cancel-${row.id}`}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className={`text-body font-bold ${row.enabled ? "text-ink" : "text-ink2"}`}>
                {row.title}
              </span>
              {/* v1 also put an unlabelled padlock beside the title. `locked` is
                  true exactly when the row is a built-in, so it duplicated the
                  BUILT-IN badge below with a glyph that had no accessible name —
                  DESIGN.md §5 retires decorative ornament on status, and D8 puts
                  that above the prototype's example. */}
              <button
                type="button"
                aria-label={`Rename ${row.title}`}
                title="Rename this rule"
                onClick={onRenameStart}
                className={cn(INLINE_LINK, "text-ink3 hover:text-brandink")}
                data-testid={`rule-rename-${row.id}`}
              >
                <FaPen className="size-2.5" /> Rename
              </button>
            </div>
          )}
          <p className="mt-0.5 text-meta text-ink2">{row.summary}</p>
          {row.source === "record" && !row.unsupportedReason && (
            <button
              type="button"
              onClick={onOpenAdvanced}
              className={cn(INLINE_LINK, "mt-1.5 text-brandink")}
              data-testid={`rule-open-advanced-${row.id}`}
            >
              ↳ Constraint <FaArrowRight className="size-2.5" />
            </button>
          )}
          {row.source === "builtin" && (
            <Badge
              variant="neutral"
              title="Structural constraint the engine always enforces."
              className="mt-1.5"
            >
              <FaShieldHalved /> Built-in
            </Badge>
          )}
        </div>
        <div className="flex flex-none flex-col items-end gap-2">
          {/* The config chip pairs the accent TINT with accent ink on a neutral
              hairline. It is deliberately not `Badge variant="brand"`: that
              variant's `--brand` border is the selection language DESIGN.md §6
              reserves for "this is the one", and an enabled rule is the ordinary
              state, not a selection. The hairline is what keeps the OFF chip
              legible once the row itself recedes to the same `--panel` tone. */}
          <span
            className={cn(
              "rounded-chip border border-line px-2.5 py-1 font-mono text-label font-semibold tracking-[0.03em]",
              row.enabled ? "bg-brandtint text-brandink" : "bg-panel text-ink2",
            )}
          >
            {row.enabled ? "ON" : "OFF"}
          </span>
          {canAdjust && (
            <Button
              variant={adjustOpen ? "secondary" : "outline"}
              size="sm"
              aria-expanded={adjustOpen}
              aria-controls={adjustOpen ? adjustPanelId : undefined}
              onClick={onToggleAdjust}
              data-testid={`rule-adjust-toggle-${row.id}`}
            >
              <FaSliders /> {adjustOpen ? "Close" : "Adjust"}
            </Button>
          )}
        </div>
      </div>
      {row.unsupportedReason && (
        // An inset note strip, but a HAND-AUTHORED one rather than the `well`
        // recipe: the row's own tone is already `--panel` when the rule is
        // switched off, and `well` has no bordered form, so the strip keeps a
        // hairline instead of resting on tone alone (DESIGN.md §4 rule 5).
        <div className="mx-5 mb-3.5 flex flex-col gap-2.5 rounded-control border border-line2 bg-panel px-3.5 py-2.5">
          <div className="flex items-start gap-2">
            <FaLock className="mt-0.5 size-2.5 flex-none text-ink3" />
            <span className="text-meta text-ink2">{row.unsupportedReason}</span>
          </div>
          {row.source === "record" && (
            // The prototype's own treatment for this state (ScreenRules "Set in
            // Advanced only"): the reason reads as prose and the handoff is its
            // own control beneath it. v1 buried it as a bare `<button>` inside the
            // sentence, where it could never reach a 44px touch target.
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={onOpenAdvanced}
              data-testid={`rule-open-advanced-unsupported-${row.id}`}
            >
              Edit in Advanced <FaArrowRight />
            </Button>
          )}
        </div>
      )}
      {adjustOpen && canAdjust && (
        <AdjustPanel
          id={adjustPanelId}
          row={row}
          onAdjustField={onAdjustField}
          onDone={onToggleAdjust}
        />
      )}
    </li>
  );
}

/** Parse an Adjust field's raw text into the number the store would commit, plus
 *  the live validation message. A weight field (`allowsInfinity`) accepts the
 *  soft/hard weight spellings (finite, `∞`, `-∞`, `Infinity`, suffixes) via the
 *  shared `parseWeightInput`; every other field is a plain non-empty number. In
 *  both cases the field's OWN `validate` decides the message, so validation stays
 *  identical to an Advanced edit — an unparseable draft becomes `NaN`, which
 *  `validate` already rejects. */
function evaluateDraft(
  field: GuidedRuleRow["quickFields"][number],
  raw: string,
): { value: number; message: string | undefined } {
  if (field.allowsInfinity) {
    const parsed = parseWeightInput(raw);
    const value = typeof parsed === "number" ? parsed : Number.NaN;
    return { value, message: field.validate(value) };
  }
  if (raw.trim() === "") return { value: Number.NaN, message: "Enter a number" };
  const value = Number(raw);
  if (Number.isNaN(value)) return { value, message: "Enter a number" };
  return { value, message: field.validate(value) };
}

function AdjustPanel({
  id,
  row,
  onAdjustField,
  onDone,
}: {
  id: string;
  row: GuidedRuleRow;
  onAdjustField: (key: string, value: number) => string | undefined;
  onDone: () => void;
}) {
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({});
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});

  return (
    // A full-bleed adjustment band inside the category card: `--panel` tone, flat,
    // and explicitly square (DESIGN.md §4 rule 2) — the dashed top edge is a
    // single edge, so a radius here would leave a sliver of the card in each
    // corner. The card's own `overflow-hidden` clips it when it ends the list.
    <div
      id={id}
      className="rounded-none border-t border-dashed border-line bg-panel px-5 py-3.5"
      data-testid={`rule-adjust-panel-${row.id}`}
    >
      <div className="mb-3 text-label font-semibold uppercase tracking-[0.03em] text-ink2">
        Adjust parameters
      </div>
      <div className="flex flex-wrap gap-4">
        {row.quickFields.map((field) => {
          const draftValue = drafts[field.key] ?? String(field.value);
          const error = errors[field.key];
          const setError = (message: string | undefined) =>
            setErrors((er) => ({ ...er, [field.key]: message }));

          // Live feedback only — update the draft + error on every keystroke, but
          // never write the store here (that would make each digit its own zundo
          // entry). The commit happens once, on blur/Enter, below.
          const onChangeRaw = (raw: string) => {
            setDrafts((d) => ({ ...d, [field.key]: raw }));
            setError(evaluateDraft(field, raw).message);
          };

          // Commit exactly once: validate the final draft and, when valid AND
          // actually changed, apply the single mutation via `onAdjustField`
          // (which validates + writes the store, exactly like an Advanced edit).
          const commitValue = (value: number) => {
            const message = field.validate(value);
            if (message) return setError(message);
            if (value === field.value) return setError(undefined);
            setError(onAdjustField(field.key, value));
          };
          const commitRaw = (raw: string) => {
            const { value, message } = evaluateDraft(field, raw);
            if (message) return setError(message);
            commitValue(value);
          };
          const setHard = (value: number) => {
            setDrafts((d) => ({ ...d, [field.key]: String(value) }));
            commitValue(value);
          };

          const commonProps = {
            value: draftValue,
            "aria-label": field.label,
            "data-testid": `rule-adjust-input-${row.id}-${field.key}`,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChangeRaw(e.target.value),
            onBlur: (e: React.FocusEvent<HTMLInputElement>) => commitRaw(e.target.value),
            onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRaw(e.currentTarget.value);
              }
            },
          };

          return (
            <label key={field.key} className="block">
              <span className="mb-1.5 block text-meta text-ink2">{field.label}</span>
              <div className="flex items-center gap-2">
                {field.allowsInfinity ? (
                  <>
                    <Input
                      type="text"
                      inputMode="text"
                      className="w-24 font-mono font-bold"
                      {...commonProps}
                    />
                    {/* The shared control, not a hand-rolled `h-9` box: `sm` is
                        the absolute 32px token and the variant carries the pill,
                        L1 fill, focus outline and 44px coarse floor. */}
                    <Button
                      variant="outline"
                      size="sm"
                      title="Hard rule (positive infinity)"
                      onClick={() => setHard(Infinity)}
                      data-testid={`rule-adjust-plus-inf-${row.id}-${field.key}`}
                      className="font-mono text-label font-semibold"
                    >
                      +∞
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      title="Hard rule (negative infinity)"
                      onClick={() => setHard(-Infinity)}
                      data-testid={`rule-adjust-minus-inf-${row.id}-${field.key}`}
                      className="font-mono text-label font-semibold"
                    >
                      −∞
                    </Button>
                  </>
                ) : (
                  <Input
                    type="number"
                    min={field.min}
                    max={field.max}
                    className="w-24 font-mono font-bold"
                    {...commonProps}
                  />
                )}
                {field.unit && <span className="font-mono text-label text-ink3">{field.unit}</span>}
              </div>
              {error && (
                // `--errorink` rather than `--error`: DESIGN.md §2 makes the ink
                // tier the deepest treatment, which is what error TEXT on a
                // `--panel` band needs to clear AA.
                <p className="mt-1 text-label text-errorink" role="alert">
                  {error}
                </p>
              )}
            </label>
          );
        })}
      </div>
      <div className="mt-3.5">
        <Button size="sm" onClick={onDone} data-testid={`rule-adjust-done-${row.id}`}>
          <FaCheck /> Done
        </Button>
      </div>
    </div>
  );
}
