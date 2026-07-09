---
title: "Decision Log — Discovered gap: 7th preference type `shift type covering`"
kind: spec
---

# Decision Log — Discovered gap: 7th preference type `shift type covering`

## Context

While resuming wave 2 of the spec build (reviewing C1, C5, and the behavior/test
catalog against the current source), a thorough end-to-end walk-through of the
codebase surfaced a **previously undocumented preference type with a full**
implementation already merged:

- `core/nurse_scheduling/models.py:35, 304-323, 347 — defines`
`SHIFT_TYPE_COVERING = 'shift type covering' and the`
`ShiftTypeCoveringPreference model.`
- `core/nurse_scheduling/preference_types.py:622-732, 735-743 — handler`
`shift_type_covering and dispatch entry in PREFERENCE_TYPES_TO_FUNC.`
- `core/tests/test_shift_type_covering_preference.py — model unit tests.`
- `web-frontend/src/types/scheduling.ts:157, 229-237, 247 — type constant and`
`ShiftTypeCoveringPreference interface; added to the Preference union.`
- `web-frontend/src/components/Navigation.tsx:37 — new tab`
`'8b. Shift Type Coverings' at route /shift-type-coverings (index 9;`
total tab count is now 13, was 12).
- `web-frontend/src/app/shift-type-coverings/page.tsx (557 lines) — full`
card-list editor with form validation, drag-reorder, duplicate, delete,
scroll save/restore, IME-guarded Enter/Escape, undo-via-history.
- `web-frontend/src/app/shift-type-coverings/page.test.tsx — page tests.`
- `web-frontend/src/utils/anonymizeSchedulingState.ts:25, 76-83 — handles`
`preceptors, preceptees, shiftTypes via mapReferenceIdTree (the`
reference-tree contract for nested lists).

## Semantics (from the handler)

`shift_type_covering is a `**hard constraint: for every date in **`date and`
every shift type in `shiftTypes, if any person in preceptees is assigned to`
that shift that day, then at least one person in `preceptors must also be`
assigned. Encoded as the Boolean OR
`(sum(preceptors shifts) >= 1)  OR  (sum(preceptees shifts) < 1)`
(`preference_types.py:629-633). Unlike shift affinity (which is a soft`
weighted preference), this is unrejectable — the solver cannot leave a
preceptee working without a preceptor present.

## Scope of work for this decision

**Done in this turn (wave 2 work):**

- **C1 (**`contracts/c1-yaml-scenario-schema): added ShiftTypeCoveringPreference`
to §3.3 (preference (g)) and the canonical `type strings list; added a`
validation rule (V20) and an extra-key reference; updated §3.4 conformance
notes to call out the new fields' nested-list contract and the frontend
coercion to single-level arrays.
- **C3 (**`contracts/c3-preference-constraint-semantics): added CON-SEM-07`
documenting the handler semantics — the hard-OR reification, the
`constants.Operator.GE reification machinery, the cross-product expansion`
(preceptor-group × preceptee-group × shift-type-group), and the precondition
errors for empty selectors.
- **Behavior-test-catalog (**`behavior-test-catalog): added section CC`
covering the new preference type — UI behaviors, anonymization case,
reference cascade gap, edge cases, and unit-test references.

**Known gaps surfaced and NOT yet closed (deferred to follow-up turns):**

1. **Spec 06 (Reference Integrity): the cascade handler**
 `web-frontend/src/hooks/schedulingReferenceUpdates.ts does NOT include`
 `SHIFT_TYPE_COVERING in applyPreferencesForIdChange /`
 `applyPreferencesForIdDeletion / applyExportLayoutForIdChange. This is a`
 real bug in the codebase — renaming a person or shift type referenced in a
 covering rule leaves stale IDs in `preceptors/preceptees/shiftTypes;`
 deleting a referenced ID does NOT drop the rule. The behavior-test-catalog
 flags this explicitly (CC-B4) so it is not silently lost.
2. **Spec 07 (State / Persistence / Navigation): tab count changed from 12**
 to 13; the new tab is `8b. Shift Type Coverings at index 9; keyboard`
 shortcut `9 previously went to 9. Export Layout (now it goes to the new`
 tab and the user must use arrow keys to reach Export Layout). Number-key
 shortcuts 0-9 still only reach tabs 0-9 (Export Layout is now at index 10).
3. **Spec 05 (Card Preference Editors): title and scope currently cover**
 "Requirements, Successions, Counts, Affinities" (4 editors); needs to add
 the 5th covering editor. The PR prefix and validation/AC structure should
 cover it.
4. **Dedicated spec 11 (Shift Type Coverings Editor): the new tab is**
 non-trivial (557 lines of page logic + test coverage + reference-tree
 semantics); a dedicated spec artifact would give Claude Design and the
 rebuilders a focused target. Not strictly required (the existing C1/C3
 contracts plus the page tests give parity coverage), but recommended for
 parity-bar rigor given the size of the new feature.
5. **Sort order: **`web-frontend/src/hooks/schedulingPreferenceOrdering.ts:102`
 has `typeOrder = [AT_MOST_ONE_SHIFT_PER_DAY, SHIFT_TYPE_REQUIREMENT,  SHIFT_REQUEST, SHIFT_TYPE_SUCCESSIONS, SHIFT_COUNT, SHIFT_AFFINITY] — does`
 not include `SHIFT_TYPE_COVERING. Covering preferences will sort to the`
 tail (or behave unpredictably) on normalize. Real bug; flagged in
 CC-B5.
6. **Anonymization unit-test coverage: no tests in**
 `web-frontend/src/utils/anonymizeSchedulingState.test.ts cover the new`
 branch (lines 76-83 of `anonymizeSchedulingState.ts). Re-author when`
 tests are regenerated.
7. **E2E coverage: zero e2e specs reference the new tab. Re-author when**
 e2e specs are regenerated.

## Affected artifacts (this turn)

- `nurse-scheduling-functional-spec/contracts/c1-yaml-scenario-schema/index.md`
— §3.3 (added preference (g)), §3.4 conformance notes (called out new fields
and nested-list contract), §5 validation table (added V20 for extra-field
rejection pattern; cross-referenced shift-type covering semantics to C3).
- `nurse-scheduling-functional-spec/contracts/c3-preference-constraint-semantics/index.md`
— added CON-SEM-07 (handler-level semantics).
- `nurse-scheduling-functional-spec/behavior-test-catalog/index.md`
— added a CC-prefixed section covering UI behaviors, anonymization,
reference-cascade gap, normalization-sort gap, unit/e2e test references.

## Decision

Document this gap as a known issue rather than pretending the spec was complete.
The wave 2 work adds the contract coverage and the test catalog; the
remaining gap-filling (dedicated spec 11, spec 06 cascade fix, spec 07 nav
update, spec 05 editor count update) is tracked here as explicit follow-up.

## Status update (wave 3 — gap closure)

The five items listed as deferred follow-up have been closed for the
code, the spec structural shape, and the test coverage:

1. **Spec 06 cascade fix — **`applyPreferencesForIdChange and`
 `applyPreferencesForIdDeletion now branch on SHIFT_TYPE_COVERING,`
 rewriting the nested `preceptors / preceptees / shiftTypes trees`
 on rename and filtering them on delete (with the second-pass
 required-field drop for empty rules). 14 new tests added to
 `schedulingReferenceUpdates.test.ts (10 nested-tree tests + 4`
 flat-runtime-shape tests), all passing.
2. **Spec 07 nav update — tab count is now 13; the new tab sits at**
 array index 9 (`8b. Shift Type Coverings); the digit 9 jumps to`
 the new tab (Export Layout is now unreachable by digit, at array
 index 10). The stale 12-tab text in spec 07's edge cases and
 `AC-ST-17 has been refreshed.`
3. **Spec 05 editor count update — the artifact is renamed to**
 "Card Preference Editors (Requirements, Successions, Counts,
 Affinities, Coverings)" and documents the covering editor's
 unique fields. The shared-section header has been corrected from
 "all four editors" to "all five editors."
4. **Spec 11 — Shift Type Coverings Editor — created as a dedicated**
 artifact at
 `nurse-scheduling-functional-spec/11-shift-type-coverings-editor/index.md`
 with FR-CV-01..24, validation rules, edge cases, and 14 acceptance
 criteria.
5. **Sort-order fix — **`sortPreferencesByType includes`
 `SHIFT_TYPE_COVERING in the trailing position of the type order;`
 `normalizePreferenceOrder adds a covering branch that sorts the`
 flat `date array and passes the nested trees through unchanged.`
 5 new tests added to `schedulingPreferenceOrdering.test.ts (all`
 passing).

The behavior-test-catalog entries CC-B4 and CC-B5 have been rewritten to
describe the closed behavior (with @line citations to the new tests)
rather than the prior "known gap" status.

## Status update (wave 3 — review findings)

A subsequent adversarial review of wave 3 surfaced two **product-side**
**quirks that the spec now documents explicitly (rather than papering**
over). They are **out of scope for the wave 3 code changes and remain**
open as future follow-up:

1. **Covering editor silently drops the selected ****`date`**** on Save/Update.**
 `buildPrefFromForm at`
 `web-frontend/src/app/shift-type-coverings/page.tsx:155-162 does not`
 copy `formData.date into the persisted object, regardless of the`
 user's selection. The form tracks the selection across toggles, but
 the saved preference never carries a `date key. Spec 11 FR-CV-07`
 and FR-CV-12, AC-CV-02, EDGE-CV-02, and spec 05 FR-PR-84 and
 EDGE-PR-17 now document this current behavior and offer a one-line
 fix for a rebuilder:
 `...(formData.date.length > 0 ? { date: formData.date } : {}) in`
 `buildPrefFromForm.`
2. **Covering ****`weight`**** is semantically misleading in the UI copy.**
 The current backend
 (`core/nurse_scheduling/preference_types.py:622-633, :701-721) does`
 not read `preference.weight at all — every valid weight produces the`
 same hard implication. The instructions-panel text
 ("Use 1 (default) for a soft preference or +Infinity (∞) for a hard
 require...") is preserved verbatim for strict UI parity but is
 semantically wrong. Spec 05 FR-PR-86, spec 11 EDGE-CV-04, and
 `behavior-test-catalog/index.md CC-B8 all annotate this`
 divergence.

The behavior-test-catalog coverage claim for covering UI flows
("validation, duplicate, drag-reorder, delete") overstates current test
coverage: `web-frontend/src/app/shift-type-coverings/page.test.tsx`
only has three cases (open form, weight label, render existing rules).
This is documented in the catalog as a known coverage gap, not
silently asserted as parity.
