"use client";

// Normal-mode cell editor (T11, spec 04 FR-SR-17/21-23; prototype
// ScreenRequests.dc.html:195-250). One (person,date) coordinate: strict-XOR
// day-state tabs (Available / Paid leave / Requests off); Available shows a
// weight row per target (worked shift types + groups); Requests off shows one
// OFF weight. Save normalizes the draft into a `CellEditorResult` — the
// container commits it as the coordinate transaction (paint-store seam is out
// of scope here; this component never touches the store).
//
// Weight parsing reuses `weight-field.tsx`'s `parseWeightInput`/
// `isValidWeightValue`/`formatWeight` (the project's one weight-parse
// contract) rather than reimplementing it, per T11's "reuse weight-field.tsx
// parsing" instruction. The invalid-weight guard string is verbatim from the
// other card-editor `*-model.ts` files' `weightInvalid` constant.

import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { UiRequestCell } from "@/lib/scenario";
import {
  formatWeight,
  isValidWeightValue,
  parseWeightInput,
  type WeightFieldValue,
} from "@/components/card-editor/weight-field";

/** Verbatim guard, matching `weightInvalid` in requirements/successions/counts/affinities models. */
const WEIGHT_INVALID_MESSAGE = "Weight must be a valid number, Infinity, or -Infinity";

export type DayStateChoice = "available" | "leave" | "off";

export interface WeightTarget {
  id: string;
  name: string;
  isGroup: boolean;
}

export type CellEditorResult =
  | { kind: "leave" }
  | { kind: "off"; weight?: number }
  | { kind: "requests"; prefs: { shiftType: string; weight: number }[] }
  | { kind: "clear" };

export interface CellPreferenceEditorProps {
  open: boolean;
  personLabel: string;
  dateLabel: string;
  cells: UiRequestCell[];
  targets: WeightTarget[];
  onSave: (result: CellEditorResult) => void;
  onClear: () => void;
  onClose: () => void;
}

interface Draft {
  dayState: DayStateChoice;
  weights: Record<string, WeightFieldValue>;
  offWeight: WeightFieldValue;
}

/** Seed the draft from the coordinate's current cells, applying LEAVE > OFF > worked
 *  display precedence (§ Conflict boundary) — a coexisting day-state always wins the tab. */
function draftFromCells(cells: readonly UiRequestCell[], targets: readonly WeightTarget[]): Draft {
  const weights: Record<string, WeightFieldValue> = {};
  targets.forEach((t) => {
    weights[t.id] = 0;
  });
  const leave = cells.find((c) => c.kind === "leave");
  if (leave) return { dayState: "leave", weights, offWeight: 0 };
  const off = cells.find((c) => c.kind === "off");
  if (off) return { dayState: "off", weights, offWeight: off.weight };
  cells.forEach((cell) => {
    if (cell.kind === "request" && cell.shiftType in weights) {
      weights[cell.shiftType] = cell.weight;
    }
  });
  return { dayState: "available", weights, offWeight: 0 };
}

export function CellPreferenceEditor({
  open,
  personLabel,
  dateLabel,
  cells,
  targets,
  onSave,
  onClear,
  onClose,
}: CellPreferenceEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFromCells(cells, targets));
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setDraft(draftFromCells(cells, targets));
      setError(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setDayState = (dayState: DayStateChoice) => setDraft((d) => ({ ...d, dayState }));
  const setWeight = (id: string, value: WeightFieldValue) =>
    setDraft((d) => ({ ...d, weights: { ...d.weights, [id]: value } }));
  const setOffWeight = (value: WeightFieldValue) => setDraft((d) => ({ ...d, offWeight: value }));

  const handleSave = () => {
    if (draft.dayState === "leave") {
      onSave({ kind: "leave" });
      onClose();
      return;
    }
    if (draft.dayState === "off") {
      if (!isValidWeightValue(draft.offWeight)) {
        setError(WEIGHT_INVALID_MESSAGE);
        return;
      }
      onSave({ kind: "off", weight: draft.offWeight !== 0 ? draft.offWeight : undefined });
      onClose();
      return;
    }
    const invalidTarget = targets.find((t) => !isValidWeightValue(draft.weights[t.id]));
    if (invalidTarget) {
      setError(WEIGHT_INVALID_MESSAGE);
      return;
    }
    const prefs = targets
      .map((t) => ({ shiftType: t.id, weight: draft.weights[t.id] as number }))
      .filter((p) => p.weight !== 0);
    onSave({ kind: "requests", prefs });
    onClose();
  };

  const handleClearCell = () => {
    onClear();
    onClose();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 animate-fade" />
        <Dialog.Popup
          data-testid="cell-preference-editor"
          className="fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 border border-line bg-surface shadow-dialog animate-fade"
        >
          <div className="border-b border-line2 px-[18px] py-4">
            <Dialog.Title className="font-heading text-cardhead font-extrabold tracking-tight">
              Cell preference
            </Dialog.Title>
            <div className="mt-0.5 text-meta text-ink3">
              {personLabel} · {dateLabel}
            </div>
          </div>

          <div className="p-[18px]">
            <div className="mb-2 text-label font-semibold uppercase tracking-[0.03em] text-ink2">
              Day state
            </div>
            <div role="tablist" className="mb-4 flex border border-line">
              <button
                type="button"
                role="tab"
                aria-selected={draft.dayState === "available"}
                data-testid="cell-editor-tab-available"
                onClick={() => setDayState("available")}
                className={cn(
                  "flex-1 h-9 text-meta font-semibold",
                  draft.dayState === "available" ? "bg-brand text-onbrand" : "hover:bg-panel",
                )}
              >
                Available
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={draft.dayState === "leave"}
                data-testid="cell-editor-tab-leave"
                onClick={() => setDayState("leave")}
                className={cn(
                  "flex-1 h-9 border-l border-line text-meta font-semibold",
                  draft.dayState === "leave" ? "bg-brand text-onbrand" : "hover:bg-panel",
                )}
              >
                Paid leave
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={draft.dayState === "off"}
                data-testid="cell-editor-tab-off"
                onClick={() => setDayState("off")}
                className={cn(
                  "flex-1 h-9 border-l border-line text-meta font-semibold",
                  draft.dayState === "off" ? "bg-brand text-onbrand" : "hover:bg-panel",
                )}
              >
                Requests off
              </button>
            </div>

            {draft.dayState === "available" && (
              <div data-testid="cell-editor-weights">
                <div className="mb-1 text-label font-semibold uppercase tracking-[0.03em] text-ink2">
                  Set weights per shift type &amp; group
                </div>
                <p className="mb-3 text-meta text-ink3">
                  Positive prefers, negative avoids, 0 means no preference. Use ∞ / -∞ for a hard
                  pin.
                </p>
                <div className="flex flex-col gap-2">
                  {targets.map((target) => {
                    const value = draft.weights[target.id];
                    const invalid = !isValidWeightValue(value);
                    return (
                      <div
                        key={target.id}
                        data-testid={`cell-editor-weight-row-${target.id}`}
                        className="flex items-center gap-2.5"
                      >
                        <div className="min-w-11 whitespace-nowrap font-mono text-meta font-bold">
                          {target.id}
                        </div>
                        <div className="min-w-0 flex-1 truncate text-meta text-ink3">
                          {target.name}
                          {target.isGroup && (
                            <span className="ml-1.5 text-label uppercase tracking-[0.03em] text-ink3">
                              group
                            </span>
                          )}
                        </div>
                        <Input
                          value={String(value)}
                          onChange={(e) => setWeight(target.id, parseWeightInput(e.target.value))}
                          placeholder="0"
                          data-testid={`cell-editor-weight-input-${target.id}`}
                          className="h-8.5 w-16 flex-none text-center text-meta"
                        />
                        <div
                          className={cn(
                            "w-8.5 flex-none text-meta font-semibold",
                            invalid
                              ? "text-error"
                              : Number(value) > 0
                                ? "text-success"
                                : Number(value) < 0
                                  ? "text-warn"
                                  : "text-ink3",
                          )}
                        >
                          {formatWeight(value)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {draft.dayState === "leave" && (
              <div
                data-testid="cell-editor-leave-note"
                className="border border-brand bg-brandtint px-3 py-2.5 text-meta text-ink2"
              >
                Pinned as paid leave — always honored, no coverage. No built-in hours credit; any
                credit depends on the configured contracted-hours rules. Weight is not applicable.
              </div>
            )}

            {draft.dayState === "off" && (
              <div data-testid="cell-editor-off">
                <div className="mb-1 text-label font-semibold uppercase tracking-[0.03em] text-ink2">
                  Off weight
                </div>
                <p className="mb-2.5 text-meta text-ink3">
                  A soft preference for a rest day off. Positive prefers OFF, negative avoids it, 0
                  means no preference. Use ∞ for a hard pin.
                </p>
                <div className="mb-3 flex items-center gap-2.5">
                  <div className="min-w-11 font-mono text-meta font-bold">OFF</div>
                  <div className="flex-1 text-meta text-ink3">Requests off</div>
                  <Input
                    value={String(draft.offWeight)}
                    onChange={(e) => setOffWeight(parseWeightInput(e.target.value))}
                    placeholder="0"
                    data-testid="cell-editor-off-weight-input"
                    className="h-8.5 w-16 flex-none text-center text-meta"
                  />
                  <div className="w-8.5 flex-none text-meta font-semibold text-ink2">
                    {formatWeight(draft.offWeight)}
                  </div>
                </div>
                <div className="border border-error bg-errortint px-3 py-2.5 text-meta text-ink2">
                  Requests a rest day off — the nurse&apos;s weekend equivalent. Leave weight blank
                  for a plain OFF request.
                </div>
              </div>
            )}

            {error && (
              <p
                className="mt-3 text-meta font-semibold text-error"
                role="alert"
                data-testid="cell-editor-error"
              >
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-2.5 border-t border-line2 px-[18px] py-3.5">
            <Button variant="outline" data-testid="cell-editor-clear" onClick={handleClearCell}>
              Clear cell
            </Button>
            <div className="flex gap-2.5">
              <Button variant="outline" data-testid="cell-editor-cancel" onClick={onClose}>
                Cancel
              </Button>
              <Button data-testid="cell-editor-save" onClick={handleSave}>
                Save
              </Button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
