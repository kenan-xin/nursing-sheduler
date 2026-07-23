"use client";

// The saved-counts list (spec 05 FR-PR-55/55a), built on the shared ScreenCards
// card frame: each count is a numbered card with its description, the shared
// weight pill, a People/Count shift types/Dates/Expression field grid (plus a
// Coefficients cell when the card has any), and the labelled Disable/Enable ·
// Edit · Duplicate · Delete action row. A contracted-hours card
// (`tag: "contracted_hours"`, M2's marker — not authored by this ticket) renders
// the `◆ Contracted hours` badge and a brand left border; an unmarked
// generic-array card (FR-PR-55a) renders an `Advanced (list)` badge. Neither is
// editable in this scalar form — Edit is omitted and a short "read-only" note
// explains why, so a click can never silently corrupt a shape this module
// doesn't author.

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  FaPowerOff,
  FaPen,
  FaCopy,
  FaTrash,
  FaChevronUp,
  FaChevronDown,
  FaArrowRightArrowLeft,
} from "@/components/icons";
import { WeightPill } from "@/components/card-editor/weight-field";
import type { CountCard } from "@/lib/scenario";
import {
  CardActionButton,
  CardListItem,
  type DropPosition,
} from "@/components/card-editor/card-editor-shell";
import {
  describeCountExpressionTarget,
  isAdvancedCountCard,
  isContractedHoursCard,
  isEditableCountCard,
  summarizeRefs,
} from "./counts-model";
import { convertContractedToGeneric } from "./convert-model";
import { formatHalfHours, formatHalfHourRange } from "./half-hour-codec";

/** The YAML-first explanation shown on a disabled Convert for an advanced-array
 *  count — its shape can only be edited through Save & Load first. */
const CONVERT_ADVANCED_REASON = "Edit via Save & Load (YAML) first.";

interface CountCardListProps {
  counts: CountCard[];
  onEdit: (uid: string) => void;
  onDuplicate: (uid: string) => void;
  onDelete: (uid: string) => void;
  onMove: (uid: string, direction: -1 | 1) => void;
  onSetDisabled: (uid: string, value: boolean) => void;
  /** Primary DnD reorder (the shared card-list reorder interaction). `position` is
   *  the pointer half of the drop target (insert before/after — FR-PR-12). */
  onReorder: (fromUid: string, toUid: string, position: DropPosition) => void;
  /** Seed the guided contracted editor from a scalar generic count (M2a-4). */
  onConvertToContracted: (uid: string) => void;
  /** Request the inline convert-to-generic confirm for a marked card. */
  onConvertToGeneric: (uid: string) => void;
  /** The marked card whose convert-to-generic confirm panel is currently open. */
  convertToGenericUid: string | null;
  /** Commit the convert-to-generic (one replace-in-place mutation). */
  onConfirmConvertToGeneric: (uid: string) => void;
  /** Dismiss the convert-to-generic confirm without mutating. */
  onCancelConvertToGeneric: () => void;
}

/** The inline Confirm/Cancel panel for converting a marked card back to a generic
 *  count. Previews what the card becomes: an Exact contract's scalar fields yield
 *  an editable Shift Count; a Range contract's array fields yield an advanced (list)
 *  rule that is edited via Save & Load (YAML). */
function ConvertToGenericConfirm({
  card,
  index,
  onConfirm,
  onCancel,
}: {
  card: CountCard;
  index: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const willBeEditable = isContractedHoursCard(card)
    ? isEditableCountCard(convertContractedToGeneric(card))
    : true;
  const preview = willBeEditable
    ? "This becomes an editable Shift Count."
    : "This becomes an advanced (list) rule, editable via Save & Load (YAML).";
  return (
    <div
      className="mt-3 border border-line2 bg-panel p-3.5"
      data-testid={`count-convert-generic-confirm-${index}`}
    >
      <p className="mb-2.5 text-meta text-ink2">Remove the contracted-hours marker? {preview}</p>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          className="h-9 px-4"
          data-testid={`count-convert-generic-commit-${index}`}
          onClick={onConfirm}
        >
          Convert to generic
        </Button>
        <Button
          variant="outline"
          className="h-9 px-4"
          data-testid={`count-convert-generic-cancel-${index}`}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Format a contracted-hours card's half-hour target the way the guided editor's
 *  target inputs display it: an exact scalar as human hours (320 -> "160h"), a
 *  [min, max] range as a single hours span (formatHalfHourRange). */
function describeContractedTarget(target: number | number[]): string {
  return Array.isArray(target)
    ? formatHalfHourRange([target[0], target[1]])
    : formatHalfHours(target);
}

function CoefficientChips({ card }: { card: CountCard }) {
  const coefficients = card.countShiftTypeCoefficients ?? [];
  // A contracted-hours card stores coefficients as raw half-hours (the guided
  // flow's grid unit); show them in human hours to match the target display, so a
  // ward manager never reads 16 as shifts. Ordinary counts keep their raw value.
  const contracted = isContractedHoursCard(card);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {coefficients.map(([id, value]) => (
        <span
          key={id}
          className="border border-line2 bg-panel px-2 py-0.5 font-mono text-label font-semibold text-ink"
        >
          {id} · {contracted && typeof value === "number" ? formatHalfHours(value) : value}
        </span>
      ))}
    </div>
  );
}

export function CountCardList({
  counts,
  onEdit,
  onDuplicate,
  onDelete,
  onMove,
  onSetDisabled,
  onReorder,
  onConvertToContracted,
  onConvertToGeneric,
  convertToGenericUid,
  onConfirmConvertToGeneric,
  onCancelConvertToGeneric,
}: CountCardListProps) {
  // HTML5 DnD state for the shared card-list reorder (the primary control; the
  // keyboard Up/Down buttons below are the accessibility supplement).
  const [dragUid, setDragUid] = useState<string | null>(null);
  const [overUid, setOverUid] = useState<string | null>(null);

  return (
    <ul className="flex flex-col gap-3" data-testid="counts-list">
      {counts.map((card, index) => {
        const contractedHours = isContractedHoursCard(card);
        const advanced = isAdvancedCountCard(card);
        // An ordinary card edits in the scalar form; a contracted card routes to the
        // guided contracted editor (M2a-2). Only the unmarked advanced-array card
        // (FR-PR-55a) stays read-only here — YAML is its only edit path.
        const showEdit = !advanced;
        const coefficients = card.countShiftTypeCoefficients ?? [];

        return (
          <CardListItem
            key={card.uid}
            testId={`count-card-${index}`}
            index={index}
            disabled={card.disabled}
            accent={contractedHours ? "brand" : "none"}
            draggable
            isDragging={dragUid === card.uid}
            isOver={overUid === card.uid && dragUid !== null && dragUid !== card.uid}
            onDragStart={() => setDragUid(card.uid)}
            onDragOver={() => setOverUid(card.uid)}
            onDragEnd={() => {
              setDragUid(null);
              setOverUid(null);
            }}
            onDrop={(position) => {
              if (dragUid && dragUid !== card.uid) onReorder(dragUid, card.uid, position);
              setDragUid(null);
              setOverUid(null);
            }}
            title={card.description?.trim() ? card.description : "Untitled shift count"}
            badges={
              <>
                {card.disabled && <Badge variant="neutral">Disabled</Badge>}
                {contractedHours && (
                  <Badge variant="brand" data-testid={`count-contracted-badge-${index}`}>
                    ◆ Contracted hours
                  </Badge>
                )}
                {!contractedHours && advanced && (
                  <Badge variant="neutral" data-testid={`count-advanced-badge-${index}`}>
                    Advanced (list)
                  </Badge>
                )}
                <WeightPill value={card.weight} />
              </>
            }
            fields={[
              { label: "People", value: summarizeRefs(card.person) },
              { label: "Count shift types", value: summarizeRefs(card.countShiftTypes) },
              { label: "Dates", value: summarizeRefs(card.countDates) },
              {
                label: "Expression",
                value: (
                  <code className="font-mono">
                    {contractedHours
                      ? describeContractedTarget(card.target)
                      : describeCountExpressionTarget(card.expression, card.target)}
                  </code>
                ),
              },
              ...(coefficients.length > 0
                ? [{ label: "Coefficients", value: <CoefficientChips card={card} /> }]
                : []),
            ]}
            actions={
              <>
                <CardActionButton
                  icon={<FaPowerOff className="size-3" />}
                  onClick={() => onSetDisabled(card.uid, !card.disabled)}
                  testId={`count-disable-${index}`}
                  ariaLabel={card.disabled ? "Enable shift count" : "Disable shift count"}
                >
                  {card.disabled ? "Enable" : "Disable"}
                </CardActionButton>
                {showEdit ? (
                  <CardActionButton
                    icon={<FaPen className="size-3" />}
                    onClick={() => onEdit(card.uid)}
                    testId={`count-edit-${index}`}
                    ariaLabel="Edit shift count"
                  >
                    Edit
                  </CardActionButton>
                ) : (
                  <span
                    className="text-meta italic text-ink3"
                    data-testid={`count-readonly-note-${index}`}
                    title="Edit via Save & Load (YAML) — this rule's shape isn't authored by this form"
                  >
                    Read-only here — edit via Save &amp; Load (YAML)
                  </span>
                )}
                {contractedHours ? (
                  <CardActionButton
                    icon={<FaArrowRightArrowLeft className="size-3" />}
                    onClick={() => onConvertToGeneric(card.uid)}
                    testId={`count-convert-generic-${index}`}
                    ariaLabel="Convert to generic shift count"
                  >
                    Convert to generic
                  </CardActionButton>
                ) : (
                  <CardActionButton
                    icon={<FaArrowRightArrowLeft className="size-3" />}
                    onClick={() => onConvertToContracted(card.uid)}
                    testId={`count-convert-contracted-${index}`}
                    ariaLabel="Convert to contracted hours"
                    disabled={advanced}
                    disabledReason={CONVERT_ADVANCED_REASON}
                  >
                    Convert to contracted
                  </CardActionButton>
                )}
                <CardActionButton
                  icon={<FaCopy className="size-3" />}
                  onClick={() => onDuplicate(card.uid)}
                  testId={`count-dup-${index}`}
                  ariaLabel="Duplicate shift count"
                >
                  Duplicate
                </CardActionButton>
                <CardActionButton
                  icon={<FaTrash className="size-3" />}
                  danger
                  onClick={() => onDelete(card.uid)}
                  testId={`count-delete-${index}`}
                  ariaLabel="Delete shift count"
                >
                  Delete
                </CardActionButton>
                <CardActionButton
                  icon={<FaChevronUp className="size-3" />}
                  onClick={() => onMove(card.uid, -1)}
                  testId={`count-up-${index}`}
                  ariaLabel="Move shift count up"
                >
                  Up
                </CardActionButton>
                <CardActionButton
                  icon={<FaChevronDown className="size-3" />}
                  onClick={() => onMove(card.uid, 1)}
                  testId={`count-down-${index}`}
                  ariaLabel="Move shift count down"
                >
                  Down
                </CardActionButton>
              </>
            }
            footer={
              contractedHours && convertToGenericUid === card.uid ? (
                <ConvertToGenericConfirm
                  card={card}
                  index={index}
                  onConfirm={() => onConfirmConvertToGeneric(card.uid)}
                  onCancel={onCancelConvertToGeneric}
                />
              ) : undefined
            }
          />
        );
      })}
    </ul>
  );
}
