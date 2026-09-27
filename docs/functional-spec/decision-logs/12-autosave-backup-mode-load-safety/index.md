---
title: "DL12 — Local autosave, workspace YAML, Guided mode and load safety"
kind: spec
---

# DL12 — Local autosave, workspace YAML, Guided mode and load safety

Settled with the user after the 2026-07-18 sidebar/mode/Save & Load QA review.

<user_quoted_section>Format follow-through: DL13settles the technical/product boundary left open here: workspace backup uses aflat, versioned extension of the existing backend YAML. The new frontend andbackend accept old backend-only files; strict solver conversion remains separate.</user_quoted_section>

## Decisions

1. **Browser autosave is the authoritative working state.** A committed edit that has settled to IndexedDB is saved. Internal navigation must not call it unsaved merely because no YAML file has been downloaded.
2. **YAML is for workspace backup and sharing.** Download/Copy must preserve incomplete work. Syntax, structural integrity, and targeted invariants that prevent corruption still gate the file; full producer/backend readiness gates Optimize, not backup.
3. **Backup freshness is nonblocking.** The last-Download fingerprint may drive copy such as **Backup out of date**, but it must never arm internal navigation or claim local data loss. Clipboard Copy is not a durable backup.
4. **Only genuinely losable state is guarded.** Internal navigation warns for an open uncommitted editor/YAML draft. Browser unload may additionally warn while local persistence is pending or failed.
5. **Guided/Advanced is a real global lens.** Implement the prototype's Guided workflow, Rules projection, and mode-specific navigation. The initial version keeps mode switching simple: changing to Guided from an Advanced-only route redirects to Home.
6. **Scenario replacement is safe.** Loading into a non-empty workspace requires an explicit replacement confirmation and commits as one undoable history boundary. Loading into a truly empty workspace may proceed directly. Version information is part of the same staged confirmation, not the sole trigger.

## Deferred improvement

Preserving route context on Advanced → Guided mode switching is deliberately deferred. A backlog ticket owns mapping constraint editors to Guided Rules and Export Layout to the Guided output flow.

## Evidence carried forward

- The old app permits sparse/incomplete YAML backups while applying narrow Contracted Hours validation on Download/Copy and structural + Contracted Hours gates on import.
- The old app does not confirm a matching-version replacement, but it records Load as one undoable history entry.
- The rebuild currently does the opposite of the intended safety hierarchy: auto-saved edits trigger a destructive navigation warning, while matching-version Load replaces state and clears history without confirmation.
