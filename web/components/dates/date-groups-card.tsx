"use client";

// Date groups card (T10; spec 02 FR-DC-35/36/40/44 / acceptance rows 3 & 4;
// audit MAJOR 5 + MAJOR 6), re-skinned for v2 "Mint Canvas, Warm Ink" (R2a)
// against docs/design_prototype/source/ScreenDates.dc.html.
//
// Surfaces (DESIGN.md §4): the card is a resting L1 `surface`; a resting group row
// is an inset `well` inside it; a row that is being previewed or edited takes the
// shared `selected` role. That last choice is a deliberate deviation from the
// prototype's `--brandtint` wash — the same call `successions/pattern-builder.tsx`
// records — because a brand tint under brand-filled chips makes the chips
// disappear, and `selected` is the system's one ratified "this is the current one"
// treatment. `--brandtint` stays reserved for the selection MARKS themselves.
//
// The full prototype date-group surface (ScreenDates 129-248):
//
//   • "+ Group" opens an inline DRAFT card — group name + the shared DateScopePicker
//     + Save / Cancel / Delete. Existing EDITABLE groups render as prototype cards
//     (id, description tip, count, member chips or "No days", preview / edit / delete)
//     and edit inline the same way. Create/rename/delete/set-members all route
//     through the shared entity-editor CORE via the Dates descriptor (fs7) — no
//     bespoke mutation logic here.
//   • READ-ONLY auto-derived groups (ALL / WEEKDAY / WEEKEND / weekday names) are
//     rendered as multi-select PREVIEW chips. Selecting groups (derived or editable)
//     opens a sticky SELECTED panel with removable chips, the union day count, an
//     exact-date chip strip, and clear / hide controls. Preview NEVER mutates
//     membership — derived ids remain non-editable/non-deletable (the store never
//     offers an edit/delete affordance for them), preserving the settled guard.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLosableDraft } from "@/components/shell/use-losable-draft";
import {
  dateIdToIso,
  deriveDateGroups,
  generateDateItems,
  getDateIdForRange,
  type DateRange,
} from "@/lib/dates";
import type { EditorGroup } from "@/components/entity-editor/core";
import { validateFullEditId } from "@/components/entity-editor/core";
import type { UiDateGroup } from "@/lib/scenario";
import {
  FaCalendarDay,
  FaCheck,
  FaChevronUp,
  FaPen,
  FaPlus,
  FaTrash,
  FaXmark,
} from "@/components/icons";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { surfaceVariants } from "@/components/ui/surface";
import { datesDescriptor } from "./dates-descriptor";
import { DateScopePicker } from "./date-scope-picker";

const CHIP_DAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  timeZone: "UTC",
});
const CHIP_DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

export interface DateGroupsCardProps {
  range: DateRange;
  /** The editable groups from the store (`dateGroups`, reserved ids excluded). */
  editableGroups: UiDateGroup[];
  /** Create a new group with `memberIds` (one tracked mutation). */
  onCreateGroup: (name: string, memberIds: string[]) => void;
  /** Rename (if changed) + set members for an existing group (one tracked mutation). */
  onSaveGroup: (oldId: string, name: string, memberIds: string[]) => void;
  /** Delete an editable group through the cascade. */
  onDeleteGroup: (id: string) => void;
}

interface PreviewEntry {
  label: string;
  name: string;
  iso: string[];
}

export function DateGroupsCard({
  range,
  editableGroups,
  onCreateGroup,
  onSaveGroup,
  onDeleteGroup,
}: DateGroupsCardProps) {
  const items = useMemo(() => generateDateItems(range), [range]);
  const inRangeIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  const derived = useMemo(() => deriveDateGroups(items), [items]);
  const hasRange = items.length > 0;

  // Preview selection (MAJOR 6) — multi-select; never mutates membership.
  const [sel, setSel] = useState<PreviewEntry[]>([]);
  const [previewClosed, setPreviewClosed] = useState(false);
  const selLabels = useMemo(() => new Set(sel.map((e) => e.label)), [sel]);

  // Edit / draft state — at most one card is editable at a time. `creating` is the
  // not-yet-saved "+ Group" draft; `editingId` is the id of an existing group being
  // edited. They are mutually exclusive (a separate flag rather than a sentinel id,
  // so a real group can never be mistaken for the new-draft card).
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftSelected, setDraftSelected] = useState<ReadonlySet<string>>(new Set());
  const [draftError, setDraftError] = useState<string | null>(null);

  // When the committed range changes underneath us (undo/redo, external cascade, a
  // self-commit that re-keys/purges ids), any open preview or draft can still point
  // at members the cascade already re-keyed or purged. Reset the preview and close
  // any open draft so a stale draft can never be saved (via `buildMembers`) against
  // those ids. Skip the initial mount so a freshly rendered card keeps its seed.
  const prevRangeKey = useRef(`${range.start}|${range.end}`);
  useEffect(() => {
    const key = `${range.start}|${range.end}`;
    if (prevRangeKey.current === key) return;
    prevRangeKey.current = key;
    setSel([]);
    setPreviewClosed(false);
    setCreating(false);
    setEditingId(null);
    setDraftName("");
    setDraftSelected(new Set());
    setDraftError(null);
  }, [range.start, range.end]);

  /** Resolve a group's member ids to in-order ISO dates for preview/chips. */
  const memberIso = (members: readonly (string | number)[]): string[] =>
    members.map((m) => dateIdToIso(String(m), range)).filter((iso): iso is string => iso !== null);

  const togglePreview = (label: string, name: string, iso: string[]) => {
    setPreviewClosed(false);
    setSel((cur) =>
      cur.some((e) => e.label === label)
        ? cur.filter((e) => e.label !== label)
        : [...cur, { label, name, iso }],
    );
  };
  const removePreview = (label: string) => setSel((cur) => cur.filter((e) => e.label !== label));
  const clearPreview = () => setSel([]);

  const previewIso = useMemo(() => {
    const set = new Set<string>();
    for (const e of sel) for (const iso of e.iso) set.add(iso);
    return [...set].sort();
  }, [sel]);
  const multiMonth = useMemo(
    () => new Set(previewIso.map((iso) => iso.slice(0, 7))).size > 1,
    [previewIso],
  );
  const previewOpen = sel.length > 0 && !previewClosed;

  const busy = creating || editingId !== null;
  // FR-PR-06: register the open create/edit draft as a losable draft (T08a).
  useLosableDraft("date-groups-editor", busy, "Date groups editor");

  const startCreate = () => {
    setCreating(true);
    setEditingId(null);
    setDraftName("");
    setDraftSelected(new Set());
    setDraftError(null);
  };
  const startEdit = (group: UiDateGroup) => {
    setCreating(false);
    setEditingId(group.id);
    setDraftName(group.id);
    setDraftSelected(new Set(memberIso(group.members).filter((iso) => isInRange(iso, range))));
    setDraftError(null);
  };
  const cancelEdit = () => {
    setCreating(false);
    setEditingId(null);
    setDraftError(null);
  };

  /** Build the full member id list: preserved out-of-range ids + in-range picks. */
  const buildMembers = (existing: UiDateGroup | undefined): string[] => {
    const preserved = existing
      ? existing.members.map(String).filter((id) => !inRangeIds.has(id))
      : [];
    const picked = [...draftSelected].map((iso) => getDateIdForRange(iso, range));
    return [...preserved, ...picked];
  };

  const saveDraft = () => {
    const name = draftName.trim();
    const isNew = creating;
    const currentId = isNew ? undefined : (editingId ?? undefined);
    const groupsForValidation = editableGroups as unknown as EditorGroup[];
    const result = validateFullEditId(
      datesDescriptor,
      items.map((i) => ({ id: i.id, description: i.description })),
      groupsForValidation,
      name,
      true,
      currentId,
    );
    if (!result.ok) {
      setDraftError(result.message);
      return;
    }
    if (isNew) {
      onCreateGroup(result.id, buildMembers(undefined));
    } else {
      const existing = editableGroups.find((g) => g.id === editingId);
      onSaveGroup(editingId as string, result.id, buildMembers(existing));
    }
    setCreating(false);
    setEditingId(null);
    setDraftError(null);
  };

  return (
    <section
      className={cn(surfaceVariants({ role: "surface", geometry: "card" }))}
      data-testid="date-groups-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-line2 px-[18px] py-4">
        <div>
          <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em]">
            Date groups
          </h2>
          <p className="mt-0.5 text-meta text-ink2">
            Named sets of days you can target in rules — e.g. “staff weekends with fewer nurses”.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="flex-none"
          data-testid="date-group-add"
          disabled={!hasRange || busy}
          onClick={startCreate}
        >
          <FaPlus /> Group
        </Button>
      </div>

      <div className="flex flex-col gap-3 p-[18px]">
        {previewOpen ? (
          <PreviewPanel
            entries={sel}
            days={previewIso}
            multiMonth={multiMonth}
            onRemove={removePreview}
            onClear={clearPreview}
            onHide={() => setPreviewClosed(true)}
          />
        ) : null}

        {!hasRange ? (
          <p className="py-2 text-meta text-ink3" data-testid="date-groups-empty">
            Set a roster period above to create and preview date groups.
          </p>
        ) : null}

        {creating ? (
          <GroupEditCard
            testId="date-group-editor-new"
            range={range}
            name={draftName}
            selected={draftSelected}
            error={draftError}
            onName={setDraftName}
            onSelect={(iso) => setDraftSelected(new Set(iso))}
            onSave={saveDraft}
            onCancel={cancelEdit}
            onDelete={cancelEdit}
          />
        ) : null}

        {editableGroups.map((group) => {
          const iso = memberIso(group.members);
          const label = `grp:${group.id}`;
          if (editingId === group.id) {
            return (
              <GroupEditCard
                key={group.id}
                testId={`date-group-editor-${group.id}`}
                range={range}
                name={draftName}
                selected={draftSelected}
                error={draftError}
                onName={setDraftName}
                onSelect={(next) => setDraftSelected(new Set(next))}
                onSave={saveDraft}
                onCancel={cancelEdit}
                onDelete={() => {
                  // Clear the edit state FIRST so the editor closes and `busy`
                  // releases — otherwise the deleted group's stale `editingId`
                  // locks `+ Group` and every card action (MAJOR 1).
                  cancelEdit();
                  onDeleteGroup(group.id);
                }}
              />
            );
          }
          return (
            <GroupViewCard
              key={group.id}
              group={group}
              iso={iso}
              multiMonth={multiMonth || new Set(iso.map((d) => d.slice(0, 7))).size > 1}
              previewing={selLabels.has(label)}
              disabled={busy}
              onPreview={() => togglePreview(label, group.id, iso)}
              onEdit={() => startEdit(group)}
              onDelete={() => onDeleteGroup(group.id)}
            />
          );
        })}

        {hasRange ? (
          <div className="border-t border-line2 pt-3.5" data-testid="derived-groups">
            <div className="mb-2 text-label font-semibold uppercase tracking-[0.03em] text-ink3">
              Auto-derived · tap to preview its days (select several)
            </div>
            <div className="flex flex-wrap gap-2.5">
              {derived.map((group) => {
                const label = `auto:${group.id}`;
                const active = selLabels.has(label);
                return (
                  // A real toggle, so it is a Button: brand-filled while its days
                  // are being previewed, L1 when not. The variant carries the pill,
                  // elevation, focus outline and 44px coarse floor.
                  <Button
                    key={group.id}
                    variant={active ? "default" : "secondary"}
                    size="sm"
                    data-testid={`derived-group-${group.id}`}
                    aria-pressed={active}
                    onClick={() => togglePreview(label, group.id, memberIso(group.members))}
                  >
                    <FaCalendarDay />
                    <span className="font-mono text-label font-semibold tracking-[0.03em]">
                      {group.id}
                    </span>
                    {/* On the brand fill the count must inherit `--on-brand`; off
                        it, it steps back to the tertiary ink. */}
                    <span
                      className={active ? undefined : "text-ink3"}
                      data-testid={`derived-group-${group.id}-count`}
                    >
                      {group.members.length} day{group.members.length === 1 ? "" : "s"}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function isInRange(iso: string, range: DateRange): boolean {
  return iso >= range.start && iso <= range.end;
}

function formatChip(iso: string, multiMonth: boolean): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return (multiMonth ? CHIP_DAY_MONTH : CHIP_DAY).format(date);
}

/** The sticky SELECTED preview panel (union of the selected groups' days). */
function PreviewPanel({
  entries,
  days,
  multiMonth,
  onRemove,
  onClear,
  onHide,
}: {
  entries: PreviewEntry[];
  days: string[];
  multiMonth: boolean;
  onRemove: (label: string) => void;
  onClear: () => void;
  onHide: () => void;
}) {
  return (
    // The panel IS the current selection, so it takes the shared `selected` role
    // (--brand border + --sh-2 on --surface) instead of the hand-rolled shadow it
    // used to author. `overflow-hidden` clips its band and the scrolling day strip
    // to the card radius (DESIGN.md §4 rules 2-3). It sticks BELOW the 14-step
    // sticky top bar and under its z-30, so the two never fight.
    <div
      className={cn(
        "sticky top-14 z-20 overflow-hidden",
        surfaceVariants({ role: "selected", geometry: "card" }),
      )}
      data-testid="date-group-preview"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line2 px-2.5 py-2">
        <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
          Selected
        </span>
        {/* The prototype draws a brand chip with a separate ✕ button inside it. A
            nested icon control cannot reach the 44px coarse floor without dwarfing
            its own chip, so the chip IS the remove control: one real Button, the
            same brand-filled read, and the name still visible inside the
            accessible name. */}
        {entries.map((entry) => (
          <Button
            key={entry.label}
            size="sm"
            className="font-mono"
            aria-label={`Remove ${entry.name}`}
            data-testid={`date-group-preview-remove-${entry.label}`}
            onClick={() => onRemove(entry.label)}
          >
            {entry.name}
            <FaXmark />
          </Button>
        ))}
        <span className="min-w-2 flex-1" />
        <span
          className="whitespace-nowrap font-mono text-label text-ink3"
          data-testid="date-group-preview-count"
        >
          {days.length} day{days.length === 1 ? "" : "s"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Clear all"
          title="Clear all"
          data-testid="date-group-preview-clear"
          onClick={onClear}
        >
          <FaXmark />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Hide"
          title="Hide"
          data-testid="date-group-preview-hide"
          onClick={onHide}
        >
          <FaChevronUp />
        </Button>
      </div>
      {/* The exact days are selection MARKS, so this is where --brandtint + a
          --brand border legitimately lives (DESIGN.md §6). */}
      <div className="flex gap-1.5 overflow-x-auto px-2.5 py-2">
        {days.map((iso) => (
          <Badge
            key={iso}
            variant="brand"
            casing="normal"
            className="flex-none whitespace-nowrap font-mono"
          >
            {formatChip(iso, multiMonth)}
          </Badge>
        ))}
      </div>
    </div>
  );
}

/** A read-only editable-group card: id + tip + count + day chips + actions. */
function GroupViewCard({
  group,
  iso,
  multiMonth,
  previewing,
  disabled,
  onPreview,
  onEdit,
  onDelete,
}: {
  group: UiDateGroup;
  iso: string[];
  multiMonth: boolean;
  previewing: boolean;
  disabled: boolean;
  onPreview: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const chips = iso.slice(0, 12);
  const overflow = iso.length - chips.length;
  return (
    <div
      className={cn(
        "p-4",
        previewing
          ? surfaceVariants({ role: "selected", geometry: "control" })
          : surfaceVariants({ role: "well", geometry: "control" }),
      )}
      data-testid={`editable-group-${group.id}`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="font-mono text-label-lg font-semibold tracking-[0.03em]">
              {group.id}
            </span>
            {/* The prototype's own InfoTip, which is a focusable control with the
                help text as its accessible name — the bare icon it replaced was
                reachable by hover alone. */}
            {group.description ? <InfoTip label={group.id} text={group.description} /> : null}
            <span className="text-meta text-ink3" data-testid={`editable-group-${group.id}-count`}>
              {group.members.length} day{group.members.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {group.members.length === 0 ? (
              <span className="text-meta text-ink3">No days</span>
            ) : (
              <>
                {/* `outline` rather than the filled neutral chip: a resting row is
                    already `--panel`, and DESIGN.md §4 rule 5 forbids stacking a
                    second `--panel` plane on it. The hairline carries the chip. */}
                {chips.map((d, i) => (
                  <Badge key={`${d}-${i}`} variant="outline" casing="normal" className="font-mono">
                    {formatChip(d, multiMonth)}
                  </Badge>
                ))}
                {overflow > 0 ? (
                  <Badge variant="outline" casing="normal" className="font-mono">
                    +{overflow}
                  </Badge>
                ) : null}
              </>
            )}
          </div>
        </div>
        <div className="flex flex-none gap-1">
          <Button
            variant={previewing ? "default" : "ghost"}
            size="icon"
            aria-label={`Preview ${group.id} days`}
            aria-pressed={previewing}
            title="Preview this group's days"
            data-testid={`editable-group-preview-${group.id}`}
            onClick={onPreview}
          >
            <FaCalendarDay />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Edit group ${group.id}`}
            data-testid={`editable-group-edit-${group.id}`}
            disabled={disabled}
            onClick={onEdit}
          >
            <FaPen />
          </Button>
          {/* v2's destructive affordance is an OUTLINE everywhere the system uses
              it; the paired solid fill is reserved for a confirmed destructive
              action, not a row control. */}
          <Button
            variant="destructive-outline"
            size="icon"
            aria-label={`Delete group ${group.id}`}
            data-testid={`editable-group-delete-${group.id}`}
            disabled={disabled}
            onClick={onDelete}
          >
            <FaTrash />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The inline edit / create draft card: name + picker + Save/Cancel/Delete. */
function GroupEditCard({
  testId,
  range,
  name,
  selected,
  error,
  onName,
  onSelect,
  onSave,
  onCancel,
  onDelete,
}: {
  testId: string;
  range: DateRange;
  name: string;
  selected: ReadonlySet<string>;
  error: string | null;
  onName: (value: string) => void;
  onSelect: (iso: string[]) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const nameId = useId();
  const errorId = useId();
  return (
    <div
      className={cn(
        "flex flex-col gap-3.5 p-4",
        surfaceVariants({ role: "selected", geometry: "control" }),
      )}
      data-testid={testId}
    >
      <div className="max-w-[320px]">
        <Label htmlFor={nameId} className="mb-1.5 block">
          Group name
        </Label>
        {/* The field keeps the primitive's own hairline and brand focus ring: the
            card's brand edge already says "this is the active editor", and a second
            brand border inside it would double the signal. */}
        <Input
          id={nameId}
          className="font-semibold"
          data-testid="date-group-name"
          value={name}
          placeholder="e.g. Weekends"
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => onName(e.target.value)}
        />
        {error ? (
          <span
            id={errorId}
            className="mt-1 block text-meta text-errorink"
            data-testid="date-group-name-error"
          >
            {error}
          </span>
        ) : null}
      </div>

      <DateScopePicker range={range} selected={selected} onChange={onSelect} />

      <div className="flex gap-1.5">
        <Button size="sm" data-testid="date-group-save" onClick={onSave}>
          <FaCheck /> Save
        </Button>
        <Button variant="secondary" size="sm" data-testid="date-group-cancel" onClick={onCancel}>
          Cancel
        </Button>
        <div className="flex-1" />
        <Button
          variant="destructive-outline"
          size="sm"
          data-testid="date-group-delete"
          onClick={onDelete}
        >
          <FaTrash /> Delete
        </Button>
      </div>
    </div>
  );
}
