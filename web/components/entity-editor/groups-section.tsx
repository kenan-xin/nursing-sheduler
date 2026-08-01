"use client";

// Shared, reusable groups section (DR-1) — extracted verbatim-in-behavior from the
// monolithic entity-editor. It renders the auto-`ALL` read-only card, the custom
// group cards, and the inline transfer-list membership editor over the generic
// `TransferList` + the pure group-mutation core. The bespoke `PeopleTable` and
// `ShiftTypeGrid` screens consume it directly (the generic `EntityEditor` it was
// extracted from is retired — DR-5).
//
// It is parameterized by copy + explicit flags/optional slots (NOT copy-only), so
// the Staff/Shift divergence is expressible without a false "identical" abstraction:
//   • `showMemberSearch` — Staff shows the transfer-list search box, Shifts hides it
//     (ScreenStaff.dc.html:167-173);
//   • `selectedPaneLabel` — the selected pane reads `MEMBERS` (Staff) vs `IN GROUP`
//     (Shift);
//   • `formatCount` — the per-group count noun (`N members` vs `N TYPES`);
//   • `autoGroupNote` — the reserved auto-group's explanation.
// Every option defaults to today's People/Shift behavior, preserving the exact
// look the section had before it was extracted from the (now-retired) EntityEditor.
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
//
// F2 owns this file's PRESENTATION only, and is its sole visual owner before F4 —
// the route tickets configure it through public props and never edit it. Every
// surface here goes through the shared `surfaceVariants` recipe rather than
// restating tone/border/elevation, the reorder/edit/duplicate/delete controls are
// real 44x44 targets on a coarse pointer, and the destructive control uses the
// `destructive-outline` Button variant instead of hand-overriding a variant's
// colours. Mutation, validation, identity, stale-save, reorder and membership
// behaviour are untouched.
//
// SURFACE HIERARCHY (ii7.8.5 — measured against the rendered prototypes, not
// inferred from token names). `ScreenStaff.dc.html:116-150` and
// `ScreenShifts.dc.html:155-193` both author the groups block as ONE L1 card with
// a header band, and every group row inside it as a `--panel` well:
//
//   section  L1 card      --surface / --line hairline / 16px / --sh-1 / no padding
//   ├ header full-bleed   transparent / --line2 BOTTOM edge only / square / flat
//   └ body   plain box    18px padding, 14px gap
//     ├ auto group        --panel / 12px / --sh-well   (locked, un-authorable)
//     ├ custom group      --panel / 12px / --sh-well   (identical resting tone)
//     └ open editor       the `selected` role
//
// The custom rows are wells rather than L1 cards for two independent reasons that
// agree: the prototype measures `rgb(238,243,240)` (`--panel`) + `--sh-well` +
// 12px on them, and DESIGN.md §4 rule 5 forbids stacking two surfaces of the same
// tone — "an L1 card inside an L1 card becomes a well instead". Before this
// change the section was a transparent `<section>` (measured: transparent, 0px
// border, 0 radius, no shadow) holding L1 `--surface` cards, so the containing
// plane was missing AND the rows were the nested-card anti-pattern.
//
// The header band keeps a single bottom edge and therefore stays square
// (DESIGN.md §5: "any container whose border is a single edge … rather than a
// box"). The prototype's rendered 16px top corners on that band come from the
// retrofit shell's CORNERS layer, not from its own authored style, so they are
// not canon — the same class of phantom value as R2c's D-1.

import * as React from "react";
import { toast } from "sonner";
import type { ScenarioUiState } from "@/lib/scenario";
import { RenameCollisionError } from "@/lib/cascade";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Surface, surfaceVariants } from "@/components/ui/surface";
import {
  FaPlus,
  FaPen,
  FaTrash,
  FaCopy,
  FaCheck,
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
// today's People/Shift behavior (a consumer that passes no config gets the original look).
// ---------------------------------------------------------------------------

export interface GroupsSectionConfig {
  /** Section heading. Default `"Groups"`. */
  heading?: string;
  /**
   * One-line explanation under the heading, inside the header band. Both
   * prototypes carry one ("Bundle nurses so rules and constraints can target a
   * whole team at once."), but the copy is the ROUTE's voice, so this stays an
   * opt-in prop rather than a default — a consumer that passes nothing gets a
   * single-line band, exactly as before.
   */
  description?: string;
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
  description?: string;
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
    description: config?.description,
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
    // The single L1 containing card. It owns no padding of its own: the header
    // band and the body each carry the prototype's own insets, so the band's
    // bottom hairline runs full-bleed to the card edge rather than floating
    // inside a gutter.
    <section
      data-testid="groups-section"
      className={surfaceVariants({ role: "surface", geometry: "card" })}
    >
      <div
        data-testid="groups-header"
        className="flex items-center justify-between gap-3 border-b border-line2 px-5 py-4.5"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em]">
            {cfg.heading}
          </h2>
          {cfg.description && <p className="text-meta text-ink2">{cfg.description}</p>}
        </div>
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

      <div data-testid="groups-body" className="flex flex-col gap-4 p-5">
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

        {descriptor.syntheticGroups.map((row) => (
          <AutoGroupRow
            key={row.id}
            id={row.id}
            note={cfg.autoGroupNote ?? row.description}
            countLabel={cfg.formatCount(items.length)}
          />
        ))}
        {groups.length === 0 && (
          // Gated on CUSTOM groups only, matching the prototypes' own `noGroups`
          // (`ScreenStaff.dc.html:341`, `ScreenShifts.dc.html:370`), which sit the
          // empty state directly beside the auto group. The previous condition
          // also required zero synthetic groups, which both live routes always
          // have — so the `emptyText` each route already authors could never
          // render on either screen.
          //
          // Dashed is the empty-state affordance, so this keeps a hand-authored
          // border rather than a role's solid hairline. It is a well-tier island
          // inside the L1 card, so it takes the control radius and states no fill.
          <p
            data-testid="groups-empty"
            className="rounded-control border border-dashed border-line2 px-5 py-8 text-center text-meta text-ink2"
          >
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
 *  visible and echoed on hover/focus so the lock is never an unexplained control.
 *
 *  A `well` on the control radius, which is what the prototype measures here
 *  (`--panel`, 12px, `--sh-well`, 14x16 padding) and what a row nested inside the
 *  L1 containing card has to be. It reads locked by TONE; the padlock glyph is not
 *  carrying that alone. */
function AutoGroupRow({
  id,
  note,
  countLabel,
}: {
  id: string;
  note?: string;
  countLabel?: string;
}) {
  return (
    <Surface
      level="well"
      geometry="control"
      edge="hairline"
      data-testid={`synthetic-${id}`}
      title={note}
      className="flex flex-col gap-1.5 px-4.5 py-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-label font-semibold">{id}</span>
        <Badge variant="neutral">
          <FaLock aria-hidden />
          Auto
        </Badge>
        {countLabel && <span className="font-mono text-label text-ink3">{countLabel}</span>}
      </div>
      {note && <p className="text-meta text-ink3">{note}</p>}
    </Surface>
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
    // No surface of its own: the open form IS the active editor card (the
    // `selected` role, applied inside GroupForm). Wrapping it in a second L1 card
    // would stack two surfaces of the same tone, which DESIGN.md §4 rule 5 forbids.
    return (
      <div data-testid={`group-row-${group.id}`}>
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
      className={cn(
        "flex flex-col gap-2 px-4.5 py-4",
        // Resting, a custom group is a `well` on the control radius — the same
        // surface as the auto row beside it, which is exactly what the prototype
        // measures (`--panel` / 12px / `--sh-well`). It is NOT an L1 card: inside
        // the L1 containing card that would stack two surfaces of the same tone
        // (DESIGN.md §4 rule 5).
        //
        // A drop candidate stays the SAME well and swaps only its edge, so the
        // recessed direction of light survives the drag (DESIGN.md §4 rule 1 —
        // a well is never lifted on an outer cast). It deliberately does not
        // take the `drop-target` ROLE: that role restates `--panel-alt` and an
        // outer `--sh-2`, which is correct for the card editor's L1 drop zone
        // and would invert this one. Dashed rather than solid because a solid
        // brand edge is the selection / open-editor language, and a row under
        // the pointer is neither.
        //
        // Exactly one of `edge`/`drop` is ever passed, so the resulting border
        // never depends on tailwind-merge resolving two competing edges.
        //
        // The grab/drag affordances come from the same recipe because
        // `cursor-*` and `opacity-*` are not layout utilities and so cannot be
        // authored here.
        surfaceVariants({
          role: "well",
          geometry: "control",
          edge: isOver ? undefined : "hairline",
          drop: isOver ? "candidate" : undefined,
          interaction: isDragging ? "dragging" : canDrag ? "grabbable" : undefined,
        }),
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {canDrag && <FaGripVertical aria-hidden className="size-3 text-ink3" />}
            <span
              data-testid={`group-id-text-${group.id}`}
              className="font-mono text-label-lg font-semibold"
            >
              {group.id}
            </span>
            <span className="font-mono text-label text-ink3">{cfg.formatCount(memberCount)}</span>
          </div>
          {group.members.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {group.members.map((m) => (
                /* Member NAMES render as authored — the prototype's read-row chips are
                   not uppercased (only status badges like AUTO are). `casing` is a
                   Badge variant, so this is a choice of chip kind rather than a
                   caller-owned override of the badge's typography. */
                <Badge key={entityKey(m)} variant="outline" casing="normal">
                  {String(m)}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-none items-center gap-1">
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
            variant="destructive-outline"
            aria-label="Delete group"
            data-testid={`group-delete-${group.id}`}
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
      className={cn(
        "flex flex-col gap-3.5 px-4.5 py-4",
        // BOTH modes are the active editor card, so both take the `selected`
        // role. The prototype makes the same call structurally — "add group"
        // there just opens a new row in the editing state, so add and edit are
        // one visual state. It also has to be `selected` rather than `surface`
        // now: a plain L1 form inside the L1 containing card would be the same
        // same-tone stack DESIGN.md §4 rule 5 forbids, with no brand edge to
        // distinguish it.
        surfaceVariants({ role: "selected", geometry: "card" }),
      )}
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
