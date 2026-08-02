"use client";

// Bespoke Shifts card-grid (DR-3) — replaces the generic `EntityEditor` for the
// /shift-types route. It follows docs/design_prototype/source/ScreenShifts.dc.html: a
// 3-column card grid where each shift renders as a read card (icon tile, big code,
// name subtitle, clock time + duration badge), the reserved OFF/LEAVE day-states
// render locked (AUTO, never a raw disabled control), and Edit expands the card
// in-place into a Code / Name / Time-on-floor / Rest / Working(auto) draft. It
// consumes the shared pure `entity-editor/core/*` mutations directly and the shared
// `working-time-fields.tsx` + `core/working-time.ts` for the 30-min-grid time
// picker and the derived working-hours readout, and the shared `GroupsSection`
// (Shift config) for the Shift groups block.
//
// TERMINOLOGY: user-facing copy uses the "Shifts"/"shift" voice (the nav label
// override). Routes (/shift-types), data keys (`shifts`), and `data-*` testids are
// unchanged. Cross-references to the staff screen say "Staff".
//
// Store discipline (T04): every user action feeds ONE composed `ScenarioUiState`
// to one `mutateScenario` call (one patch ⇒ one zundo entry). Rename/delete route
// through the core cascade so requirement `shiftType` refs follow a rename and empty
// requirements drop on delete. A `RenameCollisionError` surfaces as a field error.
//
// DR-4 staffing tie-in: Min./Preferred resolve from active requirement coverage.
// A direct all-scope baseline is editable, uncovered shifts may create one, and
// group/qualified/date/multi-target coverage is read-only with a deep-link. The
// Save path commits shift fields + the validated requirement patch in one
// live-state updater, with rename-first ordering and a form-open identity guard.
//
// R2c (v2 "Mint Canvas, Warm Ink"): every surface on this route goes through the
// shared `surfaceVariants` recipe rather than restating tone/border/elevation —
// the screen root is the L0 page plane, each shift and reserved tile is a resting
// L1 card at `--r-card`, the open editor is the ladder's `selected` role, the icon
// tiles and the read-only staffing boxes are inset `well`s, and the drop candidate
// is the shared `drop-target` role instead of a hand-authored inset shadow.
// Actions use the shared Button variants (including `destructive-outline`) so the
// pill, `--sh-1`, active-flatten, focus outline and 44px coarse floor come from
// one contract. Domain behaviour, ordering, reserved OFF/LEAVE semantics, the
// staffing tie-in and every `data-testid` are untouched.

import * as React from "react";
import { toast } from "sonner";
import { useScenarioStore } from "@/lib/store";
import { useLosableDraft } from "@/components/shell/use-losable-draft";
import type { ScenarioUiState, UiShiftType } from "@/lib/scenario";
import { RenameCollisionError } from "@/lib/cascade";
import { GuardedLink } from "@/components/shell/guarded-link";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Surface, surfaceVariants } from "@/components/ui/surface";
import {
  FaPlus,
  FaArrowRight,
  FaPen,
  FaTrash,
  FaCheck,
  FaLock,
  FaGripVertical,
  FaChevronUp,
  FaChevronDown,
  FaClock,
  FaPowerOff,
  FaMugHot,
  FaCircleExclamation,
  FaLayerGroup,
  FaUserShield,
  type IconType,
} from "@/components/icons";
import {
  deleteItem,
  reorderItems,
  validateFullEditId,
  validateWorkingTimeDraft,
  entityKey,
  type EditorGroup,
  type WorkingTimeValue,
} from "@/components/entity-editor/core";
import { WorkingTimeFields } from "@/components/entity-editor/working-time-fields";
import { GroupsSection, type GroupsSectionConfig } from "@/components/entity-editor/groups-section";
import { InfoTip } from "@/components/ui/info-tip";
import type { RequirementNumberValue } from "@/components/requirements/requirements-model";
import { shiftTypesDescriptor } from "./shift-types-descriptor";
import {
  resolveStaffingCardState,
  saveShiftTypeCard,
  ShiftRequirementValidationError,
  StaleShiftRequirementError,
  type StaffingCardState,
} from "./save-shift-card";

type Commit = (next: ScenarioUiState) => void;
type CurrentState = () => ScenarioUiState;

// ---------------------------------------------------------------------------
// Shift-groups config for the shared GroupsSection ("Shifts" copy — no member
// search, "IN GROUP" pane, "N TYPES" count, shift auto-group note).
// ---------------------------------------------------------------------------

const SHIFT_GROUPS_CONFIG: GroupsSectionConfig = {
  heading: "Shift groups",
  // Verbatim from the canonical screen (ScreenShifts.dc.html:159).
  description: "Bundle shifts so rules can target them together — e.g. “count all working shifts”.",
  addLabel: "Group",
  // Canonical empty state, verbatim from ScreenShifts.dc.html:185-188. Shifts
  // authors ALL first and the prompt after it, which is the default placement.
  emptyTitle: "No custom shift groups yet",
  emptyText:
    "Bundle shift types — like “Working” or “Night” — so a rule can count or target them together.",
  emptyActionLabel: "New group",
  showMemberSearch: false,
  selectedPaneLabel: "IN GROUP",
  selectedTestKey: "in-group",
  availableEmpty: "All shift types added.",
  selectedEmpty: "Empty — pick from the left.",
  formatCount: (count) => `${count} TYPE${count === 1 ? "" : "S"}`,
  autoGroupNote:
    "Every worked shift type — rules can target them all at once. Updates automatically as you " +
    "add or remove shifts. Off and Paid leave are excluded.",
};

// ---------------------------------------------------------------------------
// Working-time helpers (small local copies — the reusable derivation itself lives
// in core/working-time.ts and working-time-fields.tsx, which this screen reuses).
// ---------------------------------------------------------------------------

type WorkingTimeItem = Pick<
  UiShiftType,
  "startTime" | "endTime" | "restMinutes" | "durationMinutes"
>;

/** Pull the working-time fields off a shift item into the sub-form's value shape. */
function pickWorkingTime(item: WorkingTimeItem): WorkingTimeValue {
  return {
    startTime: item.startTime,
    endTime: item.endTime,
    restMinutes: item.restMinutes,
    durationMinutes: item.durationMinutes,
  };
}

/** Format working minutes as the design's "8h" / "8h 30m" readout. */
function fmtHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// The compound card edit draft: shift fields plus inline staffing values.
// ---------------------------------------------------------------------------

interface ShiftDraft {
  /** The shift code — the item id. */
  code: string;
  /** The shift name — the item description. */
  name: string;
  /** The time-on-floor / rest / derived working-time sub-form value. */
  workingTime: WorkingTimeValue;
  /** Inline staffing minimum. Blank means "do not create" only when no baseline exists. */
  required: RequirementNumberValue;
  /** Optional soft target. Equal/blank collapses to the domain's forced no-preferred shape. */
  preferred: RequirementNumberValue;
}

// ---------------------------------------------------------------------------
// Top-level grid
// ---------------------------------------------------------------------------

/** The single active selection across the whole screen (one editor at a time). */
type Sel =
  | null
  | { t: "add-shift" }
  | { t: "edit-shift"; key: string }
  | { t: "add-group" }
  | { t: "edit-group"; id: string };

export function ShiftTypeGrid() {
  const descriptor = shiftTypesDescriptor;
  const scenario = useScenarioStore((state) => state as ScenarioUiState);
  const items = descriptor.readItems(scenario);
  const groups = descriptor.readGroups(scenario);
  const commit = React.useCallback<Commit>((next) => {
    useScenarioStore.getState().mutateScenario(next);
  }, []);
  const currentState = React.useCallback<CurrentState>(
    () => useScenarioStore.getState() as ScenarioUiState,
    [],
  );

  const [sel, setSel] = React.useState<Sel>(null);
  const editing = sel !== null;

  // Register the open add/edit form as a losable draft (T08a / FR-PR-06).
  useLosableDraft("shift-type-grid", editing, "Shifts editor");

  // Staleness detection for an open form — mirrors EntityEditor exactly. On the
  // open⇄close transition we capture the item+group slice the form was formed
  // against ("form-open token"); `isStale` re-reads the live store and reports
  // whether that relevant slice changed (undo/redo temporal travel or a cascade
  // from elsewhere). It gates BOTH the visible-close effect and every submit path.
  const openToken = React.useRef<{ items: UiShiftType[]; groups: EditorGroup[] } | null>(null);
  const wasEditing = React.useRef(false);
  if (editing !== wasEditing.current) {
    wasEditing.current = editing;
    openToken.current = editing ? { items, groups } : null;
  }
  const isStale = React.useCallback(() => {
    const token = openToken.current;
    if (token === null) return false;
    const live = useScenarioStore.getState() as ScenarioUiState;
    return (
      descriptor.readItems(live) !== token.items || descriptor.readGroups(live) !== token.groups
    );
  }, [descriptor]);
  React.useEffect(() => {
    if (editing && isStale()) setSel(null);
  });

  // Native drag-reorder of real cards. Identity is the source INDEX; dragging is
  // gated off while any editor is open (`canDrag`), and reserved cards are never
  // draggable (rendered outside this list).
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);
  const [overIndex, setOverIndex] = React.useState<number | null>(null);
  const canDrag = !editing;

  const onDrop = (to: number) => {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from != null && from !== to) {
      commit(reorderItems(currentState(), descriptor, from, to));
    }
  };

  // Keyboard-accessible reorder (drag alone has no keyboard path). One move ⇒ one
  // `reorderItems` commit ⇒ one undo entry, exactly like a drop.
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    commit(reorderItems(currentState(), descriptor, from, to));
  };

  return (
    // L0 app plane. Everything on this screen sits on it and nothing floats free
    // (DESIGN.md §4): the card grid, the reserved tiles and the F2 groups card are
    // all L1 boxes on this tone rather than a run of hairline outlines on nothing.
    <Surface
      level="page"
      geometry="square"
      data-testid="screen"
      data-screen={descriptor.labels.itemPlural}
      className="flex flex-col gap-5"
    >
      <header className="flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          {/* The setup wizard's step eyebrow, matching Dates (Step 1) and Staff
              (Step 2). ScreenShifts.dc.html opens on the same STEP 3 · SHIFTS mark;
              without it this route was the one hole in the chain. */}
          <div className="mb-2 text-label font-semibold uppercase tracking-[0.03em] text-brandink">
            Step 3 · Shifts
          </div>
          {/* Display: Figtree 700 / 1.15 / -0.015em (DESIGN.md §3). v1 ran this page
              heading at the TITLE step with `tracking-tight`, two steps down from the
              display face every other setup route uses. */}
          <h1 className="mb-2 font-heading text-display font-bold leading-[1.15] tracking-[-0.015em]">
            Define the Shifts
          </h1>
          <p className="max-w-[60ch] text-ink2">
            Set up the daily shifts your ward runs, their working time, and how you group them. Off
            and Paid leave are reserved day-states handled for you.
          </p>
        </div>
        {/* The prototype's `toRules` action (ScreenShifts.dc.html:11-18), closing
            the Dates → Staff → Shifts → Rules setup path. User-approved as a
            product decision after the cold review; R2c's first pass deliberately
            left it out rather than inventing it.

            It uses the app's EXISTING navigation contract verbatim — the same
            `GuardedLink` the Dates and Staff CTAs use. That matters: a plain
            `<Link>` pushes straight through the router and would silently discard
            an open shift draft, while `GuardedLink` routes an unmodified primary
            click through `useGuardedNavigation().navigate`, which stages the
            shell's single confirm dialog whenever a losable draft is registered.
            This grid ALREADY registers one for the whole time an editor is open
            (`useLosableDraft("shift-type-grid", editing, …)` above), so the
            ratified draft guard arms itself here with no second lifecycle, no new
            state and no local interception. Modified clicks, middle-click and
            open-in-new-tab keep native anchor behaviour. */}
        <GuardedLink
          href="/rules"
          className={cn(buttonVariants({ size: "lg" }), "font-bold")}
          data-testid="shift-types-continue"
        >
          Continue to rules <FaArrowRight />
        </GuardedLink>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => setSel((cur) => (cur?.t === "add-shift" ? null : { t: "add-shift" }))}
          aria-pressed={sel?.t === "add-shift"}
          data-testid="add-shift-toggle"
        >
          <FaPlus />
          Add shift
        </Button>
      </div>

      <section
        // `.ns-grid3` — two-up at 640px, three-up at 1100px (Nurse Scheduling.dc.html:
        // 80-82). `sm` already IS the 640px step; `grid3:` carries the 1100px one.
        // Tailwind's `lg` (1024px) used to stand in for it, turning three-up 76px early
        // and squeezing each card to ~220px at spacious, pushing controls past the edge.
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 grid3:grid-cols-3"
        data-testid="shift-grid"
        // Bounded a11y quick win: an unnamed <section> is not exposed as a
        // region, so the whole card grid was unreachable by landmark navigation
        // and indistinguishable from the Shift groups card below it.
        aria-label="Shift types"
      >
        {sel?.t === "add-shift" && (
          <ShiftCardEditor
            mode="add"
            items={items}
            groups={groups}
            currentState={currentState}
            isStale={isStale}
            onDone={() => setSel(null)}
          />
        )}

        {items.map((item, index) => {
          const key = entityKey(item.id);
          const isEditing = sel?.t === "edit-shift" && sel.key === key;
          if (isEditing) {
            return (
              <ShiftCardEditor
                key={key}
                mode="edit"
                item={item}
                items={items}
                groups={groups}
                currentState={currentState}
                isStale={isStale}
                onDone={() => setSel(null)}
              />
            );
          }
          return (
            <ShiftCard
              key={key}
              cardKey={key}
              item={item}
              scenario={scenario}
              canDrag={canDrag}
              canReorder={canDrag && items.length > 1}
              isFirst={index === 0}
              isLast={index === items.length - 1}
              isOver={overIndex === index}
              isDragging={dragIndex === index}
              onMoveUp={() => move(index, index - 1)}
              onMoveDown={() => move(index, index + 1)}
              onEdit={() => setSel({ t: "edit-shift", key })}
              onDelete={() => {
                setSel(null);
                commit(deleteItem(currentState(), descriptor, item.id));
              }}
              onDragStart={() => setDragIndex(index)}
              onDragOver={() => setOverIndex(index)}
              onDropRow={() => onDrop(index)}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
            />
          );
        })}

        {descriptor.syntheticItems.map((row) => (
          <ReservedCard key={row.id} id={row.id} description={row.description} />
        ))}
      </section>

      <GroupsSection
        descriptor={descriptor}
        items={items}
        groups={groups}
        commit={commit}
        currentState={currentState}
        isStale={isStale}
        editing={editing}
        addOpen={sel?.t === "add-group"}
        editingGroupId={sel?.t === "edit-group" ? sel.id : null}
        onToggleAdd={() => setSel((cur) => (cur?.t === "add-group" ? null : { t: "add-group" }))}
        onEditGroup={(id) => setSel({ t: "edit-group", id })}
        onCloseForm={() => setSel(null)}
        config={SHIFT_GROUPS_CONFIG}
      />
    </Surface>
  );
}

// ---------------------------------------------------------------------------
// Reserved OFF/LEAVE card — locked (AUTO), with a lock + plain-language reason.
// Never a raw disabled control.
// ---------------------------------------------------------------------------

/**
 * A reserved day-state tile. The prototype draws it on the SAME `--surface`
 * plane as an authorable card but with the quieter `--line2` hairline and NO
 * elevation, which is what makes it read as inert beside siblings carrying
 * `--line` + `--sh-1`. Radius stays DESIGN.md §5's card value: the prototype
 * renders 12px here only because its attribute-substring compatibility CSS keys
 * off the `--line2` border, and §6 forbids porting those selectors.
 *
 * This one surface stays off `surfaceVariants` DELIBERATELY, and the cold review
 * of `57ce7b6` adjudicated that explicitly: no role emits `--surface` + a
 * `--line2` hairline + no elevation. `surface` fixes `--line` and `--sh-1`, and
 * `well` + `hairline` changes both the tone and the direction of light. Adding a
 * foundation role for a single justified composition is not warranted.
 */
const RESERVED_CARD_SURFACE = "rounded-card border border-line2 bg-surface";

/**
 * The icon tile and the working-time readout are the SAME visual contract:
 * `--panel` behind a `--line2` hairline at the control radius, with the inset
 * cast. F2's `ii7.8.5` added the `emphasis` axis, so the shared recipe now emits
 * exactly that — this is the public authority (technical plan T5), not a local
 * reimplementation with canonical tokens.
 *
 * DESIGN.md §5 files "inner bordered boxes" under `--r-ctl`, which is what both
 * of these are.
 */
const INSET_HAIRLINE_BOX = surfaceVariants({
  role: "well",
  geometry: "control",
  emphasis: "hairline",
});

/**
 * The tile's box is the prototype's 42px, which has no token and cannot be a
 * `size-[42px]` utility beside the recipe: a recipe consumer's className is held
 * to layout utilities with VALIDATED values, and every arbitrary value is
 * rejected. `size-control-lg` would be 44px and `size-11.6667` is not a size
 * anyone should read. So the one dimension that has no token is set as a style,
 * the same mechanism `Select` uses for its caret gutter — and, unlike a class, it
 * cannot be defeated by a caller.
 */
const ICON_TILE_BOX = { width: 42, height: 42 } as const;

const RESERVED_META: Record<string, { icon: IconType; reason: string }> = {
  OFF: {
    icon: FaPowerOff,
    reason: "Rest / no assignment. Generated automatically — no staffing.",
  },
  LEAVE: {
    icon: FaMugHot,
    reason:
      "Paid leave · credits toward contracted hours. Never fills coverage — pin it per nurse " +
      "on the Requests & Leave screen.",
  },
};

function ReservedCard({ id, description }: { id: string; description?: string }) {
  const meta = RESERVED_META[id];
  const Icon = meta?.icon ?? FaLock;
  const reason = meta?.reason ?? description;
  return (
    // Quiet L1: the surface plane on a `--line2` hairline with NO elevation, so a
    // reserved day-state is visibly inert beside the authorable cards around it.
    // The AUTO badge, the padlock and the absent action row say the same thing in
    // text; the tone difference is what says it at a glance.
    <div
      data-testid={`synthetic-${id}`}
      className={cn("flex flex-col gap-3 p-5", RESERVED_CARD_SURFACE)}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div
            data-slot="shift-tile"
            style={ICON_TILE_BOX}
            className={cn("flex flex-none items-center justify-center", INSET_HAIRLINE_BOX)}
          >
            <Icon aria-hidden className="text-ink2" />
          </div>
          <div className="min-w-0">
            <div className="font-heading text-title font-bold leading-none tracking-[-0.015em]">
              {id}
            </div>
          </div>
        </div>
        <Badge variant="neutral">
          <FaLock aria-hidden />
          Auto
        </Badge>
      </div>
      {reason && (
        <p
          className="border-t border-line2 pt-3 text-meta text-ink3"
          data-testid={`synthetic-${id}-reason`}
        >
          {reason}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read card (not editing)
// ---------------------------------------------------------------------------

function ShiftCard({
  cardKey,
  item,
  scenario,
  canDrag,
  canReorder,
  isFirst,
  isLast,
  isOver,
  isDragging,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
  onDragStart,
  onDragOver,
  onDropRow,
  onDragEnd,
}: {
  cardKey: string;
  item: UiShiftType;
  scenario: ScenarioUiState;
  canDrag: boolean;
  canReorder: boolean;
  isFirst: boolean;
  isLast: boolean;
  isOver: boolean;
  isDragging: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDropRow: () => void;
  onDragEnd: () => void;
}) {
  const time = item.startTime && item.endTime ? `${item.startTime}–${item.endTime}` : null;
  const hasDur = item.durationMinutes != null;

  return (
    <div
      data-testid={`shift-card-${cardKey}`}
      draggable={canDrag}
      onDragStart={canDrag ? onDragStart : undefined}
      onDragOver={
        canDrag
          ? (e) => {
              e.preventDefault();
              onDragOver();
            }
          : undefined
      }
      onDrop={
        canDrag
          ? (e) => {
              e.preventDefault();
              onDropRow();
            }
          : undefined
      }
      onDragEnd={canDrag ? onDragEnd : undefined}
      // Resting L1 card; the drop candidate swaps to the shared `drop-target`
      // role (a dashed `--brand` edge over `--panel-alt`) rather than the v1
      // hand-authored `inset 0 2px 0` shadow, which the static provenance gate
      // rejects as an arbitrary elevation. Unlike R2b's <tr>, a card is a real
      // box, so the role's `--sh-2` genuinely paints here.
      className={cn(
        "flex flex-col gap-3 p-5",
        surfaceVariants({
          role: isOver ? "drop-target" : "surface",
          geometry: "card",
          interaction: isDragging ? "dragging" : canDrag ? "grabbable" : undefined,
        }),
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div
            data-slot="shift-tile"
            style={ICON_TILE_BOX}
            className={cn("flex flex-none items-center justify-center", INSET_HAIRLINE_BOX)}
          >
            <FaClock aria-hidden className="text-ink2" />
          </div>
          <div className="min-w-0">
            <div
              data-testid={`shift-code-${cardKey}`}
              className="font-heading text-title font-bold uppercase leading-none tracking-[-0.015em]"
            >
              {String(item.id)}
            </div>
            {item.description && (
              <div className="mt-1 truncate text-meta text-ink2">{item.description}</div>
            )}
          </div>
        </div>
        {canDrag && <FaGripVertical aria-hidden className="mt-1 size-3 flex-none text-ink3" />}
      </div>

      <div
        className="flex items-center gap-2 border-t border-line2 pt-3"
        data-testid={`shift-time-${cardKey}`}
      >
        <FaClock aria-hidden className="size-3 text-ink3" />
        <span className="font-mono text-meta text-ink2">{time ?? "No set time"}</span>
        {hasDur && (
          // The prototype's bordered duration pill, now the shared Badge on the
          // v2 chip radius. `casing="normal"` because "8h 30m" is authored data,
          // not a status eyebrow.
          <Badge
            variant="outline"
            casing="normal"
            className="font-mono"
            data-testid={`shift-dur-${cardKey}`}
          >
            {fmtHours(item.durationMinutes!)}
          </Badge>
        )}
      </div>

      <StaffingSummary state={scenario} item={item} />

      <div className="mt-auto flex items-center gap-2 border-t border-line2 pt-3">
        {canReorder && (
          <>
            <Button
              size="icon"
              variant="outline"
              aria-label={`Move ${String(item.id)} up`}
              data-testid={`shift-move-up-${cardKey}`}
              disabled={isFirst}
              onClick={onMoveUp}
            >
              <FaChevronUp />
            </Button>
            <Button
              size="icon"
              variant="outline"
              aria-label={`Move ${String(item.id)} down`}
              data-testid={`shift-move-down-${cardKey}`}
              disabled={isLast}
              onClick={onMoveDown}
            >
              <FaChevronDown />
            </Button>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* `secondary`, not `outline`: the prototype's card actions sit on the
              `--line` hairline, and `outline` is the heavier `--rule` edge.
              Measured against ScreenShifts.dc.html — same tone, same elevation.

              Bounded a11y quick win: the visible label is the same word on every
              card, so an accessible name that names the shift is what makes the
              action list navigable. The visible text stays a substring of the
              accessible name (WCAG 2.5.3 Label in Name). */}
          <Button
            variant="secondary"
            aria-label={`Edit ${String(item.id)}`}
            data-testid={`shift-edit-${cardKey}`}
            onClick={onEdit}
          >
            <FaPen />
            Edit
          </Button>
          {/* The shared destructive OUTLINE variant, not an `outline` button
              with its colours hand-overridden at the call site. */}
          <Button
            variant="destructive-outline"
            aria-label={`Delete ${String(item.id)}`}
            data-testid={`shift-delete-${cardKey}`}
            onClick={onDelete}
          >
            <FaTrash />
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

const REQUIREMENTS_HREF = "/shift-type-requirements";

function StaffingLink({
  children = "Manage staffing requirements",
  testId,
}: {
  children?: React.ReactNode;
  testId?: string;
}) {
  return (
    <GuardedLink
      href={REQUIREMENTS_HREF}
      data-testid={testId}
      className="text-label font-semibold uppercase tracking-[0.03em] text-brandink hover:underline"
    >
      {children} →
    </GuardedLink>
  );
}

function StaffingValues({
  card,
  testKey,
}: {
  card: { requiredNumPeople: number; preferredNumPeople?: number } | null;
  testKey: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-body text-ink2">Minimum nurses</span>
        <span
          className="font-heading text-title font-bold leading-none tracking-[-0.015em]"
          data-testid={`staffing-min-${testKey}`}
        >
          {card ? card.requiredNumPeople : "—"}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-meta text-ink3">Preferred</span>
        <span className="font-mono text-meta font-semibold text-ink2">
          {card?.preferredNumPeople ?? "—"}
        </span>
      </div>
    </div>
  );
}

function StaffingContextChips({ chips, testKey }: { chips: readonly string[]; testKey: string }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={`staffing-chips-${testKey}`}>
      {chips.map((chip) => (
        <GuardedLink
          key={chip}
          href={REQUIREMENTS_HREF}
          aria-label={`${chip}, manage staffing requirements`}
        >
          <Badge variant={chip.endsWith(" only") ? "brand" : "neutral"}>
            {chip.endsWith(" only") ? <FaUserShield aria-hidden /> : <FaLayerGroup aria-hidden />}
            {chip}
          </Badge>
        </GuardedLink>
      ))}
    </div>
  );
}

function StaffingSummary({ state, item }: { state: ScenarioUiState; item: UiShiftType }) {
  const staffing = resolveStaffingCardState(state, item.id);
  const testKey = entityKey(item.id);
  if (staffing.kind === "none") return null;

  if (staffing.kind === "numeric") {
    return (
      <div
        className="border-t border-line2 pt-3 text-meta text-ink3"
        data-testid={`staffing-numeric-${testKey}`}
      >
        {staffing.explanation}
      </div>
    );
  }

  if (staffing.kind === "readonly") {
    return (
      <div
        className="flex flex-col gap-2.5 border-t border-line2 pt-3"
        data-testid={`staffing-readonly-${testKey}`}
      >
        <StaffingValues card={staffing.primary.card} testKey={testKey} />
        <p className="text-meta font-semibold text-ink2">{staffing.ruleSummary}</p>
        <p className="text-label leading-relaxed text-ink3">{staffing.explanation}</p>
        <StaffingLink testId={`staffing-link-${testKey}`} />
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-2.5 border-t border-line2 pt-3"
      data-testid={`staffing-editable-${testKey}`}
    >
      <StaffingValues card={staffing.baseline} testKey={testKey} />
      {!staffing.baseline && (
        <p className="text-label text-ink3">No staffing requirement has been set.</p>
      )}
      <StaffingContextChips chips={staffing.contextChips} testKey={testKey} />
      {(staffing.baseline || staffing.hasContext) && (
        <StaffingLink testId={`staffing-link-${testKey}`} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expand-in-place edit card (add + edit). Owns the Code/Name/time DRAFT and the
// Save PATH — one compound shift + requirement mutation.
// ---------------------------------------------------------------------------

function numberDraft(value: string): RequirementNumberValue {
  return value === "" ? "" : Number(value);
}

/** Shown inline and on the Enter/Save path when a numbers-only code is entered —
 *  staffing selectors are string-only, so a numeric-only code can't carry one. */
const NUMERIC_CODE_HINT =
  "Shift codes need at least one letter (like AM or N2) so they can carry staffing.";

function StaffingEditor({
  prefix,
  staffing,
  required,
  preferred,
  onRequiredChange,
  onPreferredChange,
}: {
  prefix: string;
  staffing: StaffingCardState;
  required: RequirementNumberValue;
  preferred: RequirementNumberValue;
  onRequiredChange: (value: RequirementNumberValue) => void;
  onPreferredChange: (value: RequirementNumberValue) => void;
}) {
  if (staffing.kind === "none") return null;
  if (staffing.kind === "numeric") {
    return (
      <div
        className={cn("px-3 py-2.5", surfaceVariants({ role: "well", geometry: "control" }))}
        data-testid={`${prefix}-staffing-numeric`}
      >
        <p className="text-meta text-ink3">{staffing.explanation}</p>
      </div>
    );
  }
  if (staffing.kind === "readonly") {
    return (
      <div
        className={cn(
          "flex flex-col gap-2 px-3 py-2.5",
          surfaceVariants({ role: "well", geometry: "control" }),
        )}
        data-testid={`${prefix}-staffing-readonly`}
      >
        <StaffingValues card={staffing.primary.card} testKey={`${prefix}-editor`} />
        <p className="text-meta font-semibold text-ink2">{staffing.ruleSummary}</p>
        <p className="text-label leading-relaxed text-ink3">{staffing.explanation}</p>
        <StaffingLink testId={`${prefix}-staffing-link`} />
      </div>
    );
  }

  const preferredWillCollapse =
    staffing.baseline?.preferredNumPeople !== undefined &&
    (preferred === "" || preferred === required);

  return (
    <div className="flex flex-col gap-3 border-t border-line2 pt-3">
      {/* NOT `.ns-formgrid`. The shift card's editing grid is the card's own inline
          rule — a flat `1fr 1fr` with no media query at all (ScreenShifts.dc.html:46) —
          so `sm` here is our own concession to phones, not a stand-in for a prototype
          breakpoint. Don't "correct" it to `formgrid:`. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <Label htmlFor={`${prefix}-required`}>Min. nurses</Label>
            <InfoTip
              label="Minimum nurses"
              text="This sets the shift's staffing requirement over all dates — the same rule under Staffing Requirements. Editing here updates that one rule."
            />
          </div>
          <Input
            id={`${prefix}-required`}
            data-testid={`${prefix}-required`}
            type="number"
            min={0}
            value={required}
            placeholder="—"
            onChange={(event) => onRequiredChange(numberDraft(event.target.value))}
          />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <Label htmlFor={`${prefix}-preferred`}>Preferred</Label>
            <InfoTip
              label="Preferred nurses"
              text="Ideal number of nurses for this shift when staffing allows — a soft target above the minimum. The generator fills up to preferred if spare nurses are available, but never breaks the minimum to reach it. Leave blank to use the minimum only."
            />
          </div>
          <Input
            id={`${prefix}-preferred`}
            data-testid={`${prefix}-preferred`}
            type="number"
            min={0}
            value={preferred}
            placeholder="—"
            onChange={(event) => onPreferredChange(numberDraft(event.target.value))}
          />
        </div>
      </div>

      {!staffing.baseline && (
        <p className="text-label text-ink3" data-testid={`${prefix}-staffing-create-note`}>
          Creates a rule for all nurses on every date.
        </p>
      )}

      {preferredWillCollapse && (
        // Status pairs its tint with the MATCHING semantic ink and a base-hue
        // border (DESIGN.md §2 Redundant Signal Rule); the copy says what will
        // happen, so colour never carries the state alone.
        <div
          className="rounded-control border border-warn bg-warntint px-3 py-2 text-label font-semibold text-warnink"
          data-testid={`${prefix}-preferred-collapse`}
        >
          Preferred will be cleared and its weight reset from {staffing.baseline?.weight} to -1 when
          you save.
        </div>
      )}

      <StaffingContextChips chips={staffing.contextChips} testKey={`${prefix}-editor`} />
      {staffing.hasContext && <StaffingLink testId={`${prefix}-staffing-link`} />}
    </div>
  );
}

function ShiftCardEditor({
  mode,
  item,
  items,
  groups,
  currentState,
  isStale,
  onDone,
}: {
  mode: "add" | "edit";
  item?: UiShiftType;
  items: UiShiftType[];
  groups: EditorGroup[];
  currentState: CurrentState;
  isStale: () => boolean;
  onDone: () => void;
}) {
  const descriptor = shiftTypesDescriptor;
  const prefix = mode === "add" ? "shift-add" : `shift-edit-${entityKey(item!.id)}`;

  const [staffing] = React.useState<StaffingCardState>(() =>
    mode === "edit"
      ? resolveStaffingCardState(currentState(), item!.id)
      : {
          kind: "editable",
          baseline: null,
          token: { baselineUid: null, baselineCard: null },
          matches: [],
          contextChips: [],
          hasContext: false,
        },
  );
  const [draft, setDraft] = React.useState<ShiftDraft>(() => {
    const baseline = staffing.kind === "editable" ? staffing.baseline : null;
    return {
      code: mode === "edit" ? String(item!.id) : "",
      name: mode === "edit" ? (item!.description ?? "") : "",
      workingTime: mode === "edit" ? pickWorkingTime(item! as WorkingTimeItem) : {},
      required: baseline?.requiredNumPeople ?? "",
      preferred: baseline?.preferredNumPeople ?? "",
    };
  });
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // Only a RAW change to the code text authors a new candidate id — an unrelated
  // edit preserves the original TYPED id verbatim (numeric stays numeric; a bare
  // duration or whitespace id is not silently trimmed/renamed).
  const codeChanged = mode === "add" || draft.code !== String(item!.id);
  const currentId = mode === "edit" ? item!.id : undefined;
  const idCheck = codeChanged
    ? validateFullEditId(descriptor, items, groups, draft.code, false, currentId)
    : ({ ok: true, id: String(item!.id) } as const);
  const wtCheck = validateWorkingTimeDraft(draft.workingTime);
  // A shift code must contain a letter — a numbers-only code can't carry a staffing
  // requirement (selectors are text-only), so forbid a new/changed numeric-only code
  // up front instead of silently degrading the staffing area to read-only.
  const codeNumericOnly = codeChanged && /^\d+$/.test(draft.code.trim());
  const canSave = idCheck.ok && wtCheck.ok && !codeNumericOnly;

  const setCode = (code: string) => {
    setSaveError(null);
    setDraft((d) => ({ ...d, code }));
  };
  const setName = (name: string) => {
    setSaveError(null);
    setDraft((d) => ({ ...d, name }));
  };
  const setWorkingTime = (workingTime: WorkingTimeValue) =>
    setDraft((d) => ({ ...d, workingTime }));
  const setRequired = (required: RequirementNumberValue) => {
    setSaveError(null);
    setDraft((d) => ({ ...d, required }));
  };
  const setPreferred = (preferred: RequirementNumberValue) => {
    setSaveError(null);
    setDraft((d) => ({ ...d, preferred }));
  };

  /** Commit code/name/time + staffing through one live-state updater. */
  const commitShiftDraft = () => {
    if (!idCheck.ok) return;
    const staffingDraft =
      staffing.kind === "editable"
        ? {
            type: "editable" as const,
            token: staffing.token,
            required: draft.required,
            preferred: draft.preferred,
          }
        : ({ type: "none" } as const);
    const result = saveShiftTypeCard(
      (updater) => useScenarioStore.getState().mutateScenario(updater),
      mode === "add"
        ? {
            mode,
            fields: {
              code: idCheck.id,
              name: draft.name,
              workingTime: draft.workingTime,
            },
            staffing: staffingDraft,
          }
        : {
            mode,
            shiftTypeId: item!.id,
            fields: {
              code: codeChanged ? idCheck.id : String(item!.id),
              name: draft.name,
              workingTime: draft.workingTime,
            },
            staffing: staffingDraft,
          },
    );
    const collapseCopy = result.preferredCollapsed
      ? " Preferred was cleared and its weight reset to -1."
      : "";
    toast.success(
      `Shift “${String(result.effectiveId)}” ${mode === "add" ? "added" : "saved"}.${collapseCopy}`,
    );
  };

  const save = () => {
    // Synchronous stale-Save guard: abort if the item/group slice changed since the
    // form opened (temporal travel / external cascade) — no commit, no history entry.
    if (isStale()) {
      setSaveError("This shift changed elsewhere. Reopen it and try again.");
      return;
    }
    if (!idCheck.ok) {
      toast.error(idCheck.message);
      return;
    }
    // Mirror the disabled-Save gate: Enter in the Code/Name inputs also routes here,
    // so a numbers-only code must be blocked on this path too — not only by the button.
    if (codeNumericOnly) {
      toast.error(NUMERIC_CODE_HINT);
      return;
    }
    if (!validateWorkingTimeDraft(draft.workingTime).ok) {
      toast.error("Fix the working-time errors first.");
      return;
    }
    try {
      commitShiftDraft();
      onDone();
    } catch (err) {
      const message =
        err instanceof RenameCollisionError ||
        err instanceof ShiftRequirementValidationError ||
        err instanceof StaleShiftRequirementError
          ? err.message
          : "Save failed.";
      setSaveError(message);
      toast.error(message);
    }
  };

  return (
    // The active editor card is the ladder's `selected` L1: `--surface` with a
    // `--brand` border and `--sh-2`. v1 washed it in `--brandtint`, which
    // DESIGN.md §6 reserves for selection MARKS — and the brand-inked eyebrow and
    // chips inside this very card would sink into it. Same call R2a/R2b recorded.
    <div
      className={cn(
        "flex flex-col gap-4 p-5",
        surfaceVariants({ role: "selected", geometry: "card" }),
      )}
      data-testid={mode === "add" ? "shift-add-form" : `shift-edit-form-${entityKey(item!.id)}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onDone();
        }
      }}
    >
      <div className="flex items-center gap-3 border-b border-line2 pb-4">
        <div
          data-slot="shift-tile"
          style={ICON_TILE_BOX}
          className={cn("flex flex-none items-center justify-center", INSET_HAIRLINE_BOX)}
        >
          <FaClock aria-hidden className="text-ink2" />
        </div>
        <div className="min-w-0">
          {/* Uppercase labels carry +0.03em, never a bespoke tracking value
              (DESIGN.md §3 Negative-Tracking Rule). v1 ran this one at 0.06em. */}
          <div className="font-heading text-label font-semibold uppercase leading-none tracking-[0.03em] text-brandink">
            {mode === "add" ? "New shift" : "Editing shift"}
          </div>
          {(mode === "edit" || draft.code) && (
            <div className="mt-1 truncate font-heading text-title font-bold uppercase leading-none tracking-[-0.015em]">
              {mode === "edit" ? String(item!.id) : draft.code}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${prefix}-code`}>Code</Label>
          <Input
            id={`${prefix}-code`}
            data-testid={`${prefix}-code`}
            value={draft.code}
            autoFocus
            placeholder="AM"
            className="text-label font-semibold uppercase"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            aria-invalid={!idCheck.ok || codeNumericOnly}
          />
          {!idCheck.ok && draft.code.length > 0 && (
            <span className="text-label text-errorink" role="alert">
              {idCheck.message}
            </span>
          )}
          {idCheck.ok && codeNumericOnly && (
            <span className="text-label text-errorink" role="alert">
              {NUMERIC_CODE_HINT}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <Label htmlFor={`${prefix}-name`}>Name</Label>
            <InfoTip
              label="Shift code & name"
              text="The code rules, groups and the roster refer to. Renaming it here updates every reference automatically."
            />
          </div>
          <Input
            id={`${prefix}-name`}
            data-testid={`${prefix}-name`}
            className="text-meta"
            value={draft.name}
            placeholder="Shift name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
        </div>
      </div>

      <WorkingTimeFields value={draft.workingTime} onChange={setWorkingTime} idPrefix={prefix} />

      <StaffingEditor
        prefix={prefix}
        staffing={staffing}
        required={draft.required}
        preferred={draft.preferred}
        onRequiredChange={setRequired}
        onPreferredChange={setPreferred}
      />

      {saveError && (
        <div
          role="alert"
          data-testid={`${prefix}-save-error`}
          className="flex items-start gap-2 rounded-control border border-error bg-errortint px-3 py-2 text-meta font-semibold text-errorink"
        >
          <FaCircleExclamation aria-hidden className="mt-0.5 flex-none text-error" />
          <span>{saveError}</span>
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-line2 pt-3">
        <Button onClick={save} disabled={!canSave} data-testid={`${prefix}-save`}>
          <FaCheck />
          {mode === "add" ? "Add shift" : "Save"}
        </Button>
        <Button variant="outline" onClick={onDone} data-testid={`${prefix}-cancel`}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
