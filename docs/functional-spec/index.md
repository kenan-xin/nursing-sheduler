---
title: "Functional Requirements — Nurse Scheduling Frontend Rebuild"
kind: story
status: 1
---

# Functional Requirements — Nurse Scheduling Frontend Rebuild

Complete, **UI-agnostic functional specification of the current app at**
**behavioral parity, produced so the frontend can be redesigned and**
rebuilt without losing any capability. Parity is defined against the shipped
backend contract, not the current UI (see the fidelity bar below). See the
[Epic Brief](../nurse-scheduling-rebuild-brief/index.md)
for scope, settled decisions, and non-goals.

**Fidelity bar (re-baselined — see [decision log 06](./decision-logs/06-rebaseline-to-shipped-backend/index.md)):**
the **binding** layer is backend behavior, data shapes, validations, and exact
**backend** error strings — the shipped Python backend moves to the rebuild
as-is and is the contract. The **UI is free**: the new frontend may look and flow
however the design lands. Current-frontend presentation choices are **not**
requirements; they are flagged `[incidental]` and kept only as reference, not as
a parity gate. Requirements describe *what the app does with data and state,*
**not how any UI looks or is laid out.**

## Spec conventions

- **Functional requirements are numbered **`FR-<PREFIX>-nn (frontend) or`
`CON-<PREFIX>-nn (fixed contracts).`
- **Acceptance criteria are **`AC-<PREFIX>-nn, written as UI-agnostic`
given/when/then, and seed the parity test suite.
- Exact **backend** strings (validation/errors) are quoted verbatim and binding.
Current-frontend presentation is **not** required; it is flagged `[incidental]`
as reference only (per the fidelity bar above / decision log 06).
- **Fixed contracts (YAML schema, HTTP API, solver/preference semantics,**
exporter output) are documented as **conformance targets — the new frontend**
must conform; they are not being rebuilt.
- **Altitude: behavior and contracts, not implementation** (confirmed 2026-07-21).
Specify observable behavior, data-format contracts, and exact user-facing strings.
Do **not** cite implementation files, functions, or line numbers — those drift on
every refactor and were the single largest source of spec rot (see the
[spec accuracy audit](./spec-accuracy-audit-2026-07-21/index.md)). Describe *what*
the app does and the data shapes it reads/writes, not the code that does it.

## Frontend functional domains

| Artifact | Prefix | Covers |
| --- | --- | --- |
| 01 — Data Model & Entities | DM | People/Shift Types/Dates + groups, IDs-as-labels, history, reserved & auto-generated entities, ordering. |
| 02 — Dates & Calendar | DC | Range-driven date generation, ID-format-by-span, calendar selection, Singapore-holiday import (English-only), date groups. |
| 03 — Item/Group Editors (People & Shift Types) | ED | Item/group CRUD, inline edit, reorder, duplicate, bulk people upload, reserved-keyword rules. |
| 04 — Shift Requests Editor | SR | Person×date matrix, quick-add/drag, CSV upload, history editing, preference-delta compaction. |
| 05 — Card Preference Editors | PR | Shift Type Requirements, Successions, Counts, Affinities, **Coverings** — fields, validation, weight semantics, coefficients. |
| 06 — Reference Integrity | RI | Rename/delete cascade across preferences, people history, export layout; empty-preference pruning (incl. the `shift type covering rule)`. |
| 07 — State, History, Persistence & Interaction | ST | Single store, localStorage, 50-deep undo/redo, dirty/tab-switch guard, **13-tab **eyboard shortcuts, scroll. |
| 08 — Save / Load & YAML | SL | Full-state replace, download/upload/copy/edit, import warnings, anonymize panel, version-mismatch handling. |
| 09 — Export Layout | EX | Formatting rules, extra columns/rows, coefficients, default generated layout. |
| 10 — Optimize & Export | OE | Backend selection/health, job submission, SSE progress + chart, cancel/finish-now, heartbeat, xlsx download + ID restore. |
| 11 — Shift Type Coverings Editor | CV | Focused parity spec for the hard-reified `shift type covering editor: page shell, save shape, validation, card display, reference-cascade behavior.` |
| 12 — Contracted Hours, Paid Leave & Shift Durations | CH | Monthly contracted-hours workflow; first-class paid-leave day-state and grid-valid working time. Separate **Add Shift Count** and **Add Contracted Hours** actions share one backend encoding. Guided contracts use fixed half-hour hard **Exact** or **Allowed Range** totals for selected dates, minimal `{unit,policy}` metadata, concrete selector snapshots, and explicit previewed Refresh; marked expression/weight stay locked. There is no weekly rescaling, automatic propagation, provenance, or migration. `leaveTypes`, backend credit store, and multi-type leave remain **[DEFERRED]**. See [decision logs 05](./decision-logs/05-contracted-hours-and-leave-model/index.md)/[09](./decision-logs/09-minute-unit-and-working-time-coefficients/index.md). |

## Fixed contracts (conformance targets)

See [contracts/: YAML scenario schema, HTTP serve API,](./contracts/index.md)
preference/constraint semantics, solvers & CLI execution, exporter output.

## Behavior / test catalog

See [behavior-test-catalog: consolidated](./behavior-test-catalog/index.md)
UI-agnostic acceptance criteria + guidance on reusing the Python core tests and
re-authoring UI e2e against the new design.
