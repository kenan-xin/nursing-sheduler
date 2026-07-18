"use client";

// Date groups card (T10; spec 02 FR-DC-35/36/40/44 / acceptance rows 3 & 4;
// audit MAJOR 5 + MAJOR 6). The full prototype date-group surface (ScreenDates
// 129-248):
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

import { useMemo, useState } from "react";
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
  FaCircleInfo,
  FaPen,
  FaPlus,
  FaTrash,
  FaXmark,
} from "@/components/icons";
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
    <section className="mt-4 border border-line bg-surface" data-testid="date-groups-panel">
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-line2 px-[18px] py-4">
        <div>
          <h2 className="font-heading text-cardhead font-extrabold tracking-tight">Date groups</h2>
          <p className="mt-0.5 text-sm text-ink2">
            Named sets of days you can target in rules — e.g. “staff weekends with fewer nurses”.
          </p>
        </div>
        <button
          type="button"
          className="ns-btn h-[34px] flex-none"
          data-testid="date-group-add"
          disabled={!hasRange || busy}
          onClick={startCreate}
        >
          <FaPlus className="size-3" /> Group
        </button>
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
          <p className="py-2 text-sm text-ink3" data-testid="date-groups-empty">
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
                  <button
                    key={group.id}
                    type="button"
                    className={`ns-derived-chip ${active ? "ns-derived-chip--on" : ""}`}
                    data-testid={`derived-group-${group.id}`}
                    aria-pressed={active}
                    onClick={() => togglePreview(label, group.id, memberIso(group.members))}
                  >
                    <FaCalendarDay className="size-2.5" />
                    <span className="font-mono text-label tracking-[0.02em]">{group.id}</span>
                    <span
                      className="text-sm opacity-90"
                      data-testid={`derived-group-${group.id}-count`}
                    >
                      {group.members.length}
                    </span>
                  </button>
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
    <div className="ns-dg-preview" data-testid="date-group-preview">
      <div className="flex flex-wrap items-center gap-2 border-b border-line2 px-2.5 py-2">
        <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
          Selected
        </span>
        {entries.map((entry) => (
          <span key={entry.label} className="ns-dg-preview__chip">
            {entry.name}
            <button
              type="button"
              aria-label={`Remove ${entry.name}`}
              className="ns-dg-preview__chip-x"
              onClick={() => onRemove(entry.label)}
            >
              <FaXmark className="size-2" />
            </button>
          </span>
        ))}
        <span className="min-w-2 flex-1" />
        <span
          className="whitespace-nowrap font-mono text-label text-ink3"
          data-testid="date-group-preview-count"
        >
          {days.length} day{days.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          aria-label="Clear all"
          title="Clear all"
          className="ns-icon-btn"
          data-testid="date-group-preview-clear"
          onClick={onClear}
        >
          <FaXmark className="size-3" />
        </button>
        <button
          type="button"
          aria-label="Hide"
          title="Hide"
          className="ns-icon-btn"
          data-testid="date-group-preview-hide"
          onClick={onHide}
        >
          <FaChevronUp className="size-3" />
        </button>
      </div>
      <div className="flex gap-1.5 overflow-x-auto px-2.5 py-2">
        {days.map((iso) => (
          <span key={iso} className="ns-dg-preview__day">
            {formatChip(iso, multiMonth)}
          </span>
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
      className={`border p-4 ${previewing ? "border-brand bg-brandtint" : "border-line2 bg-panel"}`}
      data-testid={`editable-group-${group.id}`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="font-mono text-label-lg tracking-[0.02em]">{group.id}</span>
            {group.description ? (
              <FaCircleInfo
                className="size-3.5 text-ink3"
                title={group.description}
                aria-label={group.description}
              />
            ) : null}
            <span className="text-sm text-ink3" data-testid={`editable-group-${group.id}-count`}>
              {group.members.length} day{group.members.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {group.members.length === 0 ? (
              <span className="text-sm text-faint">No days</span>
            ) : (
              <>
                {chips.map((d, i) => (
                  <span key={`${d}-${i}`} className="ns-day-chip">
                    {formatChip(d, multiMonth)}
                  </span>
                ))}
                {overflow > 0 ? <span className="ns-day-chip">+{overflow}</span> : null}
              </>
            )}
          </div>
        </div>
        <div className="flex flex-none gap-1">
          <button
            type="button"
            aria-label={`Preview ${group.id} days`}
            aria-pressed={previewing}
            title="Preview this group's days"
            className={`ns-square-btn ${previewing ? "ns-square-btn--on" : ""}`}
            data-testid={`editable-group-preview-${group.id}`}
            onClick={onPreview}
          >
            <FaCalendarDay className="size-3" />
          </button>
          <button
            type="button"
            aria-label={`Edit group ${group.id}`}
            className="ns-square-btn"
            data-testid={`editable-group-edit-${group.id}`}
            disabled={disabled}
            onClick={onEdit}
          >
            <FaPen className="size-3" />
          </button>
          <button
            type="button"
            aria-label={`Delete group ${group.id}`}
            className="ns-square-btn ns-square-btn--danger"
            data-testid={`editable-group-delete-${group.id}`}
            disabled={disabled}
            onClick={onDelete}
          >
            <FaTrash className="size-3" />
          </button>
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
  return (
    <div
      className="flex flex-col gap-3.5 border border-brand bg-brandtint p-4"
      data-testid={testId}
    >
      <label className="block max-w-[320px]">
        <span className="mb-1.5 block text-label font-semibold uppercase tracking-[0.03em] text-ink2">
          Group name
        </span>
        <input
          className="ns-input h-9 w-full border-brand font-semibold"
          data-testid="date-group-name"
          value={name}
          placeholder="e.g. Weekends"
          aria-invalid={Boolean(error) || undefined}
          onChange={(e) => onName(e.target.value)}
        />
        {error ? (
          <span className="mt-1 block text-meta text-error" data-testid="date-group-name-error">
            {error}
          </span>
        ) : null}
      </label>

      <DateScopePicker range={range} selected={selected} onChange={onSelect} />

      <div className="flex gap-1.5">
        <button
          type="button"
          className="ns-btn ns-btn--primary h-[34px]"
          data-testid="date-group-save"
          onClick={onSave}
        >
          <FaCheck className="size-3" /> Save
        </button>
        <button
          type="button"
          className="ns-btn h-[34px]"
          data-testid="date-group-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <div className="flex-1" />
        <button
          type="button"
          className="ns-btn ns-btn--danger h-[34px]"
          data-testid="date-group-delete"
          onClick={onDelete}
        >
          <FaTrash className="size-2.5" /> Delete
        </button>
      </div>
    </div>
  );
}
