// The coefficient sub-editor's pure contract (eligibility, sync, validation), moved
// verbatim out of `coefficient-fields.tsx` so React-free callers can share it. The
// component file re-exports every name.

/**
 * A concrete member id inside the coefficient domain. Members are compared with
 * EXACT typed identity (`Set.has`), so a numeric shift id `1` and a string shift
 * id `"1"` never collapse — matching the backend's typed group expansion (M1).
 */
export type CoefficientMemberId = number | string;

/** One coefficient-domain entity. A coefficient SOURCE id is always a string (the
 *  persisted `CoefficientEntry` / `ShiftTypeRef` is string-only), so numeric shift
 *  items are never modelled as items here — they only ever appear as typed group
 *  `members`. */
export interface CoefficientEntity {
  id: string;
}

/** One coefficient-domain group; `members` are the ids it expands to — a member
 *  may itself name another group (a group of groups), expanded transitively — kept
 *  at their AUTHORED type (numeric stays numeric) so expansion/coverage/overlap
 *  match the backend exactly (M1). */
export interface CoefficientGroup {
  id: string;
  members: readonly CoefficientMemberId[];
}

/** The full domain a coefficient sub-editor operates over — every authored item
 *  and group, INCLUDING synthetic/reserved rows (e.g. Counts' OFF/LEAVE items and
 *  ALL group) when the consumer wants them coefficient-eligible. */
export interface CoefficientDomain {
  items: readonly CoefficientEntity[];
  groups: readonly CoefficientGroup[];
}

/** A draft coefficient value: a positive integer, `""` (blank, dropped on save), or
 *  a raw invalid string kept verbatim (mirrors EDGE-PR-10's clamp-vs-validate split). */
export type CoefficientDraftValue = number | string;

/** A `[id, value]` pair — the draft form of the persisted `CoefficientEntry`. */
export type CoefficientPair = [string, CoefficientDraftValue];

function expandedIdsById(domain: CoefficientDomain): Map<string, readonly CoefficientMemberId[]> {
  const map = new Map<string, readonly CoefficientMemberId[]>();
  for (const item of domain.items) map.set(item.id, [item.id]);
  const groupsById = new Map(domain.groups.map((group) => [group.id, group]));
  const visiting = new Set<string>();

  // A member may itself name another group (a group of groups), so expand
  // transitively. `visiting` breaks a cycle by contributing nothing for the
  // back-edge, and the result is cached so each group expands once.
  const expand = (member: CoefficientMemberId): readonly CoefficientMemberId[] => {
    if (typeof member !== "string") return [member];
    const cached = map.get(member);
    if (cached) return cached;
    const group = groupsById.get(member);
    if (!group) return [member];
    if (visiting.has(member)) return [];
    visiting.add(member);
    const members = [...new Set(group.members.flatMap(expand))];
    visiting.delete(member);
    map.set(member, members);
    return members;
  };

  for (const group of domain.groups) expand(group.id);
  return map;
}

/** Canonical entry order: authored items, then groups, each in authoring order
 *  (FR-PR-54 / the historical `entityOrdering.getOrderedEntries`). */
export function coefficientEntryOrder(domain: CoefficientDomain): string[] {
  return [...domain.items.map((i) => i.id), ...domain.groups.map((g) => g.id)];
}

/** Sort `ids` into canonical entry order; an id absent from the domain sorts last,
 *  in its original relative order (stable). */
export function sortIdsByEntryOrder(ids: readonly string[], domain: CoefficientDomain): string[] {
  const order = new Map(coefficientEntryOrder(domain).map((id, index) => [id, index]));
  return [...ids].sort(
    (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Eligible coefficient ids (FR-PR-70): every item whose id is in the expanded
 * selection, plus every non-empty group whose (transitively) expanded members are
 * ALL in the expanded selection — in canonical entry order (EDGE-PR-11).
 */
export function eligibleCoefficientIds(
  selection: readonly string[],
  domain: CoefficientDomain,
): string[] {
  const expanded = expandedIdsById(domain);
  const selectedExpanded = new Set<CoefficientMemberId>(
    selection.flatMap((id) => expanded.get(id) ?? []),
  );
  return [
    // Only string item ids are coefficient SOURCES; a numeric member reached via a
    // group is covered for group-eligibility but never returned/persisted itself.
    ...domain.items.filter((item) => selectedExpanded.has(item.id)).map((item) => item.id),
    ...domain.groups
      .filter((g) => {
        // Test the group's EXPANDED members, so a parent whose members are
        // themselves groups is eligible exactly when its whole subtree is covered.
        const members = expanded.get(g.id) ?? [];
        return members.length > 0 && members.every((m) => selectedExpanded.has(m));
      })
      .map((g) => g.id),
  ];
}

/** Read one id's current draft value, defaulting to blank. */
export function coefficientValueFor(
  pairs: readonly CoefficientPair[],
  id: string,
): CoefficientDraftValue {
  return pairs.find(([pid]) => pid === id)?.[1] ?? "";
}

/**
 * Re-sync the draft pairs to the currently-eligible ids (FR-PR-73): drop ids no
 * longer eligible, add blank pairs for newly-eligible ones, and preserve every
 * other id's value untouched — in canonical entry order.
 */
export function syncCoefficientPairs(
  selection: readonly string[],
  pairs: readonly CoefficientPair[],
  domain: CoefficientDomain,
): CoefficientPair[] {
  return eligibleCoefficientIds(selection, domain).map(
    (id): CoefficientPair => [id, coefficientValueFor(pairs, id)],
  );
}

/**
 * Parse+clamp one coefficient input on change (FR-PR-72/EDGE-PR-10): blank stays
 * blank; a `NaN` parse keeps the raw text; otherwise `Math.max(1, parsedInt)` — so
 * `1.5`/`2.9` truncate to `1`/`2` via `Number.parseInt` and values below 1 clamp up.
 */
export function parseCoefficientInput(raw: string): CoefficientDraftValue {
  if (raw === "") return "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? raw : Math.max(1, parsed);
}

/** Rewrite exactly one id's value, preserving every other eligible id's value. */
export function updateCoefficientPair(
  eligibleIds: readonly string[],
  pairs: readonly CoefficientPair[],
  id: string,
  value: CoefficientDraftValue,
): CoefficientPair[] {
  return eligibleIds.map(
    (eid): CoefficientPair => [eid, eid === id ? value : coefficientValueFor(pairs, eid)],
  );
}

/** The verbatim per-id integer error (spec 05 coefficient validation table). */
export function coefficientIntegerErrorMessage(id: string): string {
  return `Coefficient for ${id} must be an integer of at least 1`;
}

/** The verbatim overlap error (spec 05 coefficient validation table). */
export function coefficientOverlapMessage(
  sourceA: string,
  sourceB: string,
  sharedId: CoefficientMemberId,
): string {
  return `Shift type coefficients overlap: ${sourceA}, ${sourceB} include ${sharedId}`;
}

function findCoefficientOverlap(
  entries: readonly [string, number][],
  domain: CoefficientDomain,
): string | undefined {
  const expanded = expandedIdsById(domain);
  const sourceByExpandedId = new Map<CoefficientMemberId, string>();
  for (const [id] of entries) {
    for (const expandedId of expanded.get(id) ?? []) {
      const existing = sourceByExpandedId.get(expandedId);
      if (existing !== undefined) return coefficientOverlapMessage(existing, id, expandedId);
      sourceByExpandedId.set(expandedId, id);
    }
  }
  return undefined;
}

export interface CoefficientValidation {
  /** The `[id, coefficient]` entries to persist — populated only when there are no
   *  per-id errors (blank entries are dropped, per FR-PR-74). */
  entries: Array<[string, number]>;
  /** Per-id integer errors, keyed by id. */
  errorsById: Record<string, string>;
  /** Set only when every id parses cleanly AND two sources still overlap (per-id
   *  errors take precedence over the overlap check — spec 05 coefficient table). */
  overlapError?: string;
}

/**
 * Validate + build the persisted `[id, coefficient]` entries. Syncs to the
 * currently-eligible ids first (so a stale id from a prior selection can never
 * leak into the saved array), then applies the per-id integer rule; the overlap
 * check runs only when every remaining (non-blank) value is already valid.
 */
export function validateCoefficientPairs(
  selection: readonly string[],
  pairs: readonly CoefficientPair[],
  domain: CoefficientDomain,
): CoefficientValidation {
  const synced = syncCoefficientPairs(selection, pairs, domain);
  const errorsById: Record<string, string> = {};
  for (const [id, value] of synced) {
    if (value === "") continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      errorsById[id] = coefficientIntegerErrorMessage(id);
    }
  }
  if (Object.keys(errorsById).length > 0) return { entries: [], errorsById };
  const entries = synced.filter((pair): pair is [string, number] => pair[1] !== "");
  return { entries, errorsById, overlapError: findCoefficientOverlap(entries, domain) };
}
