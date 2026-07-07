---
kind: review
title: "Critique — Functional Spec Set (pre-design pressure test)"
---

# Critique — Functional Spec Set (pre-design pressure test)

Adversarial cold-reader critique of the full [Functional Requirements story](../index.md)
(11 domain specs as of the wave-3/wave-4 review, 5 contracts, behavior catalog),
run by fresh agents that verified every claim against the actual source.
Findings are ordered by how expensive they are if wrong, mapped to the three
downstream purposes: **(a)** design a new UI without a capability gap,
**(b)** rebuild to parity, **(c)** seed a parity test suite.

> **Supersession note:** this critique predates the wave-3 (covering
> preference, 13-tab navigation, sort-order, covering cascade) and
> wave-4 (comprehensive spec review) updates. The post-wave-3 state
> of the spec set has addressed several CRITICAL items from this
> critique (the export-asymmetry is now FR-OE-43a, the
> `at most one shift per day` UI disposition is documented in
> spec 01 FR-DM-19, etc.). The wave-3 review surfaced new findings
> (covering date-save bug, covering weight semantics drift, covering
> `OFF` UI gap, `Apply` button dead branch, history-order, etc.) that
> are tracked in
> `decision-logs/02-shift-type-covering-preference/index.md`. The
> wave-4 comprehensive review surfaced further findings (PuLP/CBC/cuOpt
> solver removal, `country` SG-only restriction, covering aggregate
> semantics, etc.) that have been folded into Contracts C1/C2/C4 and
> the relevant domain specs. **The F1 "app-shell spec gap" claim
> from this critique is NOT closed** — spec 11 is the Shift Type
> Coverings editor (a card-list preference page), not the Home /
> app-shell. The Home / New Schedule / Continue / custom "Confirm
> Reset" modal / footer / forced light mode / excluded shell/ops
> features still have no owning spec artifact; T01 in `tickets/`
> remains the open follow-up. **Do not use this critique as the
> live source of truth** — read the current spec set and the
> decision logs directly.

## Verdict

The set is **unusually accurate** — the four reviewers could not find a single
wrong constant, endpoint, status code, or contract error string; the five
contracts are the strongest part. The problems are **structural and framing**,
not factual: a missing app-shell spec, an unresolved "strict parity vs new
design" tension, one real frontend↔backend validation divergence, and scope
leakage in the test catalog. None blocks starting design work, but the CRITICAL
items should be fixed before hand-off so the designer/rebuilder isn't misled.

Severity legend: **CRITICAL** (blocks a downstream purpose or causes runtime
rejection) · **CONTRADICTION** · **GAP** · **AMBIGUITY/MINOR**.

---

## CRITICAL

### R1 — The Home tab / app shell has no owning spec — CRITICAL (a,b,c)
The 12-tab set (`FR-ST-28`) includes `0. Home`, but no spec describes what tab 0
contains. Real, in-scope, parity-bound content lives nowhere: title + welcome
copy + dev-warning banner; the **"New Schedule"** and **"Continue"** buttons; and
a **custom "Confirm Reset" modal** (heading `Confirm Reset`, body
`Are you sure you want to start from a new state? This will reset all your current data.`,
buttons `Cancel` / `Reset Data`). Critically this is a **custom modal, not a
native `confirm()`** — the opposite of `FR-ST-31`'s native tab-switch guard, a
distinction a rebuilder must not get wrong. `FR-ST-18` only pins the reset's
state mechanics. Forced light-mode (`layout.tsx`, `globals.css`) and the footer
are likewise unspecced.
**Breaks first:** the designer gets no capability inventory for tab 0; parity
strings that the brief makes hard requirements exist nowhere.
**Fix:** add a **Home / App-Shell** spec covering tab-0 content, the New Schedule
→ custom Confirm Reset modal (verbatim strings, flagged custom), Continue, the
welcome/dev-warning copy, footer, and forced-light-mode — plus an explicit
"present in current app but excluded" list (see R9). Source: `web-frontend/src/app/page.tsx`, `layout.tsx`.

### R2 — "Strict parity" and "brand-new design" collide; intent vs mechanism not separated — CRITICAL (a)
The fidelity bar ("reproduce every quirk") is stated as hard requirements in
places that assume the *current UI mechanism*, which a redesign cannot honor:
- `FR-ST-24/28`, `AC-ST-17`: digit-key→tab-index shortcuts, numeric tab labels
  (`0. Home`…), and the "tabs 10/11 have no digit shortcut" quirk — all assume a
  numbered tab bar. A sidebar/command-palette can't reproduce them; `AC-ST-17`
  becomes untestable.
- `FR-ED-22`, `FR-DC-33`, `FR-SR-30/45`, `FR-PR-12`, `FR-ED-19`: mouse-down/enter/up
  drag-select mechanics as parity. `FR-DC-33` even pins a **calendar a11y defect**
  (Enter/Space `preventDefault` → keys inert) as a requirement.
- `AC-SR-05` opacity curve, verbatim aria-label strings, and native `confirm()`/
  `alert()` usage specced as behavior.

Spec 04 already does this right for matrix colors ("non-binding reference") — that
pattern just isn't applied uniformly.
**Breaks first:** the designer is handed contradictory instructions (be new / be
identical); "parity" would force replicating a keyboard-inaccessible calendar.
**Fix:** add a **"behavioral intent vs current mechanism"** convention to the
story index and apply it to nav shortcuts, drag gestures, opacity/aria/native
dialogs. Keep intents as parity (fast tab jump; bulk select in one gesture that
collapses to one undo step; intensity scales with weight; accessible names;
destructive actions confirm with the given text). Mark the mechanisms as current,
not binding. Do **not** require reproducing the keyboard-inert calendar.

### R3 — Requirement weight `-Infinity`: frontend allows, backend rejects → runtime-failed job — CRITICAL (b,c)
With `preferredNumPeople` set, the backend rejects **both** `+inf` and `-inf`
(`preference_types.py:186-190`, error E27 `Infinity weights are not allowed for
shift type requirement with 'preferredNumPeople'...`). But spec 05 `AC-PR-08`
requires the requirement weight only to be `<= 0` **"(including -Infinity)"** and
the UI has a `-∞` button. So a requirement with `preferred ≠ required` + weight
`-∞` passes frontend validation, serializes to `weight: -.inf`, and the backend
FAILS the job at solve time. C3 (CON-SEM-02/E27) is correct; spec 05 is the
divergence — and it reflects a **latent bug in the current frontend**.
**Breaks first:** the "frontend emits YAML the backend rejects" failure mode, in
the rebuilt app.
**Fix:** decide policy explicitly — either (i) document current behavior as a
known latent bug the rebuild reproduces (strict parity) *and* add a parity test
asserting the resulting FAILED job, or (ii) treat it as a bug to fix in the
rebuild (reject both infinities when `preferredNumPeople` set). Annotate
`AC-PR-08` to point at C3 E27 either way. Source: `preference_types.py:186-190`;
`web-frontend/src/utils/numberParsing.ts:143-145`.

---

## CONTRADICTIONS & SCOPE

### R4 — Optimize payload always sends `export`; save/load omits it — HIGH / GAP (b,c)
`FR-OE-43` treats the optimize `yaml_content` shape as identical to spec 08, but
the optimize page builds state with `export: effectiveExportData` where
`effectiveExportData = state.export ?? generateExportLayoutConfig(...)`
(`optimize-and-export/page.tsx:508-516`, `useSchedulingData.ts:972-973`). So the
optimize payload **always** contains an `export:` block (the generated default
when none is authored), whereas the save/load download **omits** `export` in that
same case (`save-and-load/page.tsx:86`).
**Breaks first:** a rebuild that reuses one serializer and mirrors spec 08's
asymmetry sends no `export` on optimize → the fixed backend renders different
output; a byte-diff test of the two producers fails.
**Fix:** state the asymmetry explicitly in `FR-OE-43`/`AC-OE-15`.

### R5 — Catalog re-introduces excluded ops features as parity behaviors — CONTRADICTION (c, scope)
The domain specs correctly exclude Sentry/GA/build-selector/cross-tab-banner/
GitHub-version-banner. But the **behavior catalog** (mechanically derived from the
existing test suite, which still tests them) leaks them back: `ST-B4` (cross-tab
storage banner), the "Navigation & Shell" flows (build selector + feedback button
overlap; forced-light-mode), and `OE-B8`'s `sentrySchedulingState.test.ts`
citation.
**Breaks first:** a team building the parity suite from the catalog writes tests
for features the brief says not to build.
**Fix:** remove/reclassify `ST-B4`, the excluded-feature flows, and the Sentry
citation as out-of-scope in the catalog. (Forced-light-mode: decide if it's parity
→ give it a home in the shell spec, or a visual choice → hand to Claude Design.)

### R6 — "at most one shift per day" preference has no UI disposition; dangling "(covered elsewhere)" — GAP (a,b)
This preference is seeded (`FR-DM-18`), required (CON-YAML V1, CON-SEM-01), and
indestructible in cascades (`FR-RI-11`), yet no spec states it is implicit,
non-editable, tab-less, and always emitted. Spec 05 defers it to "covered
elsewhere" — but there is no elsewhere. Relatedly (**R6b**), `loadFromYaml` does
**not** re-add it (`useSchedulingData.ts:771-970`), so a YAML omitting it yields a
frontend scenario the backend rejects (CON-YAML V1) — undocumented.
**Fix:** state its implicit/always-present/non-editable disposition (spec 01 or
the shell spec); delete "(covered elsewhere)"; document the load-path behavior in
spec 08 + a parity test.

### R7 — Validation & edge-case ID schemes collide across specs — CONTRADICTION (c, traceability)
Bare `V1..Vn` is reused in specs 03, 08, and 09 for **different** rules; edge IDs
vary (`QK-SR-nn` vs `EDGE-PR-nn` vs none); specs 02/07 use `VR-<PREFIX>`. The
story's convention section only governs `FR-`/`CON-`/`AC-` IDs.
**Breaks first:** "assert V1" is ambiguous across the set → broken test
traceability.
**Fix:** namespace all validation IDs `VR-<PREFIX>-nn` and edge IDs
`EDGE-<PREFIX>-nn`; document in the story index.

### R8 — Frontend vs backend validation strings differ subtly, same rule — AMBIGUITY (c)
E.g. spec 05 `Weight must be non-positive for shift count with "|x - T|^2"` (double
quotes, no period) vs C3 E39 `...with '{expression}'.` (single quotes, period,
templated). Coefficient messages differ by layer too.
**Fix:** note in spec 05 and C3 that these are **separate layers with separate
verbatim strings**; parity tests assert the frontend string for frontend-caught
cases, the backend string for backend-caught cases.

### R9 — Dangling references to a nonexistent "App Shell / Layout artifact" — GAP (b)
Specs 07 and 08 defer excluded banners to "the App Shell / Layout artifact," which
does not exist.
**Fix:** resolve together with R1 — either create that artifact or rewrite the
references to "intentionally undocumented (excluded)."

---

## GAPS & UNPINNED PARITY

### R10 — "Shift types missing" precondition is unreachable-by-construction — GAP (c)
`FR-OE-30/31`, `AC-OE-11`: the check is `shiftTypeData.items.length===0 &&
groups.length===0`, but auto `OFF` item + `ALL` group are always injected
(`keywords.ts:37-62`), so it's never true; the banner never renders.
**Fix:** mark it unreachable-by-construction (keep for literal parity, note it
never fires). Dates/People checks are genuinely reachable.

### R11 — C2 doesn't state the server never validates `solver` — GAP (b)
Unlike the CLI (argparse `choices`), `POST /optimize` accepts **any** `solver`
string (`serve.py:462`), returns `202`, then FAILS async with E52
`Unsupported solver configuration: ...`.
**Fix:** add a sentence to `CON-API-03`: unknown `solver` is accepted (202) and
surfaces later as a FAILED job carrying the E52 string.

### R12 — "Byte-stable / idempotent YAML" is overclaimed — AMBIGUITY (c)
`FR-SL-06`/`AC-SL-02` state byte-identity as an unconditional MUST, but it holds
only for YAML **already produced by this UI at the current app version**; first
import of hand-authored YAML mutates shape (scalar→array `FR-SL-24`, `[ALL]`
inject `FR-SL-27`, zero-pad `FR-SL-23`) and `CustomDump` conditionally prepends a
newline.
**Fix:** scope `FR-SL-06`/`AC-SL-02` to UI-generated, version-matching YAML;
reference the shape-changing normalizations.

### R13 — e2e mock job-response is a strict subset of the real contract — GAP (c)
The mock returns only `{jobId,status,score,solverStatus,xlsxReady,links}`
(`helpers.ts:87-215`); `queuePosition`, `finishNowRequested`, `cancelRequested`,
`error`, `clientHeartbeatExpired` are absent, so `FR-OE-58/66/67` are thinly
covered.
**Fix:** flag the divergence; require the parity suite to exercise queue-position
and finish-now rendering (unit test or enriched mock).

### R14 — Spec 02 "Apply"/"Update" button: the "Apply" branch is dead code — INACCURACY (b,c)
`dateData.range` is a permanently-present object (seeded `{startDate:undefined,
endDate:undefined}`, required field), so `{dateData.range ? 'Update':'Apply'}`
always yields **"Update"** — even first-run. `FR-DC-04`/`AC-DC-01` describe an
"Apply" state the app never shows; `FR-DC-01/02` gate on the same always-true
condition.
**Fix:** state the label is always "Update"; if "Apply-when-empty" was intended,
note it as a latent bug the current build does not exhibit. Source:
`app/dates/page.tsx:408,169,184`.

### R15 — Unpinned parity in Shift Requests summary + history — GAP (b,c)
`FR-SR-39` "Current Shift Requests" renders the **raw** weight with a `+` prefix
(`+Infinity`/`-Infinity`, un-abbreviated) — **not** `getWeightDisplayLabel` used
by the matrix, so a rebuilder reusing the label helper would show `+∞` and
diverge (`shift-requests/page.tsx:1957`). Captions `Wants this shift`/`Wants to
avoid`/`Neutral` are unpinned. Also `OFF` is a valid, selectable history value
(lists include the auto `OFF` item) — not called out.
**Fix:** pin the raw-number rendering + three captions; note `OFF` is an accepted
history value (only shift-type *groups* are rejected).

### R16 — Top-level `description` is serialized but non-editable in the UI — GAP (low, b)
No `updateDescription` exists; `description` is settable only via YAML load/edit.
**Fix:** one sentence in spec 01/08.

---

## MINOR / CITATION

- **R17** — C5 `CON-OUT-41` says restore reads "rows `3 .. 3+count`"; source is
  half-open `3 … 3+count−1` (`restorePeopleIdsInXlsx.ts:35`); spec 10 already
  correct. Off-by-one could seed a bug. **Fix:** `[3, 3+count)`.
- **R18** — C3 catalog **E29** ("History must not include nested ID") is
  unreachable for loader-validated scenarios (E12/E13 pre-empt); label
  "nested" is misleading. **Fix:** annotate as unreachable.
- **R19** — SSE terminal-status check is exact-case in `waitForOptimizeJob`/
  `pollOptimizeJob` (`page.tsx:690,706`) but lower-cased in `isJobActive`
  (`:497`); a backend returning `"OPTIMAL"` would not resolve the loop. **Fix:**
  pin the case behavior; conformance to C2 assumes lower-cased statuses.
- **R20** — `FR-RI-09` omits that an undefined `history` coerces to `[]`
  (`schedulingReferenceUpdates.ts:63`), asymmetric with `FR-RI-04`. **Fix:** add it.
- **R21** — `FR-SL-37` prose has a stray trailing `"` on the scatter error (V17
  table is correct); `FR-ST-15` cites `useSchedulingData.ts:207-213` spuriously;
  `FR-PR-11` delete-filter cited to `DraggableCardList` but lives in each page
  handler; spec 02 live-count string drops the word — actual is
  `` `${N} day${N===1?'':'s'} selected` ``. **Fix:** correct strings/citations.
- **R22 (verify-debt)** — the specs-01–05 reviewer could not ground-verify some
  component-level claims (`AddEditItemGroupForm`, `DataTable`, `TableColumns/
  RowActions`, `InlineEdit`, `DraggableCardList`, `CalendarMonthView`,
  `DateGroupMemberSelector`, `DateRangeCalendarPicker`, several `useSchedulingData`
  wirings). Other reviewers verified many of these, but the calendar-picker /
  member-selector mechanics (`FR-DC-13..33`) remain partly unverified. **Fix:**
  a targeted re-verify pass before trusting these as test seeds.

---

## Action item beyond the specs

- **Backend export-golden blind spot (verified true):** `0` testcases (incl.
  `real/`) use a top-level `export:` block, so the YAML→CSV/XLSX golden harness
  never exercises export layout — a rebuild could pass the whole harness while
  regressing export rendering (covered only by `test_export_formatting.py` inline
  YAML + frontend tests). **Action:** add `export:`-bearing golden fixtures to the
  core suite. (Also: keep emitting **string** shift-type ids — an integer id would
  `TypeError` in `exporter.py:589`, an untested path.)

---

## What held up (spot-checks that passed)

Reviewers verified as exact: all six preference field schemas + weight defaults;
the full rename/delete cascade; `MAX_HISTORY_SIZE=50`, storage key, Infinity
placeholders, index clamp; the 12-tab set/routes; YAML key order + `appVersion`
last + flow-style leaf arrays; `getVersionWarning` three messages; anonymize
defaults; `generateExportLayoutConfig` rules + colors + clear-dialog strings;
backend endpoints/status codes/limits/job-response shape; SSE event set; solver
dispatch + capability tables + cooperative-stop; `SolverStatus` mapping; the 9
phase codes; CLI args/exit codes; exporter DataFrame layout + Notes sheet + ARGB/
luminance styling + CSV encoding; anonymization mapping. Contracts C1–C5 had **zero**
category-1 (dangerous) errors.

## Suggested disposition

Fix R1–R3 (CRITICAL) and R4–R9 before hand-off to Claude Design; R10–R16 fold in
during a revise pass; R17–R22 are quick corrections. Route through
`traycer-revise-requirements`.
