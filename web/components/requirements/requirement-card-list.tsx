"use client";

// The saved-requirements list (spec 05 FR-PR-29), built on the shared ScreenCards
// card frame: each requirement is a numbered card with its description, the
// shared weight pill (shown ONLY when the preferred/required weight is
// meaningful — FR-PR-29), a Shift types/Required/Qualified/Dates field grid (plus
// a Coefficients cell when the card has any, and an Exceptions cell when it has
// per-date overrides), and the labelled Edit · Duplicate ·
// Delete action row.
//
// The Exceptions cell also lists the cover effects on THIS card, read-only and
// apart from the hand-written per-date overrides (d582, spec §6): a temporary
// cover lowers the need on her date, so the cell says so
// (`14 Oct: 2 · Haseena (Ward 3) covering`) and links to Staff, where covers live.

import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Badge } from "@/components/ui/badge";
import { FaPowerOff, FaPen, FaCopy, FaTrash } from "@/components/icons";
import { WeightPill } from "@/components/card-editor/weight-field";
import type { RequirementCard } from "@/lib/scenario";
import { changeKeys } from "@/lib/change-highlight/keys";
import {
  CardActionButton,
  CardListItem,
  CardMoveActions,
  type DropPosition,
} from "@/components/card-editor/card-editor-shell";
import { formatShortDate } from "@/lib/dates/date-id";
import { useScenarioStore } from "@/lib/store";
import { GuardedLink } from "@/components/shell/guarded-link";
import {
  coverCardsOf,
  coverInputFrom,
  coverSlicesOf,
  coverStatuses,
} from "@/lib/scenario/temporary-cover";
import { summarizeRefs } from "./requirements-model";
import { findSpareSlotBonus } from "@/components/successions/successions-model";

interface RequirementCardListProps {
  requirements: RequirementCard[];
  onEdit: (uid: string) => void;
  onDuplicate: (uid: string) => void;
  onDelete: (uid: string) => void;
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
          className="rounded-chip border border-line2 bg-panel px-2 py-0.5 font-mono text-label font-semibold text-ink"
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
  onSetDisabled,
  onReorder,
}: RequirementCardListProps) {
  // HTML5 DnD state for the shared card-list reorder.
  const [dragUid, setDragUid] = useState<string | null>(null);
  const [overUid, setOverUid] = useState<string | null>(null);

  // The cover effects that land on a card are read-only here — covers are managed on
  // Staff — but they change what this card's need IS, so the cell reports them. Two
  // narrow subscriptions, so a card kind the cover maths never reads cannot re-render.
  const coverSlices = useScenarioStore(useShallow(coverSlicesOf));
  const coverRequirements = useScenarioStore(coverCardsOf);
  // The spare-slot bonus rules (uv8n) live on Shift sequences; the Preferred cell names them.
  const successions = useScenarioStore((state) => state.cardsByKind.successions);
  const coverLines = useMemo(() => {
    const coverState = coverInputFrom(coverSlices, coverRequirements);
    const lines = new Map<string, string[]>();
    for (const status of coverStatuses(coverState)) {
      const name = coverState.temporaryCover[status.index]?.name ?? "";
      for (const effect of status.effects) {
        const list = lines.get(effect.cardUid) ?? [];
        list.push(`${formatShortDate(effect.iso)}: ${effect.after} · ${name} covering`);
        lines.set(effect.cardUid, list);
      }
    }
    return lines;
  }, [coverSlices, coverRequirements]);

  return (
    <ul className="flex flex-col gap-3" data-testid="requirements-list">
      {requirements.map((card, index) => {
        const coefficients = card.shiftTypeCoefficients ?? [];
        const exceptions = [
          ...(card.requiredNumPeopleOverrides ?? []).map(
            ([iso, n]) => `${formatShortDate(iso)}: ${n}`,
          ),
          ...(coverLines.get(card.uid) ?? []),
        ];
        // FR-PR-29: the weight pill is shown ONLY when a distinct preferred value
        // makes the weight meaningful (mirrors the form's conditional dial).
        const hasSpare =
          card.preferredNumPeople !== undefined &&
          card.preferredNumPeople !== card.requiredNumPeople;
        // Weight 0 (uv8n): the spare places are optional bonuses, so no weight pill that
        // reads as a penalty; the Preferred field says it in words instead.
        const optionalSpare = hasSpare && card.weight === 0;
        const bonus = optionalSpare ? findSpareSlotBonus(successions, card) : undefined;
        const showWeight = hasSpare && !optionalSpare;

        return (
          <CardListItem
            key={card.uid}
            testId={`requirement-card-${index}`}
            changeKey={changeKeys.rule("requirements", card.uid)}
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
              {
                label: "Required",
                value: card.skillMix?.length
                  ? `${card.requiredNumPeople} · at least ${card.skillMix.map((e) => `${e.minNumPeople} ${e.people}`).join(", ")}`
                  : `${card.requiredNumPeople}`,
              },
              ...(exceptions.length > 0
                ? [
                    {
                      label: "Exceptions",
                      value: (
                        <span data-testid={`requirement-exceptions-${card.uid}`}>
                          {exceptions.join(" · ")}
                          {" · "}
                          <GuardedLink
                            href="/people"
                            className="text-brandink underline-offset-4 hover:underline"
                          >
                            Temporary cover on Staff
                          </GuardedLink>
                        </span>
                      ),
                    },
                  ]
                : []),
              {
                label: "Preferred",
                value:
                  card.preferredNumPeople == null
                    ? "—"
                    : bonus
                      ? `${card.preferredNumPeople} · extra places are a bonus, +${bonus.weight} points each`
                      : optionalSpare
                        ? `${card.preferredNumPeople} · spare places are optional, an empty one costs nothing`
                        : String(card.preferredNumPeople),
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
                <CardMoveActions
                  cards={requirements}
                  index={index}
                  onReorder={onReorder}
                  testIdPrefix="requirement"
                  subject="requirement"
                />
              </>
            }
          />
        );
      })}
    </ul>
  );
}
