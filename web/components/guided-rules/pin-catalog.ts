// Pin catalog and CRUD adapters over T14a (T14b scope). `listPinnableRecords`
// backs the "Customise library" picker (one entry per card of the five kinds,
// independent of whether it is already pinned); `pinConstraint`/`repinConstraint`/
// `unpinConstraint` wrap T14a's pure `guidedRulePins` array ops with the
// existence/quick-field validation the picker needs, returning a structured
// `GuidedPinOutcome` instead of throwing.

import {
  removeGuidedRulePin,
  updateGuidedRulePin,
  upsertGuidedRulePinBySource,
  type CardsByKind,
  type GuidedRuleConstraintKind,
  type GuidedRulePin,
  type ScenarioUiState,
} from "@/lib/scenario";
import type { GuidedPinOutcome, GuidedRuleMapper, PinnableRecord } from "./types";
import {
  affinitiesMapper,
  countsMapper,
  coveringsMapper,
  requirementsMapper,
  successionsMapper,
} from "./mappers";

function pinnableFor<TCard extends { uid: string }>(
  mapper: GuidedRuleMapper<TCard>,
  cards: readonly TCard[],
): PinnableRecord[] {
  return cards.map((card) => {
    const unsupported = mapper.unsupportedReason(card);
    return {
      kind: mapper.kind,
      constraintId: card.uid,
      label: mapper.defaultTitle(card),
      category: mapper.category,
      quickFieldOptions: unsupported
        ? []
        : mapper.quickFields(card).map((f) => ({ key: f.key, label: f.label, value: f.value })),
    };
  });
}

/** Every card of the five kinds, as a pinnable candidate for the "pin a
 *  constraint" picker — independent of whether it is already pinned. */
export function listPinnableRecords(state: ScenarioUiState): PinnableRecord[] {
  return [
    ...pinnableFor(requirementsMapper, state.cardsByKind.requirements),
    ...pinnableFor(successionsMapper, state.cardsByKind.successions),
    ...pinnableFor(countsMapper, state.cardsByKind.counts),
    ...pinnableFor(affinitiesMapper, state.cardsByKind.affinities),
    ...pinnableFor(coveringsMapper, state.cardsByKind.coverings),
  ];
}

function quickFieldKeysFor<TCard extends { uid: string }>(
  mapper: GuidedRuleMapper<TCard>,
  cards: readonly TCard[],
  constraintId: string,
): string[] | undefined {
  const card = cards.find((c) => c.uid === constraintId);
  if (!card) return undefined;
  const unsupported = mapper.unsupportedReason(card);
  return unsupported ? [] : mapper.quickFields(card).map((f) => f.key);
}

/** Resolve a card's mapper-declared quick-field keys directly against
 *  `cardsByKind` — the validation seam `pinConstraint`/`repinConstraint` share.
 *  `undefined` means the source card does not exist. */
function resolveQuickFieldKeys(
  cardsByKind: CardsByKind,
  kind: GuidedRuleConstraintKind,
  constraintId: string,
): string[] | undefined {
  switch (kind) {
    case "requirements":
      return quickFieldKeysFor(requirementsMapper, cardsByKind.requirements, constraintId);
    case "successions":
      return quickFieldKeysFor(successionsMapper, cardsByKind.successions, constraintId);
    case "counts":
      return quickFieldKeysFor(countsMapper, cardsByKind.counts, constraintId);
    case "affinities":
      return quickFieldKeysFor(affinitiesMapper, cardsByKind.affinities, constraintId);
    case "coverings":
      return quickFieldKeysFor(coveringsMapper, cardsByKind.coverings, constraintId);
  }
}

/** Fields a caller supplies to pin a constraint — mirrors `GuidedRulePinDraft`
 *  (T14a) minus `constraintKind`/`constraintId`, which come from the picker. */
export interface PinConstraintInput {
  constraintKind: GuidedRuleConstraintKind;
  constraintId: string;
  category: string;
  description?: string;
  quickFields: string[];
}

/**
 * Pin a constraint: validate the source card exists and every requested quick
 * field is one the mapper actually declares for it, then insert a new pin —
 * or, when this source is already pinned, replace that existing pin in place
 * rather than appending a duplicate (T14d: at most one pin per source).
 * `quickFields: []` is a valid, deliberate display-only pin.
 */
export function pinConstraint(
  cardsByKind: CardsByKind,
  pins: readonly GuidedRulePin[],
  input: PinConstraintInput,
): GuidedPinOutcome {
  const available = resolveQuickFieldKeys(cardsByKind, input.constraintKind, input.constraintId);
  if (available === undefined) return { kind: "missing-source" };
  const invalid = input.quickFields.find((key) => !available.includes(key));
  if (invalid !== undefined) return { kind: "unsupported-field", field: invalid };

  return { kind: "applied", pins: upsertGuidedRulePinBySource(pins, input) };
}

/** Patch an existing pin's shortcut metadata (category/description/quickFields).
 *  Re-validates `quickFields` against the CURRENT card shape, so a field the
 *  source no longer supports (e.g. after an Advanced edit) can never linger. */
export function repinConstraint(
  cardsByKind: CardsByKind,
  pins: readonly GuidedRulePin[],
  id: string,
  patch: { category?: string; description?: string; quickFields?: string[] },
): GuidedPinOutcome {
  const pin = pins.find((p) => p.id === id);
  if (!pin) return { kind: "missing-source" };
  if (patch.quickFields) {
    const available = resolveQuickFieldKeys(cardsByKind, pin.constraintKind, pin.constraintId);
    if (available === undefined) return { kind: "missing-source" };
    const invalid = patch.quickFields.find((key) => !available.includes(key));
    if (invalid !== undefined) return { kind: "unsupported-field", field: invalid };
  }
  return { kind: "applied", pins: updateGuidedRulePin(pins, id, patch) };
}

/** Unpin — removes only the shortcut, never the source constraint. Always
 *  succeeds (a missing id is a reference-stable no-op, per T14a). */
export function unpinConstraint(pins: readonly GuidedRulePin[], id: string): GuidedRulePin[] {
  return removeGuidedRulePin(pins, id);
}
