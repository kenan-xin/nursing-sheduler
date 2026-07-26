// Guided rule projection/mutation types (T14b). A `GuidedRuleRow` is the plain-
// English Rules-screen unit: EVERY card of the five constraint kinds gets exactly
// one row via its kind's mapper (tech-plan §3 — "derive every row from
// `cardsByKind` through a per-kind mapper registry"); built-in structural rules
// (e.g. "at most one shift per day") are additional, separately-derived, always-
// locked rows. There is nothing to opt into and nothing to configure — the row
// set IS the constraint set, and a row never holds a value the source record
// does not.

import type { GuidedRuleConstraintKind } from "@/lib/scenario";

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
  /** When set, this field is a soft/hard weight: it accepts `±Infinity` (a hard
   *  constraint) alongside finite values, so the Adjust control renders a weight
   *  text/`±∞` affordance instead of a plain `type="number"` box (which can't
   *  represent Infinity). Plain numeric fields (people/target) leave this unset. */
  allowsInfinity?: boolean;
  /** Returns an error message for an invalid value, `undefined` when valid. */
  validate(value: number): string | undefined;
}

/** A typed mapper for one constraint kind (T14b). Every function is pure — no
 *  store access — so the projection/mutation seam is fully unit-testable. */
export interface GuidedRuleMapper<TCard> {
  kind: GuidedRuleConstraintKind;
  /** The plain-English heading rows of this kind are grouped under. Derived from
   *  the kind alone, so it can never go stale against the record. */
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
   *  card-derived row. */
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
}

/** Structured outcomes for a Guided mutation — T14c renders these directly
 *  without parsing prose (T14b scope). */
export type GuidedMutationOutcome<TCard> =
  | { kind: "applied"; card: TCard }
  | { kind: "missing-source" }
  | { kind: "unsupported-field" }
  | { kind: "invalid-value"; message: string };
