---
title: "Save / Load & YAML"
kind: spec
status: 1
---

# Save / Load & YAML

<user_quoted_section>Spec altitude convention (2026-07-22): this section documents observablebehavior, data-format contracts, and user-visible strings. It does NOT citesource files, function names, or line numbers — those rot on every refactor.Acceptance evidence is Given/When/Then, not code references.</user_quoted_section>

## Purpose & Scope

Save / Load backs up, shares, and restores the working scheduling scenario as
YAML. It is **not** the primary save mechanism — the browser auto-persists
every committed edit to IndexedDB (that auto-save is covered in spec 07).
Save / Load produces and consumes **YAML files** for backup, sharing, and
advanced editing.

**In scope**

- Two YAML file formats: **Workspace V1** (what the app exports) and
**legacy/scenario** (what the app accepts for backward compatibility).
- Download (plain and anonymized), Copy, Edit-YAML-inline, and Upload flows.
- Dual-format load dispatch, version integrity check, and replacement safety.
- The Anonymize panel and its transform.
- Backup-freshness indicator and Start-over reset.

**Out of scope**

- Auto-save to IndexedDB and undo/redo history internals (spec 07).
- The Optimize & Export run experience (spec 10), which submits a *strict*
solver projection — not a workspace backup.
- GitHub release polling banner (operational, not scenario integrity).

## 1. Two file formats

The app emits and accepts two YAML file shapes. Both are self-contained data
contracts — this section defines them without relying on external schema docs.

### 1.1 Workspace V1 (what the app exports)

Every user-authored backup — Download, Copy, Edit-YAML preview, anonymized
Download — emits Workspace V1. This is a **superset** of the legacy/scenario
format: it carries everything the solver needs, plus authoring state the solver
never sees.

**Top-level keys, in emitted order:**

| Key | Type | Purpose |
| --- | --- | --- |
| `workspaceVersion` | `1` (integer) | Format discriminator. Always first. |
| `apiVersion` | string | Backend data contract (currently `"alpha"`). |
| `description` | string (optional) | Free-text scenario description. |
| `dates.range` | `{ startDate: date\|null, endDate: date\|null }` | Roster range. **null preserves incomplete work.** |
| `dates.groups` | array (optional) | Date groups. |
| `country` | string (optional) | Holiday locale. |
| `people` | container | People items + groups. |
| `shiftTypes` | container | Shift-type items + groups. |
| `preferences` | array | Constraint/request records, each with optional `workspaceId` (stable identity) and `enabled` (on/off flag). Disabled records are **kept**, not stripped. |
| `export` | object (optional) | Export layout config. Present only when configured. |
| `appVersion` | string (optional) | Build provenance. Always last. Can be `"unknown"`. |

**Key invariant:** the backbone (`apiVersion`, `dates`, `people`, `shiftTypes`,
preference bodies, `export`) is structurally identical to the legacy/scenario
format. Workspace V1 only *adds* `workspaceVersion` and per-preference
`workspaceId`/`enabled`.

### 1.2 Legacy / scenario format (what the app accepts)

Files without a `workspaceVersion` key are treated as legacy/scenario files.
This is the format the **old app exported** and the **backend accepts** directly.
It is a strict, complete, optimize-ready scenario — it cannot carry incomplete
work or disabled records.

**Top-level keys:**

| Key | Type | Purpose |
| --- | --- | --- |
| `apiVersion` | string | Backend data contract. |
| `description` | string (optional) | Free text. |
| `dates` | object | Range + items + groups. |
| `people` | container | People items + groups. |
| `shiftTypes` | container | Shift-type items + groups. |
| `preferences` | array | Constraints/requests. No `workspaceId`/`enabled`. |
| `export` | object (optional) | Export layout. |
| `appVersion` | string (optional) | Build provenance. |

**Relationship to C1:** C1 defines the authoritative backend schema for this
format. Until C1 is corrected to reflect the rebuild's dual-format architecture,
this section is self-contained. (C1 accuracy follow-up tracked separately.)

### 1.3 Wire invariants (both formats)

All emitted YAML conforms to:

- **YAML 1.2** (not 1.1) — pinned to match the Python `ruamel.yaml` safe loader.
Avoids YAML 1.1 implicit-typing hazards (Norway problem, sexagesimal, etc.).
- **No anchors or aliases** — output is literal and diffable.
- **Deterministic key order** — stable across invocations with identical input.
- **Inline leaf arrays** — arrays of primitives render as `[a, b]`, not block style.
- **One trailing newline.**
- **Dates** serialize as bare `YYYY-MM-DD`.
- **Infinite weights** (LEAVE pins) serialize as `.inf`.

Rationale and serializer decision: see tech-plan decision
`yaml-serializer-ruamel-alignment-2026-07-22`.

## 2. Save / Copy / Edit-preview

### FR-SL-01 — Download produces a Workspace V1 file.

Given a Download action, the app serializes the current workspace state as
Workspace V1 YAML and triggers a browser download.

- Filename: `scenario.yaml` (static; no date prefix).
- MIME type: `text/yaml`.
- Feedback: success toast `"Downloaded scenario.yaml"`.
- **Download is the only action that marks the backup as "current"**
(backup-freshness indicator changes from stale/no-backup to current).

### FR-SL-02 — Copy writes YAML to clipboard with transient confirmation.

Given a Copy action, the app writes the Workspace V1 YAML to the clipboard.

- Button label changes from `"Copy"` to `"Copied!"` for **1500 ms**, then reverts.
- On failure: `console.error` only; no visible error; button does not flip.
- Copy does **not** mark the backup as current.

### FR-SL-03 — Edit-YAML preview shows the current Workspace V1.

The YAML preview panel heading reads `"Current state · YAML"`.

- **Edit-YAML toggle** enters an inline editor pre-filled with the current
Workspace V1 YAML. While editing, the heading reads `"Edit YAML Configuration"`.
An unsaved-edit navigation guard is armed while the editor is open.
- **Save** parses the edited text. If the parse succeeds and version
classification allows it (see §4), the workspace is replaced. If the parse
fails, an inline error shows the parser message and the editor stays open.
- **Cancel** discards edits — no state change. Navigation guard disarms.
- Edit-YAML preview does **not** mark the backup as current.

## 3. Anonymize panel

### FR-SL-04 — Three toggles with fixed defaults.

| Toggle label (verbatim) | Default |
| --- | --- |
| `"Replace item/group IDs"` | ON |
| `"Replace people group IDs"` | OFF |
| `"Scatter shift requests (developer only)"` | OFF |

Download-Anonymized is disabled when all three toggles are off.

### FR-SL-05 — Anonymized download pipeline.

Given an anonymized download with at least one toggle on:

1. If scatter is on, concrete single-person/single-shift-type date requests are
randomized first (preserving per-person WORKDAY/NON-WORKDAY category counts
and consecutive-run lengths). Group/keyword requests are untouched.
2. Selected people items → `P1, P2, …`; selected groups → `G1, G2, …`.
Generated IDs skip any collision with retained (non-anonymized) IDs.
3. Every reference to rewritten IDs (preferences, group members, export people)
is updated consistently.
4. The result is serialized as Workspace V1 and downloaded.
  - Filename: `scenario-anonymised.yaml`.
  - MIME: `text/yaml`.
  - Feedback: success toast.
5. **The live scenario is never modified** — both scatter and anonymize operate
on a copy.

**Scatter errors** (multi-person/multi-shift-type request, unclassifiable date,
no non-overlapping placement) abort the download with a toast:
`"Unable to randomize shift requests: <message>"`.

### FR-SL-06 — Scatter group-missing fallback warning.

When scatter is on and a `WORKDAY` or `NON-WORKDAY` date group is absent, an
inline warning appears and scatter falls back to `WEEKDAY`/`WEEKEND` classification.

## 4. Load — dual-format dispatch and replacement safety

### 4.1 Dispatch matrix

|  | Workspace V1 | Legacy / scenario | Unsupported `workspaceVersion` |
| --- | --- | --- | --- |
| **Discriminator** | `workspaceVersion: 1` (integer scalar) | `workspaceVersion` key absent | Any other value/type |
| **Accepted state** | Incomplete dates, disabled records | Complete, optimize-valid scenario only | Rejected |
| **Blocking conditions** | YAML syntax error; strict structural validation failure; duplicate/missing `workspaceId`; unknown top-level key | YAML syntax error; strict import schema failure; producer preflight failure | Always |
| **Warning channel** | Readiness issues (non-blocking for incomplete state) | Advanced-syntax preservation warnings (non-blocking); uncredited-LEAVE fence (non-blocking) | Issues list (blocking) |
| **Restored metadata** | `workspaceId`, `enabled`, `country` | None (rules still populate from constraints) | None |

**Unsupported-version outcome:** the load is rejected with an issues list
(`"Unsupported workspaceVersion: <value>"`). No state change occurs.

### 4.2 Legacy import outcomes

Legacy/scenario files (no `workspaceVersion`) are loaded through a strict import
path that validates, canonicalizes, and normalizes:

| Outcome | Behavior |
| --- | --- |
| **Valid scenario** | Fully replaces workspace state as one undoable step. |
| **Scalar references** | Normalized to arrays (`person: P1` → `person: [P1]`). |
| **Numeric IDs** | Accepted as-is; numeric `1` and string `"1"` remain distinct. |
| **Advanced/nested reference syntax** | **Preserved** and a non-blocking warning is surfaced (banner: `"Imported YAML contains advanced backend syntax."`). This includes shift-type covering `preceptors`/`preceptees` — they **do** receive the advanced-syntax warning. |
| **Missing `date` on requirement/succession** | Defaults to `[ALL]`. |
| **Structurally invalid** | Rejected with an issues list. **No partial load** — state is unchanged. |

### 4.3 Version integrity check

Every file's `appVersion` is classified (exact string comparison, not semver):

| Classification | Condition | Warning shown? |
| --- | --- | --- |
| `match` | `appVersion` equals current build | No |
| `missing` | `appVersion` absent or falsy | Yes |
| `dirty` | `appVersion` ends with `"-dirty"` | Yes (checked before mismatch) |
| `mismatch` | `appVersion` ≠ current build | Yes |

The `dirty` case is evaluated before `mismatch`.

### 4.4 Replacement + version decision table

Load safety is governed by two axes: **workspace occupancy** (empty vs.
non-empty) and **version classification** (match vs. non-match).

| Workspace | Version | Behavior | Postconditions |
| --- | --- | --- | --- |
| Empty | Match | **Direct commit** — no dialog | One undoable history entry; backup-freshness unchanged |
| Empty | Non-match | **Version-confirm dialog** | On Continue: same as direct commit. On Cancel: no state change |
| Non-empty | Match | **Replacement-confirm dialog** | On Continue: one undoable history entry; backup-freshness set to none. On Cancel: no state change |
| Non-empty | Non-match | **Combined replacement+version dialog** | Same as non-empty match, with version warning in dialog body |

**Key postconditions on confirmed load:**

- The entire workspace is replaced as **one undoable step** (Undo restores the
prior state; earlier undo history is preserved).
- Backup-freshness is set to **none** (the imported file is not a Download).
- A success toast appears: `"Scenario loaded — this replaces your current setup."`
- An uncredited-LEAVE fence may surface a non-blocking warning if the imported
scenario has a contracted-hours rule that omits LEAVE credit.

### 4.5 Guided Rules population on load

<user_quoted_section>Projection model ownership: the Guided Rules projection invariants (everyconstraint → rule row; pins as overlays; built-ins always projected) aredefined in spec 07. This section states only the load-time mapping.</user_quoted_section>

<user_quoted_section>Revised 2026-07-26. The quoted ownership note above predates the removal ofGuided pins; the "pins as overlays" invariant no longer exists. Rules is now asingle unconditional projection with no overlay layer — seethe removal decision.</user_quoted_section>

- **Both formats** fully populate the Rules screen from imported constraints, and
identically so — there is no per-format Guided metadata. Every imported
requirement, succession, count, affinity, and covering card becomes a rule row,
enabled or disabled. Built-in rules (e.g., "at most one shift per day") always
appear.
- A rule's plain-English title comes from the constraint's own `description`, so a
rename authored in either Rules or Advanced survives the round trip like any other
constraint field.
- Records whose shape Guided cannot render natively load as read-only *Set in*
*Advanced only* rows — never hidden, never flattened.

## 5. Backup-freshness indicator

A non-blocking status indicator shows whether the last Downloaded backup matches
the current workspace:

| State | Label | When |
| --- | --- | --- |
| none | `"No backup"` | Initial state; after Load/New; after any non-Download action |
| current | `"Backup current"` | After a plain Download, if no edits have since been made |
| stale | `"Backup out of date"` | After any edit following a Download |

The indicator is display-only — it never blocks navigation or editing. Only
plain Download sets it to current; Copy, anonymized Download, Upload, and
Edit-YAML do not.

## 6. Start-over reset

A confirmed destructive action that clears the entire workspace to a fresh
empty state.

- Requires explicit confirmation dialog.
- Clears all scenario state, undo history, and backup-freshness.
- If a YAML Edit session is active, it is also cancelled.
- IndexedDB auto-save persists the empty state.

## 7. Validation messages

All user-facing strings are **hard requirements**. Substitutions are runtime`.`

| Trigger | Channel | Message (verbatim) |
| --- | --- | --- |
| Download succeeds | toast | `"Downloaded scenario.yaml"` |
| Copy succeeds | button label | `"Copied!"` (1500 ms) → `"Copy"` |
| Load succeeds | toast | `"Scenario loaded — this replaces your current setup."` |
| Upload wrong extension | toast | `"Please upload a file with one of these extensions: .yaml, .yml"` |
| Upload empty file | toast | `"No content found in the uploaded file."` |
| Parse / validation failure | inline issues list | Specific issue messages with field paths |
| Version warning (missing) | confirm dialog | `"The loaded file does not contain app version information…"` |
| Version warning (dirty) | confirm dialog | `"Dirty app version detected…"` |
| Version warning (mismatch) | confirm dialog | `"App version mismatch detected…"` |
| Replacement warning | confirm dialog | Combined with version warning if applicable |
| Advanced syntax preserved | banner | `"Imported YAML contains advanced backend syntax."` + itemized list + Dismiss |
| Scatter error | toast | `"Unable to randomize shift requests: <message>"` |
| Scatter group missing | inline warning | `"Warning: <group(s)> missing. Scattering will fall back to WEEKDAY and WEEKEND groups."` |
| Unsupported workspaceVersion | inline issues | `"Unsupported workspaceVersion: <value>"` |

## 8. Acceptance criteria (Given/When/Then)

### AC-SL-01 — Workspace V1 export shape

**Given** any workspace state (including incomplete dates or disabled records),
**when** Download is triggered,
**then** the emitted YAML begins with `workspaceVersion: 1`, ends with
`appVersion`, and preserves disabled records and null dates.

### AC-SL-02 — Workspace round-trip losslessness

**Given** a Workspace V1 file produced by this app,
**when** it is loaded into a fresh workspace and re-downloaded,
**then** the re-downloaded file preserves every preference's `workspaceId`,
`enabled` flag, disabled records, and incomplete dates.

### AC-SL-03 — Legacy backward compatibility

**Given** a valid legacy/scenario file (no `workspaceVersion`),
**when** it is loaded,
**then** a version-confirm dialog appears (old `appVersion` ≠ current), the
workspace is replaced on confirmation, and the Rules screen fully populates from
the imported constraints — identically to a Workspace V1 load, since Rules carries
no format-specific metadata.

### AC-SL-04 — Replacement confirmation on non-empty workspace

**Given** a non-empty workspace and a file with a matching `appVersion`,
**when** the file is loaded,
**then** a replacement-confirmation dialog appears (not just a version warning),
and confirming replaces the workspace as one undoable step with backup-freshness
set to none.

### AC-SL-05 — Cancel leaves state untouched

**Given** any load dialog (version, replacement, or combined),
**when** the user cancels,
**then** no state change occurs — workspace, undo history, and backup-freshness
are unchanged.

### AC-SL-06 — Anonymized export preserves workspace metadata, never mutates live state

**Given** an anonymized download with people-ID replacement on,
**when** the anonymized YAML is produced,
**then** people IDs become `P1, P2, …` consistently across all references,
`workspaceId`/`enabled` are preserved on the anonymized copy, and
the live scenario state is byte-for-byte unchanged.

### AC-SL-07 — Structurally invalid file rejected, no partial load

**Given** a file that fails structural validation (unknown top-level key, wrong
nested shape, producer-preflight failure),
**when** load is attempted,
**then** an issues list appears with specific field paths, and the workspace
state is unchanged.

### AC-SL-08 — Unsupported workspaceVersion rejected

**Given** a file with `workspaceVersion: 2` (or any non-1 value),
**when** load is attempted,
**then** the load is rejected with `"Unsupported workspaceVersion: 2"` and no
state change occurs.

### AC-SL-09 — Wire format invariants

**Given** any YAML emitted by this app,
**when** it is parsed by a YAML 1.2 parser,
**then** no anchors/aliases are present, leaf arrays are inline, dates are
`YYYY-MM-DD`, infinite weights are `.inf`, and there is exactly one trailing
newline.

### AC-SL-10 — Advanced syntax preserved with warning

**Given** a legacy file containing nested reference trees or backend-only
preference shapes (including covering `preceptors`/`preceptees`),
**when** it is loaded,
**then** the advanced syntax is preserved (not rewritten or dropped), a
non-blocking banner lists each preserved field, and the workspace is usable.

### AC-SL-11 — Backup-freshness indicator

**Given** a workspace with no prior Download,
**when** an edit is made,
**then** the indicator reads `"No backup"`. **When** a Download occurs,
**then** it reads `"Backup current"`. **When** a subsequent edit is made,
**then** it reads `"Backup out of date"`.

## 9. Cross-references (with local summaries)

| Reference | What it owns | Local summary for /docs portability |
| --- | --- | --- |
| **DL12** (autosave/backup/load-safety) | Replacement-confirm on every non-empty load; backup-freshness semantics; load is undoable. | 08 §4.4 restates the decision table; DL12 has the rationale. |
| **DL13** (shared workspace YAML contract) | Workspace V1 is a flat superset; dual-format dispatch; Optimize converts to strict. | 08 §1 defines both formats self-contained; DL13 has the evolution rationale. |
| **C1** (YAML scenario schema) | Authoritative backend schema for the legacy/scenario format. | **Currently stale** vs the rebuild's dual-format architecture; 08 §1.2 is self-contained until C1 is corrected. Accuracy follow-up tracked. |
| **Spec 07** (state/history/persistence) | Auto-save to IndexedDB; undo/redo. | 08 states only the load-time mapping (§4.5). |
| **Customise-library removal** (2026-07-26) | `guidedRules` deleted from the contract; Rules is one unconditional projection. | Amends DL13; this spec reflects the post-removal shape throughout. |
| **Spec 12** (contracted hours/leave) | LEAVE keyword, half-hour coefficients, uncredited-LEAVE detection. | 08 notes only the import fence (non-blocking warning on load). |
| **Tech-plan decision** (YAML serializer) | Why `yaml`/eemeli pinned to 1.2 vs `js-yaml`. | 08 §1.3 states wire invariants; decision has the rationale. |

## Appendix — Audit-closure checklist (08-1 through 08-12)

| Finding | Drift | Destination in rewritten 08 |
| --- | --- | --- |
| 08-1 | Wrong export format (scenario, not Workspace V1) | §1.1 defines Workspace V1 as the export format |
| 08-2 | Wrong serializer mechanism | §1.3 states wire invariants; serializer decision linked |
| 08-3 | Wrong filenames/MIME | §2 FR-SL-01: `scenario.yaml`, `text/yaml` |
| 08-4 | Copy revert 2000→1500 ms | §2 FR-SL-02: 1500 ms |
| 08-5 | `window.confirm` → React modal | §4.3-4.4: confirm dialog behavior |
| 08-6 | Replacement confirm only on mismatch | §4.4 decision table: non-empty + match also confirms |
| 08-7 | `alert()` → toasts + inline | §7 validation messages table |
| 08-8 | Dead import-normalization functions | §4.2 outcomes-only legacy import table |
| 08-9 | Preceptors "exempt" → actually warned | §4.2: preceptors/preceptees DO receive warning |
| 08-10 | Toggle label "Replace **people** item/group IDs" → "Replace item/group IDs" | §3 FR-SL-04 |
| 08-11 | Refuted — validation behavior lives in sibling artifacts | §9 cross-refs with local summaries (retained, not duplicated) |
| 08-12 | View heading "Current State YAML" → "Current state · YAML" | §2 FR-SL-03 |
