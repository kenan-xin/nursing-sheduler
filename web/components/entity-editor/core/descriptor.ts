// Domain-agnostic descriptor for the shared item/group editor (T09).
//
// The generic editor (table, drag-reorder, add/edit form, transfer-list,
// validation, duplicate) knows nothing about People vs Shift Types — it reads a
// descriptor that names the cascade domain, labels, reserved keywords, the state
// slices to read/write, an item factory, and the synthetic read-only rows
// (ALL/OFF/LEAVE) to display. People and Shift Types are thin wrappers that
// build a descriptor; Dates and other domains can adopt the same interface later
// (the build here is scoped to People + Shift Types only).

import type { EntityDomain } from "@/lib/cascade";
import type { ScenarioUiState } from "@/lib/scenario";

/** An id as authored/stored (`int | str`, mirroring the backend union). */
export type EntityId = number | string;

/**
 * A type-tagged, collision-free string key for an id — the PRESENTATION identity for
 * React keys, test ids, and edit/drag tracking ONLY. Numeric `1` and string `"1"`
 * are DISTINCT ids (T18 `PersonId`/`ShiftTypeId = number | string`; exact identity,
 * per the producer + T07). Both branches carry a DISJOINT type tag so the key is
 * unique across the WHOLE id domain — `number:1` vs `string:1`, and crucially
 * `number:1` vs `string:#1` and `number:-1` vs `string:#-1` never collide (the
 * Major-1 key-collision bug: a bare `#`-prefix let numeric `1` and the legal string
 * `"#1"` share one key). NEVER use this key for logical membership equality — use
 * {@link sameEntityId} (`Object.is`) for that.
 */
export function entityKey(id: EntityId): string {
  return typeof id === "number" ? `number:${id}` : `string:${id}`;
}

/** Exact typed id equality — `1` and `"1"` never collapse (mirrors T07/T18). */
export function sameEntityId(a: EntityId, b: EntityId): boolean {
  return Object.is(a, b);
}

/** The minimum shape the generic editor needs from an item row. Domain-specific
 *  fields (people `history`, shift-type working time) ride along untouched. */
export interface EditorItemBase {
  id: EntityId;
  description?: string;
}

/** A named group: an id plus the ids of its member items. */
export interface EditorGroup {
  id: string;
  description?: string;
  members: EntityId[];
}

/** Singular/plural labels for the item entity; groups are always "Group". */
export interface EntityLabels {
  /** e.g. "Person" / "Shift Type" — the singular item label. */
  item: string;
  /** e.g. "People" / "Shift Types" — the plural item label. */
  itemPlural: string;
  /** Lowercase singular used inside placeholders/messages ("person", "shift type"). */
  itemLower: string;
  /** Lowercase plural used in empty-selector messages ("people", "shift types"). */
  itemPluralLower: string;
}

/** A synthetic, auto-generated row: displayed read-only, never part of state. */
export interface SyntheticRow {
  id: string;
  description?: string;
}

/**
 * Everything the generic editor needs to operate one domain. Generic over the
 * concrete item type so people `history` / shift-type working-time fields are
 * preserved through reorder/duplicate/update without the core knowing them.
 */
export interface EntityDescriptor<TItem extends EditorItemBase = EditorItemBase> {
  /**
   * Cascade reference namespace — drives reserved sets + rename/delete (T07).
   * People + Shift Types drive the full generic {@link EntityEditor}; Dates (T10)
   * reuses only the pure group CRUD/validation core (add/rename/delete/set-members
   * over `dateGroups`) behind a date-scope picker, so `"date"` is admitted here.
   */
  domain: Extract<EntityDomain, "person" | "shift" | "date">;
  labels: EntityLabels;
  /**
   * Reserved keywords for this domain, matched case-insensitively. Sourced from
   * the shared `RESERVED_SHIFT_TYPE` constant by the wrapper — never hardcoded —
   * so it stays aligned with the producer schema + T07 collision authority.
   */
  reservedKeywords: readonly string[];
  /** Whether item drafts expose the optional working-time sub-form (shift types). */
  supportsWorkingTime: boolean;
  /**
   * Optional domain-specific reserved-id predicate, consulted by BOTH id validators
   * IN ADDITION to `reservedKeywords`. Dates uses it to reject concrete date-literal
   * shapes (`D` / `MM-DD` / `YYYY-MM-DD`) at create/rename — the producer + T07
   * authority — which a flat keyword list cannot express. People/Shift omit it.
   */
  isReservedId?(id: string): boolean;

  /** Read the item slice for this domain from durable state. */
  readItems(state: ScenarioUiState): TItem[];
  /** Read the group slice for this domain from durable state. */
  readGroups(state: ScenarioUiState): EditorGroup[];
  /**
   * Return a NEW `ScenarioUiState` with the given item/group slices replaced.
   * Unspecified slices keep their existing reference; replaced slices get a fresh
   * one so undo/dirty tracking stays accurate (T04 mutation contract).
   */
  writeState(
    state: ScenarioUiState,
    patch: { items?: TItem[]; groups?: EditorGroup[] },
  ): ScenarioUiState;
  /**
   * Build a durable item from the authored id/description. People add
   * `history: []`; domain-specific extra fields (shift-type working time) are
   * merged separately by the mutation layer via the draft's `extra` blob.
   */
  createItem(fields: { id: string; description?: string }): TItem;

  /** Auto-generated read-only item rows (Shift Types: OFF/LEAVE; People: none). */
  syntheticItems: readonly SyntheticRow[];
  /** Auto-generated read-only group rows (both domains: ALL). */
  syntheticGroups: readonly SyntheticRow[];
}
