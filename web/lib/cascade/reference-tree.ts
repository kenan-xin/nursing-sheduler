// Recursive reference-id-tree helpers (T07) — ported from the prototype's
// `referenceIds.ts` (`web-frontend/src/utils/referenceIds.ts`), generalized from
// string-only leaves to the `number | string` refs the canonical model uses
// (`PersonRef`/`DateRef` may be numeric; `ShiftTypeRef` selectors are strings even
// when the shift-type id is numeric — see `@/lib/scenario` types.ts).
//
// A reference field's cascade representation is `leaf | tree[]` — a leaf ref or an
// arbitrarily nested array of such trees (spec 06 FR-RI-02). Frontend preference
// fields are mostly flat, but affinities/coverings are one level deep and imported
// advanced shapes may nest arbitrarily; these helpers recurse so a rename/prune
// preserves the nesting.

/** A single reference leaf. Matches the backend `int | str` reference union. */
export type RefLeaf = number | string;
/** A reference tree: a leaf, or a nested array of trees (spec 06 FR-RI-02). */
export type RefTree = RefLeaf | RefTree[];

/**
 * The string form of a reference — used ONLY for reserved-keyword matching (which
 * the producer does case-insensitively) and for display. It is deliberately NOT
 * used for reference identity: the backend treats numeric and string ids as
 * distinct (`build_shift_type_index_map` keys a JS/py `Map`/`Set` by the raw id, so
 * `3` and `"3"` are different keys; the producer's duplicate checks use exact
 * `Set.has`). Identity therefore uses {@link sameRef} (exact), not `refKey`.
 */
export const refKey = (ref: RefLeaf): string => String(ref);

/**
 * Whether two references denote the same entity. Exact (`===`) identity, matching
 * the backend/producer, so a numeric id `1` and the string `"1"` — which may
 * legitimately coexist as distinct ids (`PersonId`/`ShiftTypeId` = `number | str`)
 * — never collapse into one.
 */
export const sameRef = (a: RefLeaf, b: RefLeaf): boolean => a === b;

/** Recursively map every leaf of a reference tree, preserving its structure. */
export function mapRefTree(value: RefTree, mapLeaf: (leaf: RefLeaf) => RefLeaf): RefTree {
  return Array.isArray(value) ? value.map((item) => mapRefTree(item, mapLeaf)) : mapLeaf(value);
}

/**
 * Recursively rebuild a reference tree keeping only leaves for which `keep`
 * returns true. For an array it filters children, **dropping any array child that
 * became empty** and any leaf child that fails `keep`; for a leaf it returns the
 * leaf if kept, otherwise the empty array `[]` (spec 06 FR-RI-02). A fully pruned
 * field therefore collapses to `[]`, whose `length === 0` then drives the
 * empty-required-field drop (FR-RI-11).
 */
export function filterRefTree(value: RefTree, keep: (leaf: RefLeaf) => boolean): RefTree {
  return Array.isArray(value)
    ? value
        .map((item) => filterRefTree(item, keep))
        .filter((item) => (Array.isArray(item) ? item.length > 0 : keep(item)))
    : keep(value)
      ? value
      : [];
}

/** Rename every leaf equal to `oldId` to `newId` (spec 06 FR-RI-02). */
export function renameRefTree(value: RefTree, oldId: RefLeaf, newId: RefLeaf): RefTree {
  return mapRefTree(value, (leaf) => (sameRef(leaf, oldId) ? newId : leaf));
}

/**
 * Prune every leaf in `deleted` (spec 06 FR-RI-02). The set is keyed by the raw
 * reference (a JS `Set` uses SameValueZero, matching the backend's exact identity),
 * so deleting id `1` never prunes the distinct id `"1"`.
 */
export function pruneRefTree(value: RefTree, deleted: ReadonlySet<RefLeaf>): RefTree {
  return filterRefTree(value, (leaf) => !deleted.has(leaf));
}

/**
 * Whether a (possibly optional) reference field is *present but empty* — the
 * signal that a fully pruned tree should drop its owning preference (FR-RI-11) or
 * export rule (FR-RI-12). An absent (`undefined`) optional field is NOT empty (it
 * was never referencing), and a surviving scalar leaf is NOT empty.
 */
export function isEmptyRefField(value: RefTree | undefined): boolean {
  return Array.isArray(value) && value.length === 0;
}
