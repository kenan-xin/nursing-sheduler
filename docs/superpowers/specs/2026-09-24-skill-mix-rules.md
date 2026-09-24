# Skill-mix rules ("at least k from a group on a shift") — spec

Bead: `nursing-sheduler-2ti`. Date: 2026-09-24. Status: draft for review.

## Problem

Ward managers need to say "at least 2 RNs on every night shift" or "at least one senior on every day". Today the product cannot say it directly:

- A `shift type requirement` is an **exact** count, or a floor-to-preferred range when `preferredNumPeople` is set (`core/nurse_scheduling/preference_types.py:185-190`).
- `qualifiedPeople` **bans everyone else** from those shifts (`preference_types.py:174-182`). So "2 RNs on nights", written as `qualifiedPeople: [RN], requiredNumPeople: 2`, really means "exactly 2 people on nights, both RNs". That shape already ships in the repair fixtures (`core/tests/fixtures/assistant_repair/onlyRnOnLeave.before.yaml`, "1 RN every night"), and the assistant's own tool example gets it wrong the same way (`web/lib/ai/runtime/model-visible-tools.test.ts:376-383`, "Two RNs on every night shift" with `qualifiedPeople: ["RN"]`).
- The real wards work around this with a **twin shift**. The header of `ward-8-shift-patterns-senior-on-every-shift.yaml` says why: `qualifiedPeople` excludes everyone else, so it cannot express "at least one of these", and the senior needs a slot of their own. Each pattern is declared twice (`night`, `night+`). The headcount moves onto a group (`AllNights = [night, night+]`). `night+` gets its own requirement with `qualifiedPeople`. Every rest rule names groups that include the twin.

## Options weighed

**(a) Keep the twin idiom and add one atomic "add skill mix" UI feature plus an assistant op that does the whole transformation.** To be safe, the transformation has to:
1. Add a twin shift type and copy its times and paid minutes.
2. Add a base+twin group.
3. Move every headcount card that names the base shift onto the group.
4. Add the twin requirement with `qualifiedPeople`.
5. Widen every other reference to the base shift so that it includes the twin. This covers succession patterns (directly and through groups), count rules with their `countShiftTypeCoefficients` and `hoursContract`, affinities and coverings. It also covers shift requests (a painted "night" request is **not** met by `night+`), history tokens and export formatting.

Removing a skill mix means running all of that in reverse. Every rule family added later must also remember to widen twins. That invariant has no end date, and the bead records it being missed once already ("A naive twin-only batch adds staff and lets twin shifts escape rest/cap rules"). The roster also shows `night+` as its own shift code. The per-date staffing override (sibling plan) would need to know about twins too. The solver pays for one extra shift type per twin, so the variable count goes up by a factor of (1 + 1/n).

**(b) A native solver concept: "at least k of these people among this shift's staff", with no ban on anyone else.** In the solver this is one linear inequality per (date, requirement group, entry):
`sum_{s in group, p in eligible ∩ G} shifts[d,s,p] >= k`.
Rest, cap and request rules stay correct with no changes, because nobody moves to a different shift. The field is optional and additive, so existing documents and twin scenarios keep working as they are. An older core build rejects the new field loudly (`extra="forbid"`) instead of misreading it.

**Recommendation: (b).** It is correct by construction, where (a) is only correct as long as a set of rewrite rules stays complete. It is also far smaller (about 15 lines in core against a many-family rewrite), and it is the concept managers actually have in mind.

### Where (b) lives: a field on the requirement, not a new preference type

A skill mix is always relative to one shift's headcount ("2 of the 4 on nights"). Managers already edit that headcount on the Staffing requirements card, and the nav already calls it "Min nurses & skill mix per shift" (`web/components/shell/nav-config.ts:167`). Putting `skillMix` on `ShiftTypeRequirementsPreference` and `RequirementCard` gives:
- No new store key, page, persistence kind, cascade kind or workspace model. The field goes through the requirement spine that already exists.
- A fail-safe for consumers that are not updated. They see the correct headcount and only miss the extra floor. The solver still enforces it.
- Parity for free. The UI form and the assistant's staffing ops share `validateRequirementForm`.

## Behaviour

### Data model (core and web, the same shape)

```yaml
- type: shift type requirement
  description: Night needs 4, at least 2 of them RNs
  shiftType: night
  requiredNumPeople: 4
  qualifiedPeople: ALL
  skillMix:
    - people: RN          # one person or staff-group id
      minNumPeople: 2
    - people: Senior
      minNumPeople: 1
  date: ALL
```

- `skillMix` is optional. When it is absent or an empty list there is no skill mix, and it is omitted on export.
- Entry `people`: a single `PersonRef` (a group id or a person id). Entry `minNumPeople`: an integer ≥ 1.
- Validation, the same in core (`model_validator`) and web (`validateRequirementForm`, persistence sanitizer):
  - `minNumPeople` must be at least 1 and at most `requiredNumPeople`.
  - `people` refs are unique within the card.
  - The card's `qualifiedPeople` must be absent or `ALL`. A skill mix on a banning card has no meaning.
  - The card must not use `shiftTypeCoefficients`. A skill mix counts heads.
- Semantics per date and per top-level shift selector of the card. This is the same equation grouping the headcount already uses, so an aggregate group such as `AllMornings` gives "one senior across the whole morning", which is ward-8's rule. Entries are independent floors, and a person in two groups counts toward both (an RN who is also a senior).
- Skill mix is always **hard**. There is no weight.

### Solver (`core/nurse_scheduling/preference_types.py::shift_type_requirements`)

For each (d, group), for each entry: `sum(shifts[(d,s,p)] for s in ss for p in qualified_ps_by_s[s] if p in parse_pids(entry.people)) >= entry.minNumPeople`. Nobody is banned. An empty or unknown group gives an infeasible model (or `ValueError: Unknown person ID`), never a crash.

### UI (Staffing requirements form and card)

- Under "Qualified people" there is a **Skill mix** field with rows of `[number] from [group/person select] [Remove]` and an "Add skill mix" button.
- Help text under the field: "At least this many of the shift's nurses must come from the group. Anyone can fill the other places."
- While Qualified people is not Everyone, the field is disabled with the note: "A skill mix needs the shift open to everyone. Set Qualified people to Everyone first."
- Card summary: `4 nurses · at least 2 RN, 1 Senior`.
- The Shifts page staffing chip shows `at least 2 RN`. Lowering the staffing there below a skill-mix minimum shows the validation message.

Validation messages (verbatim):
- `skillMixPeopleEmpty`: "Choose a staff group or person for each skill mix row"
- `skillMixMinInvalid`: "Each skill mix number must be a whole number of at least 1"
- `skillMixAboveRequired`: "A skill mix cannot ask for more people than the required number"
- `skillMixDuplicate`: "Each group or person can appear in the skill mix only once"
- `skillMixNeedsEveryone`: "A skill mix needs the shift open to everyone. Set Qualified people to Everyone first"
- `skillMixCoefficients`: "A skill mix counts people, so it cannot be combined with staffing multipliers"

### Assistant (propose, then Apply; parity with the UI)

- New arm `set_skill_mix { ruleId, skillMix: {people, minNumPeople}[] }`. It replaces the card's skill mix, which is what the Edit form's rows do, and it goes through `requirementToForm → validateRequirementForm → applyRequirementPatch`.
- `add_staffing_requirement` gains an optional `skillMix`, matching the Add form's rows, because a batch cannot address a card it creates (uids are digests).
- `edit_staffing_requirement` keeps the stored `skillMix`, the same way it keeps the preferred count.
- `set_staffing_requirement_people` and the Guided quick edit reject a count below the card's largest skill-mix minimum, using one shared helper.

### Preview wording

`describeRequirement` (`web/lib/proposal/diff.ts`) adds this after the count: `; at least 2 from “RN”, 1 from “Senior” — anyone can fill the other places`. An added, changed or removed skill mix therefore shows up as a before/after line on the card, with nothing hidden.

### Help text (`web/lib/capability/help-content.ts`, `staffing-requirements`)

Replace "The assistant cannot yet set up a skill-mix rule…" with: "A skill mix says how many of a shift's people must come from a group, for example at least 2 RNs among the 4 on nights; anyone can fill the other places. Naming who is qualified is different: nobody else can work that shift at all." Then regenerate with `pnpm capability:generate`.

### Static check and repair

- `findStaffingShortfalls` adds one counted equation per skill-mix entry. It is not restricting, has an infinite max and `mix: true`, and its qualified set is (entry people ∩ staff). A `requirement_short` from it has `skillMix: true` and the new field `mixPeople: <entry ref>`. `requirement_conflict` then also catches entries that exceed the headcount ceiling.
- `skillGroup` prefers `mixPeople`, so `borrow_temporary_nurse` offers to place the borrowed nurse **in that group**. The existing guard still applies: only when the manager confirms her qualification. `ask_nurse_on_leave` names a qualified member who is on leave.
- `run_one_short` is never offered for a skill-mix-only gap, because a lower headcount does not fix it. `skillMixOn` includes the card's own `skillMix` minimums, so a headcount never drops below them.
- **Safety floor, unchanged in principle:** the assistant can add or raise a skill mix. It can never remove an entry, lower `minNumPeople` or change an entry's `people` (`set_skill_mix`), remove a staff group that a skill mix names (`remove_people_group`), or turn off or remove a card that carries a skill mix (already forbidden as "staffing to 0"). `set_skill_mix` is never on the repair allowlist (`isSafeOption`). The existing `add_staffing_requirement` with a named `qualifiedPeople` stays forbidden.

### Export, import and versioning

- The field is additive and optional: no `workspaceVersion` bump, no persistence-version bump, no migration. The persistence sanitizer validates it when present.
- Import (lenient zod), producer (strict zod), canonical projection, anonymize (the entry's `people` is renamed), cascade (renaming a person or group rewrites entries, deleting one prunes entries), core workspace people-reference checks and the differential oracle all carry `skillMix`.
- Existing twin scenarios (`ward-8-*`, `large-ward-with-87-people-*`) are untouched and still solve.

## Out of scope

- Soft skill mix ("ideally one senior"), a roster-viewer indicator showing skill mix per cell, automatic conversion of twin scenarios to native, and multi-ref entries ("RN or Senior"). Model that last one with a group.

## Acceptance

1. A solver pytest proves that "night needs exactly 4, at least 2 from RN" gives ≥ 2 RNs every night, that non-RNs still work nights, that it is infeasible when only one RN is available, and that an empty group is infeasible without a crash.
2. The UI adds, edits and removes skill-mix rows; validation matches the messages above; the round trip through export and import is lossless.
3. `set_skill_mix` and `add_staffing_requirement{skillMix}` give the same card as the UI form (parity test). The Preview shows the wording above.
4. A scripted repair ward ("RN on leave under a skill mix") is proven infeasible before the top repair and feasible after it by the real solver. The top repair is `borrow_temporary_nurse` into group RN.
5. The safety floor rejects every relaxation listed above.
