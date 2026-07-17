"use client";

// The saved-coverings list (spec 11 FR-CV-18..21), rebuilt onto the shared
// ScreenCards card frame (audit M4): each rule is a numbered card with its
// description, a red "Always enforced" hard-rule badge (+ a "Disabled" badge when
// turned off), a four-cell Preceptors/Preceptees/Shift types/Dates field grid,
// and the labelled Disable/Enable · Edit · Duplicate · Delete action row. Reorder
// (FR-CV-21) is preserved as supplementary keyboard move buttons — an accessible,
// deterministic affordance the audit (M4) explicitly permits alongside the
// labelled primary actions.

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { FaPowerOff, FaPen, FaCopy, FaTrash, FaChevronUp, FaChevronDown } from "@/components/icons";
import type { CoveringCard } from "@/lib/scenario";
import { CardActionButton, CardListItem } from "@/components/card-editor/card-editor-shell";
import { isAdvancedCoveringCard, summarizeRefs } from "./coverings-model";
import type { DropPosition } from "@/components/card-editor/card-editor-shell";

interface CoveringCardListProps {
  coverings: CoveringCard[];
  onEdit: (uid: string) => void;
  onDuplicate: (uid: string) => void;
  onDelete: (uid: string) => void;
  onMove: (uid: string, direction: -1 | 1) => void;
  onSetDisabled: (uid: string, value: boolean) => void;
  /** Primary DnD reorder (M4 "shared card-list reorder interaction"). */
  onReorder: (fromUid: string, toUid: string, position: DropPosition) => void;
}

export function CoveringCardList({
  coverings,
  onEdit,
  onDuplicate,
  onDelete,
  onMove,
  onSetDisabled,
  onReorder,
}: CoveringCardListProps) {
  // HTML5 DnD state for the shared card-list reorder (the primary control; the
  // keyboard Up/Down buttons below are the accessibility supplement — audit M4).
  const [dragUid, setDragUid] = useState<string | null>(null);
  const [overUid, setOverUid] = useState<string | null>(null);

  return (
    <ul className="flex flex-col gap-3" data-testid="coverings-list">
      {coverings.map((card, index) => {
        const advanced = isAdvancedCoveringCard(card);
        return (
          <CardListItem
            key={card.uid}
            testId={`covering-card-${index}`}
            index={index}
            disabled={card.disabled}
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
            title={card.description?.trim() ? card.description : "Untitled covering"}
            badges={
              <>
                {card.disabled && <Badge variant="neutral">Disabled</Badge>}
                {advanced && <Badge variant="neutral">Advanced (multi-term)</Badge>}
                <Badge variant="error">Always enforced</Badge>
              </>
            }
            fields={[
              { label: "Preceptors", value: summarizeRefs(card.preceptors) },
              { label: "Preceptees", value: summarizeRefs(card.preceptees) },
              { label: "Shift types", value: summarizeRefs(card.shiftTypes) },
              {
                label: "Dates",
                value: card.date === undefined ? "(all)" : summarizeRefs(card.date),
              },
            ]}
            actions={
              <>
                <CardActionButton
                  icon={<FaPowerOff className="size-3" />}
                  onClick={() => onSetDisabled(card.uid, !card.disabled)}
                  testId={`covering-disable-${index}`}
                  ariaLabel={card.disabled ? "Enable covering" : "Disable covering"}
                >
                  {card.disabled ? "Enable" : "Disable"}
                </CardActionButton>
                {advanced ? (
                  <span
                    className="text-meta italic text-ink3"
                    data-testid={`covering-readonly-note-${index}`}
                  >
                    Read-only here — edit via Save &amp; Load (YAML)
                  </span>
                ) : (
                  <CardActionButton
                    icon={<FaPen className="size-3" />}
                    onClick={() => onEdit(card.uid)}
                    testId={`covering-edit-${index}`}
                    ariaLabel="Edit covering"
                  >
                    Edit
                  </CardActionButton>
                )}
                <CardActionButton
                  icon={<FaCopy className="size-3" />}
                  onClick={() => onDuplicate(card.uid)}
                  testId={`covering-dup-${index}`}
                  ariaLabel="Duplicate covering"
                >
                  Duplicate
                </CardActionButton>
                <CardActionButton
                  icon={<FaTrash className="size-3" />}
                  danger
                  onClick={() => onDelete(card.uid)}
                  testId={`covering-delete-${index}`}
                  ariaLabel="Delete covering"
                >
                  Delete
                </CardActionButton>
                {/* Supplementary keyboard reorder (FR-CV-21) — sanctioned by M4. */}
                <CardActionButton
                  icon={<FaChevronUp className="size-3" />}
                  onClick={() => onMove(card.uid, -1)}
                  testId={`covering-up-${index}`}
                  ariaLabel="Move covering up"
                >
                  Up
                </CardActionButton>
                <CardActionButton
                  icon={<FaChevronDown className="size-3" />}
                  onClick={() => onMove(card.uid, 1)}
                  testId={`covering-down-${index}`}
                  ariaLabel="Move covering down"
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
