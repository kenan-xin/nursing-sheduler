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
// V2 RE-SKIN (R2a's sibling, R2b). Surfaces, in ladder order (DESIGN.md §4): the
// screen root is the L0 page plane; the table container is a resting L1 `surface`
// on the card radius that CLIPS its own scroll region; the column header row is a
// full-bleed square `band`; the open inline editor row is the shared `selected`
// role. Every action is a shared `Button` — the last `.ns-btn` consumer in the app
// left with this ticket, and the rule it depended on was deleted with it. Data
// structure stays square throughout: the table, its rows and its cells never round.
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
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Surface, surfaceVariants } from "@/components/ui/surface";
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
  autoGroupNote:
    "Every nurse, always. Generated automatically — use it in rules that target the whole ward.",
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
    <Surface
      level="page"
      geometry="square"
      data-testid="screen"
      data-screen="Staff"
      className="flex flex-col gap-4"
    >
      <header className="mb-2 flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          <div className="mb-2 text-label font-semibold uppercase tracking-[0.03em] text-brandink">
            Step 2 · Staff
          </div>
          {/* Display: Figtree 700 / 1.15 / -0.015em (DESIGN.md §3). v1 ran 800 at
              1.05 and -0.02em; v2 is one weight step lighter with an opener line.
              Copy and wrapping are unchanged. */}
          <h1 className="mb-2 font-heading text-display font-bold leading-[1.15] tracking-[-0.015em]">
            Your Ward Staff
          </h1>
          <p className="max-w-[60ch] text-ink2">
            List your nurses, then bundle them into groups (like Seniors or Team A) so rules can
            target a whole team at once.
          </p>
        </div>
        {/* Still a real `<a href>`, so copy-link and open-in-new-tab keep working and
            the shell's draft guard still stages on a plain click. It wears the shared
            Button recipe instead of the retired `.ns-btn` fork, so the pill, `--sh-1`,
            active-flatten, focus outline and 44px coarse floor come from one contract.
            `lg` is the prototype's 44px primary action (ScreenStaff.dc.html:12). */}
        <GuardedLink
          href="/shift-types"
          className={cn(buttonVariants({ size: "lg" }), "font-bold")}
          data-testid="people-continue"
        >
          Continue to shifts <FaArrowRight />
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
            <FaMagnifyingGlass
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-3 -translate-y-1/2 text-ink3"
            />
            <Input
              data-testid="people-search"
              className="pl-8 pr-9 pointer-coarse:pr-14"
              placeholder="Search nurses"
              aria-label="Search nurses"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {q && (
              // A real control, sized honestly: 16px beside a 36px field on a precise
              // pointer, a true 44x44 box on a coarse one (the field's own padding
              // grows with it). No pseudo-element hitbox — v2 technical plan T8.
              <button
                type="button"
                aria-label="Clear search"
                data-testid="people-search-clear"
                className="absolute right-2 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded-full text-ink3 pointer-coarse:size-touch hover:text-ink"
                onClick={() => setQuery("")}
              >
                <FaXmark aria-hidden className="size-3" />
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

      {/* Table container: a resting L1 card whose own scroll region ends the card,
          so it takes the card radius and CLIPS to it (DESIGN.md §4 rule 3). Everything
          inside — the header band, every row, every cell — stays square. */}
      <div
        data-testid="people-table-wrap"
        className={cn(
          "w-full overflow-x-auto",
          surfaceVariants({ role: "surface", geometry: "card" }),
        )}
      >
        <table data-testid="people-table" className="w-full min-w-[520px] border-collapse">
          <caption className="sr-only">
            Ward staff — each nurse, the groups they belong to, and row actions.
          </caption>
          <thead>
            {/* Full-bleed header band: square and flat by contract — a band that spans
                the whole card never takes a chip radius or a well shadow. */}
            <tr className={surfaceVariants({ role: "band", geometry: "square" })}>
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
                      <div className="flex size-11 items-center justify-center border border-dashed border-line2 text-ink3">
                        <FaMagnifyingGlass aria-hidden />
                      </div>
                      {/* Title: 600 at -0.015em (DESIGN.md §3). The prototype draws it
                          at 700; the type contract outranks a prototype weight. */}
                      <div className="font-heading text-title font-semibold tracking-[-0.015em] text-ink2">
                        No matches
                      </div>
                      <div className="text-meta text-ink3">No nurses match “{query.trim()}”.</div>
                      <Button
                        variant="link"
                        size="sm"
                        data-testid="people-empty-clear"
                        onClick={() => setQuery("")}
                      >
                        Clear search
                      </Button>
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
    </Surface>
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
      // Row states, all on canonical tokens. Hover is `--panel-alt`, NOT `--panel`:
      // DESIGN.md §6 reserves the well tone for header bands and true insets, and
      // the prototype's `--panel` row hover would collide with the header band
      // directly above it. The drop candidate speaks the shared `drop-target`
      // LANGUAGE — a dashed `--brand` edge over `--panel-alt` — rather than the
      // recipe role itself: a `<tr>` in the collapsed-border model paints no
      // box-shadow, so the role's `--sh-2` would be a claim the browser never
      // honours, and the recipe cannot share a class list with the hover tone
      // (`surface-contract.test.ts` holds a consumer's className to layout only).
      // This replaces the v1 `shadow-[inset_0_2px_0_...]` arbitrary elevation.
      className={cn(
        "border-t border-line2 transition-colors duration-fast",
        canDrag && "cursor-grab",
        isDragging && "opacity-50",
        isOver ? "border-dashed border-brand bg-panel-alt" : "hover:bg-panel-alt",
      )}
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
              /* Group NAMES render as authored (prototype chips are not uppercased). */
              <Badge key={g.id} variant="neutral" className="normal-case">
                {g.id}
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
          {/* The destructive affordance is a VARIANT, not a caller-owned colour
              override: `destructive-outline` is the paired outline treatment
              (`--errorink` on `--surface`, `--errortint` on hover) the prototype
              draws at ScreenStaff.dc.html:62. */}
          <Button
            size="icon"
            variant="destructive-outline"
            aria-label={`Delete ${item.id}`}
            data-testid={`people-delete-${itemKey}`}
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
    // The open editor row IS the active editor, so it takes the shared `selected`
    // role: `--surface` under a `--brand` border. The prototype washes it in
    // `--brandtint`, which DESIGN.md §6 reserves for the selection MARKS (the
    // brand-filled group toggles sitting inside this very row would disappear into
    // it). Same call R2a recorded for the previewed date-group row.
    <tr
      data-testid={`people-edit-row-${key}`}
      className={surfaceVariants({ role: "selected", geometry: "square" })}
    >
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
            className="mt-1.5 text-label font-semibold text-errorink"
          >
            {check.message}
          </div>
        )}
      </td>
      <td className="px-3 py-3 align-top">
        {groups.length === 0 ? (
          <span className="text-meta text-ink3">No groups yet — add one below.</span>
        ) : (
          // Named group, so a screen-reader user entering this cell hears WHOSE
          // memberships these toggles are rather than a bare run of pressed buttons.
          <div
            role="group"
            aria-label={`Groups for ${mode === "edit" ? String(item!.id) : "the new nurse"}`}
            className="flex flex-wrap gap-1.5"
            data-testid={`people-group-toggles-${key}`}
          >
            {groups.map((g) => {
              const on = draftGroups.includes(g.id);
              return (
                // A membership toggle is a real action, so it is a shared Button
                // rather than a hand-skinned 2px-radius chip: the pill, the paired
                // `--onbrand` foreground on the brand fill, the focus outline and the
                // 44px coarse floor all arrive from one contract. `aria-pressed`
                // carries the on/off state it always did.
                <Button
                  key={g.id}
                  size="sm"
                  variant={on ? "default" : "secondary"}
                  data-testid={`people-group-${key}-${g.id}`}
                  aria-pressed={on}
                  onClick={() =>
                    setDraftGroups((cur) =>
                      cur.includes(g.id) ? cur.filter((x) => x !== g.id) : [...cur, g.id],
                    )
                  }
                >
                  {g.id}
                </Button>
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
