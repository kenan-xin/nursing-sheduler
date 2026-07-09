---
title: "Functional Requirements — Nurse Scheduling Frontend Rebuild"
kind: story
status: 1
---

# Functional Requirements — Nurse Scheduling Frontend Rebuild

Complete, **UI-agnostic functional specification of the current app at**
**strict behavioral parity, produced so the frontend can be redesigned and**
rebuilt without losing any capability. See the [Epic Brief](../nurse-scheduling-rebuild-brief/index.md)
for scope, settled decisions, and non-goals.

**Fidelity bar: every observable behavior — including quirks and exact**
user-visible strings — is a hard requirement. Requirements describe *what the*
app does with data and state, **not how any UI looks or is laid out.**

## Spec conventions

- **Functional requirements are numbered **`FR-<PREFIX>-nn (frontend) or`
`CON-<PREFIX>-nn (fixed contracts).`
- **Acceptance criteria are **`AC-<PREFIX>-nn, written as UI-agnostic`
given/when/then, and seed the parity test suite.
- Exact user-visible strings are quoted verbatim. Incidental quirks are still
required but flagged `[incidental quirk].`
- **Fixed contracts (YAML schema, HTTP API, solver/preference semantics,**
exporter output) are documented as **conformance targets — the new frontend**
must conform; they are not being rebuilt.

## Frontend functional domains

| Artifact | Prefix | Covers |
| --- | --- | --- |
| 01 — Data Model & Entities | DM | People/Shift Types/Dates + groups, IDs-as-labels, history, reserved & auto-generated entities, ordering. |
| 02 — Dates & Calendar | DC | Range-driven date generation, ID-format-by-span, calendar selection, Singapore-holiday import (English-only), date groups. |
| 03 — Item/Group Editors (People & Shift Types) | ED | Item/group CRUD, inline edit, reorder, duplicate, bulk people upload, reserved-keyword rules. |
| 04 — Shift Requests Editor | SR | Person×date matrix, quick-add/drag, CSV upload, history editing, preference-delta compaction. |
| 05 — Card Preference Editors | PR | Shift Type Requirements, Successions, Counts, Affinities, **Coverings** — fields, validation, weight semantics, coefficients. |
| 06 — Reference Integrity | RI | Rename/delete cascade across preferences, people history, export layout; empty-preference pruning (incl. the `shift type covering rule)`. |
| 07 — State, History, Persistence & Interaction | ST | Single store, localStorage, 50-deep undo/redo, dirty/tab-switch guard, **13-tab **navigation, keyboard shortcuts, scroll. |
| 08 — Save / Load & YAML | SL | Full-state replace, download/upload/copy/edit, import warnings, anonymize panel, version-mismatch handling. |
| 09 — Export Layout | EX | Formatting rules, extra columns/rows, coefficients, default generated layout. |
| 10 — Optimize & Export | OE | Backend selection/health, job submission, SSE progress + chart, cancel/finish-now, heartbeat, xlsx download + ID restore. |
| 11 — Shift Type Coverings Editor | CV | Focused parity spec for the hard-reified `shift type covering editor: page shell, save shape, validation, card display, reference-cascade behavior.` |

## Fixed contracts (conformance targets)

See [contracts/: YAML scenario schema, HTTP serve API,](./contracts/index.md)
preference/constraint semantics, solvers & CLI execution, exporter output.

## Behavior / test catalog

See [behavior-test-catalog: consolidated](./behavior-test-catalog/index.md)
UI-agnostic acceptance criteria + guidance on reusing the Python core tests and
re-authoring UI e2e against the new design.
