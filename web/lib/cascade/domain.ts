// Cascade domain vocabulary + rename-collision authority (T07).
//
// The scheduling model has no surrogate keys: a person, shift type, or date —
// item OR named group — is identified only by its string id, and every reference
// stores a copy of that string (spec 06 FR-RI-01). A rename therefore rewrites the
// string everywhere; a delete reconciles every copy. Because references are bare
// strings, a group id cascades through the SAME path as an item id in its domain
// (spec 06 FR-RI-13/14, edge "Group IDs share the reference namespace with item
// IDs") — so the cascade is keyed by the reference *namespace*, not by item-vs-group.
//
//   • "person" — people items (`staff`) AND people groups (`staffGroups`)
//   • "shift"  — shift-type items (`shifts`) AND shift-type groups (`shiftGroups`)
//   • "date"   — date groups (`dateGroups`); dates themselves are a generated range,
//                not renameable items (the prototype refuses derived-date renames)
//
// Renaming/deleting a *group* uses its domain (a people group → "person"); this is
// the deliberate reconciliation of the ticket's `person|shift|date|group` wording,
// since a bare "group" cannot convey which of the three namespaces it lives in and
// the cascade + collision checks are namespace-scoped.

import { RESERVED_SHIFT_TYPE, type ScenarioUiState } from "@/lib/scenario";
import { refKey, type RefLeaf } from "./reference-tree";

/** A cascade reference namespace (covers both items and groups in that domain). */
export type EntityDomain = "person" | "shift" | "date";

/** An entity id / reference (`int | str`, mirroring the backend union). */
export type EntityRef = RefLeaf;

/** Why a rename was rejected (spec 06 finding #5 — reject, don't merge). */
export type CollisionReason = "duplicate-item" | "duplicate-group" | "reserved" | "non-string-id";

/**
 * Thrown by the rename cascade when `newId` collides with an existing id in the
 * same domain (item↔item, item↔group) or a reserved keyword (tech-plan §4
 * "Rename-collision — REJECT"; design review finding #5). The throw happens before
 * any new state is built, so the caller's state is left untouched (atomic); editors
 * catch it and surface a validation error.
 */
export class RenameCollisionError extends Error {
  readonly domain: EntityDomain;
  readonly oldId: EntityRef;
  readonly newId: EntityRef;
  readonly reason: CollisionReason;

  constructor(domain: EntityDomain, oldId: EntityRef, newId: EntityRef, reason: CollisionReason) {
    const detail =
      reason === "reserved"
        ? `it is a reserved ${domain} keyword`
        : reason === "non-string-id"
          ? "a new id must be an authored string"
          : `another ${reason === "duplicate-group" ? "group" : "item"} already uses that id`;
    super(`Cannot rename ${domain} "${String(oldId)}" to "${String(newId)}": ${detail}.`);
    this.name = "RenameCollisionError";
    this.domain = domain;
    this.oldId = oldId;
    this.newId = newId;
    this.reason = reason;
  }
}

// Reserved-keyword sets per domain — mirrors the producer schema's cross-field
// refinement (`@/lib/scenario/schemas/producer.ts`, the authority the ticket names)
// and the backend constants (`core/nurse_scheduling/constants.py`). Matched
// case-insensitively, exactly as the producer compares with `.toUpperCase()`.
const RESERVED_BY_DOMAIN: Record<EntityDomain, readonly string[]> = {
  // People: only `ALL` is reserved (producer.ts people-id check).
  person: [RESERVED_SHIFT_TYPE.all],
  // Shift types: `ALL`/`OFF`/`LEAVE` (producer.ts shift-type-id check).
  shift: [RESERVED_SHIFT_TYPE.all, RESERVED_SHIFT_TYPE.off, RESERVED_SHIFT_TYPE.leave],
  // Dates: weekday names + `ALL`/`WEEKDAY`/`WEEKEND` (producer.ts date-group check).
  date: [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
    "ALL",
    "WEEKDAY",
    "WEEKEND",
  ],
} as const;

// A date-group id must not look like a concrete date (`D`, `MM-DD`, `YYYY-MM-DD`),
// else it would collide with a generated in-range date reference (producer.ts).
const DATE_LITERAL_PATTERNS = [/^\d{1,2}$/, /^\d{2}-\d{2}$/, /^\d{4}-\d{2}-\d{2}$/];

/** Whether `id` is a reserved keyword (or, for dates, a concrete-date literal). */
function isReservedId(domain: EntityDomain, id: EntityRef): boolean {
  const key = refKey(id);
  if (RESERVED_BY_DOMAIN[domain].includes(key.toUpperCase())) return true;
  if (domain === "date" && DATE_LITERAL_PATTERNS.some((re) => re.test(key))) return true;
  return false;
}

/** The item and group id lists for a domain (date has no renameable items). */
function domainIds(
  state: ScenarioUiState,
  domain: EntityDomain,
): {
  items: EntityRef[];
  groups: EntityRef[];
} {
  switch (domain) {
    case "person":
      return { items: state.staff.map((p) => p.id), groups: state.staffGroups.map((g) => g.id) };
    case "shift":
      return { items: state.shifts.map((s) => s.id), groups: state.shiftGroups.map((g) => g.id) };
    case "date":
      return { items: [], groups: state.dateGroups.map((g) => g.id) };
  }
}

/**
 * Reject a rename that would collide (design review finding #5 — reject, never
 * merge). Throws {@link RenameCollisionError} for a non-string target (a new id is
 * always an authored string — spec 06; T18 item ids may be numeric but a *rename
 * target* is not), a reserved-keyword target, or a target already used by another
 * item or group in the same domain. The entity's own `oldId` is excluded
 * (rename-to-self is a no-op, not a collision). Existing-id collisions use EXACT
 * identity — mirroring the producer's exact duplicate detection, so the distinct
 * ids `1` and `"1"` never falsely collide; only reserved keywords are matched
 * case-insensitively.
 */
export function assertNoRenameCollision(
  state: ScenarioUiState,
  domain: EntityDomain,
  oldId: EntityRef,
  newId: string,
): void {
  // Defensive runtime guard for untyped JS callers (the type already forbids it).
  if (typeof newId !== "string") {
    throw new RenameCollisionError(domain, oldId, newId, "non-string-id");
  }
  if (isReservedId(domain, newId)) {
    throw new RenameCollisionError(domain, oldId, newId, "reserved");
  }
  const { items, groups } = domainIds(state, domain);
  if (items.some((id) => id !== oldId && id === newId)) {
    throw new RenameCollisionError(domain, oldId, newId, "duplicate-item");
  }
  if (groups.some((id) => id !== oldId && id === newId)) {
    throw new RenameCollisionError(domain, oldId, newId, "duplicate-group");
  }
}
