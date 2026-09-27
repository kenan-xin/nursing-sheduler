---
title: "06 — Re-baseline: shipped backend is the contract; fidelity rule; spec-12 vision deferred"
kind: spec
---

# Decision 06 — Re-baseline to the shipped backend

Triggered by the adversarial coverage critique ([leave-coverage-critique](../../../leave-coverage-critique/index.md)),
which found the LEAVE feature is half-shipped and the specs are split in opposite
directions from the code. This decision settles how the spec corpus is re-baselined.

## Settled decisions

1. **The shipped Python backend IS the parity contract. The core moves to the new**
base with minimal changes. Therefore whatever the backend accepts, rejects, and
produces *today is what the new frontend must conform to — it is not a design choice.*
2. **The shipped "middle state" is current, not the spec-12 vision. What actually**
runs today is the three-state day-state model with a single reserved `LEAVE`
sentinel (`LEAVE_sid = -2), a single leaves[(d,p)] variable, live`
`durationMinutes (authoring-only), and exporter "Leave" rendering. The elaborate`
spec-12 design — a top-level `leaveTypes container, pre-Pydantic LV migration,`
multi-type `map_lid_lt leave, unit-toggle integer safety — is `**not implemented and**
** is deferred as a future backend enhancement. It must not appear in the parity layer.**
3. **Fidelity rule (confirmed by the user). For the rebuild:**
  - **Binding: backend behaviors, data shapes, validations, and exact backend**
error messages.
  - **Free: the UI — the new frontend may look and flow however the (WIP) design lands.**
  - **Incidental (not required): current-frontend quirks (e.g. the current UI treating**
a `LEAVE request as a normal weighted shift-type selector, or auto-fill rounding`
12.5h→13 in hour mode). These are recorded as `[incidental], not forced onto the`
new design. The binding requirement is the *data shape and backend error, not the*
current widget behavior.

## What this means concretely

- **Contracts C1/C3/C4/C5 are re-baselined UP to the shipped three-state backend: live**
`LEAVE + durationMinutes move out of "Option C / future" into "current"; ALL`
expansion, succession/count/affinity semantics, reserved ids `{ALL, OFF, LEAVE}, and`
exporter `"Leave" rendering are corrected to match source.`
- **Spec 12 / decision-log 05 are re-baselined DOWN to what shipped: the **`leaveTypes`
container, the `LV migration, and the multi-type leave model are removed from the`
parity layer and fenced as a documented future extension.
- The behavior-test catalog tags each row parity-backbone (source-backed) vs.
target/aspirational.

## Verified source-of-truth anchors

- Reserved ids + sentinels: `constants.py:22-26 (ALL, OFF/OFF_sid=-1,`
`LEAVE/LEAVE_sid=-2).`
- `ALL = worked shift types only (excludes OFF+LEAVE): scheduler.py:89-91.`
- Three-state equation `offs + Σshifts + leaves == 1: scheduler.py:201.`
- Leave is input-only (pinned by requests, forced 0 elsewhere): `scheduler.py:276-284;`
`context.py:56-63.`
- Shift request ALL→worked_sum; OFF→offs; LEAVE→hard pin: `preference_types.py:238-280.`
- Requirements reject OFF **and LEAVE (exact messages): **`preference_types.py:138-148.`
- Covering rejects OFF **and LEAVE (exact message): **`preference_types.py:716-720.`
- Count/affinity route through `_day_state_expr (OFF+LEAVE countable): preference_types.py:32-44, 470-472, 623-637.`
- `ShiftType.durationMinutes live; no leaveTypes; reserved enforced on items+groups;`
history allows OFF+LEAVE: `models.py:67-73, 334-386, 396-402.`
- No migration: `loader.py:53-54.`
- Exporter renders `"Leave"; three-state sanity check: exporter.py:604-635.`
- `SolverProgress.solutionIndex: int | None: solver_interface.py:49, 95.`

## Non-goals / out of scope

- **LV migration — REMOVED (non-issue).** The pre-Pydantic `LV`-to-`LEAVE`
migration (marker recognition `paidLeave`/`isLeave`, `LV`-id fallback, full
reference rewriting) is **removed as a requirement**, not deferred. Rationale:
the rebuild is from scratch, the backend moves as-is, and the shipped model
uses the `LEAVE` keyword directly — there is no legacy `LV` data to migrate.
The requirement, its acceptance criteria (AC-CH-10a..10e), its contract entry
(CON-YAML-24), and its test (CH-B9) are struck from the corpus.
- Building the spec-12 `leaveTypes`/multi-type vision (deferred future work —
distinct from migration, which is removed).
- Changing the Python core (it is a fixed contract; this decision only corrects the
*documentation to match it).*
- Visual/interface design (WIP, separate track).
