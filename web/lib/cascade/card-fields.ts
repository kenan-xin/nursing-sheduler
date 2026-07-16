// Per-card reference-field maps (T07) — the new-model counterpart of the
// prototype's `dataType -> field` maps (`schedulingReferenceUpdates.ts`), spec 06
// FR-RI-05/10/11. In the rebuild the six editable preferences live as typed cards
// in `state.cardsByKind` (the always-on "at most one shift per day" carries no
// reference fields and is not modelled here — spec 06 FR-RI-05/AC-RI-05), and the
// person×date matrix lives in `state.reqData` (handled directly by the ops).

import type { CardsByKind } from "@/lib/scenario";
import type { EntityDomain } from "./domain";

/** The five reference-bearing card kinds. */
export type CardKind = keyof CardsByKind;

/**
 * Which field(s) on each card kind reference a given domain. A field only ever
 * references one entity kind (spec 06), so a domain selects exactly the fields to
 * rewrite/prune. Optional fields (e.g. requirement `date`/`qualifiedPeople`,
 * succession/covering `date`) are transformed only when present.
 */
export const CARD_REF_FIELDS: Record<CardKind, Record<EntityDomain, readonly string[]>> = {
  requirements: { person: ["qualifiedPeople"], date: ["date"], shift: ["shiftType"] },
  successions: { person: ["person"], date: ["date"], shift: ["pattern"] },
  counts: { person: ["person"], date: ["countDates"], shift: ["countShiftTypes"] },
  affinities: { person: ["people1", "people2"], date: ["date"], shift: ["shiftTypes"] },
  coverings: { person: ["preceptors", "preceptees"], date: ["date"], shift: ["shiftTypes"] },
};

/**
 * The coefficient list on each card kind whose tuple ids follow shift-type renames
 * / deletions (spec 06 FR-RI-06/10). Only the SHIFT domain touches these; a person
 * or date rename/delete never disturbs coefficient tuples.
 */
export const CARD_COEFFICIENT_FIELD: Partial<Record<CardKind, string>> = {
  requirements: "shiftTypeCoefficients",
  counts: "countShiftTypeCoefficients",
};

/**
 * Fields that must stay non-empty for a card to survive a delete (spec 06
 * FR-RI-11). A card is dropped when any listed field is *present but empty* after
 * pruning (an omitted optional field does not count — see `isEmptyRefField`).
 * Covering `date` is intentionally absent: it is optional (omitted = all dates,
 * DL08 / finding #18), so an emptied covering `date` is omitted, not a drop.
 */
export const CARD_REQUIRED_FIELDS: Record<CardKind, readonly string[]> = {
  requirements: ["shiftType", "date", "qualifiedPeople"],
  successions: ["person", "date", "pattern"],
  counts: ["person", "countDates", "countShiftTypes"],
  affinities: ["date", "people1", "people2", "shiftTypes"],
  coverings: ["preceptors", "preceptees", "shiftTypes"],
};
