"use client";

// Shared, reusable groups section (DR-1) — extracted verbatim-in-behavior from the
// monolithic entity-editor. It renders the auto-`ALL` read-only card, the custom
// group cards, and the inline transfer-list membership editor over the generic
// `TransferList` + the pure group-mutation core. People and Shift Types both drive
// it (today through `EntityEditor`; the bespoke `PeopleTable` / `ShiftTypeGrid`
// screens adopt it directly in later tickets).
//
// It is parameterized by copy + explicit flags/optional slots (NOT copy-only), so
// the Staff/Shift divergence is expressible without a false "identical" abstraction:
//   • `showMemberSearch` — Staff shows the transfer-list search box, Shifts hides it
//     (ScreenStaff.dc.html:167-173);
//   • `selectedPaneLabel` — the selected pane reads `MEMBERS` (Staff) vs `IN GROUP`
//     (Shift);
//   • `formatCount` — the per-group count noun (`N members` vs `N TYPES`);
//   • `autoGroupNote` — the reserved auto-group's explanation.
// Every option defaults to today's People/Shift behavior so a consumer that passes
// no config (as `EntityEditor` does) is byte-for-byte unchanged.
//
// EXTRACTION CONTRACT (parity preserved — the section was never standalone):
//   • controlled single-draft edit; atomic Save = ONE composed `ScenarioUiState` +
//     ONE commit (one zundo entry); Cancel discards with no commit;
//   • the owner's `isStale` guard aborts a stale Save and the owner closes the draft
//     on any external membership/rename change (no stale write-back);
//   • exact typed member identity (numeric `1` ≠ string `"1"`);
//   • unknown/nested members preserved through an edit (SET write);
//   • reserved auto-group (`ALL`) rendered read-only/locked.
// Selection is owned by the parent (single active selection across the whole editor)
// and threaded in via `addOpen` / `editingGroupId` + the `onToggleAdd` /
// `onEditGroup` / `onCloseForm` callbacks, so opening a group form still closes any
// open item form and keeps the parent's losable-draft + stale token accurate.

import * as React from "react";
import { toast } from "sonner";
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
  FaChevronUp,
  FaChevronDown,
} from "@/components/icons";
import {
  addGroup,
  deleteGroup,
  duplicateGroup,
  reorderGroups,
  renameGroup,
  setGroupMembers,
  toggleGroupMembership,
  updateGroupFields,
  validateFullEditId,
  entityKey,
  sameEntityId,
  type EntityDescriptor,
  type EntityId,
  type EditorGroup,
  type EditorItemBase,
} from "./core";
import { TransferList } from "./transfer-list";

type Commit = (next: ScenarioUiState) => void;
type CurrentState = () => ScenarioUiState;

// ---------------------------------------------------------------------------
// Public config — copy + explicit flags. Every field is optional and defaults to
// today's People/Shift behavior (so `EntityEditor` passes nothing and is unchanged).
// ---------------------------------------------------------------------------

export interface GroupsSectionConfig {
  /** Section heading. Default `"Groups"`. */
  heading?: string;
  /** Add-button label. Default `"Group"`. */
  addLabel?: string;
  /** Empty-state copy when no custom or synthetic groups exist. */
  emptyText?: string;
  /**
   * Show the member-search box inside the transfer list. Staff → true; Shift →
   * false (ScreenShifts has no member search). Default `true`.
   */
  showMemberSearch?: boolean;
  /** Selected-pane title in the transfer list. `MEMBERS` (Staff) / `IN GROUP` (Shift). */
  selectedPaneLabel?: string;
  /** Testid fragment for the selected pane (`transfer-<key>-<id>`). Default `"members"`. */
  selectedTestKey?: string;
  /** Placeholder for the transfer-list member search. Default `"Search members"`. */
  memberSearchPlaceholder?: string;
  /** Empty message for the available pane. */
  availableEmpty?: string;
  /** Empty message for the selected pane. */
  selectedEmpty?: string;
  /** aria-label for an add-member row. Default `Add <label> to group`. */
  addMemberAria?: (label: string) => string;
  /** aria-label for a remove-member row. Default `Remove <label> from group`. */
  removeMemberAria?: (label: string) => string;
  /** Format the per-group count badge. Default `N member(s)`. Shift → `N TYPES`. */
  formatCount?: (count: number) => string;
  /**
   * Explanation shown on the reserved auto-group. When omitted, each synthetic
   * group's own `description` is used (today's behavior).
   */
  autoGroupNote?: string;
}

/** Config with every default resolved — the shape threaded to the sub-components. */
interface ResolvedConfig {
  heading: string;
  addLabel: string;
  emptyText: string;
  showMemberSearch: boolean;
  selectedPaneLabel: string;
  selectedTestKey: string;
  memberSearchPlaceholder: string;
  availableEmpty: string;
  selectedEmpty: string;
  addMemberAria: (label: string) => string;
  removeMemberAria: (label: string) => string;
  formatCount: (count: number) => string;
  autoGroupNote?: string;
}

function resolveConfig(config?: GroupsSectionConfig): ResolvedConfig {
  return {
    heading: config?.heading ?? "Groups",
    addLabel: config?.addLabel ?? "Group",
    emptyText: config?.emptyText ?? "No groups yet — add one above.",
    showMemberSearch: config?.showMemberSearch ?? true,
    selectedPaneLabel: config?.selectedPaneLabel ?? "MEMBERS",
    selectedTestKey: config?.selectedTestKey ?? "members",
    memberSearchPlaceholder: config?.memberSearchPlaceholder ?? "Search members",
    availableEmpty: config?.availableEmpty ?? "Everyone's already a member.",
    selectedEmpty: config?.selectedEmpty ?? "No members yet — pick from the left.",
    addMemberAria: config?.addMemberAria ?? ((label) => `Add ${label} to group`),
    removeMemberAria: config?.removeMemberAria ?? ((label) => `Remove ${label} from group`),
    formatCount: config?.formatCount ?? ((count) => `${count} member${count === 1 ? "" : "s"}`),
    autoGroupNote: config?.autoGroupNote,
  };
}

// ---------------------------------------------------------------------------
// Membership SET writer (moved from entity-editor, behavior identical).
// ---------------------------------------------------------------------------

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
// Groups section
// ---------------------------------------------------------------------------

export interface GroupsSectionProps<TItem extends EditorItemBase> {
  descriptor: EntityDescriptor<TItem>;
  items: TItem[];
  groups: EditorGroup[];
  commit: Commit;
  currentState: CurrentState;
  /** True if the relevant item/group slice changed since the open form's form-open
   *  token — the parent's synchronous stale-Save guard, shared with its close effect. */
  isStale: () => boolean;
  /** True while ANY editor (item or group) is open — disables group drag/keyboard reorder. */
  editing: boolean;
  /** Whether the add-group form is open (owned by the parent selection). */
  addOpen: boolean;
  /** The id of the group currently in edit mode, or null. */
  editingGroupId: string | null;
  /** Toggle the add-group form open/closed. */
  onToggleAdd: () => void;
  /** Open the edit form for the given group. */
  onEditGroup: (id: string) => void;
  /** Close any open group form (add or edit). */
  onCloseForm: () => void;
  config?: GroupsSectionConfig;
}

export function GroupsSection<TItem extends EditorItemBase>({
  descriptor,
  items,
  groups,
  commit,
  currentState,
  isStale,
  editing,
  addOpen,
  editingGroupId,
  onToggleAdd,
  onEditGroup,
  onCloseForm,
  config,
}: GroupsSectionProps<TItem>) {
  const cfg = React.useMemo(() => resolveConfig(config), [config]);
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

  // Keyboard-accessible reorder (drag alone has no keyboard path). One move ⇒ one
  // `reorderGroups` commit ⇒ one undo entry, exactly like a drop.
  const move = (from: number, to: number) => {
    if (to < 0 || to >= groups.length || from === to) return;
    commit(reorderGroups(currentState(), descriptor, from, to));
  };

  return (
    <section className="flex flex-col gap-3" data-testid="groups-section">
      <div className="flex items-center gap-2">
        <h2 className="mr-auto font-heading text-cardhead font-semibold">{cfg.heading}</h2>
        <Button
          variant="outline"
          onClick={onToggleAdd}
          aria-pressed={addOpen}
          data-testid="add-group-toggle"
        >
          <FaPlus />
          {cfg.addLabel}
        </Button>
      </div>

      {addOpen && (
        <GroupForm
          mode="add"
          descriptor={descriptor}
          items={items}
          groups={groups}
          commit={commit}
          currentState={currentState}
          isStale={isStale}
          onDone={onCloseForm}
          cfg={cfg}
        />
      )}

      <div className="flex flex-col gap-2">
        {descriptor.syntheticGroups.map((row) => (
          <AutoGroupRow key={row.id} id={row.id} note={cfg.autoGroupNote ?? row.description} />
        ))}
        {groups.length === 0 && descriptor.syntheticGroups.length === 0 && (
          <p className="border border-dashed border-line bg-surface p-4 text-meta text-ink2">
            {cfg.emptyText}
          </p>
        )}
        {groups.map((group, index) => (
          <GroupRow
            key={group.id}
            descriptor={descriptor}
            group={group}
            items={items}
            groups={groups}
            commit={commit}
            currentState={currentState}
            isEditing={editingGroupId === group.id}
            onEdit={() => onEditGroup(group.id)}
            onCloseForm={onCloseForm}
            isStale={isStale}
            cfg={cfg}
            canDrag={canDrag}
            canReorder={canDrag && groups.length > 1}
            isFirst={index === 0}
            isLast={index === groups.length - 1}
            onMoveUp={() => move(index, index - 1)}
            onMoveDown={() => move(index, index + 1)}
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

/** The reserved auto-group card (`ALL`): read-only/locked, with an explanatory note
 *  visible and echoed on hover/focus so the lock is never an unexplained control. */
function AutoGroupRow({ id, note }: { id: string; note?: string }) {
  return (
    <div
      data-testid={`synthetic-${id}`}
      title={note}
      className="flex items-center gap-3 border border-line bg-panel px-3 py-2"
    >
      <Badge variant="neutral">
        <FaLock aria-hidden />
        Auto
      </Badge>
      <span className="font-medium">{id}</span>
      {note && <span className="text-meta text-ink2">{note}</span>}
    </div>
  );
}

function GroupRow<TItem extends EditorItemBase>({
  descriptor,
  group,
  items,
  groups,
  commit,
  currentState,
  isEditing,
  onEdit,
  onCloseForm,
  isStale,
  cfg,
  canDrag,
  canReorder,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
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
  isEditing: boolean;
  onEdit: () => void;
  onCloseForm: () => void;
  isStale: () => boolean;
  cfg: ResolvedConfig;
  canDrag: boolean;
  canReorder: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isOver: boolean;
  isDragging: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDropRow: () => void;
  onDragEnd: () => void;
}) {
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
          onDone={onCloseForm}
          cfg={cfg}
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
        <Badge variant="neutral">{cfg.formatCount(memberCount)}</Badge>
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
          {canReorder && (
            <>
              <Button
                size="icon"
                variant="outline"
                aria-label={`Move ${group.id} up`}
                data-testid={`group-move-up-${group.id}`}
                disabled={isFirst}
                onClick={onMoveUp}
              >
                <FaChevronUp />
              </Button>
              <Button
                size="icon"
                variant="outline"
                aria-label={`Move ${group.id} down`}
                data-testid={`group-move-down-${group.id}`}
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
            aria-label="Edit group"
            data-testid={`group-edit-${group.id}`}
            onClick={onEdit}
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
              onCloseForm();
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
// temporal change to the relevant slice closes the whole form (the parent's
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
  cfg,
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
  cfg: ResolvedConfig;
}) {
  const [id, setId] = React.useState(mode === "edit" ? group!.id : "");
  const [description, setDescription] = React.useState(
    mode === "edit" ? (group!.description ?? "") : "",
  );

  // Membership is a SET-model draft: the user's INTENDED final set of real-item
  // members, seeded from the live group at form-open. It is NOT rebased while open —
  // an external/temporal membership change closes the whole form (the parent's
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
          showSearch={cfg.showMemberSearch}
          selectedTitle={cfg.selectedPaneLabel}
          selectedTestKey={cfg.selectedTestKey}
          searchPlaceholder={cfg.memberSearchPlaceholder}
          availableEmpty={cfg.availableEmpty}
          selectedEmpty={cfg.selectedEmpty}
          addAria={cfg.addMemberAria}
          removeAria={cfg.removeMemberAria}
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
