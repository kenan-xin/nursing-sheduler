---
title: "DL13 — Flat extended scheduling YAML and strict solver conversion"
kind: spec
---

# DL13 — Flat extended scheduling YAML and strict solver conversion

Settled with the user while revising the T08/T14/T17 technical approach after DL12.

## Decisions

1. **Workspace YAML extends the existing backend YAML in place.** Introduce a
versioned flat `WorkspaceSchedulingDataV1` superset understood by both TypeScript
and Python. Existing top-level `apiVersion`, `dates`, `people`, `shiftTypes`,
`preferences` and `export` remain in place; there is no `scenario`/`ui` wrapper.
2. **The extension is forward-compatible with old files.** The new frontend and
backend accept legacy backend-only YAML with no `workspaceVersion`. New files may
add optional authoring fields: incomplete/null dates, stable preference IDs,
and enabled state. Old backend binaries are not
expected to accept new fields because their models use `extra="forbid"`.
3. **Workspace files preserve authoring state.** They may contain incomplete setup,
disabled constraint records, requests, and export configuration. The format is neutral domain data, not a serialized
React/Zustand store.
4. **The strict solver model stays strict.** `NurseSchedulingData` remains the
authoritative Optimize boundary. A workspace adapter filters disabled records,
strips workspace/UI metadata, canonicalizes, and then validates the existing
solver model. Incomplete work is never passed into scheduling internals.
5. **Optimize accepts both forms.** The existing backend Optimize upload detects
`workspaceVersion`; workspace input is converted and validated before a job is
created. Legacy/backend YAML continues to load unchanged.
6. **Frontend Save & Load emits extended workspace YAML.** Optimize still submits the strict
producer projection. Legacy/backend YAML imported by the frontend is normalized
into the workspace state model.
7. **Guided disclosure is intentional.** Guided Save & Load shows backup, sharing,
loading, recovery and ordinary anonymisation. Raw YAML preview/editing, schema
metadata and developer-only scatter controls are Advanced tools.

## Amendment — 2026-07-26: `guidedRules` removed from the contract

Decisions 2 and 3 originally carried a top-level `guidedRules` array (Guided pin
overlays). The Customise-library feature that produced it has been removed, so the
key is deleted from `WorkspaceSchedulingDataV1` on both the TypeScript and Python
sides — no tolerance shim and no `workspaceVersion` bump, since the app is
pre-production with no files in the wild. Under `extra="forbid"`, a document still
carrying `guidedRules` is now rejected as an unknown field. Everything else in
DL13 — the flat superset, dual-format dispatch, preserved authoring state, the
strict solver boundary — is unchanged. See
[the removal decision](../../../app-prototype-fidelity-audit/decisions/rules-remove-customise-library/index.md).

## Supersession

This is a deliberate extension to DL06's previously fixed backend-contract rule.
DL06 continues to govern solver semantics, C1/C3/C5 behavior and the strict
`NurseSchedulingData` model. DL13 adds one new compatibility boundary around it;
it does not relax the solver model itself.

## See also

- [Tech decision — YAML serializer (`yaml`, pinned 1.2, ruamel-aligned)](../../../rebuild-tech-plan/decisions/yaml-serializer-ruamel-alignment-2026-07-22/index.md) — the library + serialization discipline that emits this format across the JS/Python boundary.
