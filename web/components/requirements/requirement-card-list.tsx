"use client";

// The saved-requirements list (spec 05 FR-PR-29), built on the shared ScreenCards
// card frame: each requirement is a numbered card with its description, the
// shared weight pill (shown ONLY when the preferred/required weight is
// meaningful — FR-PR-29), a Shift types/Required/Qualified/Dates field grid (plus
// a Coefficients cell when the card has any), and the labelled Edit · Duplicate ·
// Delete action row.

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { FaPowerOff, FaPen, FaCopy, FaTrash, FaChevronUp, FaChevronDown } from "@/components/icons";
import { WeightPill } from "@/components/card-editor/weight-field";
import type { RequirementCard } from "@/lib/scenario";
import {
  CardActionButton,
  CardListItem,
  type DropPosition,
} from "@/components/card-editor/card-editor-shell";
import { summarizeRefs } from "./requirements-model";

interface RequirementCardListProps {
  requirements: RequirementCard[];
  onEdit: (uid: string) => void;
  onDuplicate: (uid: string) => void;
  onDelete: (uid: string) => void;
  onMove: (uid: string, direction: -1 | 1) => void;
  onSetDisabled: (uid: string, value: boolean) => void;
  /** Primary DnD reorder. `position` is the pointer half of the drop target
   *  (insert before/after — FR-PR-12). */
  onReorder: (fromUid: string, toUid: string, position: DropPosition) => void;
}

function CoefficientChips({ card }: { card: RequirementCard }) {
  const coefficients = card.shiftTypeCoefficients ?? [];
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

export function RequirementCardList({
  requirements,
  onEdit,
  onDuplicate,
  onDelete,
  onMove,
  onSetDisabled,
  onReorder,
}: RequirementCardListProps) {
  // HTML5 DnD state for the shared card-list reorder (the primary control; the
  // keyboard Up/Down buttons below are the accessibility supplement).
  const [dragUid, setDragUid] = useState<string | null>(null);
  const [overUid, setOverUid] = useState<string | null>(null);

  return (
    <ul className="flex flex-col gap-3" data-testid="requirements-list">
      {requirements.map((card, index) => {
        const coefficients = card.shiftTypeCoefficients ?? [];
        // FR-PR-29: the weight pill is shown ONLY when a distinct preferred value
        // makes the weight meaningful (mirrors the form's conditional dial).
        const showWeight =
          card.preferredNumPeople !== undefined &&
          card.preferredNumPeople !== card.requiredNumPeople;

        return (
          <CardListItem
            key={card.uid}
            testId={`requirement-card-${index}`}
            index={index}
            disabled={card.disabled}
            accent="none"
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
            title={card.description?.trim() ? card.description : "Untitled requirement"}
            badges={
              <>
                {card.disabled && <Badge variant="neutral">Disabled</Badge>}
                {showWeight && <WeightPill value={card.weight} />}
              </>
            }
            fields={[
              { label: "Shift types", value: summarizeRefs(card.shiftType) },
              ...(coefficients.length > 0
                ? [
                    {
                      label: "Coefficients · staffing multiplier",
                      value: <CoefficientChips card={card} />,
                    },
                  ]
                : []),
              { label: "Required", value: `${card.requiredNumPeople}` },
              {
                label: "Preferred",
                value: card.preferredNumPeople != null ? String(card.preferredNumPeople) : "—",
              },
              { label: "Qualified", value: summarizeRefs(card.qualifiedPeople ?? "ALL") },
              { label: "Dates", value: summarizeRefs(card.date ?? "ALL") },
            ]}
            actions={
              <>
                <CardActionButton
                  icon={<FaPowerOff className="size-3" />}
                  onClick={() => onSetDisabled(card.uid, !card.disabled)}
                  testId={`requirement-disable-${index}`}
                  ariaLabel={card.disabled ? "Enable requirement" : "Disable requirement"}
                >
                  {card.disabled ? "Enable" : "Disable"}
                </CardActionButton>
                <CardActionButton
                  icon={<FaPen className="size-3" />}
                  onClick={() => onEdit(card.uid)}
                  testId={`requirement-edit-${index}`}
                  ariaLabel="Edit requirement"
                >
                  Edit
                </CardActionButton>
                <CardActionButton
                  icon={<FaCopy className="size-3" />}
                  onClick={() => onDuplicate(card.uid)}
                  testId={`requirement-dup-${index}`}
                  ariaLabel="Duplicate requirement"
                >
                  Duplicate
                </CardActionButton>
                <CardActionButton
                  icon={<FaTrash className="size-3" />}
                  danger
                  onClick={() => onDelete(card.uid)}
                  testId={`requirement-delete-${index}`}
                  ariaLabel="Delete requirement"
                >
                  Delete
                </CardActionButton>
                <CardActionButton
                  icon={<FaChevronUp className="size-3" />}
                  onClick={() => onMove(card.uid, -1)}
                  testId={`requirement-up-${index}`}
                  ariaLabel="Move requirement up"
                >
                  Up
                </CardActionButton>
                <CardActionButton
                  icon={<FaChevronDown className="size-3" />}
                  onClick={() => onMove(card.uid, 1)}
                  testId={`requirement-down-${index}`}
                  ariaLabel="Move requirement down"
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
