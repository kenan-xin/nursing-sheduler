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
import { FaPowerOff, FaPen, FaCopy, FaTrash, FaChevronUp, FaChevronDown } from "@/components/icons";
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
  summarizeRefs,
} from "./counts-model";

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
}

function CoefficientChips({ card }: { card: CountCard }) {
  const coefficients = card.countShiftTypeCoefficients ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {coefficients.map(([id, value]) => (
        <span
          key={id}
          className="border border-line2 bg-panel px-2 py-0.5 font-mono text-label font-semibold text-ink"
        >
          {id} · {value}
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
                    {describeCountExpressionTarget(card.expression, card.target)}
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
          />
        );
      })}
    </ul>
  );
}
