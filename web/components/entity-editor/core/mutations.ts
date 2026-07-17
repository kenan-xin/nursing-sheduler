// Entity CRUD over a descriptor (T09) — pure transforms that return a NEW
// `ScenarioUiState`, never mutating the input. These are the editor's whole
// behaviour minus React: add / inline-update / reorder / duplicate for items and
// groups, a transfer-list membership set, and rename / delete routed through T07's
// cascade (`renameEntity` / `deleteEntity`) so every reference stays consistent.
//
// Reference discipline (T04 mutation contract): simple ops only replace the slice
// they touch via the descriptor's `writeState`; a no-op edit returns the *same*
// state object so `mutateScenario` produces no spurious zundo entry. Rename/delete
// return the cascade's full state (every affected slice gets a fresh reference).
// The React layer feeds each result to `mutateScenario(nextState)` — one patch ⇒
// one undo entry. The store wiring + zundo gate live in the components, not here.

import type { ScenarioUiState } from "@/lib/scenario";
import { deleteEntity, renameEntity } from "@/lib/cascade";
import type { EditorGroup, EntityDescriptor, EntityId, EditorItemBase } from "./descriptor";
import { sortMembersByItemOrder } from "./membership";
import { getUniqueCopyLabel } from "./duplicate-label";
import { isReservedKeyword } from "./validation";

/** Exact-id equality — `1` and `"1"` never collapse (mirrors T07/T18 identity). */
function sameId(a: EntityId, b: EntityId): boolean {
  return Object.is(a, b);
}

/** Two arrays equal by exact identity, same length and order. */
function sameSequence(a: readonly EntityId[], b: readonly EntityId[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/** Every authored id in the shared namespace (items + groups) as strings. */
function namespaceIds<TItem extends EditorItemBase>(
  items: readonly TItem[],
  groups: readonly EditorGroup[],
): string[] {
  return [...items.map((item) => String(item.id)), ...groups.map((group) => group.id)];
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** An item to add: an authored id, optional description, and optional extra
 *  (domain-specific) fields merged over the descriptor's `createItem` base. `extra`
 *  is restricted to non-identity fields so it can never clobber the descriptor-owned
 *  `id`/`description`/`history` (NEW MAJOR 4). */
export interface ItemDraft<TItem extends EditorItemBase> {
  id: string;
  description?: string;
  extra?: Omit<Partial<TItem>, "id" | "description">;
}

/**
 * Append a new item. The descriptor builds the durable base (people get
 * `history: []`); `extra` (shift-type working time) is merged UNDER the base so
 * descriptor-owned identity/description/history always win. Pre-validate the id in
 * the UI via `validateFullEditId` — this op is intentionally dumb about
 * reserved/duplicate ids (the rename/delete cascade is the authority for those).
 */
export function addItem<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  draft: ItemDraft<TItem>,
): ScenarioUiState {
  const base = descriptor.createItem({ id: draft.id, description: draft.description });
  // extra is merged FIRST so the descriptor base (id/description/history) wins.
  const item = (draft.extra ? { ...draft.extra, ...base } : base) as TItem;
  const items = [...descriptor.readItems(state), item];
  return descriptor.writeState(state, { items });
}

/**
 * Update an item's non-id fields (description, working time). Returns the same
 * state when nothing changed (no spurious history entry). The id is never editable
 * here — changing it is a rename and must go through {@link renameItem} so the T07
 * cascade rewrites every reference; a runtime `id` key is rejected defensively.
 */
export function updateItemFields<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  id: EntityId,
  patch: Omit<Partial<TItem>, "id">,
): ScenarioUiState {
  if (typeof patch === "object" && patch !== null && "id" in patch) {
    throw new Error(
      "updateItemFields cannot change the id — use renameItem so references cascade.",
    );
  }
  const items = descriptor.readItems(state);
  const idx = items.findIndex((item) => sameId(item.id, id));
  if (idx === -1) return state;
  const merged = patch as Partial<TItem>;
  const keys = Object.keys(patch) as (keyof TItem)[];
  const changed = keys.some((key) => !Object.is(items[idx][key], merged[key]));
  if (!changed) return state;
  const next = items.slice();
  next[idx] = { ...items[idx], ...patch } as TItem;
  return descriptor.writeState(state, { items: next });
}

/**
 * Move the item at `from` to `to` and re-sort every group's members to match the
 * new item order (spec 03 FR-ED-08/10/21 — member order always tracks item order).
 */
export function reorderItems<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  from: number,
  to: number,
): ScenarioUiState {
  const items = descriptor.readItems(state);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return state;
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) {
    return state;
  }
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const order = next.map((item) => item.id);
  const groups = descriptor.readGroups(state).map((group) => ({
    ...group,
    members: sortMembersByItemOrder(group.members, order),
  }));
  return descriptor.writeState(state, { items: next, groups });
}

/**
 * Move the group at `from` to `to` within the groups list (spec 03 FR-ED-19..21).
 * Unlike item reorder, group reorder does not change item order, so group members
 * are not re-sorted. Returns the same state for an out-of-range or same-index move.
 */
export function reorderGroups<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  from: number,
  to: number,
): ScenarioUiState {
  const groups = descriptor.readGroups(state);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return state;
  if (from < 0 || to < 0 || from >= groups.length || to >= groups.length || from === to) {
    return state;
  }
  const next = groups.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return descriptor.writeState(state, { groups: next });
}

/**
 * Duplicate an item: a unique "{id} copy" id (stripping any prior copy suffix),
 * inserted directly after the source, preserving the source's domain-specific
 * fields (working time). The descriptor re-stamps the base, so a duplicated person
 * starts with a fresh `history: []`. Per FR-ED-16, the new id is also inserted into
 * every group containing the source, immediately after the source's membership
 * position (so the duplicate inherits group membership); matching is EXACT identity.
 */
export function duplicateItem<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  id: EntityId,
): ScenarioUiState {
  const items = descriptor.readItems(state);
  const groups = descriptor.readGroups(state);
  const idx = items.findIndex((item) => sameId(item.id, id));
  if (idx === -1) return state;
  const source = items[idx];
  const newId = getUniqueCopyLabel(String(source.id), namespaceIds(items, groups));
  const created = descriptor.createItem({ id: newId, description: source.description });
  const copy = { ...source, ...created } as TItem;
  const nextItems = [...items.slice(0, idx + 1), copy, ...items.slice(idx + 1)];
  // FR-ED-16: insert the new id after every exact-identity source member in each group.
  const nextGroups = groups.map((group) => {
    if (!group.members.some((member) => sameId(member, id))) return group;
    const members: EntityId[] = [];
    for (const member of group.members) {
      members.push(member);
      if (sameId(member, id)) members.push(newId);
    }
    return { ...group, members };
  });
  return descriptor.writeState(state, { items: nextItems, groups: nextGroups });
}

/**
 * Delete an item and cascade the removal through every reference (cards, matrix,
 * history, export layout) via T07's `deleteEntity`. Pure: returns a new state.
 */
export function deleteItem<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  id: EntityId,
): ScenarioUiState {
  return deleteEntity(state, descriptor.domain, id);
}

/**
 * Rename an item id and cascade it everywhere via T07's `renameEntity`. Throws
 * `RenameCollisionError` (state untouched) on a reserved/duplicate target — the UI
 * pre-validates with `validateInlineId` and catches the cascade error as backstop.
 */
export function renameItem<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  oldId: EntityId,
  newId: string,
): ScenarioUiState {
  return renameEntity(state, descriptor.domain, oldId, newId);
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/** A group to add: an authored id and optional description (starts empty). */
export interface GroupDraft {
  id: string;
  description?: string;
}

/** Append a new empty group. */
export function addGroup<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  draft: GroupDraft,
): ScenarioUiState {
  const groups = descriptor.readGroups(state);
  const group: EditorGroup = { id: draft.id, description: draft.description, members: [] };
  return descriptor.writeState(state, { groups: [...groups, group] });
}

/** Update a group's description. Returns the same state when unchanged. */
export function updateGroupFields<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  id: string,
  patch: { description?: string },
): ScenarioUiState {
  const groups = descriptor.readGroups(state);
  const idx = groups.findIndex((group) => group.id === id);
  if (idx === -1) return state;
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  const changed = keys.some((key) => !Object.is(groups[idx][key], patch[key]));
  if (!changed) return state;
  const next = groups.slice();
  next[idx] = { ...groups[idx], ...patch };
  return descriptor.writeState(state, { groups: next });
}

/** Duplicate a group: unique "{id} copy" id, inserted after the source, members
 *  copied (findings #8). */
export function duplicateGroup<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  id: string,
): ScenarioUiState {
  const items = descriptor.readItems(state);
  const groups = descriptor.readGroups(state);
  const idx = groups.findIndex((group) => group.id === id);
  if (idx === -1) return state;
  const source = groups[idx];
  const newId = getUniqueCopyLabel(source.id, namespaceIds(items, groups));
  const copy: EditorGroup = {
    id: newId,
    description: source.description,
    members: [...source.members],
  };
  const next = [...groups.slice(0, idx + 1), copy, ...groups.slice(idx + 1)];
  return descriptor.writeState(state, { groups: next });
}

/** Delete a group and cascade the removal via T07's `deleteEntity`. */
export function deleteGroup<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  id: string,
): ScenarioUiState {
  return deleteEntity(state, descriptor.domain, id);
}

/** Rename a group id and cascade it via T07's `renameEntity` (a group shares its
 *  domain's reference namespace). Throws `RenameCollisionError` on collision. */
export function renameGroup<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  oldId: string,
  newId: string,
): ScenarioUiState {
  return renameEntity(state, descriptor.domain, oldId, newId);
}

/**
 * Replace a group's membership with `memberIds`, re-sorted to match item order
 * (spec 03 FR-ED-21 — selection order is never preserved). Returns the same state
 * when the membership is unchanged (no spurious history entry).
 */
export function setGroupMembers<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  groupId: string,
  memberIds: readonly EntityId[],
): ScenarioUiState {
  const items = descriptor.readItems(state);
  const groups = descriptor.readGroups(state);
  const idx = groups.findIndex((group) => group.id === groupId);
  if (idx === -1) return state;
  const order = items.map((item) => item.id);
  const members = sortMembersByItemOrder(memberIds, order);
  if (sameSequence(groups[idx].members, members)) return state;
  const next = groups.slice();
  next[idx] = { ...groups[idx], members };
  return descriptor.writeState(state, { groups: next });
}

/**
 * Toggle a single item's membership of a group (live, one mutation). Adds the item
 * in item order, or removes it (exact identity). Used by the editor's per-row group
 * toggle chips and the transfer list's single add/remove (spec 03 FR-ED-17/18/23).
 */
export function toggleGroupMembership<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  groupId: string,
  memberId: EntityId,
): ScenarioUiState {
  const groups = descriptor.readGroups(state);
  const idx = groups.findIndex((group) => group.id === groupId);
  if (idx === -1) return state;
  const has = groups[idx].members.some((member) => sameId(member, memberId));
  const next = has
    ? groups[idx].members.filter((member) => !sameId(member, memberId))
    : [...groups[idx].members, memberId];
  return setGroupMembers(state, descriptor, groupId, next);
}

/**
 * People bulk-upload transform (spec 03 FR-ED-31). Rebuilds the item list as:
 * existing people reordered to the file's order + new people inserted in file
 * order + unmentioned existing people appended trailing; then re-sorts every
 * group's members to the final item order. Matching is EXACT identity
 * (`P3` and `p3` are distinct).
 *
 * Lifecycle validation (NEW Major 6): a name that is a reserved keyword, or that
 * would create a NEW item whose id collides (exact) with an existing group id in
 * the shared namespace, ABORTS the whole upload before any mutation — the same
 * atomic-abort discipline as the intra-file duplicate path. This keeps the upload
 * from writing producer-invalid ids (`models.py` / T07 authority), rather than
 * reproducing the prototype's guard-bypass quirk.
 *
 * No-op discipline (NEW Major 8): when the resulting item sequence and every
 * group's member sequence are identical to the current state, the ORIGINAL state
 * reference is returned (no `writeState`) so a semantically-identical upload
 * produces no zundo entry — the same same-ref rule the other transforms follow.
 */
export type ReorderByUploadOk = {
  ok: true;
  state: ScenarioUiState;
  /** Existing people matched (exact) and reordered into file order. */
  reordered: number;
  /** New people created (`history: []`). */
  added: number;
  /** Existing people absent from the file, moved to the end. */
  movedToEnd: number;
};
export type ReorderByUploadErr = {
  ok: false;
  /**
   * "empty" (V8 — no usable names), "duplicate" (V10 — a name repeated within the
   * file), "reserved" (a reserved keyword), or "collision" (a new name equal to an
   * existing group id). Reserved/collision abort atomically before any mutation.
   */
  error: "empty" | "duplicate" | "reserved" | "collision";
  /** The offending name, for "duplicate" / "reserved" / "collision". */
  name?: string;
};
export type ReorderByUploadResult = ReorderByUploadOk | ReorderByUploadErr;

export function reorderByUpload<TItem extends EditorItemBase>(
  state: ScenarioUiState,
  descriptor: EntityDescriptor<TItem>,
  names: readonly string[],
): ReorderByUploadResult {
  // V8: no usable names → abort before any mutation.
  if (names.length === 0) return { ok: false, error: "empty" };

  // V10: a name repeated within the file → abort before any mutation (exact match).
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) return { ok: false, error: "duplicate", name };
    seen.add(name);
  }

  const items = descriptor.readItems(state);
  const groups = descriptor.readGroups(state);
  const existingByExactId = new Map<EntityId, TItem>();
  for (const item of items) existingByExactId.set(item.id, item);
  const groupIds = new Set(groups.map((group) => group.id));

  // Lifecycle guards (Major 6): reserved keyword, or a NEW name colliding with an
  // existing group id in the shared namespace → abort the whole upload atomically.
  for (const name of names) {
    if (isReservedKeyword(descriptor.reservedKeywords, name)) {
      return { ok: false, error: "reserved", name };
    }
    if (!existingByExactId.has(name) && groupIds.has(name)) {
      return { ok: false, error: "collision", name };
    }
  }

  const mentioned = new Set<EntityId>();
  const nextItems: TItem[] = [];
  let reordered = 0;
  let added = 0;

  for (const name of names) {
    const existing = existingByExactId.get(name);
    if (existing !== undefined && !mentioned.has(existing.id)) {
      nextItems.push(existing); // reuse the exact-matching object (preserves its fields)
      mentioned.add(existing.id);
      reordered += 1;
    } else if (existing === undefined) {
      // New person — created with a fresh history: [].
      nextItems.push(descriptor.createItem({ id: name }) as TItem);
      added += 1;
    }
  }

  // Append unmentioned existing items, in their original order.
  const movedToEnd: TItem[] = [];
  for (const item of items) {
    if (!mentioned.has(item.id)) movedToEnd.push(item);
  }
  const finalItems = [...nextItems, ...movedToEnd];

  // Re-sort every group's members to the final item order (FR-ED-21). Reuse the
  // original group object when its member sequence is unchanged (Major 8).
  const order = finalItems.map((item) => item.id);
  const finalGroups = groups.map((group) => {
    const members = sortMembersByItemOrder(group.members, order);
    return sameSequence(group.members, members) ? group : { ...group, members };
  });

  // Major 8: semantically-identical upload → return the ORIGINAL state (same refs,
  // no zundo entry). Item objects are reused above, so ref-equality is exact.
  const itemsUnchanged =
    finalItems.length === items.length && finalItems.every((it, i) => it === items[i]);
  const groupsUnchanged = finalGroups.every((g, i) => g === groups[i]);
  if (itemsUnchanged && groupsUnchanged) {
    return { ok: true, state, reordered, added, movedToEnd: movedToEnd.length };
  }

  return {
    ok: true,
    state: descriptor.writeState(state, { items: finalItems, groups: finalGroups }),
    reordered,
    added,
    movedToEnd: movedToEnd.length,
  };
}
