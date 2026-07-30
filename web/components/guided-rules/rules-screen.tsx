"use client";

// The Guided Rules screen — a direct, real /rules route, re-skinned for v2 "Mint
// Canvas, Warm Ink" (R3) against docs/design_prototype/source/ScreenRules.dc.html.
// Every row is derived from `cardsByKind` through the mapper registry: every
// constraint appears, always, with nothing to opt into. Navigation exposure
// (sidebar/Home/crumbs, global mode switching) is the shell's job — this screen is
// complete and directly routable on its own.
//
// The prototype's Rules screen is built around a Customise library and constraint
// pinning, and groups rows by a human-authored semantic taxonomy. All of that is
// removed end-to-end by the adoption deviation matrix, so the fidelity taken from
// it here is the VISUAL SYSTEM only: the header block, the on-count chip, the
// advanced-records strip, the icon-tile category headings and the list-card rows.
//
// Surfaces, in ladder order (DESIGN.md §4): the screen root is the L0 page plane;
// the on-count chip is a resting L1 island on it; the advanced-records strip is an
// inset well; each category list is an L1 card that clips its square rows,
// dividers and adjustment bands to the card radius.

import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Surface, surfaceVariants } from "@/components/ui/surface";
import {
  FaArrowRight,
  FaCalculator,
  FaCircleInfo,
  FaLock,
  FaPeopleArrows,
  FaSliders,
  FaUserNurse,
  FaUserShield,
} from "@/components/icons";
import type { IconType } from "@/components/icons";
import { useGuardedNavigation } from "@/components/shell/use-guarded-navigation";
import { useCardEditorDraftGuard } from "@/components/card-editor/card-editor-shell";
import { useGuidedRules } from "./use-guided-rules";
import { RuleRow } from "./rule-row";
import type { GuidedRuleRow } from "./types";

const CATEGORY_ICONS: Record<string, IconType> = {
  "Always on": FaLock,
  "Staffing levels": FaUserNurse,
  "Shift sequences": FaArrowRight,
  "Hours & contracts": FaCalculator,
  "Who works together": FaPeopleArrows,
  Supervision: FaUserShield,
};

function categoryIcon(category: string): IconType {
  return CATEGORY_ICONS[category] ?? FaSliders;
}

function groupByCategory(rows: GuidedRuleRow[]): { category: string; rows: GuidedRuleRow[] }[] {
  const order: string[] = [];
  const byCategory = new Map<string, GuidedRuleRow[]>();
  for (const row of rows) {
    if (!byCategory.has(row.category)) {
      order.push(row.category);
      byCategory.set(row.category, []);
    }
    byCategory.get(row.category)!.push(row);
  }
  return order.map((category) => ({ category, rows: byCategory.get(category)! }));
}

const KIND_LABELS: Record<string, string> = {
  requirements: "requirements",
  successions: "successions",
  counts: "counts",
  affinities: "affinities",
  coverings: "coverings",
};

export interface RulesScreenProps {
  /** T08d integration seam: when provided, called instead of a plain guarded
   *  navigate for "Edit in Advanced" links, so the shell can perform the atomic
   *  mode-switch + navigate transaction (tech-plan §2). Defaults to a bare
   *  guarded navigation — this ticket does not change global mode state. */
  onOpenAdvanced?: (route: string) => void;
}

export function RulesScreen({ onOpenAdvanced }: RulesScreenProps) {
  const { navigate } = useGuardedNavigation();
  const { state, rows, toggle, adjust, rename } = useGuidedRules();

  const [openAdjustId, setOpenAdjustId] = React.useState<string | null>(null);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");

  const renamingRow = renamingId ? rows.find((r) => r.id === renamingId) : undefined;
  // Only a rename holding an actual change is losable work — an open input still
  // showing the current title has nothing to discard.
  const renameDirty =
    renamingRow !== undefined &&
    renameDraft.trim() !== "" &&
    renameDraft.trim() !== renamingRow.title;
  useCardEditorDraftGuard("guided-rules", renameDirty);

  function startRename(row: GuidedRuleRow) {
    setRenamingId(row.id);
    setRenameDraft(row.title);
  }

  function closeRename() {
    setRenamingId(null);
    setRenameDraft("");
  }

  function submitRename(row: GuidedRuleRow) {
    rename(row, renameDraft);
    closeRename();
  }

  const openAdvanced = React.useCallback(
    (route: string) => {
      if (onOpenAdvanced) onOpenAdvanced(route);
      else navigate(route);
    },
    [onOpenAdvanced, navigate],
  );

  const groups = groupByCategory(rows);
  const hasRecords = rows.some((r) => r.source === "record");
  const onCount = rows.filter((r) => r.enabled).length;
  const total = rows.length;

  const advCounts = {
    requirements: state.cardsByKind.requirements.length,
    successions: state.cardsByKind.successions.length,
    counts: state.cardsByKind.counts.length,
    affinities: state.cardsByKind.affinities.length,
    coverings: state.cardsByKind.coverings.length,
  };
  const advTotal = Object.values(advCounts).reduce((a, b) => a + b, 0);
  const advBreakdown = (Object.keys(advCounts) as (keyof typeof advCounts)[])
    .filter((k) => advCounts[k] > 0)
    .map((k) => `${advCounts[k]} ${KIND_LABELS[k]}`)
    .join(" · ");

  return (
    <Surface
      level="page"
      geometry="square"
      className="flex flex-col gap-5"
      data-testid="screen"
      data-screen="rules"
    >
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          <div className="mb-2 text-label font-semibold uppercase tracking-[0.03em] text-brandink">
            Step 4 · Rules
          </div>
          {/* Display: Figtree 700 / 1.15 / -0.015em (DESIGN.md §3). v1 ran 800 at
              1.05 and -0.02em; v2 is one weight step lighter with an opener line.
              Copy and wrapping are unchanged. */}
          <h1 className="mb-2 font-heading text-display font-bold leading-[1.15] tracking-[-0.015em]">
            Choose the Rules
          </h1>
          <p className="m-0 max-w-[68ch] text-ink2">
            Every rule your ward runs on, in plain English. Switch a rule off, change its numbers,
            or rename it to the words your team actually uses — each one reads and writes the same
            record you would edit under Advanced, so nothing here is a copy. A <b>built-in</b> rule
            is one the engine always enforces; it can be renamed but never switched off.
          </p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {/* `lg` is the absolute 44px control token the prototype's primary
              action uses; the variant carries the pill, --sh-1, active-flatten,
              focus outline and coarse-pointer floor as one contract. Only the
              prototype's 700 weight is added on top, as on Home. */}
          <Button
            size="lg"
            onClick={() => navigate("/shift-requests")}
            data-testid="rules-continue"
            className="font-bold"
          >
            Continue <FaArrowRight />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3.5">
        {/* A summary island resting directly on the page plane, so it is L1
            (--surface + a hairline + --sh-1) rather than a well — DESIGN.md §4
            puts wells INSIDE an L1 card. Geometry is the 12px control role: an
            inner bordered box, larger than a chip and smaller than a card. */}
        <div
          className={cn(
            "inline-flex items-baseline gap-2 px-3.5 py-2.5",
            surfaceVariants({ role: "surface", geometry: "control" }),
          )}
        >
          <span className="font-heading text-title font-semibold tracking-[-0.015em]">
            {onCount}
          </span>
          <span className="font-mono text-label font-semibold tracking-[0.03em] text-ink3">
            OF {total} RULES ON
          </span>
        </div>
        <div className="flex min-w-[180px] flex-1 items-center gap-2 text-meta text-ink2">
          <FaCircleInfo className="shrink-0 text-ink3" />
          <span>
            Rules with numbers show an <b>Adjust</b> button, and any rule can be renamed. Tap a
            rule&rsquo;s <b>↳ constraint</b> link to edit the exact record in Advanced.
          </span>
        </div>
      </div>

      {advTotal > 0 && (
        // An inset note strip, which DESIGN.md §4 puts on the `well` level rather
        // than giving it a card's hairline-and-drop-shadow box (the same call R4's
        // shared info strip makes).
        <Surface
          level="well"
          geometry="control"
          className="flex flex-wrap items-center gap-3 px-3.5 py-3"
        >
          <FaSliders className="text-ink2" />
          <div className="min-w-[200px] flex-1 text-meta text-ink2">
            Every rule below comes from a record you can open in Advanced — {advBreakdown}. Advanced
            shows each one in full detail.
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openAdvanced("/shift-type-requirements")}
            data-testid="rules-open-advanced-banner"
          >
            Open Advanced <FaArrowRight />
          </Button>
        </Surface>
      )}

      <div className="flex flex-col gap-5">
        {groups.map((group) => {
          const Icon = categoryIcon(group.category);
          return (
            <div key={group.category}>
              <div className="mb-3 flex items-center gap-2.5">
                {/* A small bordered tile inside the heading row is a chip, not a
                    data surface — square is reserved for tables, grid cells and
                    full-bleed bars (DESIGN.md §5). */}
                <div className="flex size-[30px] items-center justify-center rounded-chip border border-line2 bg-panel text-ink2">
                  <Icon className="size-3.5" />
                </div>
                <div className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
                  {group.category}
                </div>
                <div className="h-px flex-1 bg-line2" />
              </div>
              {/* Each category is one resting L1 card. `overflow-hidden` is what
                  lets the rows, their hairline dividers and an open adjustment
                  band all stay square while still being clipped to the card's
                  16px corners (DESIGN.md §4 rules 2-3). */}
              <ul
                className={cn(
                  "overflow-hidden",
                  surfaceVariants({ role: "surface", geometry: "card" }),
                )}
                data-testid={`rule-category-${group.category}`}
              >
                {group.rows.map((row) => (
                  <RuleRow
                    key={row.id}
                    row={row}
                    adjustOpen={openAdjustId === row.id}
                    onToggleAdjust={() => setOpenAdjustId((id) => (id === row.id ? null : row.id))}
                    renaming={renamingId === row.id}
                    renameDraft={renameDraft}
                    onRenameStart={() => startRename(row)}
                    onRenameDraftChange={setRenameDraft}
                    onRenameCancel={closeRename}
                    onRenameSubmit={() => submitRename(row)}
                    onToggleEnabled={(enabled) => {
                      if (row.kind && row.constraintId) toggle(row.kind, row.constraintId, enabled);
                    }}
                    onOpenAdvanced={() => {
                      if (row.advancedRoute) openAdvanced(row.advancedRoute);
                    }}
                    onAdjustField={(key, value) => {
                      if (!row.kind || !row.constraintId) return undefined;
                      const outcome = adjust(row.kind, row.constraintId, key, value);
                      return outcome.kind === "invalid-value" ? outcome.message : undefined;
                    }}
                  />
                ))}
              </ul>
            </div>
          );
        })}
        {!hasRecords && (
          // Dashed stays the zero-data affordance, so this keeps a hand-authored
          // border rather than the `surface` role's solid hairline (the same call
          // R4's card-editor empty state makes). Radius follows the card role.
          <div
            className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line bg-surface px-10 py-12 text-center"
            data-testid="rules-empty-state"
          >
            <div className="font-heading text-title font-semibold tracking-[-0.015em] text-ink2">
              No ward rules yet, beyond the built-in one
            </div>
            <p className="max-w-[44ch] text-meta text-ink3">
              Add a constraint in Advanced and it shows up here automatically — there is nothing to
              set up.
            </p>
          </div>
        )}
      </div>
    </Surface>
  );
}
