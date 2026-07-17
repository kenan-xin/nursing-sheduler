"use client";

// The saved-successions list (spec 05 FR-PR-34), built on the shared ScreenCards
// card frame: each succession is a numbered card with its description, the
// shared weight pill, a People/Pattern/Dates field grid (Pattern rendered as
// `→`-joined chips, matching the prototype's ordered-sequence display), and the
// labelled Disable/Enable · Edit · Duplicate · Delete · Up/Down action row
// (mirrors `count-card-list.tsx`).
//
// A card with a nested-aggregate pattern position (`isAdvancedSuccessionCard`)
// is the lossless read-only fallback (mirrors the Counts generic-array card):
// the sequential PatternBuilder cannot represent an aggregate position without
// corrupting it, so it renders an `Advanced (nested)` badge and a read-only note
// instead of Edit, and is preserved byte-for-byte through duplicate/reorder/
// disable/delete (none of which route through `flattenPattern`/`buildSuccessionCard`).

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  FaArrowRightLong,
  FaPowerOff,
  FaPen,
  FaCopy,
  FaTrash,
  FaChevronUp,
  FaChevronDown,
} from "@/components/icons";
import { WeightPill } from "@/components/card-editor/weight-field";
import type { SuccessionCard } from "@/lib/scenario";
import {
  CardActionButton,
  CardListItem,
  type DropPosition,
} from "@/components/card-editor/card-editor-shell";
import {
  isEditableSuccessionCard,
  patternPositionsForDisplay,
  summarizeRefs,
} from "./successions-model";

interface SuccessionCardListProps {
  successions: SuccessionCard[];
  onEdit: (uid: string) => void;
  onDuplicate: (uid: string) => void;
  onDelete: (uid: string) => void;
  onMove: (uid: string, direction: -1 | 1) => void;
  onSetDisabled: (uid: string, value: boolean) => void;
  /** Primary DnD reorder (the shared card-list reorder interaction). `position` is
   *  the pointer half of the drop target (insert before/after — FR-PR-12). */
  onReorder: (fromUid: string, toUid: string, position: DropPosition) => void;
}

/** Pattern rendered as `→`-joined chips, in order (FR-PR-34). A nested-aggregate
 *  position (advanced card) shows its terms joined by ` + `, faithful to the
 *  stored shape — never flattened into extra `→` steps. */
function PatternChips({ card }: { card: SuccessionCard }) {
  const positions = patternPositionsForDisplay(card.pattern);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {positions.map((label, index) => (
        <span key={index} className="flex items-center gap-1.5">
          {index > 0 && <FaArrowRightLong className="size-2.5 text-ink3" aria-hidden />}
          <span className="border border-line2 bg-panel px-2 py-0.5 font-mono text-label font-semibold text-ink">
            {label}
          </span>
        </span>
      ))}
    </div>
  );
}

export function SuccessionCardList({
  successions,
  onEdit,
  onDuplicate,
  onDelete,
  onMove,
  onSetDisabled,
  onReorder,
}: SuccessionCardListProps) {
  // HTML5 DnD state for the shared card-list reorder (the primary control; the
  // keyboard Up/Down buttons below are the accessibility supplement).
  const [dragUid, setDragUid] = useState<string | null>(null);
  const [overUid, setOverUid] = useState<string | null>(null);

  return (
    <ul className="flex flex-col gap-3" data-testid="successions-list">
      {successions.map((card, index) => {
        const dates = Array.isArray(card.date)
          ? card.date
          : card.date === undefined
            ? []
            : [card.date];
        const editable = isEditableSuccessionCard(card);

        return (
          <CardListItem
            key={card.uid}
            testId={`succession-card-${index}`}
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
            title={card.description?.trim() ? card.description : "Untitled succession"}
            badges={
              <>
                {card.disabled && <Badge variant="neutral">Disabled</Badge>}
                {!editable && (
                  <Badge variant="neutral" data-testid={`succession-advanced-badge-${index}`}>
                    Advanced (nested)
                  </Badge>
                )}
                <WeightPill value={card.weight} />
              </>
            }
            fields={[
              { label: "People", value: summarizeRefs(card.person) },
              { label: "Pattern", value: <PatternChips card={card} /> },
              ...(dates.length > 0 ? [{ label: "Dates", value: summarizeRefs(dates) }] : []),
            ]}
            actions={
              <>
                <CardActionButton
                  icon={<FaPowerOff className="size-3" />}
                  onClick={() => onSetDisabled(card.uid, !card.disabled)}
                  testId={`succession-disable-${index}`}
                  ariaLabel={card.disabled ? "Enable succession" : "Disable succession"}
                >
                  {card.disabled ? "Enable" : "Disable"}
                </CardActionButton>
                {editable ? (
                  <CardActionButton
                    icon={<FaPen className="size-3" />}
                    onClick={() => onEdit(card.uid)}
                    testId={`succession-edit-${index}`}
                    ariaLabel="Edit succession"
                  >
                    Edit
                  </CardActionButton>
                ) : (
                  <span
                    className="text-meta italic text-ink3"
                    data-testid={`succession-readonly-note-${index}`}
                    title="Edit via Save & Load (YAML) — this pattern has a nested-aggregate position this form can't author"
                  >
                    Read-only here — edit via Save &amp; Load (YAML)
                  </span>
                )}
                <CardActionButton
                  icon={<FaCopy className="size-3" />}
                  onClick={() => onDuplicate(card.uid)}
                  testId={`succession-dup-${index}`}
                  ariaLabel="Duplicate succession"
                >
                  Duplicate
                </CardActionButton>
                <CardActionButton
                  icon={<FaTrash className="size-3" />}
                  danger
                  onClick={() => onDelete(card.uid)}
                  testId={`succession-delete-${index}`}
                  ariaLabel="Delete succession"
                >
                  Delete
                </CardActionButton>
                <CardActionButton
                  icon={<FaChevronUp className="size-3" />}
                  onClick={() => onMove(card.uid, -1)}
                  testId={`succession-up-${index}`}
                  ariaLabel="Move succession up"
                >
                  Up
                </CardActionButton>
                <CardActionButton
                  icon={<FaChevronDown className="size-3" />}
                  onClick={() => onMove(card.uid, 1)}
                  testId={`succession-down-${index}`}
                  ariaLabel="Move succession down"
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
