"use client";

// The saved-affinities list (spec 05 FR-PR-62), built on the shared ScreenCards
// card frame: each affinity is a numbered card with its description, the shared
// weight pill, a People 1/People 2/Shift types/Dates field grid, and the
// labelled Disable/Enable · Edit · Duplicate · Delete action row.

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { FaPowerOff, FaPen, FaCopy, FaTrash, FaChevronUp, FaChevronDown } from "@/components/icons";
import { WeightPill } from "@/components/card-editor/weight-field";
import type { AffinityCard } from "@/lib/scenario";
import {
  CardActionButton,
  CardListItem,
  type DropPosition,
} from "@/components/card-editor/card-editor-shell";
import { isAdvancedAffinityCard, summarizeRefs } from "./affinities-model";

interface AffinityCardListProps {
  affinities: AffinityCard[];
  onEdit: (uid: string) => void;
  onDuplicate: (uid: string) => void;
  onDelete: (uid: string) => void;
  onMove: (uid: string, direction: -1 | 1) => void;
  onSetDisabled: (uid: string, value: boolean) => void;
  /** Primary DnD reorder (the shared card-list reorder interaction). `position` is
   *  the pointer half of the drop target (insert before/after — FR-PR-12). */
  onReorder: (fromUid: string, toUid: string, position: DropPosition) => void;
}

export function AffinityCardList({
  affinities,
  onEdit,
  onDuplicate,
  onDelete,
  onMove,
  onSetDisabled,
  onReorder,
}: AffinityCardListProps) {
  // HTML5 DnD state for the shared card-list reorder (the primary control; the
  // keyboard Up/Down buttons below are the accessibility supplement).
  const [dragUid, setDragUid] = useState<string | null>(null);
  const [overUid, setOverUid] = useState<string | null>(null);

  return (
    <ul className="flex flex-col gap-3" data-testid="affinities-list">
      {affinities.map((card, index) => {
        // An advanced (multi-term) affinity cannot enter the single-term form —
        // it renders read-only and is preserved byte-for-byte (FR-PR-55a-style).
        const advanced = isAdvancedAffinityCard(card);
        return (
          <CardListItem
            key={card.uid}
            testId={`affinity-card-${index}`}
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
            title={card.description?.trim() ? card.description : "Untitled affinity"}
            badges={
              <>
                {card.disabled && <Badge variant="neutral">Disabled</Badge>}
                {advanced && (
                  <Badge variant="neutral" data-testid={`affinity-advanced-badge-${index}`}>
                    Advanced (multi-term)
                  </Badge>
                )}
                <WeightPill value={card.weight} />
              </>
            }
            fields={[
              { label: "People 1", value: summarizeRefs(card.people1) },
              { label: "People 2", value: summarizeRefs(card.people2) },
              { label: "Shift types", value: summarizeRefs(card.shiftTypes) },
              { label: "Dates", value: summarizeRefs(card.date) },
            ]}
            actions={
              <>
                <CardActionButton
                  icon={<FaPowerOff className="size-3" />}
                  onClick={() => onSetDisabled(card.uid, !card.disabled)}
                  testId={`affinity-disable-${index}`}
                  ariaLabel={card.disabled ? "Enable affinity" : "Disable affinity"}
                >
                  {card.disabled ? "Enable" : "Disable"}
                </CardActionButton>
                {advanced ? (
                  <span
                    className="text-meta italic text-ink3"
                    data-testid={`affinity-readonly-note-${index}`}
                    title="Edit via Save & Load (YAML) — this rule's multi-term shape isn't authored by this form"
                  >
                    Read-only here — edit via Save &amp; Load (YAML)
                  </span>
                ) : (
                  <CardActionButton
                    icon={<FaPen className="size-3" />}
                    onClick={() => onEdit(card.uid)}
                    testId={`affinity-edit-${index}`}
                    ariaLabel="Edit affinity"
                  >
                    Edit
                  </CardActionButton>
                )}
                <CardActionButton
                  icon={<FaCopy className="size-3" />}
                  onClick={() => onDuplicate(card.uid)}
                  testId={`affinity-dup-${index}`}
                  ariaLabel="Duplicate affinity"
                >
                  Duplicate
                </CardActionButton>
                <CardActionButton
                  icon={<FaTrash className="size-3" />}
                  danger
                  onClick={() => onDelete(card.uid)}
                  testId={`affinity-delete-${index}`}
                  ariaLabel="Delete affinity"
                >
                  Delete
                </CardActionButton>
                <CardActionButton
                  icon={<FaChevronUp className="size-3" />}
                  onClick={() => onMove(card.uid, -1)}
                  testId={`affinity-up-${index}`}
                  ariaLabel="Move affinity up"
                >
                  Up
                </CardActionButton>
                <CardActionButton
                  icon={<FaChevronDown className="size-3" />}
                  onClick={() => onMove(card.uid, 1)}
                  testId={`affinity-down-${index}`}
                  ariaLabel="Move affinity down"
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
