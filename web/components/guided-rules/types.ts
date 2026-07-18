// Guided rule projection/mutation types (T14b). A `GuidedRuleRow` is the plain-
// English Rules-screen unit: EVERY enabled card of the five constraint kinds gets
// exactly one row via its kind's mapper (tech-plan §3 — "derive every row from
// `cardsByKind` through a per-kind mapper registry"); built-in structural rules
// (e.g. "at most one shift per day") are additional, separately-derived, always-
// locked rows. A `GuidedRulePin` (T14a) is an optional shortcut OVERLAY on top of
// an existing row — its `category`/`quickFields` override the mapper defaults and
// its presence flags the row as user-pinned — never a second source of truth for
// the constraint itself.

import type { GuidedRuleConstraintKind, GuidedRulePin } from "@/lib/scenario";

/** One numeric field a mapper declares eligible for the Guided inline Adjust
 *  control, with its current value and validator. People/shift-type/date fields
 *  are never offered here — they stay in Advanced (tech-plan §3). */
export interface GuidedQuickField {
  key: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  unit?: string;
  /** Returns an error message for an invalid value, `undefined` when valid. */
  validate(value: number): string | undefined;
}

/** A typed mapper for one constraint kind (T14b). Every function is pure — no
 *  store access — so the projection/mutation seam is fully unit-testable. */
export interface GuidedRuleMapper<TCard> {
  kind: GuidedRuleConstraintKind;
  /** Default category a row of this kind is grouped under, absent a pin override. */
  category: string;
  /** The Advanced route this kind's editor lives at (the "Edit in Advanced" link). */
  advancedRoute: string;
  /** The default plain-English title — `card.description` when authored, else a
   *  kind-specific fallback derived from the card's own fields. */
  defaultTitle(card: TCard): string;
  /** The plain-English one-line summary shown under the title. */
  summary(card: TCard): string;
  /** Mapper-declared numeric quick fields, `[]` when `card` is unsupported. */
  quickFields(card: TCard): GuidedQuickField[];
  /** A read-only fallback reason when the record's shape is outside Guided
   *  support (nested/multi-term constructs) — `undefined` when fully supported. */
  unsupportedReason(card: TCard): string | undefined;
  /** Apply an already-validated numeric quick edit, returning the new card body.
   *  Only ever called with a `key` this mapper declared via `quickFields`. */
  applyQuickField(card: TCard, key: string, value: number): TCard;
  /** Rename the plain-English title by writing the source card's own `description`
   *  — the "renaming the rule title updates the source constraint's existing
   *  description" contract (T14b scope). */
  rename(card: TCard, title: string): TCard;
}

/** One row the Rules screen renders. */
export interface GuidedRuleRow {
  /** Stable list key: `builtin:<id>` for a structural rule, `<kind>:<uid>` for a
   *  card-derived row — never the pin id, so the row survives a pin edit/removal. */
  id: string;
  source: "builtin" | "record";
  kind?: GuidedRuleConstraintKind;
  /** The source card's stable `uid` — absent for a built-in row. */
  constraintId?: string;
  category: string;
  title: string;
  summary: string;
  enabled: boolean;
  /** Built-ins are always locked; a `record` row is never locked (tech-plan §3 —
   *  only structural rules are locked). */
  locked: boolean;
  advancedRoute?: string;
  quickFields: GuidedQuickField[];
  /** Present when the record's shape can't be natively rendered — the "Set in
   *  Advanced only" read-only fallback (never hidden/flattened). */
  unsupportedReason?: string;
  /** The pin overlay this row was built from, when the constraint is pinned. */
  pin?: GuidedRulePin;
}

/** The result of projecting Guided rules from durable scenario state. */
export interface GuidedRuleProjection {
  rows: GuidedRuleRow[];
  /** Ids of pins that are never rendered on any row — either because their
   *  source constraint no longer resolves, or because a later duplicate for
   *  the same source superseded them (T14d). Should be empty in practice
   *  (T14a prunes orphaned pins on every card mutation; `pinConstraint` never
   *  appends a duplicate for an already-pinned source); surfaced as a
   *  structured, actionable signal — and a one-click cleanup target — rather
   *  than a silently dropped row. */
  stalePinIds: string[];
}

/** A pinnable record surfaced by the "Customise library" picker — one entry per
 *  enabled card of the five kinds, independent of whether it is already pinned. */
export interface PinnableRecord {
  kind: GuidedRuleConstraintKind;
  constraintId: string;
  label: string;
  category: string;
  /** The mapper's full declared quick-field set for this record (key/label/
   *  current value), so the picker can render a labelled tick-list rather than
   *  bare keys — `[]` when the record's shape is unsupported. */
  quickFieldOptions: { key: string; label: string; value: number }[];
}

/** Structured outcomes for a Guided mutation — T14c renders these directly
 *  without parsing prose (T14b scope). */
export type GuidedMutationOutcome<TCard> =
  | { kind: "applied"; card: TCard }
  | { kind: "missing-source" }
  | { kind: "unsupported-field" }
  | { kind: "invalid-value"; message: string };

/** Structured outcomes for a pin CRUD operation (T14b — "pin catalog and CRUD
 *  adapters over T14a"). */
export type GuidedPinOutcome =
  | { kind: "applied"; pins: GuidedRulePin[] }
  | { kind: "missing-source" }
  | { kind: "unsupported-field"; field: string };
