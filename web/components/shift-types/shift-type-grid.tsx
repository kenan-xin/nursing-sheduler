"use client";

// Bespoke Shifts card-grid (DR-3) — replaces the generic `EntityEditor` for the
// /shift-types route. It follows docs/design_prototype/ScreenShifts.dc.html: a
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

import * as React from "react";
import { toast } from "sonner";
import { useScenarioStore } from "@/lib/store";
import { useLosableDraft } from "@/components/shell/use-losable-draft";
import type { ScenarioUiState, UiShiftType } from "@/lib/scenario";
import { RenameCollisionError } from "@/lib/cascade";
import { GuardedLink } from "@/components/shell/guarded-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  FaPlus,
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
  addLabel: "Group",
  emptyText:
    "No custom shift groups yet — bundle shift types so a rule can count or target them together.",
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
    <div
      data-testid="screen"
      data-screen={descriptor.labels.itemPlural}
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-8"
    >
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-title font-semibold tracking-tight">Shifts</h1>
        <p className="text-meta text-ink2">
          Set up the daily shifts your ward runs, their working time, and how you group them. Off
          and Paid leave are reserved day-states handled for you.
        </p>
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
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        data-testid="shift-grid"
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reserved OFF/LEAVE card — locked (AUTO), with a lock + plain-language reason.
// Never a raw disabled control.
// ---------------------------------------------------------------------------

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
    <div
      data-testid={`synthetic-${id}`}
      className="flex flex-col gap-3 border border-line2 bg-panel p-[18px]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-[42px] flex-none items-center justify-center border border-line2 bg-surface text-ink2">
            <Icon aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="font-heading text-title font-extrabold leading-none">{id}</div>
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
      className={`flex flex-col gap-3 border border-line bg-surface p-[18px] ${
        canDrag ? "cursor-grab" : ""
      } ${isOver ? "shadow-[inset_0_2px_0_var(--color-brand)]" : ""} ${
        isDragging ? "opacity-50" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-[42px] flex-none items-center justify-center border border-line2 bg-panel text-ink2">
            <FaClock aria-hidden />
          </div>
          <div className="min-w-0">
            <div
              data-testid={`shift-code-${cardKey}`}
              className="font-heading text-title font-extrabold uppercase leading-none"
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
          <span
            data-testid={`shift-dur-${cardKey}`}
            className="border border-line2 px-[7px] py-0.5 font-mono text-label text-ink3"
          >
            {fmtHours(item.durationMinutes!)}
          </span>
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
          <Button variant="outline" data-testid={`shift-edit-${cardKey}`} onClick={onEdit}>
            <FaPen />
            Edit
          </Button>
          <Button
            variant="outline"
            className="text-error hover:bg-errortint"
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
          className="font-heading text-title font-extrabold leading-none"
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
        className="border border-line bg-panel px-3 py-2.5 text-meta text-ink3"
        data-testid={`${prefix}-staffing-numeric`}
      >
        {staffing.explanation}
      </div>
    );
  }
  if (staffing.kind === "readonly") {
    return (
      <div
        className="flex flex-col gap-2 border border-line bg-panel px-3 py-2.5"
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
        <div
          className="border border-warn bg-warntint px-3 py-2 text-label font-semibold text-ink"
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
    <div
      className="flex flex-col gap-4 border border-brand bg-brandtint/40 p-[18px]"
      data-testid={mode === "add" ? "shift-add-form" : `shift-edit-form-${entityKey(item!.id)}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onDone();
        }
      }}
    >
      <div className="font-heading text-label font-semibold uppercase tracking-[0.06em] text-brandink">
        {mode === "add" ? "New shift" : "Editing shift"}
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
            className="font-semibold uppercase"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            aria-invalid={!idCheck.ok || codeNumericOnly}
          />
          {!idCheck.ok && draft.code.length > 0 && (
            <span className="text-label text-error" role="alert">
              {idCheck.message}
            </span>
          )}
          {idCheck.ok && codeNumericOnly && (
            <span className="text-label text-error" role="alert">
              Shift codes need at least one letter (like AM or N2) so they can carry staffing.
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
          className="flex items-start gap-2 border border-error bg-errortint px-3 py-2 text-meta font-semibold text-ink"
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
