"use client";

// The generic item/group editor (T09, Option A). Domain-agnostic: it reads a
// descriptor and renders the full spec-03 editing surface — an items table with
// native HTML5 drag-reorder, an add form, per-row full edit (edit-toggle) and
// double-click inline edit, immediate duplicate/delete, per-row group membership
// badges each with an inline ×-remove (one tracked membership toggle),
// and a groups section with a live transfer-list membership picker plus (People
// only) a .txt/.csv bulk upload. People and Shift Types are thin descriptor-driven
// wrappers (see components/people + components/shift-types); Dates adopt the same
// interface later (T10 owns Dates; a follow-up DRYs it).
//
// Interaction model follows docs/design_prototype (ScreenStaff / ScreenShifts):
// a single edit selection at a time (`sel`); the edited row gets a brand tint and
// drag is disabled while any edit/inline/add is active; delete is immediate with NO
// confirmation dialog (spec 03 FR-ED-14); there are no role/seniority badges (DL10
// overrides the prototype's Senior/Preceptee/Junior chips).
//
// Store discipline (T04): every user action feeds ONE produced `ScenarioUiState` to
// one `mutateScenario` call (one patch ⇒ one zundo entry). A compound action (add an
// item and drop it into groups; rename + description + working-time + membership on
// save) is composed through the pure core transforms and committed once. Rename/
// delete route through T07's cascade (renameEntity/deleteEntity) so references stay
// consistent; a `RenameCollisionError` surfaces as a field error. No store slices
// are added.

import * as React from "react";
import { toast } from "sonner";
import { useScenarioStore } from "@/lib/store";
import { useLosableDraft } from "@/components/shell/use-losable-draft";
import type { ScenarioUiState } from "@/lib/scenario";
import { RenameCollisionError } from "@/lib/cascade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  FaPlus,
  FaPen,
  FaTrash,
  FaCopy,
  FaCheck,
  FaXmark,
  FaLock,
  FaGripVertical,
  FaFileArrowUp,
  FaMagnifyingGlass,
} from "@/components/icons";
import {
  addItem,
  addGroup,
  deleteGroup,
  deleteItem,
  duplicateGroup,
  duplicateItem,
  reorderItems,
  reorderGroups,
  renameItem,
  renameGroup,
  setGroupMembers,
  toggleGroupMembership,
  updateItemFields,
  updateGroupFields,
  reorderByUpload,
  validateFullEditId,
  validateInlineId,
  validateWorkingTimeDraft,
  entityKey,
  sameEntityId,
  type EntityDescriptor,
  type EntityId,
  type EditorGroup,
  type EditorItemBase,
  type WorkingTimeValue,
} from "./core";
import { WorkingTimeFields } from "./working-time-fields";
import { TransferList } from "./transfer-list";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

type Commit = (next: ScenarioUiState) => void;
type CurrentState = () => ScenarioUiState;

/** The single active selection across the whole editor (spec 03 modes). */
type Sel =
  | null
  | { t: "add-item" }
  | { t: "add-group" }
  | { t: "edit-item"; key: string }
  | { t: "edit-group"; id: string }
  | { t: "inline-item"; key: string; field: "id" | "desc" }
  | { t: "inline-group"; id: string; field: "id" | "desc" };

/** The working-time keys (present only on shift-type items). */
type WorkingTimeItem = {
  startTime?: string;
  endTime?: string;
  restMinutes?: number;
  durationMinutes?: number;
};

// ---------------------------------------------------------------------------
// Working-time helpers
// ---------------------------------------------------------------------------

/** Pull the working-time fields off a shift-type item (absent on people). */
function pickWorkingTime(item: WorkingTimeItem): WorkingTimeValue {
  return {
    startTime: item.startTime,
    endTime: item.endTime,
    restMinutes: item.restMinutes,
    durationMinutes: item.durationMinutes,
  };
}

/** Only-authored working-time keys, for the `addItem` `extra` blob. */
function workingTimeExtra(v: WorkingTimeValue): WorkingTimeValue {
  const out: WorkingTimeValue = {};
  if (v.startTime) out.startTime = v.startTime;
  if (v.endTime) out.endTime = v.endTime;
  if (v.restMinutes) out.restMinutes = v.restMinutes;
  if (v.durationMinutes != null) out.durationMinutes = v.durationMinutes;
  return out;
}

/**
 * A replace patch for the working-time keys: every key is present, cleared keys are
 * explicit `undefined` (spec 03 FR-ED-06a Clear semantics + Major 5). Merging this
 * over a shift removes any field the user cleared instead of retaining the old value.
 */
function workingTimePatch(v: WorkingTimeValue): WorkingTimeItem {
  return {
    startTime: v.startTime || undefined,
    endTime: v.endTime || undefined,
    restMinutes: v.restMinutes || undefined,
    durationMinutes: v.durationMinutes ?? undefined,
  };
}

/** Format working minutes as the design's "8h" / "8h 30m" readout. */
function fmtWorkingHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** A short human summary of a shift's working time, or null when none authored. */
function workingTimeSummary(value: WorkingTimeValue): string | null {
  if (!value.startTime && !value.endTime && value.durationMinutes == null) return null;
  const clock = value.startTime && value.endTime ? `${value.startTime}–${value.endTime}` : null;
  const dur = value.durationMinutes != null ? fmtWorkingHours(value.durationMinutes) : null;
  return [clock, dur].filter(Boolean).join(" · ") || null;
}

/**
 * Write an item's group membership to EXACTLY `desiredGroupIds` (a SET model, not a
 * toggle delta). For every LIVE group, the item is added or removed to match the
 * desired set by comparing against the group's CURRENT membership — so the write is
 * IDEMPOTENT: if the live state already matches the intent, nothing changes.
 * `desiredGroupIds` is the form's draft; the form guarantees it is never stale (an
 * external/temporal change closes the form, and the synchronous `isStale` guard
 * aborts a racing Save), so this only ever runs against the slice the draft was
 * formed against. Exact typed identity throughout.
 */
function writeItemGroups<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  itemId: EntityId,
  desiredGroupIds: readonly string[],
): ScenarioUiState {
  const desired = new Set(desiredGroupIds);
  let next = state;
  for (const group of descriptor.readGroups(state)) {
    const isMember = group.members.some((m) => sameEntityId(m, itemId));
    const shouldBe = desired.has(group.id);
    if (isMember !== shouldBe) next = toggleGroupMembership(next, descriptor, group.id, itemId);
  }
  return next;
}

/**
 * Write a group's membership to EXACTLY `desiredItemMembers` plus the group's LIVE
 * unknown/nested members preserved (a SET model). `setGroupMembers` replaces the
 * whole array and re-sorts to item order, so the write is IDEMPOTENT (Major 1 —
 * `setGroupMembers` returns the same state when the sequence is unchanged) and the
 * desired set is applied directly rather than toggled. Unknown/nested members that
 * the user cannot author are carried through untouched.
 */
function writeGroupMembers<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  groupId: string,
  desiredItemMembers: readonly EntityId[],
): ScenarioUiState {
  const group = descriptor.readGroups(state).find((g) => g.id === groupId);
  if (!group) return state;
  const items = descriptor.readItems(state);
  const isItem = (m: EntityId) => items.some((it) => sameEntityId(it.id, m));
  // Keep only desired members that genuinely exist as live items; carry the group's
  // own unknown/nested members (which the transfer list never exposes) untouched.
  const realMembers = desiredItemMembers.filter(isItem);
  const unknownMembers = group.members.filter((m) => !isItem(m));
  return setGroupMembers(state, descriptor, groupId, [...realMembers, ...unknownMembers]);
}

// ---------------------------------------------------------------------------
// Top-level editor
// ---------------------------------------------------------------------------

export function EntityEditor<TItem extends EditorItemBase>({
  descriptor,
}: {
  descriptor: EntityDescriptor<TItem>;
}) {
  const items = useScenarioStore(descriptor.readItems);
  const groups = useScenarioStore(descriptor.readGroups);
  const commit = React.useCallback<Commit>((next) => {
    useScenarioStore.getState().mutateScenario(next);
  }, []);
  const currentState = React.useCallback<CurrentState>(
    () => useScenarioStore.getState() as ScenarioUiState,
    [],
  );

  const [sel, setSel] = React.useState<Sel>(null);
  const [query, setQuery] = React.useState("");
  const [uploadOpen, setUploadOpen] = React.useState(false);

  const editing = sel !== null;
  // FR-PR-06: register the open add/edit/inline form as a losable draft (T08a).
  useLosableDraft(
    `entity-editor:${descriptor.domain}`,
    editing,
    `${descriptor.labels.itemPlural} editor`,
  );

  // Staleness detection for an open add/edit/inline form. When a form OPENS we capture
  // the item + group slice references it was formed against ("form-open token"), held
  // ACROSS rerenders (not current props). ONE synchronous predicate — `isStale` —
  // re-reads the live store and reports whether that relevant slice has changed since
  // open (undo/redo temporal travel, or a T07 cascade rename/delete from elsewhere).
  // It is consulted by BOTH the visible-close effect below AND every submit handler
  // (as `isStale` threaded down), so "what closes the form" and "what blocks a stale
  // Save" are provably the same relevance condition. It keys ONLY on items/groups, so
  // unrelated durable meta churn neither closes the form nor blocks its Save.
  const openToken = React.useRef<{ items: TItem[]; groups: EditorGroup[] } | null>(null);
  const wasEditing = React.useRef(false);
  if (editing !== wasEditing.current) {
    // Capture/clear synchronously on the open⇄close transition (survives rerenders).
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

  // Visible cancellation: once the relevant slice has changed under an open form,
  // close it. Self-Save closes via `onDone` in the same tick (then `editing` is false
  // and the token is cleared), so this never fires for the form's own commit. The
  // synchronous `isStale` guard in each submit path is what blocks a stale Save in the
  // render→effect window; this effect is only the visible follow-up.
  React.useEffect(() => {
    if (editing && isStale()) setSel(null);
  });

  return (
    <div
      data-testid="screen"
      data-screen={descriptor.labels.itemPlural}
      className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-8"
    >
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-title font-semibold tracking-tight">
          {descriptor.labels.itemPlural}
        </h1>
        <p className="text-meta text-ink2">
          Manage {descriptor.labels.itemPluralLower}, their groups, and membership. Generated rows
          (reserved keywords) are read-only.
        </p>
      </header>

      <ItemsSection
        descriptor={descriptor}
        items={items}
        groups={groups}
        commit={commit}
        currentState={currentState}
        sel={sel}
        setSel={setSel}
        isStale={isStale}
        query={query}
        setQuery={setQuery}
        editing={editing}
        onOpenUpload={() => setUploadOpen(true)}
      />

      <GroupsSection
        descriptor={descriptor}
        items={items}
        groups={groups}
        commit={commit}
        currentState={currentState}
        sel={sel}
        setSel={setSel}
        isStale={isStale}
        editing={editing}
      />

      {descriptor.domain === "person" && uploadOpen && (
        <UploadDialog
          descriptor={descriptor}
          commit={commit}
          currentState={currentState}
          onClose={() => setUploadOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Items section (toolbar + add form + table)
// ---------------------------------------------------------------------------

interface SectionProps<TItem extends EditorItemBase> {
  descriptor: EntityDescriptor<TItem>;
  items: TItem[];
  groups: EditorGroup[];
  commit: Commit;
  currentState: CurrentState;
  sel: Sel;
  setSel: React.Dispatch<React.SetStateAction<Sel>>;
  /** True if the relevant item/group slice changed since the open form's form-open
   *  token — a synchronous stale-Save guard shared with the close-on-external effect. */
  isStale: () => boolean;
  editing: boolean;
}

function ItemsSection<TItem extends EditorItemBase>({
  descriptor,
  items,
  groups,
  commit,
  currentState,
  sel,
  setSel,
  isStale,
  editing,
  query,
  setQuery,
  onOpenUpload,
}: SectionProps<TItem> & {
  query: string;
  setQuery: (q: string) => void;
  onOpenUpload: () => void;
}) {
  // Drag identity is the source INDEX, never `entityKey` — `entityKey(-0)` and
  // `entityKey(0)` collide, so key-based resolution can't reorder two exact numeric
  // rows (Minor 1). Dragging is only enabled with no search filter, so a filtered
  // index equals its index in the full `items` list.
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);
  const [overIndex, setOverIndex] = React.useState<number | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter(
        (it) =>
          String(it.id).toLowerCase().includes(q) ||
          (it.description ?? "").toLowerCase().includes(q),
      )
    : items;
  const canDrag = !editing && !q;

  const onDrop = (to: number) => {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from != null && from !== to) {
      commit(reorderItems(currentState(), descriptor, from, to));
    }
  };

  const toggleAdd = () => setSel((cur) => (cur?.t === "add-item" ? null : { t: "add-item" }));

  return (
    <section className="flex flex-col gap-3" data-testid="items-section">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-heading text-cardhead font-semibold">
          {descriptor.labels.itemPlural}
        </h2>
        <Button
          onClick={toggleAdd}
          aria-pressed={sel?.t === "add-item"}
          data-testid="add-item-toggle"
        >
          <FaPlus />
          Add {descriptor.labels.item}
        </Button>
        {descriptor.domain === "person" && (
          <Button variant="outline" onClick={onOpenUpload} data-testid="upload-toggle">
            <FaFileArrowUp />
            Upload list
          </Button>
        )}
      </div>

      <div className="relative max-w-sm">
        <FaMagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 size-3 -translate-y-1/2 text-ink3" />
        <Input
          data-testid="items-search"
          className="pl-8"
          placeholder={`Search ${descriptor.labels.itemPluralLower}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {sel?.t === "add-item" && (
        <ItemForm
          mode="add"
          descriptor={descriptor}
          items={items}
          groups={groups}
          commit={commit}
          currentState={currentState}
          isStale={isStale}
          onDone={() => setSel(null)}
        />
      )}

      <div className="flex flex-col">
        {descriptor.syntheticItems.map((row) => (
          <SyntheticRow key={row.id} id={row.id} description={row.description} />
        ))}
        {filtered.length === 0 && (
          <p className="border border-dashed border-line bg-surface p-4 text-meta text-ink2">
            {q
              ? `No ${descriptor.labels.itemPluralLower} match “${query}”.`
              : `No ${descriptor.labels.itemPluralLower} yet — add one above.`}
          </p>
        )}
        {filtered.map((item, index) => {
          const key = entityKey(item.id);
          return (
            <ItemRow
              key={key}
              itemKey={key}
              descriptor={descriptor}
              item={item}
              items={items}
              groups={groups}
              commit={commit}
              currentState={currentState}
              sel={sel}
              setSel={setSel}
              isStale={isStale}
              canDrag={canDrag}
              isOver={overIndex === index}
              isDragging={dragIndex === index}
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
      </div>
    </section>
  );
}

function SyntheticRow({ id, description }: { id: string; description?: string }) {
  return (
    <div
      data-testid={`synthetic-${id}`}
      className="flex items-center gap-3 border border-line bg-panel px-3 py-2"
    >
      <Badge variant="neutral">
        <FaLock aria-hidden />
        Auto
      </Badge>
      <span className="font-medium">{id}</span>
      {description && <span className="text-meta text-ink2">{description}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item row (not-editing / inline / full-edit)
// ---------------------------------------------------------------------------

function ItemRow<TItem extends EditorItemBase>({
  itemKey,
  descriptor,
  item,
  items,
  groups,
  commit,
  currentState,
  sel,
  setSel,
  isStale,
  canDrag,
  isOver,
  isDragging,
  onDragStart,
  onDragOver,
  onDropRow,
  onDragEnd,
}: {
  itemKey: string;
  descriptor: EntityDescriptor<TItem>;
  item: TItem;
  items: TItem[];
  groups: EditorGroup[];
  commit: Commit;
  currentState: CurrentState;
  sel: Sel;
  setSel: React.Dispatch<React.SetStateAction<Sel>>;
  isStale: () => boolean;
  canDrag: boolean;
  isOver: boolean;
  isDragging: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDropRow: () => void;
  onDragEnd: () => void;
}) {
  const isEditing = sel?.t === "edit-item" && sel.key === itemKey;
  const memberOf = groups.filter((g) => g.members.some((m) => sameEntityId(m, item.id)));

  if (isEditing) {
    return (
      <div
        data-testid={`item-row-${itemKey}`}
        className="border border-brand bg-brandtint/40 px-3 py-3"
      >
        <ItemForm
          mode="edit"
          descriptor={descriptor}
          item={item}
          items={items}
          groups={groups}
          commit={commit}
          currentState={currentState}
          isStale={isStale}
          onDone={() => setSel(null)}
        />
      </div>
    );
  }

  const inlineId = sel?.t === "inline-item" && sel.key === itemKey && sel.field === "id";
  const inlineDesc = sel?.t === "inline-item" && sel.key === itemKey && sel.field === "desc";

  return (
    <div
      data-testid={`item-row-${itemKey}`}
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
      className={`flex flex-wrap items-center gap-2 border border-line bg-surface px-3 py-2 ${
        canDrag ? "cursor-grab" : ""
      } ${isOver ? "shadow-[inset_0_2px_0_var(--color-brand)]" : ""} ${
        isDragging ? "opacity-50" : ""
      }`}
    >
      {canDrag && <FaGripVertical aria-hidden className="size-3 text-ink3" />}

      {inlineId ? (
        <InlineEdit
          testId={`item-id-input-${itemKey}`}
          initial={String(item.id)}
          onCancel={() => setSel(null)}
          onCommit={(raw) => {
            // Synchronous stale-Save guard: if the relevant slice changed since the
            // form opened (temporal travel / external cascade), abort and let the
            // effect close the row — never write the stale rename (close-gate Major).
            if (isStale()) {
              setSel(null);
              return;
            }
            // Major 2/3 + Minor 2: unchanged RAW text is a no-op — preserve the
            // original TYPED id (numeric stays numeric; whitespace preserved) and
            // close the editor WITHOUT validating (no false duplicate against a
            // string sibling). Only genuinely changed text is validated/renamed.
            if (raw === String(item.id)) {
              setSel(null);
              return;
            }
            const check = validateInlineId(descriptor, items, groups, raw, false, item.id);
            if (!check.ok) {
              toast.error(check.message);
              return;
            }
            try {
              commit(renameItem(currentState(), descriptor, item.id, check.id));
              setSel(null);
            } catch (err) {
              toast.error(err instanceof RenameCollisionError ? err.message : "Rename failed.");
            }
          }}
        />
      ) : (
        <button
          type="button"
          data-testid={`item-id-text-${itemKey}`}
          className="font-medium"
          onDoubleClick={() => setSel({ t: "inline-item", key: itemKey, field: "id" })}
          title="Double-click to edit"
        >
          {String(item.id)}
        </button>
      )}

      {inlineDesc ? (
        <InlineEdit
          testId={`item-desc-input-${itemKey}`}
          initial={item.description ?? ""}
          onCancel={() => setSel(null)}
          onCommit={(raw) => {
            // Stale-Save guard (close-gate Major): abort if the relevant slice moved.
            if (isStale()) {
              setSel(null);
              return;
            }
            // Description commits the TRIMMED value (FR-ED-12); id preserves raw.
            commit(
              updateItemFields(currentState(), descriptor, item.id, {
                description: raw.trim() || undefined,
              } as Omit<Partial<TItem>, "id">),
            );
            setSel(null);
          }}
        />
      ) : (
        <button
          type="button"
          data-testid={`item-desc-text-${itemKey}`}
          className="text-meta text-ink2"
          onDoubleClick={() => setSel({ t: "inline-item", key: itemKey, field: "desc" })}
          title="Double-click to edit"
        >
          {item.description || "Add description…"}
        </button>
      )}

      {descriptor.supportsWorkingTime &&
        workingTimeSummary(pickWorkingTime(item as WorkingTimeItem)) && (
          <span className="font-mono text-label text-ink3">
            {workingTimeSummary(pickWorkingTime(item as WorkingTimeItem))}
          </span>
        )}

      {memberOf.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid={`item-groups-${itemKey}`}>
          {memberOf.map((g) => (
            <Badge key={g.id} variant="neutral">
              {g.id}
              <button
                type="button"
                aria-label={`Remove ${item.id} from ${g.id}`}
                data-testid={`item-group-remove-${itemKey}-${g.id}`}
                className="-mr-0.5 ml-0.5 inline-flex items-center text-ink3 hover:text-error"
                onClick={() =>
                  commit(toggleGroupMembership(currentState(), descriptor, g.id, item.id))
                }
              >
                <FaXmark aria-hidden />
              </button>
            </Badge>
          ))}
        </div>
      )}

      <div className="ml-auto flex items-center gap-1">
        <Button
          size="icon"
          variant="outline"
          aria-label={`Edit ${descriptor.labels.itemLower}`}
          data-testid={`item-edit-${itemKey}`}
          onClick={() => setSel({ t: "edit-item", key: itemKey })}
        >
          <FaPen />
        </Button>
        <Button
          size="icon"
          variant="outline"
          aria-label={`Duplicate ${descriptor.labels.itemLower}`}
          data-testid={`item-dup-${itemKey}`}
          onClick={() => commit(duplicateItem(currentState(), descriptor, item.id))}
        >
          <FaCopy />
        </Button>
        <Button
          size="icon"
          variant="outline"
          aria-label={`Delete ${descriptor.labels.itemLower}`}
          data-testid={`item-delete-${itemKey}`}
          className="text-error hover:bg-errortint"
          onClick={() => {
            setSel(null);
            commit(deleteItem(currentState(), descriptor, item.id));
          }}
        >
          <FaTrash />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / full-edit item form (shared)
// ---------------------------------------------------------------------------

function ItemForm<TItem extends EditorItemBase>({
  mode,
  descriptor,
  item,
  items,
  groups,
  commit,
  currentState,
  isStale,
  onDone,
}: {
  mode: "add" | "edit";
  descriptor: EntityDescriptor<TItem>;
  item?: TItem;
  items: TItem[];
  groups: EditorGroup[];
  commit: Commit;
  currentState: CurrentState;
  isStale: () => boolean;
  onDone: () => void;
}) {
  const prefix = mode === "add" ? "add-item" : `item-edit-${entityKey(item!.id)}`;
  const [id, setId] = React.useState(mode === "edit" ? String(item!.id) : "");
  const [description, setDescription] = React.useState(
    mode === "edit" ? (item!.description ?? "") : "",
  );
  const [workingTime, setWorkingTime] = React.useState<WorkingTimeValue>(
    mode === "edit" ? pickWorkingTime(item! as WorkingTimeItem) : {},
  );
  // Membership is a SET-model draft: the user's INTENDED final set of group ids for
  // this item, seeded from the live membership at form-open. It is NOT rebased while
  // open — an external/temporal membership change closes the whole form (see the
  // EntityEditor close-on-external-change effect), so the draft can never be silently
  // clobbered or saved stale (Major 1). Save writes the set idempotently against live.
  const [draftGroups, setDraftGroups] = React.useState<string[]>(
    mode === "edit"
      ? groups.filter((g) => g.members.some((m) => sameEntityId(m, item!.id))).map((g) => g.id)
      : [],
  );

  // Major 2/3: only a RAW change to the id text authors a new candidate. Unchanged
  // text preserves the original TYPED id VERBATIM (numeric `1` stays numeric; a
  // whitespace id `" P1 "` is not silently trimmed/renamed on an unrelated edit).
  const idChanged = mode === "add" || id !== String(item!.id);
  const currentId = mode === "edit" ? item!.id : undefined;
  const idCheck = idChanged
    ? validateFullEditId(descriptor, items, groups, id, false, currentId)
    : ({ ok: true, id } as const);
  const wtCheck = descriptor.supportsWorkingTime
    ? validateWorkingTimeDraft(workingTime)
    : { ok: true as const };
  const canSave = idCheck.ok && wtCheck.ok;

  const submit = () => {
    // Synchronous stale-Save guard (close-gate Major): if the item/group slice changed
    // since this form opened (undo/redo temporal travel, or an external cascade), abort
    // the write entirely — no commit, no history entry — and let the effect close the
    // form. Self-Save is never stale here: drafts don't mutate live, so the slice is
    // still the form-open token until this very commit. Keyed on the SAME predicate as
    // the visible-close effect, so unrelated durable meta churn does not trip it.
    if (isStale()) {
      onDone();
      return;
    }
    if (!idCheck.ok) {
      toast.error(idCheck.message);
      return;
    }
    if (descriptor.supportsWorkingTime && !validateWorkingTimeDraft(workingTime).ok) {
      toast.error("Fix the working-time errors first.");
      return;
    }
    try {
      if (mode === "add") {
        const extra = descriptor.supportsWorkingTime ? workingTimeExtra(workingTime) : undefined;
        let next = addItem(currentState(), descriptor, {
          id: idCheck.id,
          description: description.trim() || undefined,
          extra: extra as Omit<Partial<TItem>, "id" | "description"> | undefined,
        });
        next = writeItemGroups(next, descriptor, idCheck.id, draftGroups);
        commit(next);
        toast.success(`${descriptor.labels.item} “${idCheck.id}” added.`);
      } else {
        let next = currentState();
        // Unchanged raw id → keep the original typed id untouched (no rename cascade).
        let effectiveId: EntityId = item!.id;
        if (idChanged) {
          next = renameItem(next, descriptor, item!.id, idCheck.id);
          effectiveId = idCheck.id;
        }
        const patch: Record<string, unknown> = { description: description.trim() || undefined };
        if (descriptor.supportsWorkingTime) Object.assign(patch, workingTimePatch(workingTime));
        next = updateItemFields(next, descriptor, effectiveId, patch as Omit<Partial<TItem>, "id">);
        next = writeItemGroups(next, descriptor, effectiveId, draftGroups);
        commit(next);
        toast.success(`${descriptor.labels.item} “${String(effectiveId)}” saved.`);
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof RenameCollisionError ? err.message : "Save failed.");
    }
  };

  const onFormKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onDone();
    }
  };

  return (
    <div
      className="flex flex-col gap-3 border border-line bg-surface p-4"
      data-testid={mode === "add" ? "add-item-form" : `item-edit-form-${entityKey(item!.id)}`}
      onKeyDown={onFormKeyDown}
    >
      {mode === "add" && (
        <h3 className="font-heading text-cardhead font-semibold">
          Add New {descriptor.labels.item}
        </h3>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(8rem,16rem)_1fr]">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${prefix}-id`}>{descriptor.labels.item} ID</Label>
          <Input
            id={`${prefix}-id`}
            data-testid={`${prefix}-id`}
            value={id}
            autoFocus
            placeholder={`Enter ${descriptor.labels.itemLower} ID`}
            onChange={(e) => setId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            aria-invalid={!idCheck.ok}
          />
          {!idCheck.ok && id.length > 0 && (
            <span className="text-label text-error" role="alert">
              {idCheck.message}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${prefix}-desc`}>Description (optional)</Label>
          <Input
            id={`${prefix}-desc`}
            data-testid={`${prefix}-desc`}
            value={description}
            placeholder={`Enter ${descriptor.labels.itemLower} description (optional)`}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
      </div>

      {descriptor.supportsWorkingTime && (
        <WorkingTimeFields value={workingTime} onChange={setWorkingTime} idPrefix={prefix} />
      )}

      <div className="flex flex-col gap-1">
        <Label>Groups</Label>
        {groups.length === 0 ? (
          <span className="text-meta text-faint">No groups yet — add one below.</span>
        ) : (
          <div className="flex flex-wrap gap-2" data-testid={`${prefix}-groups`}>
            {groups.map((g) => {
              const on = draftGroups.includes(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  data-testid={`${prefix}-group-${g.id}`}
                  aria-pressed={on}
                  onClick={() =>
                    setDraftGroups((cur) =>
                      cur.includes(g.id) ? cur.filter((x) => x !== g.id) : [...cur, g.id],
                    )
                  }
                  className={`rounded-none border px-3 py-1 text-meta ${
                    on ? "border-brand bg-brand text-onbrand" : "border-line bg-surface text-ink2"
                  }`}
                >
                  {g.id}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={!canSave} data-testid={`${prefix}-save`}>
          <FaCheck />
          {mode === "add" ? `Add ${descriptor.labels.item}` : "Save"}
        </Button>
        <Button variant="outline" onClick={onDone} data-testid={`${prefix}-cancel`}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline editor (double-click id / description)
// ---------------------------------------------------------------------------

function InlineEdit({
  testId,
  initial,
  onCommit,
  onCancel,
}: {
  testId: string;
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = React.useState(initial);
  return (
    <Input
      data-testid={testId}
      className="h-8 max-w-[14rem]"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Groups section
// ---------------------------------------------------------------------------

function GroupsSection<TItem extends EditorItemBase>({
  descriptor,
  items,
  groups,
  commit,
  currentState,
  sel,
  setSel,
  isStale,
  editing,
}: SectionProps<TItem>) {
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overId, setOverId] = React.useState<string | null>(null);
  const canDrag = !editing;

  const onDrop = (targetId: string) => {
    const from = groups.findIndex((g) => g.id === dragId);
    const to = groups.findIndex((g) => g.id === targetId);
    setDragId(null);
    setOverId(null);
    if (from !== -1 && to !== -1 && from !== to) {
      commit(reorderGroups(currentState(), descriptor, from, to));
    }
  };

  const toggleAdd = () => setSel((cur) => (cur?.t === "add-group" ? null : { t: "add-group" }));

  return (
    <section className="flex flex-col gap-3" data-testid="groups-section">
      <div className="flex items-center gap-2">
        <h2 className="mr-auto font-heading text-cardhead font-semibold">Groups</h2>
        <Button
          variant="outline"
          onClick={toggleAdd}
          aria-pressed={sel?.t === "add-group"}
          data-testid="add-group-toggle"
        >
          <FaPlus />
          Group
        </Button>
      </div>

      {sel?.t === "add-group" && (
        <GroupForm
          mode="add"
          descriptor={descriptor}
          items={items}
          groups={groups}
          commit={commit}
          currentState={currentState}
          isStale={isStale}
          onDone={() => setSel(null)}
        />
      )}

      <div className="flex flex-col gap-2">
        {descriptor.syntheticGroups.map((row) => (
          <SyntheticRow key={row.id} id={row.id} description={row.description} />
        ))}
        {groups.length === 0 && descriptor.syntheticGroups.length === 0 && (
          <p className="border border-dashed border-line bg-surface p-4 text-meta text-ink2">
            No groups yet — add one above.
          </p>
        )}
        {groups.map((group) => (
          <GroupRow
            key={group.id}
            descriptor={descriptor}
            group={group}
            items={items}
            groups={groups}
            commit={commit}
            currentState={currentState}
            sel={sel}
            setSel={setSel}
            isStale={isStale}
            canDrag={canDrag}
            isOver={overId === group.id}
            isDragging={dragId === group.id}
            onDragStart={() => setDragId(group.id)}
            onDragOver={() => setOverId(group.id)}
            onDropRow={() => onDrop(group.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
          />
        ))}
      </div>
    </section>
  );
}

function GroupRow<TItem extends EditorItemBase>({
  descriptor,
  group,
  items,
  groups,
  commit,
  currentState,
  sel,
  setSel,
  isStale,
  canDrag,
  isOver,
  isDragging,
  onDragStart,
  onDragOver,
  onDropRow,
  onDragEnd,
}: {
  descriptor: EntityDescriptor<TItem>;
  group: EditorGroup;
  items: TItem[];
  groups: EditorGroup[];
  commit: Commit;
  currentState: CurrentState;
  sel: Sel;
  setSel: React.Dispatch<React.SetStateAction<Sel>>;
  isStale: () => boolean;
  canDrag: boolean;
  isOver: boolean;
  isDragging: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDropRow: () => void;
  onDragEnd: () => void;
}) {
  const isEditing = sel?.t === "edit-group" && sel.id === group.id;

  if (isEditing) {
    return (
      <div
        data-testid={`group-row-${group.id}`}
        className="border border-brand bg-brandtint/40 p-3"
      >
        <GroupForm
          mode="edit"
          descriptor={descriptor}
          group={group}
          items={items}
          groups={groups}
          commit={commit}
          currentState={currentState}
          isStale={isStale}
          onDone={() => setSel(null)}
        />
      </div>
    );
  }

  const memberCount = group.members.length;

  return (
    <div
      data-testid={`group-row-${group.id}`}
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
      className={`flex flex-col gap-2 border border-line bg-surface p-3 ${
        canDrag ? "cursor-grab" : ""
      } ${isOver ? "shadow-[inset_0_2px_0_var(--color-brand)]" : ""} ${
        isDragging ? "opacity-50" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {canDrag && <FaGripVertical aria-hidden className="size-3 text-ink3" />}
        <span data-testid={`group-id-text-${group.id}`} className="font-mono font-semibold">
          {group.id}
        </span>
        <Badge variant="neutral">
          {memberCount} member{memberCount === 1 ? "" : "s"}
        </Badge>
        {group.members.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {group.members.map((m) => (
              <Badge key={entityKey(m)} variant="outline">
                {String(m)}
                <button
                  type="button"
                  aria-label={`Remove ${String(m)} from ${group.id}`}
                  data-testid={`group-member-remove-${group.id}-${entityKey(m)}`}
                  className="-mr-0.5 ml-0.5 inline-flex items-center text-ink3 hover:text-error"
                  onClick={() =>
                    commit(toggleGroupMembership(currentState(), descriptor, group.id, m))
                  }
                >
                  <FaXmark aria-hidden />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon"
            variant="outline"
            aria-label="Edit group"
            data-testid={`group-edit-${group.id}`}
            onClick={() => setSel({ t: "edit-group", id: group.id })}
          >
            <FaPen />
          </Button>
          <Button
            size="icon"
            variant="outline"
            aria-label="Duplicate group"
            data-testid={`group-dup-${group.id}`}
            onClick={() => commit(duplicateGroup(currentState(), descriptor, group.id))}
          >
            <FaCopy />
          </Button>
          <Button
            size="icon"
            variant="outline"
            aria-label="Delete group"
            data-testid={`group-delete-${group.id}`}
            className="text-error hover:bg-errortint"
            onClick={() => {
              setSel(null);
              commit(deleteGroup(currentState(), descriptor, group.id));
            }}
          >
            <FaTrash />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / full-edit group form (shared). Group membership is a CONTROLLED DRAFT in
// BOTH modes: every transfer-list toggle and Add-all/Remove-all mutates only local
// draft state — nothing hits durable state until Save, so Cancel discards cleanly
// and Save applies id + description + membership in ONE composed `ScenarioUiState`
// and ONE commit (one zundo entry). Save writes the membership as a SET
// (`writeGroupMembers`, idempotent) against the live group, preserving the group's
// own unknown/nested members. The draft is NEVER rebased while open: an external /
// temporal change to the relevant slice closes the whole form (EntityEditor's
// close-on-external effect), and the synchronous `isStale` guard aborts a Save that
// races that close — so a stale draft can never be written (close-gate Major).
// ---------------------------------------------------------------------------

function GroupForm<TItem extends EditorItemBase>({
  mode,
  descriptor,
  group,
  items,
  groups,
  commit,
  currentState,
  isStale,
  onDone,
}: {
  mode: "add" | "edit";
  descriptor: EntityDescriptor<TItem>;
  group?: EditorGroup;
  items: TItem[];
  groups: EditorGroup[];
  commit: Commit;
  currentState: CurrentState;
  isStale: () => boolean;
  onDone: () => void;
}) {
  const [id, setId] = React.useState(mode === "edit" ? group!.id : "");
  const [description, setDescription] = React.useState(
    mode === "edit" ? (group!.description ?? "") : "",
  );

  // Membership is a SET-model draft: the user's INTENDED final set of real-item
  // members, seeded from the live group at form-open. It is NOT rebased while open —
  // an external/temporal membership change closes the whole form (EntityEditor
  // close-on-external-change effect), so the draft can never be clobbered or saved
  // stale (Major 1). Unknown/nested members are preserved by the SET write, not here.
  const [draftMembers, setDraftMembers] = React.useState<EntityId[]>(
    mode === "edit" ? group!.members.filter((m) => items.some((it) => sameEntityId(it.id, m))) : [],
  );

  // Major 3: gate on the RAW id text — a whitespace group id `" Team "` is preserved
  // verbatim on an unrelated (description/membership) edit; only genuinely changed
  // text authors a new candidate.
  const idChanged = mode === "add" || id !== group!.id;
  const currentId = mode === "edit" ? group!.id : undefined;
  const idCheck = idChanged
    ? validateFullEditId(descriptor, items, groups, id, true, currentId)
    : ({ ok: true, id: group!.id } as const);
  const testGroupId = mode === "edit" ? group!.id : "__new__";

  const toggleDraft = (memberId: EntityId) =>
    setDraftMembers((cur) =>
      cur.some((m) => sameEntityId(m, memberId))
        ? cur.filter((m) => !sameEntityId(m, memberId))
        : [...cur, memberId],
    );

  const save = () => {
    // Synchronous stale-Save guard (close-gate Major): abort if the item/group slice
    // moved since form-open (temporal travel / external cascade). Self-Save is never
    // stale here (drafts don't mutate live). Same predicate as the visible-close effect.
    if (isStale()) {
      onDone();
      return;
    }
    if (!idCheck.ok) {
      toast.error(idCheck.message);
      return;
    }
    try {
      let next = currentState();
      let gid: string;
      if (mode === "add") {
        next = addGroup(next, descriptor, {
          id: idCheck.id,
          description: description.trim() || undefined,
        });
        gid = idCheck.id;
      } else {
        gid = group!.id;
        if (idChanged) {
          next = renameGroup(next, descriptor, group!.id, idCheck.id);
          gid = idCheck.id;
        }
        next = updateGroupFields(next, descriptor, gid, {
          description: description.trim() || undefined,
        });
      }
      next = writeGroupMembers(next, descriptor, gid, draftMembers);
      commit(next);
      toast.success(`Group “${idCheck.id}” ${mode === "add" ? "added" : "saved"}.`);
      onDone();
    } catch (err) {
      toast.error(err instanceof RenameCollisionError ? err.message : "Save failed.");
    }
  };

  return (
    <div
      className="flex flex-col gap-3 border border-line bg-surface p-4"
      data-testid={mode === "add" ? "add-group-form" : `group-edit-form-${group!.id}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onDone();
        }
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`group-${testGroupId}-id`}>Group name</Label>
        <Input
          id={`group-${testGroupId}-id`}
          data-testid={mode === "add" ? "add-group-id" : `group-edit-id-${group!.id}`}
          value={id}
          autoFocus
          placeholder="Enter group ID"
          onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          aria-invalid={!idCheck.ok}
        />
        {idChanged && !idCheck.ok && id.length > 0 && (
          <span className="text-label text-error" role="alert">
            {idCheck.message}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`group-${testGroupId}-desc`}>Description (optional)</Label>
        <Input
          id={`group-${testGroupId}-desc`}
          data-testid={mode === "add" ? "add-group-desc" : `group-edit-desc-${group!.id}`}
          value={description}
          placeholder="Enter group description (optional)"
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label>Members</Label>
        <TransferList
          idPrefix={testGroupId}
          items={items.map((it) => ({
            value: it.id,
            label: it.description ? `${it.id} — ${it.description}` : String(it.id),
          }))}
          selected={draftMembers}
          onToggle={toggleDraft}
          keyOf={entityKey}
          sameValue={sameEntityId}
          selectedTitle="MEMBERS"
          selectedTestKey="members"
          searchPlaceholder="Search members"
          availableEmpty="Everyone's already a member."
          selectedEmpty="No members yet — pick from the left."
          addAria={(label) => `Add ${label} to group`}
          removeAria={(label) => `Remove ${label} from group`}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={!idCheck.ok} data-testid={`group-save-${testGroupId}`}>
          <FaCheck />
          {mode === "add" ? "Add group" : "Save"}
        </Button>
        <Button variant="outline" onClick={onDone} data-testid={`group-cancel-${testGroupId}`}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// People bulk upload dialog (.txt / .csv) — spec 03 FR-ED-29..32 / AC-ED-16..17
// ---------------------------------------------------------------------------

function UploadDialog<TItem extends EditorItemBase>({
  descriptor,
  commit,
  currentState,
  onClose,
}: {
  descriptor: EntityDescriptor<TItem>;
  commit: Commit;
  currentState: CurrentState;
  onClose: () => void;
}) {
  const onFile = async (file: File) => {
    const text = await file.text();
    if (text.trim() === "") {
      toast.error("No content found in the uploaded file.");
      return;
    }
    // Split on newlines; trim; drop blank lines and `#` comment lines (FR-ED-30).
    const names = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    if (names.length > 1000) {
      toast.error(
        `Uploaded file contains ${names.length} people, which exceeds the maximum of 1000. ` +
          `Please split the file and upload fewer names at a time.`,
      );
      return;
    }
    const result = reorderByUpload(currentState(), descriptor, names);
    if (!result.ok) {
      const message =
        result.error === "empty"
          ? "No people names found in the uploaded file."
          : result.error === "duplicate"
            ? `Duplicate person name "${result.name}" found in the uploaded list. ` +
              `Please remove duplicates.`
            : result.error === "reserved"
              ? `"${result.name}" is a reserved keyword and cannot be used as a name.`
              : `"${result.name}" is already used by an existing group.`;
      toast.error(message);
      return;
    }
    commit(result.state);
    toast.success(
      `Successfully uploaded ${names.length} people: ${result.reordered} existing people ` +
        `reordered, ${result.added} new people added, ${result.movedToEnd} existing people moved to end.`,
    );
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(8,10,14,0.5)]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Upload people list"
        data-testid="upload-dialog"
        className="w-[460px] max-w-[92vw] border border-line bg-surface shadow-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line2 px-4 py-3">
          <h3 className="font-heading text-cardhead font-semibold">Upload people list</h3>
          <Button size="icon" variant="outline" aria-label="Close" onClick={onClose}>
            <FaXmark />
          </Button>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-meta text-ink2">
            One name per line (<code className="font-mono">.txt</code> /{" "}
            <code className="font-mono">.csv</code>). Existing people are reordered to match the
            file, new names are added, and any not listed move to the end. Lines starting with{" "}
            <code className="font-mono">#</code> are skipped.
          </p>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 border border-dashed border-line bg-panel p-6 text-center hover:border-brand">
            <FaFileArrowUp className="size-6 text-ink3" />
            <span className="font-medium text-meta">Choose a .txt / .csv file</span>
            <input
              type="file"
              accept=".txt,.csv"
              data-testid="upload-file-input"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
              }}
            />
          </label>
        </div>
      </div>
    </div>
  );
}
