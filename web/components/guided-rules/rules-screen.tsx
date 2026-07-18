"use client";

// The Guided Rules screen (T14c) — a direct, real /rules route faithful to
// docs/design_prototype/ScreenRules.dc.html. Every row is derived from
// `cardsByKind` through the T14b mapper registry; a `GuidedRulePin` is an
// optional shortcut overlay. Navigation exposure (sidebar/Home/crumbs, global
// mode switching) is explicitly T08d's job — this screen is complete and
// directly routable on its own.

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  FaArrowRight,
  FaCalculator,
  FaLock,
  FaPeopleArrows,
  FaSliders,
  FaThumbtack,
  FaTriangleExclamation,
  FaUserNurse,
  FaUserShield,
} from "@/components/icons";
import type { IconType } from "@/components/icons";
import { useGuardedNavigation } from "@/components/shell/use-guarded-navigation";
import { useCardEditorDraftGuard } from "@/components/card-editor/card-editor-shell";
import { useGuidedRules } from "./use-guided-rules";
import { RuleRow } from "./rule-row";
import { PinForm, type PinFormSubmission } from "./pin-form";
import type { GuidedRuleRow } from "./types";

const CATEGORY_ICONS: Record<string, IconType> = {
  Staffing: FaUserNurse,
  Sequencing: FaArrowRight,
  Hours: FaCalculator,
  Pairing: FaPeopleArrows,
  Supervision: FaUserShield,
  Structural: FaLock,
  "Custom shortcuts": FaThumbtack,
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
  const { state, projection, pinnableRecords, toggle, adjust, submitPin, unpin, cleanupStalePins } =
    useGuidedRules();

  const [admin, setAdmin] = React.useState(false);
  const [formMode, setFormMode] = React.useState<"none" | "add" | "edit">("none");
  const [editingPinId, setEditingPinId] = React.useState<string | null>(null);
  const [openAdjustId, setOpenAdjustId] = React.useState<string | null>(null);

  useCardEditorDraftGuard("guided-rules", formMode !== "none");

  const openAdvanced = React.useCallback(
    (route: string) => {
      if (onOpenAdvanced) onOpenAdvanced(route);
      else navigate(route);
    },
    [onOpenAdvanced, navigate],
  );

  const groups = groupByCategory(projection.rows);
  const hasRecords = projection.rows.some((r) => r.source === "record");
  const onCount = projection.rows.filter((r) => r.enabled).length;
  const total = projection.rows.length;

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

  const editingPin =
    editingPinId !== null ? projection.rows.find((r) => r.pin?.id === editingPinId) : undefined;

  function handlePinSubmit(submission: PinFormSubmission) {
    submitPin(
      submission.constraintKind,
      submission.constraintId,
      submission.title,
      {
        category: submission.category,
        description: submission.description || undefined,
        quickFields: submission.quickFields,
      },
      formMode === "edit" && editingPinId ? editingPinId : undefined,
    );
    setFormMode("none");
    setEditingPinId(null);
  }

  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-5 py-8"
      data-testid="screen"
      data-screen="rules"
    >
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          <div className="mb-2 text-label font-semibold uppercase tracking-[0.03em] text-brandink">
            Step 4 · Rules
          </div>
          <h1 className="mb-2 font-heading text-display font-extrabold leading-[1.05] tracking-[-0.02em]">
            Choose the Rules
          </h1>
          <p className="m-0 max-w-[68ch] text-ink2">
            Rules is a friendly, pinned view of the ward&rsquo;s constraints — the same library you
            edit under Advanced. A <b>linked</b> rule reads and writes the exact constraint record
            it belongs to; a <b>built-in</b> rule is a structural rule the engine always enforces.
            Pin any Advanced constraint as a quick-access rule with <b>Customise library</b>.
          </p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Button
            variant={admin ? "secondary" : "outline"}
            size="lg"
            onClick={() => setAdmin((v) => !v)}
            data-testid="rules-admin-toggle"
          >
            <FaThumbtack className="size-3" /> {admin ? "Done customising" : "Customise library"}
          </Button>
          <Button
            size="lg"
            onClick={() => navigate("/shift-requests")}
            data-testid="rules-continue"
          >
            Continue <FaArrowRight className="size-3" />
          </Button>
        </div>
      </div>

      {projection.stalePinIds.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-3 border border-warn bg-warntint px-3.5 py-3"
          data-testid="rules-stale-pin-notice"
        >
          <FaTriangleExclamation className="text-warn" />
          <div className="min-w-[200px] flex-1 text-meta text-ink2">
            <b>
              {projection.stalePinIds.length} pinned shortcut
              {projection.stalePinIds.length === 1 ? "" : "s"}
            </b>{" "}
            no longer {projection.stalePinIds.length === 1 ? "points" : "point"} to a live
            constraint. The underlying rules are unaffected — only the shortcut metadata is stale.
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => cleanupStalePins(projection.stalePinIds)}
            data-testid="rules-cleanup-stale-pins"
          >
            Remove stale pins
          </Button>
        </div>
      )}

      {admin && formMode === "none" && (
        <div className="flex flex-wrap items-center gap-2.5 border border-brand bg-brandtint px-3.5 py-3">
          <FaThumbtack className="text-brandink" />
          <div className="min-w-[180px] flex-1 text-meta text-ink2">
            <b>Pin a constraint.</b> Surface any Advanced constraint as a quick-access rule and pick
            which fields become inline edits. Unpinning only removes the shortcut.
          </div>
          <Button
            size="sm"
            onClick={() => {
              setFormMode("add");
              setEditingPinId(null);
            }}
            data-testid="rules-new-pin"
          >
            <FaThumbtack className="size-2.5" /> Pin a constraint
          </Button>
        </div>
      )}

      {formMode !== "none" && (
        <PinForm
          records={pinnableRecords}
          initial={
            formMode === "edit" && editingPin
              ? { pin: editingPin.pin!, title: editingPin.title }
              : undefined
          }
          onCancel={() => {
            setFormMode("none");
            setEditingPinId(null);
          }}
          onSubmit={handlePinSubmit}
        />
      )}

      <div className="flex flex-wrap items-center gap-3.5">
        <div className="inline-flex items-baseline gap-2 border border-line bg-surface px-3.5 py-2.5">
          <span className="font-heading text-title font-extrabold">{onCount}</span>
          <span className="font-mono text-label text-ink3">OF {total} RULES ON</span>
        </div>
        <div className="min-w-[180px] flex-1 text-meta text-ink2">
          Rules with numbers show an <b>Adjust</b> button. Use <b>Customise library</b> to pin your
          own quick-access rules.
        </div>
      </div>

      {!admin && advTotal > 0 && (
        <div className="flex flex-wrap items-center gap-3 border border-line bg-panel px-3.5 py-3">
          <FaSliders className="text-ink2" />
          <div className="min-w-[200px] flex-1 text-meta text-ink2">
            <b>{advTotal} advanced constraint records</b> back these rules — {advBreakdown}.
            Advanced shows every one, including variants not surfaced here.
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openAdvanced("/shift-type-requirements")}
            data-testid="rules-open-advanced-banner"
          >
            Open Advanced <FaArrowRight className="size-2.5" />
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-5">
        {groups.map((group) => {
          const Icon = categoryIcon(group.category);
          return (
            <div key={group.category}>
              <div className="mb-3 flex items-center gap-2.5">
                <div className="flex size-[30px] items-center justify-center border border-line2 bg-panel text-ink2">
                  <Icon className="size-3.5" />
                </div>
                <div className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
                  {group.category}
                </div>
                <div className="h-px flex-1 bg-line2" />
              </div>
              <ul
                className="border border-line bg-surface"
                data-testid={`rule-category-${group.category}`}
              >
                {group.rows.map((row) => (
                  <RuleRow
                    key={row.id}
                    row={row}
                    admin={admin}
                    adjustOpen={openAdjustId === row.id}
                    onToggleAdjust={() => setOpenAdjustId((id) => (id === row.id ? null : row.id))}
                    onToggleEnabled={(enabled) => {
                      if (row.kind && row.constraintId) toggle(row.kind, row.constraintId, enabled);
                    }}
                    onOpenAdvanced={() => {
                      if (row.advancedRoute) openAdvanced(row.advancedRoute);
                    }}
                    onEditShortcut={() => {
                      if (row.pin) {
                        setEditingPinId(row.pin.id);
                        setFormMode("edit");
                      }
                    }}
                    onUnpin={() => {
                      if (row.pin) unpin(row.pin.id);
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
          <div
            className="flex flex-col items-center gap-3 border-[1.5px] border-dashed border-line px-10 py-12 text-center"
            data-testid="rules-empty-state"
          >
            <div className="font-heading text-title font-bold text-ink2">
              No advanced constraints yet
            </div>
            <p className="max-w-[44ch] text-meta text-ink3">
              Add a constraint in Advanced, then pin it here for quick access.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
