---
title: "09 — Fixed half-hour grid, hard Contracted Hours & explicit refresh"
kind: spec
---

# Decision 09 — Fixed half-hour Contracted Hours

This decision supersedes the abandoned uncommitted minute-unit Strict/Flexible design.
The committed baseline already supports hour/half-hour authoring, but the product has no
users or saved data, so the target may make a clean pre-release schema replacement.

## Settled decisions

### D1 — One fixed half-hour unit; no migration

`hoursContract.unit` has one valid value: `"half-hour"`. Contracted Hours has no unit
picker, conversion, reconciliation, compatibility layer, localStorage upgrade, or legacy
fallback. Repository fixtures and development state are updated directly. Imported
marked data using `"hour"` or `"minute"` is invalid.

The UI displays human values (`8h 30m`, `150–170h`); the shared Shift Count payload
stores integer half-hour units (`17`, `[300, 340]`). Generic unmarked Shift Counts remain
unitless and retain their full backend vocabulary.

### D2 — Hard Exact and Allowed Range

| Policy | Shared Shift Count encoding | Meaning |
| --- | --- | --- |
| **Exact** | `expression: "x = T"`, scalar target, `weight: +∞` | Total must equal the target. |
| **Allowed range** | `expression: ["x >= T", "x <= T"]`, targets `[minimum, maximum]`, `weight: +∞` | Total must be inside the inclusive range. |

For the active 28-day window, 160h emits `320`; 150–170h emits `[300, 340]`.
Minimum must not exceed maximum. Both policies are hard feasibility constraints and add
no finite objective term. There is no Flexible mode, strength slider, squared penalty,
or marked Custom state.

### D3 — Author current-window totals, not weekly goals

The user enters total hours or bounds for the currently selected count dates/scheduling
window. The stored integer target(s) are the sole authority. Date-window or selector
changes never silently rescale them; the editor continues to show the retained total so
the author can revise it explicitly.

There is no weekly proration, weekly/raw authority metadata, fractional invalid draft,
or target-source reconstruction. Every accepted target is non-negative and aligned to a
30-minute step before it reaches the shared payload.

### D4 — Minimal strict metadata

The marker is exactly:

```yaml
hoursContract:
  unit: half-hour
  policy: range
```

`unit` and `policy` are required literals; `extra="forbid"`. A marked preference must
match its policy encoding from D2. Metadata is still solver-inert: valid metadata never
enters the count arithmetic, constraints, or objective. Cross-field validation changes
which documents load, not how valid raw solver fields solve.

A marked preference must also have **exact explicit coefficient coverage**: after the
persisted selectors are expanded under existing backend semantics, coefficient ids must
equal that deduplicated concrete day-state set exactly—one positive integer per worked
Shift Type or `LEAVE`, with no omissions, extras, groups, or duplicates. Generic
unmarked counts retain the backend's default coefficient `1` behavior.

Canonical fragments:

```yaml
# Exact 160h
hoursContract: {unit: half-hour, policy: exact}
expression: x = T
target: 320
weight: .inf

# Allowed 150–170h
hoursContract: {unit: half-hour, policy: range}
expression: [x >= T, x <= T]
target: [300, 340]
weight: .inf
```

### D5 — Preserve existing dynamic group and `ALL` semantics

Marked `countShiftTypes` persists the user's selectors exactly like a generic Shift
Count. `ALL` continues to expand dynamically to all worked Shift Types only, excluding
`OFF` and `LEAVE`. Groups continue to expand through the backend's ordered group map,
including nested earlier-defined groups and any reachable reserved day state.

Contracted Hours does not redefine those selectors. Instead, the shared validator
expands them against current scenario data and enforces D4's exact coefficient coverage.
If a new Shift Type joins `ALL`, or group membership changes, the saved selector remains
unchanged but the contract becomes fixably invalid until Refresh adds/removes the
corresponding explicit coefficient rows. Reachable `OFF`, unknown/forward/cyclic group
references, and empty resolved coverage block a marked contract; reachable `LEAVE` is
included and shown explicitly in preview/validation.

Expansion has three intentionally separate orders. **Semantic order** is the backend's
`sorted(set(...))` sentinel/index order (`LEAVE` before worked item indices); it drives
validation equality and diagnostics. **Persisted selector order** follows the existing
frontend producer contract and never gets flattened merely for Contracted Hours.
**Coefficient display/serialization order** follows the existing canonical frontend
entry order, with reachable reserved states shown explicitly. Set equality, not array
position, determines coverage. For invalid ordered group graphs, report the first
backend-map construction failure; a forward reference therefore wins over a later
whole-graph cycle label.

### D6 — Explicit coefficient derivation and Refresh

On creation, the guided editor expands the current draft selectors and derives each concrete worked-shift coefficient as
`durationMinutes / 30` and LEAVE as `16` (the guided editor displays and accepts
these as human hours per D14; storage stays integer half-hours). Afterwards, Shift
Type edits do not
automatically rewrite any Contracted Hours rule.

**Refresh from Shift Types** is the only re-derivation action:

1. expand the **current draft selectors**, not only the stored preference;
2. compute rows required by the current expansion, including additions and removals;
3. show before/after/unchanged/non-derivable rows;
4. Confirm atomically replaces the **local editor draft** and records one local Refresh
undo snapshot; Cancel Preview changes nothing;
5. rows without working time retain a valid existing manual coefficient; if neither a
derivable value nor valid coefficient exists, editor commit and external
Save/Copy/download, Optimize, anonymized Optimize, and roster export are blocked.

During editing, selector removal immediately prunes draft-only coefficient rows no longer
reached by any remaining selector. Selector addition creates blank concrete rows without
guessing values; the author supplies them manually or runs Refresh. Undo Refresh restores
the previous local draft. **Update** validates and commits the entire edited preference
as one global history step; **Cancel Edit** discards selector and Refresh changes and
preserves the stored rule byte-for-byte. Global Undo applies only after Update.

While either Shift Count editor is open, document-level Ctrl/Cmd-Z and Ctrl/Cmd-Y are
owned by that editor. Contracted Hours routes them to local Refresh undo/redo when a
local snapshot exists; otherwise the shortcut is consumed and global history does not
move. The generic editor likewise consumes them because it has an uncommitted draft but
no local Refresh history. Global shortcuts resume only after Update or Cancel closes the
editor, preventing the store from moving beneath a draft.

Because changes are explicit, no per-shift provenance metadata or cross-page update
subscription is needed. A manual value remains authoritative until the author confirms
Refresh.

### D7 — The 30-minute grid is an input invariant

Backend, frontend, YAML import, and fixtures accept exactly two working-time shapes:

1. bare `durationMinutes`, positive and divisible by 30; or
2. `startTime` + `endTime` together, absent `restMinutes` meaning zero, and
required persisted `durationMinutes` equal to the derived positive grid-valid value.

Start/end use `HH:00` or `HH:30`; rest is a non-negative multiple of 30. Equal
start/end is invalid; an earlier end means overnight (+24h); rest must be less than the
span. Start-only, end-only, rest-only, partial clock combinations, disagreement with
`durationMinutes`, and rounding are rejected.

`restMinutes: 0` is accepted at the input boundary but canonicalized to omission; absence
is the only persisted zero-rest form. Shape transitions are explicit and confirmable:

- **bare → clock:** requires user-authored start and end (plus optional positive rest);
the existing bare bytes remain untouched until the proposed clock shape validates and
the author confirms, then derived `durationMinutes` and clock fields replace it;
- **clock → bare:** Confirm retains paid `durationMinutes` and clears start, end, and
rest; Cancel retains the clock shape;
- **Clear:** removes all four working-time fields from either shape.

The shared frontend codec consumes and returns a whole persisted Shift Type working-time
shape through one discriminated result: `bare`, `clock`, `cleared`, or structured
`invalid(path, code)`. It owns grid parsing, overnight span, rest subtraction, required
duration agreement, shape conversion, clear-all, and serialization. YAML import and WT4
must call this same whole-shape API; the backend validator mirrors its accepted shapes.

### D8 — Range-capable frontend wire type

The frontend's lossless Shift Count wire/state type becomes:

```ts
expression: Expression | Expression[];
target: number | number[];
```

Generic backend-valid arrays continue to round-trip through import/YAML even when the
generic scalar form cannot author every shape. They render as a read-only advanced-rule
card with full indexed pairs; duplicate/reorder/delete/export remain lossless, and Edit
routes to YAML editing rather than the scalar form. Guided↔Advanced switching never
mutates them. The guided domain narrows marked payloads to the two D2 variants. Every
scalar consumer must narrow before string/number operations.

The scalar card requirements apply only when both fields are scalar. A valid unmarked
array renders full indexed expression/target pairs, never enters the scalar form, and
routes Edit to YAML. WT3 preserves the opaque value through all wire/state operations;
WT6 alone owns this fallback presentation and navigation.

The backend must include the expression-pair index in Range model-variable/report names
so both hard boundaries remain independently observable.

### D9 — Separate entry paths and explicit conversion

Shift Counts provides **Add Shift Count** and **Add Contracted Hours**. Both save
`type: "shift count"` in one ordered list; only the guided entry carries the marker.
There is no checkbox and no inference from raw values.

Generic → Contracted Hours requires a policy, current-window target/bounds, and a
field-level preview. Dynamic selector expansion and required coefficient changes appear
in the preview. Contracted Hours → generic
removes only the marker and preserves raw fields. Confirm is one undoable replacement;
Cancel preserves bytes and list position.

### D10 — Solver details without a hidden Custom policy

**Solver details & overrides** may edit ordinary dynamic selectors, raw half-hour
coefficients (intentionally raw here — the guided editor's human-hours view is D14, not this panel),
and raw target(s). Expression and `+∞` weight are visible but locked while marked;
editing either requires conversion to generic. Global Guided/Advanced switching is
non-mutating and does not unlock marked policy fields.

### D11 — Leave assistance remains outcome-level

The non-blocking uncredited-leave guard remains. When a marked contract covers a
leave-pinned person but omits LEAVE, make the miss visible and offer a direct repair.
Adding or refreshing LEAVE uses coefficient `16`. Exact placement and remediation UI
remain design-free.

### D12 — Non-propagation does not disable reference integrity

| Scenario edit | Marked-contract behavior |
| --- | --- |
| Shift working-time edit | Coefficients unchanged until Refresh. |
| Group membership edit / new Shift Type | Selector unchanged; dynamic expansion may create a validation error until Refresh. |
| Shift Type/group rename | Atomically rename direct selectors, nested group-member references, and coefficient ids; preserve coefficient values and group-definition order. |
| Shift Type/group delete | Prune direct and nested group-member identities plus coefficients; drop an emptied required rule per spec 06 without reordering definitions. |
| Shift Type item duplicate | Existing behavior may add the copy to groups containing the source and `ALL` grows dynamically; do not add a coefficient automatically, then revalidate and require Refresh. |
| Group duplicate | Create an unreferenced new group; existing contracts are unchanged. |
| Preference duplicate | Deep-copy the complete marked rule and marker; a valid source stays valid. |
| Person/date/group rename or delete | Preserve existing reference-cascade semantics. |
| Date-window shrink | Prune removed `countDates`. If at least one remains, preserve target(s) byte-for-byte. If none remains, delete the preference per FR-RI-11. Either outcome is one global transition; never rescale. |

Each committed identity cascade is one global history transition. Refresh remains local
until Update commits the whole edited preference.

### D13 — One codec and one validator

WT0 owns nested group-member rename/delete reference integrity. WT1 owns a shared backend
ordered group-map/expansion helper used by both scenario-root validation and scheduler
setup. WT3 owns wire types plus the frontend working-time codec; it performs only
structural marked parsing, not selector/coverage semantics. WT5 owns one pure
marked-contract `expand/compile/previewRefresh/validate` API. WT6 invokes it for editor
commit and owns local Refresh undo. WT7 integrates the same validator into inbound YAML
state replacement and every outbound scenario boundary: plain download, clipboard copy,
anonymized download, normal/anonymized Optimize, and serializer callers. Re-downloading
an already-produced XLSX does not revalidate current scenario state.
Invalid local drafts remain recoverable and cannot reach the solver or scenario export.

### D14 — Guided Contracted Hours coefficients are authored in human hours

In the **guided** Contracted Hours editor, each per-shift coefficient is
displayed and entered as human working hours (`8h`, `7h 30m`) — the same
vocabulary as the target field (D1) — instead of a raw half-hour integer. This
reuses the existing lossless target codec (`formatHalfHours` / `parseHalfHours`,
`web/components/counts/half-hour-codec.ts`): a derived `durationMinutes / 30`
value renders as hours, and `LEAVE`'s `16` renders as `8h`. The persisted Shift
Count payload is unchanged — coefficients still store integer half-hours; hours
are purely a display/input view at the guided-form boundary.

Scope and boundaries:

- **Guided Contracted Hours only.** The raw **Solver details & overrides** panel
 (D10) intentionally keeps raw half-hour integers — it is the deliberate raw
 escape hatch. Generic Shift Counts and the shared coefficient sub-editor's other
 consumer (Requirements' staffing multiplier) keep their raw integer values; the
 sub-editor takes a per-consumer format/parse adapter so only the Contracted
 Hours consumer applies the hours codec.
- **Refresh preview and manual entry follow the same unit.** Before/after/
 unchanged/non-derivable rows in the Refresh preview show hours; a non-derivable
 row is entered manually in hours, and an off-grid amount (not a whole multiple
 of 30 minutes) is rejected by the codec, preserving the D7 grid invariant.
- **Guard alignment (D11).** The uncredited-leave guard's stored fix is still
 coefficient `16`; its guided-editor advisory/button surfaces it as `8h`.

This is a lossless display/input unit, not provenance metadata — the
"derived/manual provenance metadata" non-goal is unchanged. The number is legible
because `8h` plainly matches the shift's working time, with no per-row provenance
tracking.

## Explicit non-goals

- weekly goals or automatic date-window rescaling;
- automatic coefficient repair after Shift Type/group/`ALL` expansion changes;
- derived/manual provenance metadata;
- unit or saved-data migration;
- soft monthly-hours scoring;
- marked Custom expression/weight editing.

## Cross-references

- Spec 12: product behavior and grid constraints.
- Spec 05: separate actions, dynamic selectors, Refresh, and Solver details.
- C1 CON-YAML-22/25/26: target schema.
- C3 CON-SEM-05: existing hard comparison semantics.
- Spec 08: array-preserving import and strict marked validation.
- WT1–WT7: implementation ownership and verification.
