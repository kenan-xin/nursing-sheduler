---
kind: review
title: "Cross-Spec Inconsistency Review — Nurse Scheduling Functional Specs"
---

# Cross-Spec Inconsistency Review

Scope reviewed: rebuild brief, functional-spec index, 11 domain specs, C1-C5 contracts, behavior-test catalog, and four decision logs. I skipped tickets, critique, and prior review artifacts except where the requested source files referenced the same concepts.

## Findings

### 1. Legacy multi-solver behavior still appears in design/test inputs, contradicting C2/C4

**Impact:** High. A designer or rebuilder could add solver selection, unsupported-solver handling, or multi-backend cancel states that the current contracts explicitly removed.

- Brief: [nurse-scheduling-rebuild-brief/index.md:49](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-rebuild-brief/index.md:49) still says the engine has "3 solvers" including OR-Tools, PuLP/CBC, and PuLP/cuOpt.
- Behavior catalog: [behavior-test-catalog/index.md:94](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/behavior-test-catalog/index.md:94) still says unsupported solver selection is rejected.
- Behavior catalog: [behavior-test-catalog/index.md:470](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/behavior-test-catalog/index.md:470) says cancel/finish-now is rejected for solvers without stop support.
- Behavior catalog: [behavior-test-catalog/index.md:481](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/behavior-test-catalog/index.md:481) says CLI output honors `solver+timeout`.
- Contract C2 says the HTTP surface has **no** solver field and always uses OR-Tools: [contracts/c2-http-serve-api/index.md:78](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/contracts/c2-http-serve-api/index.md:78), [contracts/c2-http-serve-api/index.md:156](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/contracts/c2-http-serve-api/index.md:156), [contracts/c2-http-serve-api/index.md:233](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/contracts/c2-http-serve-api/index.md:233).
- Contract C4 says OR-Tools CP-SAT is the only backend, there is no solver string, and no `--solver` flag: [contracts/c4-solvers-cli-execution/index.md:14](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/contracts/c4-solvers-cli-execution/index.md:14), [contracts/c4-solvers-cli-execution/index.md:22](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/contracts/c4-solvers-cli-execution/index.md:22), [contracts/c4-solvers-cli-execution/index.md:212](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/contracts/c4-solvers-cli-execution/index.md:212).

**Fix:** Update the brief diagram and behavior catalog entries to OR-Tools-only. Remove unsupported-solver parity cases and solver-selection wording; keep only timeout/prettify/anonymization as user-facing run options.

### 2. PH default date group decision is not fully propagated into State/Persistence

**Impact:** High. This changes the default-state contract a rebuilt frontend seeds and displays.

- Decision log 04 settles that default dates include `PH` alongside `WORKDAY` and `NON-WORKDAY`: [decision-logs/04-ph-default-group/index.md:17](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/decision-logs/04-ph-default-group/index.md:17).
- Spec 01 matches that decision: [01-data-model-and-entities/index.md:85](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/01-data-model-and-entities/index.md:85), [01-data-model-and-entities/index.md:154](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/01-data-model-and-entities/index.md:154).
- Spec 07 FR-ST-03 still says the default state has **two** seed date groups, `WORKDAY` and `NON-WORKDAY`: [07-state-history-persistence/index.md:81](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/07-state-history-persistence/index.md:81), [07-state-history-persistence/index.md:86](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/07-state-history-persistence/index.md:86).
- Spec 07 AC-ST-01 does include `PH`, so the same artifact contradicts itself: [07-state-history-persistence/index.md:494](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/07-state-history-persistence/index.md:494).

**Fix:** Update FR-ST-03 to list all three default groups and align the cited source line range with the PH-inclusive default state.

### 3. Preference-editor counts still drift even though the active tab count is now 13

**Impact:** Medium-high. The literal 12-tab drift appears cleaned up in active specs, but the remaining count language can still confuse the UI inventory.

- Brief diagram says "13 tabs" but "6 preference editors (incl. Coverings)": [nurse-scheduling-rebuild-brief/index.md:44](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-rebuild-brief/index.md:44).
- Brief domain table says "Preference editors (x5)" but lists Shift Requests plus four card editors and excludes Coverings: [nurse-scheduling-rebuild-brief/index.md:93](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-rebuild-brief/index.md:93).
- Spec index says `05 — Card Preference Editors` covers five card-list editors including Coverings, while `04 — Shift Requests Editor` is separate: [nurse-scheduling-functional-spec/index.md:37](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/index.md:37), [nurse-scheduling-functional-spec/index.md:38](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/index.md:38).
- Spec 11 says Coverings is the fifth card-list editor: [11-shift-type-coverings-editor/index.md:11](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/11-shift-type-coverings-editor/index.md:11).
- Spec 07 calls the inserted Coverings tab "a 7th preference editor": [07-state-history-persistence/index.md:331](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/07-state-history-persistence/index.md:331). That is probably meant to mean "7th preference type", not "7th editor"; the seven preference variants are defined in Spec 01: [01-data-model-and-entities/index.md:91](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/01-data-model-and-entities/index.md:91).

**Fix:** Use one consistent inventory: 13 tabs total; 6 preference-authoring tabs if counting Shift Requests + five card-list pages; 5 card-list preference editors; 7 preference variants in the data model. Update the brief and the "7th preference editor" phrase accordingly.

### 4. A live cross-reference points to nonexistent `FR-CV-07a`

**Impact:** Medium. This is a direct FR reference in the canonical data-model spec; a downstream implementer cannot follow it.

- Spec 01 references `FR-CV-07a`: [01-data-model-and-entities/index.md:99](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/01-data-model-and-entities/index.md:99).
- Spec 11 defines `FR-CV-07`, not `FR-CV-07a`: [11-shift-type-coverings-editor/index.md:123](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/11-shift-type-coverings-editor/index.md:123). The save-date caveat is also covered by `FR-CV-12` and `EDGE-CV-02`: [11-shift-type-coverings-editor/index.md:178](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/11-shift-type-coverings-editor/index.md:178), [11-shift-type-coverings-editor/index.md:343](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/11-shift-type-coverings-editor/index.md:343).

**Fix:** Change the Spec 01 reference to `FR-CV-07`, `FR-CV-12`, and/or `EDGE-CV-02`, or split Spec 11 to actually define `FR-CV-07a`.

### 5. Exact Optimize disabled/timeout strings gain an extra period in acceptance criteria

**Impact:** Medium-low, but this spec set says exact user-visible strings are hard requirements. The validation table and FR text have single-period strings, while AC text renders them with two periods.

- Canonical FR/table strings use one period: [10-optimize-and-export/index.md:204](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/10-optimize-and-export/index.md:204), [10-optimize-and-export/index.md:455](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/10-optimize-and-export/index.md:455), [10-optimize-and-export/index.md:456](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/10-optimize-and-export/index.md:456), [10-optimize-and-export/index.md:457](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/10-optimize-and-export/index.md:457).
- AC text appends sentence punctuation after the quoted message, producing `optimizing..`, `backend..`, and `integer..`: [10-optimize-and-export/index.md:560](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/10-optimize-and-export/index.md:560), [10-optimize-and-export/index.md:562](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/10-optimize-and-export/index.md:562), [10-optimize-and-export/index.md:566](/home/kenan/.traycer/epics/8b2235d5-8943-4f6d-a61e-3b671836217a/artifacts/nurse-scheduling-functional-spec/10-optimize-and-export/index.md:566).

**Fix:** Quote the exact string and put the sentence period outside the quoted/code span in a way that does not become part of the required UI text.

## Checked Clean

- Active specs now consistently describe 13 tabs; I did not find an active "12 tabs" requirement. Remaining "12-tab layout" text is historical comparison in Spec 07 and decision log 02, not the current route inventory.
- `STORAGE_KEY = nurse-scheduling-data`, `MAX_HISTORY_SIZE = 50`, `API_VERSION = alpha`, `singapore-holidays:v1`, and optimize-server localStorage key references appear consistent across the scoped artifacts.
- Singapore / English-only and `NON-WORKDAY` naming are largely aligned in active specs. The remaining Taiwan/FreeDay mentions are historical context in decision logs, not active requirements.
