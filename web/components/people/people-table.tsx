"use client";

// Staff screen — bespoke nurse table (DR-2). Prototype: docs/design_prototype/
// ScreenStaff.dc.html. A real `<table>` (# / Nurse / Group / Actions,
// min-width:520px, horizontal-scroll wrapper), NOT the generic stacked-list
// `EntityEditor`. It consumes the same pure `entity-editor/core/*` transforms and
// the shared `GroupsSection` (Staff copy) directly — retiring the generic editor
// for People (EntityEditor deletion is DR-5).
//
// Interaction model (prototype-faithful):
//   • read row: ordinal, avatar-initials + name, group chips, Edit/Duplicate/Delete;
//   • INLINE-ROW edit (no separate form panel): a name input in the Nurse cell,
//     group toggle chips in the Group cell, Save/Cancel in Actions;
//   • the inline "name" maps to `UiPerson.id`; an existing `description` is PRESERVED
//     verbatim through a name/group edit (never written from the table);
//   • drag-reorder rows, gated off while searching OR editing (`!query && !editing`),
//     with an Up/Down keyboard fallback (drag alone has no keyboard path);
//   • "Add nurse" opens an inline draft row; "Upload list" opens the extracted
//     `UploadDialog`; search has a clear button and a live result count; a "No
//     matches" empty state offers Clear-search.
//
// Store discipline (T04): every action feeds ONE produced `ScenarioUiState` to one
// `mutateScenario` (one patch ⇒ one zundo entry). A compound inline edit (rename +
// membership) composes the pure core transforms and commits once. Rename/delete
// route through the T07 cascade so group refs follow; a `RenameCollisionError`
// surfaces as a toast. A single active selection (`sel`) spans the row table and the
// groups section, so opening one form closes the other; a form-open token drives the
// synchronous stale-Save guard and the close-on-external-change effect, exactly like
// the generic editor it replaces.

import * as React from "react";
import { toast } from "sonner";
import { useScenarioStore } from "@/lib/store";
import { useLosableDraft } from "@/components/shell/use-losable-draft";
import { GuardedLink } from "@/components/shell/guarded-link";
import type { ScenarioUiState, UiPerson } from "@/lib/scenario";
import { RenameCollisionError } from "@/lib/cascade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  FaPlus,
  FaFileArrowUp,
  FaMagnifyingGlass,
  FaXmark,
  FaPen,
  FaCopy,
  FaTrash,
  FaCheck,
  FaGripVertical,
  FaChevronUp,
  FaChevronDown,
  FaArrowRight,
} from "@/components/icons";
import {
  addItem,
  deleteItem,
  duplicateItem,
  reorderItems,
  renameItem,
  toggleGroupMembership,
  validateFullEditId,
  entityKey,
  sameEntityId,
  type EntityDescriptor,
  type EntityId,
  type EditorGroup,
} from "@/components/entity-editor/core";
import { GroupsSection, type GroupsSectionConfig } from "@/components/entity-editor/groups-section";
import { peopleDescriptor } from "./people-descriptor";
import { UploadDialog } from "./upload-dialog";

type Commit = (next: ScenarioUiState) => void;
type CurrentState = () => ScenarioUiState;

const descriptor: EntityDescriptor<UiPerson> = peopleDescriptor;

/** Single active selection across the row table AND the groups section. */
type Sel =
  | null
  | { t: "add-item" }
  | { t: "edit-item"; key: string }
  | { t: "add-group" }
  | { t: "edit-group"; id: string };

/** Staff-voiced copy for the shared groups section (member search on, MEMBERS pane,
 *  "N members" count — all defaults; heading/empty carry the ward-staff voice). */
const STAFF_GROUPS_CONFIG: GroupsSectionConfig = {
  heading: "Staff groups",
  addLabel: "Group",
  emptyText:
    "No staff groups yet — bundle nurses into a team (like Seniors or Team A) so a rule can target them all at once.",
};

/** Avatar initials from a nurse name (prototype `init`): up to two leading letters. */
function initialsOf(id: EntityId): string {
  return (
    String(id)
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "—"
  );
}

export function PeopleTable() {
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
  // Drag identity is the source INDEX (held in React state, not the DataTransfer) so
  // native drag works under synthetic events; drag is only enabled with no filter, so a
  // filtered index equals its index in the full list.
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);
  const [overIndex, setOverIndex] = React.useState<number | null>(null);

  const editing = sel !== null;
  useLosableDraft(`people:${descriptor.domain}`, editing, "Staff editor");

  // Form-open token: capture the item/group slice a form was formed against, held
  // ACROSS rerenders. `isStale` re-reads live and reports whether that slice moved
  // (undo/redo travel or an external cascade). Shared by the close-on-external effect
  // AND every submit handler, so "what closes the form" == "what blocks a stale Save".
  const openToken = React.useRef<{ items: UiPerson[]; groups: EditorGroup[] } | null>(null);
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
  }, []);
  React.useEffect(() => {
    if (editing && isStale()) setSel(null);
  });

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter(
        (it) =>
          String(it.id).toLowerCase().includes(q) ||
          (it.description ?? "").toLowerCase().includes(q),
      )
    : items;
  const canDrag = !editing && !q;

  const addOpen = sel?.t === "add-item";
  const editingItemKey = sel?.t === "edit-item" ? sel.key : null;

  const onDropRow = (to: number) => {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from != null && from !== to) commit(reorderItems(currentState(), descriptor, from, to));
  };

  // Live result count for the search (a11y): "N nurses" or "N of M nurses match".
  const countLabel = q
    ? `${filtered.length} of ${items.length} ${items.length === 1 ? "nurse" : "nurses"} match “${query.trim()}”`
    : `${items.length} ${items.length === 1 ? "nurse" : "nurses"}`;

  return (
    <div
      data-testid="screen"
      data-screen="Staff"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-5 py-8"
    >
      <header className="mb-2 flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          <div className="mb-2 text-label font-semibold uppercase tracking-[0.03em] text-brandink">
            Step 2 · Staff
          </div>
          <h1 className="mb-2 font-heading text-display font-extrabold leading-[1.05] tracking-[-0.02em]">
            Your Ward Staff
          </h1>
          <p className="max-w-[60ch] text-ink2">
            List your nurses, then bundle them into groups (like Seniors or Team A) so rules can
            target a whole team at once.
          </p>
        </div>
        <GuardedLink
          href="/shift-types"
          className="ns-btn ns-btn--primary h-11 px-5 text-body"
          data-testid="people-continue"
        >
          Continue to shifts <FaArrowRight className="size-3" />
        </GuardedLink>
      </header>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => setSel((cur) => (cur?.t === "add-item" ? null : { t: "add-item" }))}
          aria-pressed={addOpen}
          data-testid="people-add"
        >
          <FaPlus />
          Add nurse
        </Button>
        <Button variant="outline" onClick={() => setUploadOpen(true)} data-testid="people-upload">
          <FaFileArrowUp />
          Upload list
        </Button>
        <div className="ml-auto flex flex-col items-end gap-1">
          <div className="relative w-full max-w-xs">
            <FaMagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 size-3 -translate-y-1/2 text-ink3" />
            <Input
              data-testid="people-search"
              className="pl-8 pr-8"
              placeholder="Search nurses"
              aria-label="Search nurses"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {q && (
              <button
                type="button"
                aria-label="Clear search"
                data-testid="people-search-clear"
                className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center text-ink3 hover:text-ink"
                onClick={() => setQuery("")}
              >
                <FaXmark aria-hidden />
              </button>
            )}
          </div>
          <p
            role="status"
            aria-live="polite"
            data-testid="people-count"
            className="text-label text-ink3"
          >
            {countLabel}
          </p>
        </div>
      </div>

      {/* Table (horizontal-scroll wrapper) */}
      <div
        data-testid="people-table-wrap"
        className="w-full overflow-x-auto border border-line bg-surface"
      >
        <table data-testid="people-table" className="w-full min-w-[520px] border-collapse">
          <caption className="sr-only">
            Ward staff — each nurse, the groups they belong to, and row actions.
          </caption>
          <thead>
            <tr className="bg-panel">
              <th
                scope="col"
                className="w-10 px-3 py-2.5 text-left text-label font-semibold uppercase tracking-[0.03em] text-ink2"
              >
                #
              </th>
              <th
                scope="col"
                className="px-3 py-2.5 text-left text-label font-semibold uppercase tracking-[0.03em] text-ink2"
              >
                Nurse
              </th>
              <th
                scope="col"
                className="px-3 py-2.5 text-left text-label font-semibold uppercase tracking-[0.03em] text-ink2"
              >
                Group
              </th>
              <th
                scope="col"
                className="w-[130px] px-3 py-2.5 text-right text-label font-semibold uppercase tracking-[0.03em] text-ink2"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {addOpen && (
              <RowEditor
                mode="add"
                ordinal={items.length + 1}
                items={items}
                groups={groups}
                commit={commit}
                currentState={currentState}
                isStale={isStale}
                onDone={() => setSel(null)}
              />
            )}
            {filtered.map((item, index) => {
              const key = entityKey(item.id);
              if (editingItemKey === key) {
                return (
                  <RowEditor
                    key={key}
                    mode="edit"
                    item={item}
                    ordinal={index + 1}
                    items={items}
                    groups={groups}
                    commit={commit}
                    currentState={currentState}
                    isStale={isStale}
                    onDone={() => setSel(null)}
                  />
                );
              }
              return (
                <ReadRow
                  key={key}
                  itemKey={key}
                  item={item}
                  ordinal={index + 1}
                  groups={groups}
                  commit={commit}
                  currentState={currentState}
                  canDrag={canDrag}
                  canReorder={canDrag && filtered.length > 1}
                  isFirst={index === 0}
                  isLast={index === filtered.length - 1}
                  onEdit={() => setSel({ t: "edit-item", key })}
                  onMoveUp={() =>
                    commit(reorderItems(currentState(), descriptor, index, index - 1))
                  }
                  onMoveDown={() =>
                    commit(reorderItems(currentState(), descriptor, index, index + 1))
                  }
                  onDelete={() => {
                    setSel(null);
                    commit(deleteItem(currentState(), descriptor, item.id));
                  }}
                  isOver={overIndex === index}
                  isDragging={dragIndex === index}
                  onDragStart={() => setDragIndex(index)}
                  onDragOver={() => setOverIndex(index)}
                  onDropRow={() => onDropRow(index)}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                />
              );
            })}
            {filtered.length === 0 && !addOpen && (
              <tr>
                <td colSpan={4} className="px-3 py-12">
                  {q ? (
                    <div
                      data-testid="people-empty"
                      className="flex flex-col items-center gap-2 text-center"
                    >
                      <div className="flex size-11 items-center justify-center border border-dashed border-line2 text-faint">
                        <FaMagnifyingGlass />
                      </div>
                      <div className="font-heading text-title font-bold text-ink2">No matches</div>
                      <div className="text-meta text-ink3">No nurses match “{query.trim()}”.</div>
                      <button
                        type="button"
                        data-testid="people-empty-clear"
                        className="mt-1 text-meta font-semibold text-brandink hover:underline"
                        onClick={() => setQuery("")}
                      >
                        Clear search
                      </button>
                    </div>
                  ) : (
                    <p data-testid="people-empty" className="text-center text-meta text-ink3">
                      No nurses yet — add your first with “Add nurse”.
                    </p>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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
        config={STAFF_GROUPS_CONFIG}
      />

      {uploadOpen && (
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
// Read row (not editing)
// ---------------------------------------------------------------------------

function ReadRow({
  itemKey,
  item,
  ordinal,
  groups,
  commit,
  currentState,
  canDrag,
  canReorder,
  isFirst,
  isLast,
  onEdit,
  onMoveUp,
  onMoveDown,
  onDelete,
  isOver,
  isDragging,
  onDragStart,
  onDragOver,
  onDropRow,
  onDragEnd,
}: {
  itemKey: string;
  item: UiPerson;
  ordinal: number;
  groups: EditorGroup[];
  commit: Commit;
  currentState: CurrentState;
  canDrag: boolean;
  canReorder: boolean;
  isFirst: boolean;
  isLast: boolean;
  onEdit: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  isOver: boolean;
  isDragging: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDropRow: () => void;
  onDragEnd: () => void;
}) {
  const memberOf = groups.filter((g) => g.members.some((m) => sameEntityId(m, item.id)));

  return (
    <tr
      data-testid={`people-row-${itemKey}`}
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
      className={`border-t border-line2 hover:bg-panel ${canDrag ? "cursor-grab" : ""} ${
        isOver ? "shadow-[inset_0_2px_0_var(--color-brand)]" : ""
      } ${isDragging ? "opacity-50" : ""}`}
    >
      <td className="px-3 py-2.5 font-mono text-meta text-ink3">
        <span className="inline-flex items-center gap-1.5">
          {canDrag && <FaGripVertical aria-hidden className="size-3 text-ink3" />}
          {ordinal}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex size-[30px] flex-none items-center justify-center border border-line2 bg-panel font-mono text-meta font-semibold text-ink2"
          >
            {initialsOf(item.id)}
          </span>
          <span data-testid={`people-name-${itemKey}`} className="font-semibold">
            {String(item.id)}
          </span>
        </div>
      </td>
      <td className="px-3 py-2.5">
        {memberOf.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" data-testid={`people-groups-${itemKey}`}>
            {memberOf.map((g) => (
              <Badge key={g.id} variant="neutral">
                {g.id}
                <button
                  type="button"
                  aria-label={`Remove ${item.id} from ${g.id}`}
                  data-testid={`people-group-remove-${itemKey}-${g.id}`}
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
        ) : (
          <span className="text-meta text-faint">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <div className="inline-flex items-center gap-1">
          {canReorder && (
            <>
              <Button
                size="icon"
                variant="outline"
                aria-label={`Move ${item.id} up`}
                data-testid={`people-move-up-${itemKey}`}
                disabled={isFirst}
                onClick={onMoveUp}
              >
                <FaChevronUp />
              </Button>
              <Button
                size="icon"
                variant="outline"
                aria-label={`Move ${item.id} down`}
                data-testid={`people-move-down-${itemKey}`}
                disabled={isLast}
                onClick={onMoveDown}
              >
                <FaChevronDown />
              </Button>
            </>
          )}
          <Button
            size="icon"
            variant="outline"
            aria-label={`Edit ${item.id}`}
            data-testid={`people-edit-${itemKey}`}
            onClick={onEdit}
          >
            <FaPen />
          </Button>
          <Button
            size="icon"
            variant="outline"
            aria-label={`Duplicate ${item.id}`}
            data-testid={`people-dup-${itemKey}`}
            onClick={() => commit(duplicateItem(currentState(), descriptor, item.id))}
          >
            <FaCopy />
          </Button>
          <Button
            size="icon"
            variant="outline"
            aria-label={`Delete ${item.id}`}
            data-testid={`people-delete-${itemKey}`}
            className="text-error hover:bg-errortint"
            onClick={onDelete}
          >
            <FaTrash />
          </Button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Inline row editor (add + edit) — no separate form panel
// ---------------------------------------------------------------------------

function RowEditor({
  mode,
  item,
  ordinal,
  items,
  groups,
  commit,
  currentState,
  isStale,
  onDone,
}: {
  mode: "add" | "edit";
  item?: UiPerson;
  ordinal: number;
  items: UiPerson[];
  groups: EditorGroup[];
  commit: Commit;
  currentState: CurrentState;
  isStale: () => boolean;
  onDone: () => void;
}) {
  const key = mode === "edit" ? entityKey(item!.id) : "__new__";
  const [name, setName] = React.useState(mode === "edit" ? String(item!.id) : "");
  // Membership is a SET-model draft seeded from the live group slice at form-open. It
  // is NOT rebased while open — an external/temporal change closes the whole form
  // (parent close-on-external effect), so the draft can never be written stale.
  const [draftGroups, setDraftGroups] = React.useState<string[]>(
    mode === "edit"
      ? groups.filter((g) => g.members.some((m) => sameEntityId(m, item!.id))).map((g) => g.id)
      : [],
  );

  // Only a genuinely changed name authors a new candidate id; unchanged text preserves
  // the original TYPED id verbatim (numeric stays numeric; whitespace preserved).
  const nameChanged = mode === "add" || name !== String(item!.id);
  const currentId = mode === "edit" ? item!.id : undefined;
  // When the name is unchanged the original TYPED id is kept verbatim (no rename), so
  // `check.id` here is unused for mutation; keep it a `string` to match the changed path.
  const check = nameChanged
    ? validateFullEditId(descriptor, items, groups, name, false, currentId)
    : ({ ok: true, id: name } as const);
  const canSave = check.ok;

  const submit = () => {
    // Synchronous stale-Save guard: abort entirely if the item/group slice moved since
    // the form opened (temporal travel / external cascade); the effect closes the row.
    if (isStale()) {
      onDone();
      return;
    }
    if (!check.ok) {
      toast.error(check.message);
      return;
    }
    try {
      if (mode === "add") {
        // New nurse: name → id, no description authored here. history:[] via descriptor.
        let next = addItem(currentState(), descriptor, { id: check.id });
        next = writeGroups(next, check.id, draftGroups);
        commit(next);
        toast.success(`Nurse “${String(check.id)}” added.`);
      } else {
        let next = currentState();
        let effectiveId: EntityId = item!.id;
        // Rename cascade only when the name actually changed. Description is PRESERVED
        // (never written from the table), so an inline name/group edit keeps it intact.
        if (nameChanged) {
          next = renameItem(next, descriptor, item!.id, check.id);
          effectiveId = check.id;
        }
        next = writeGroups(next, effectiveId, draftGroups);
        commit(next);
        toast.success(`Nurse “${String(effectiveId)}” saved.`);
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof RenameCollisionError ? err.message : "Save failed.");
    }
  };

  return (
    <tr data-testid={`people-edit-row-${key}`} className="border-t border-line2 bg-brandtint/40">
      <td className="px-3 py-3 align-top font-mono text-meta text-ink3">{ordinal}</td>
      <td className="px-3 py-3 align-top">
        <Input
          data-testid={`people-name-input-${key}`}
          value={name}
          autoFocus
          placeholder="Nurse name"
          aria-label="Nurse name"
          aria-invalid={!check.ok}
          className="max-w-[280px] font-semibold"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") {
              e.preventDefault();
              onDone();
            }
          }}
        />
        {!check.ok && name.length > 0 && (
          <div
            role="alert"
            data-testid={`people-name-error-${key}`}
            className="mt-1.5 text-label font-semibold text-error"
          >
            {check.message}
          </div>
        )}
      </td>
      <td className="px-3 py-3 align-top">
        {groups.length === 0 ? (
          <span className="text-meta text-faint">No groups yet — add one below.</span>
        ) : (
          <div className="flex flex-wrap gap-1.5" data-testid={`people-group-toggles-${key}`}>
            {groups.map((g) => {
              const on = draftGroups.includes(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  data-testid={`people-group-${key}-${g.id}`}
                  aria-pressed={on}
                  onClick={() =>
                    setDraftGroups((cur) =>
                      cur.includes(g.id) ? cur.filter((x) => x !== g.id) : [...cur, g.id],
                    )
                  }
                  className={`border px-2.5 py-1 text-label font-semibold ${
                    on ? "border-brand bg-brand text-onbrand" : "border-line bg-surface text-ink2"
                  }`}
                >
                  {g.id}
                </button>
              );
            })}
          </div>
        )}
      </td>
      <td className="px-3 py-3 text-right align-top">
        <div className="inline-flex gap-1.5">
          <Button onClick={submit} disabled={!canSave} data-testid={`people-save-${key}`}>
            <FaCheck />
            Save
          </Button>
          <Button
            size="icon"
            variant="outline"
            aria-label="Cancel"
            data-testid={`people-cancel-${key}`}
            onClick={onDone}
          >
            <FaXmark />
          </Button>
        </div>
      </td>
    </tr>
  );
}

/**
 * Write an item's membership to EXACTLY `desiredGroupIds` (SET model, idempotent):
 * for every live group, add or remove to match the desired set. Preserves any group's
 * unknown/nested members (only this item's membership is touched).
 */
function writeGroups(
  state: ScenarioUiState,
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
