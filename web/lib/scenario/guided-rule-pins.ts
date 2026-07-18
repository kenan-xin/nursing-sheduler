// Guided rule pin domain model (T14a). A `GuidedRulePin` is durable shortcut
// metadata over an existing Advanced constraint card — Guided never owns a
// duplicate constraint value. These functions are pure (never touch the store);
// the store wires each op as one tracked `mutateScenario` call, exactly like the
// card CRUD in `components/*/use-*.ts`.
//
// `pruneOrphanedGuidedRulePins` is the shared source-card-deletion reconciliation
// (tech-plan §3: "deleting a source constraint removes its pins in the same
// tracked mutation"). It is called from both the entity-delete cascade
// (`lib/cascade/delete.ts`) and every per-kind card commit (`components/*/use-*.ts`),
// so no path that can remove a card can ever leave a dangling pin.

import type { CardsByKind, GuidedRuleConstraintKind, GuidedRulePin } from "./types";

/** The fields a caller supplies to create or fully redefine a pin. */
export interface GuidedRulePinDraft {
  constraintKind: GuidedRuleConstraintKind;
  constraintId: string;
  category: string;
  description?: string;
  quickFields: string[];
}

/** Build a new pin with a fresh stable id. */
export function createGuidedRulePin(draft: GuidedRulePinDraft): GuidedRulePin {
  return { id: crypto.randomUUID(), ...draft };
}

/** Append `pin`, or replace the existing pin with the same `id`. */
export function upsertGuidedRulePin(
  pins: readonly GuidedRulePin[],
  pin: GuidedRulePin,
): GuidedRulePin[] {
  const index = pins.findIndex((p) => p.id === pin.id);
  if (index === -1) return [...pins, pin];
  const next = [...pins];
  next[index] = pin;
  return next;
}

/** The durable invariant: at most one pin per `(constraintKind, constraintId)`
 *  source (T14d). Insert a new pin for `draft`'s source, or replace the
 *  existing pin for that same source in place (keeping its id, so an edit
 *  never churns identity) rather than appending a duplicate. */
export function upsertGuidedRulePinBySource(
  pins: readonly GuidedRulePin[],
  draft: GuidedRulePinDraft,
): GuidedRulePin[] {
  const index = pins.findIndex(
    (p) => p.constraintKind === draft.constraintKind && p.constraintId === draft.constraintId,
  );
  if (index === -1) return [...pins, createGuidedRulePin(draft)];
  const next = [...pins];
  next[index] = { ...pins[index], ...draft };
  return next;
}

/** Collapse duplicate pins referencing the same `(constraintKind, constraintId)`
 *  source down to one — the last occurrence (the most recently written) wins.
 *  Reconciles legacy persisted data written before `upsertGuidedRulePinBySource`
 *  enforced the one-pin-per-source invariant (T14d); reference-stable when no
 *  duplicates are present. */
export function dedupeGuidedRulePinsBySource(pins: readonly GuidedRulePin[]): GuidedRulePin[] {
  const keyOf = (pin: GuidedRulePin) => `${pin.constraintKind}:${pin.constraintId}`;
  const lastIndexByKey = new Map<string, number>();
  pins.forEach((pin, index) => lastIndexByKey.set(keyOf(pin), index));
  const next = pins.filter((pin, index) => lastIndexByKey.get(keyOf(pin)) === index);
  return next.length === pins.length ? (pins as GuidedRulePin[]) : next;
}

/** Remove every pin whose id is in `ids` — the bulk counterpart to
 *  `removeGuidedRulePin`, backing the one-click "clear stale pins" cleanup
 *  (T14d). One call, one patch, reference-stable when nothing is removed. */
export function removeGuidedRulePins(
  pins: readonly GuidedRulePin[],
  ids: readonly string[],
): GuidedRulePin[] {
  if (ids.length === 0) return pins as GuidedRulePin[];
  const idSet = new Set(ids);
  const next = pins.filter((pin) => !idSet.has(pin.id));
  return next.length === pins.length ? (pins as GuidedRulePin[]) : next;
}

/** Patch a pin's shortcut metadata (category/description/quickFields) by id. A
 *  missing id is a no-op — reference-stable, matching the cascade's discipline. */
export function updateGuidedRulePin(
  pins: readonly GuidedRulePin[],
  id: string,
  patch: Partial<Pick<GuidedRulePin, "category" | "description" | "quickFields">>,
): GuidedRulePin[] {
  let changed = false;
  const next = pins.map((pin) => {
    if (pin.id !== id) return pin;
    changed = true;
    return { ...pin, ...patch };
  });
  return changed ? next : (pins as GuidedRulePin[]);
}

/** Remove a pin by id (unpin). Never touches the source constraint. A missing id
 *  is a no-op — reference-stable. */
export function removeGuidedRulePin(pins: readonly GuidedRulePin[], id: string): GuidedRulePin[] {
  const next = pins.filter((pin) => pin.id !== id);
  return next.length === pins.length ? (pins as GuidedRulePin[]) : next;
}

/** Whether `pin`'s source constraint card still exists in `cardsByKind`. */
function pinSurvives(pin: GuidedRulePin, cardsByKind: CardsByKind): boolean {
  return cardsByKind[pin.constraintKind].some((card) => card.uid === pin.constraintId);
}

/**
 * Drop pins whose source constraint no longer exists in `cardsByKind` — the
 * shared source-card-deletion reconciliation every card-mutating commit runs
 * against. No dangling pin (referencing a card `uid` that no longer exists) can
 * survive a direct card removal or an entity-delete cascade. Reference-stable
 * when nothing is pruned, so an unrelated card edit never spends a spurious
 * `guidedRulePins` reference change.
 */
export function pruneOrphanedGuidedRulePins(
  pins: readonly GuidedRulePin[],
  cardsByKind: CardsByKind,
): GuidedRulePin[] {
  const next = pins.filter((pin) => pinSurvives(pin, cardsByKind));
  return next.length === pins.length ? (pins as GuidedRulePin[]) : next;
}
