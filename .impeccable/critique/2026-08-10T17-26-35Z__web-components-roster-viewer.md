---
target: roster viewer/editor against ScreenSchedule prototype
total_score: 28
p0_count: 0
p1_count: 6
timestamp: 2026-08-10T17-26-35Z
slug: web-components-roster-viewer
---
+# Roster viewer/editor prototype fidelity review

## Verdict

**Changes required before G7 can be called a full prototype-fidelity pass.** The production roster is real and substantially complete: Grid, Day, and Coverage exist; editing/autosave/undo, Save/Import/XLSX, Clear, candidate protection, responsive switching, and the exact Ward 8 two-run journey all work. The strongest part is the dense Grid. The remaining debt is concentrated in Coverage usefulness, loaded-page hierarchy, Ward-scale editing choices, dark selected-state contrast, and one browser-test race.

## Design health score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 4 | Saving, saved, edited, candidate, selection, and solver states are explicit. |
| 2 | Match system / real world | 3 | Ward shift codes lack time/context; canonical Ward coverage is unavailable. |
| 3 | User control and freedom | 3 | Cancel, Undo, Dismiss, replacement confirmation, and Clear confirmation are strong; Undo is single-level/session-only. |
| 4 | Consistency and standards | 2 | Edit options and Day tabs drift from the pill control grammar. |
| 5 | Error prevention | 4 | Existing rosters are never silently overwritten; replacement/import/clear fail closed. |
| 6 | Recognition rather than recall | 3 | Core choices remain visible, but Ward editing exposes 18 undifferentiated values. |
| 7 | Flexibility and efficiency | 2 | Three lenses and drag/keyboard editing exist; the dense grid keyboard model and flat picker do not scale. |
| 8 | Aesthetic and minimalist design | 2 | Excellent data surfaces, but duplicate headings and equal-weight mobile chrome delay the roster. |
| 9 | Error recovery | 4 | Plain-language retry/rescue and durable Save/Import paths preserve work. |
| 10 | Help and documentation | 1 | Coverage legend/instructions and shift time decoding are missing. |
| **Total** |  | **28/40** | **Good foundation, material workflow debt** |

## Technical audit health

| Dimension | Score | Key finding |
|---|---:|---|
| Accessibility | 3/4 | Dark selected lens contrast is 3.64:1; dense cell tab model is deferred backlog. |
| Performance | 3/4 | No obvious layout thrash or heavy assets; Ward scale stays below the documented virtualization threshold. |
| Responsive | 4/4 | Exact 759/760 container switch, 390px Day default, internal grid overflow without document overflow, and 44px coarse targets pass. |
| Theming | 3/4 | Light/dark tokens and data colors are stable; selected lens pair fails AA in dark mode. |
| Anti-patterns | 4/4 | No AI-slop patterns; semantic holiday stripes and literal shift colors are intentional data marks. |
| **Total** | **17/20** | **Good** |

## Anti-patterns verdict

**Pass.** The roster looks like a deliberately authored scheduling instrument, not a generic AI dashboard. Square data surfaces, restrained semantic color, sticky table anatomy, the shift ramp, and warm-ink/cool-mint surfaces are distinctive and coherent.

The bundled deterministic detector was unavailable: its entrypoint returned `Error: bundled detector not found.`. Manual fallback found nine syntactic candidates, all false positives under `DESIGN.md`: semantic holiday gradients, required literal shift data colors, and structural calendar/summary separators. Live overlay injection preflight succeeded, but `detect.js` returned 404, so no reliable human-visible overlay exists.

## Overall impression

The Grid is close to exemplary. The page becomes less convincing above it: two large “Review” headings, several equal-weight action/status/lens rows, and a Ward-scale flat edit picker make the surrounding chrome feel assembled rather than resolved. Coverage is the largest functional mismatch because the canonical Ward 8 scenario produces no usable baseline.

## What is working

1. **Grid fidelity:** 34×28 borderless chips, square cells, 66vh internal scroller, sticky z-order 5/3/2, weekend/holiday treatment, and dark-mode-stable shift colors match the shipped contract closely.
2. **State safety:** autosave, explicit candidate replacement, cancel/dismiss, Save roster file, Import roster file, XLSX export, Clear, and existing-roster non-overwrite are unusually well fenced.
3. **Responsive behavior:** container-measured Grid/Coverage/Day switching works at the exact 759/760 boundary, Day is usable on mobile, and document overflow stays contained.

## Priority issues

### [P1] Coverage is not operational for the canonical Ward 8 scenario

**Why it matters:** Ward 8 expresses staffing through shift groups and qualification scopes. Production correctly refuses to invent per-shift minima, but the result is an entire Coverage lens of “unavailable” cells. A view named Coverage cannot answer the ward scheduler’s staffing question.

**Evidence:** `web/lib/roster-viewer/coverage.ts` only derives exact unscoped shift baselines; the assembled Ward test explicitly expects Coverage unavailable for all group/scoped requirements.

**Fix:** add an aggregate coverage model for shift-group and qualification-scoped requirements, with explicit scope labels. Keep exact-shift lanes when a true per-shift baseline exists. Until derivation is available, explain why coverage is unavailable instead of showing a silent wall of dashes.

### [P1] Coverage geometry and context drift from ScreenSchedule

**Why it matters:** On a 28-day roster, horizontally scrolling loses the shift identity, and `am1/am1+/long+` are hard to decode without times.

**Evidence:** production uses `200px repeat(n,minmax(0,1fr))`, does not keep the left lane sticky, and renders id + minimum only. ScreenSchedule/DESIGN require a 212px sticky label lane, 128px day tracks, time/context, and an explanatory legend.

**Fix:** use one 212/128 template, sticky left labels, start–end time and plain description where available, and a compact legend. Test horizontal review with Ward-sized data.

### [P1] Mobile hierarchy delays the roster and gives secondary file actions equal weight

**Why it matters:** At 390px the first roster data begins around 453px down the page. A first-time or interrupted scheduler must parse duplicate headings, four document actions, status/provenance, Undo, and lenses before seeing the schedule.

**Evidence:** `roster-screen.tsx` and `roster-section.tsx` both render large review headings; actions/status/lenses stack at equal visual weight.

**Fix:** keep one route heading; remove the duplicate loaded-state heading; keep Export XLSX as the primary visible action; group portable Save/Import and privacy Clear under a labelled Roster file control on narrow screens; seat lenses directly above the data and keep them available while scrolling.

### [P1] Ward editing exposes 18 unstructured values at once

**Why it matters:** Sixteen shifts plus OFF/LV and Cancel exceed working-memory limits, especially for similar variants such as `am1` and `am1+`.

**Evidence:** `roster-edit-bar.tsx` maps every shift into one wrapping button row; the exact Ward test pins 18 values.

**Fix:** show current and recent/common choices (at most four), separate OFF/LV, then use a searchable “More shifts” combobox sorted by start time with time ranges. Do not infer semantic families unless the data model states them.

### [P1] Dark selected lens text fails WCAG AA

**Why it matters:** The active Grid/Coverage/Day label is normal-size text at 3.64:1 in dark mode.

**Evidence:** shared selected toggle recipe produces computed `#66bcac` on `#30564e`.

**Fix:** adjust the selected dark token pair or selected-item override to at least 4.5:1, then rerun dark axe coverage.

### [P1] Focused browser gate has a deterministic Clear race

**Why it matters:** the product purge succeeds, but `roster-viewer.spec.ts` observes storage before the async completion signal. The required gate remains red and could hide a real future regression.

**Fix:** await a completion-owned UI/state signal or poll the residue set to its final all-false state. Do not weaken the purge ordering.

## Secondary findings

- **[P2] Weekend-rest fairness tally is missing.** Grid ends with Off + LV even though the current DESIGN contract expects Weekend rest. Restore it or ratify the deviation with a product reason.
- **[P2] Day tabs and edit choices are square controls.** Bring them into the pill/circular control grammar while keeping data cells square.
- **[P2] Day date labels are code-like.** Prefer day-of-month + weekday hierarchy for faster scanning.

## Deferred accessibility backlog

The real Ward grid exposes 896 focusable `td role="button"` cells. A roving 2-D grid model would be better, but this is complex, cross-cutting, and regression-prone. Per the standing accessibility priority rule, it should be recorded as a non-blocking P4 backlog item rather than delaying the active fidelity repair.

## Persona red flags

- **Alex, expert scheduler:** the 18-value edit row and single-level Undo slow repetitive corrections; the dense Grid and drag-swap are strong.
- **Jordan, occasional scheduler:** duplicate “Review” headings imply two levels that do not exist; coded shifts without time ranges and unexplained unavailable coverage increase hesitation.
- **Sam, keyboard/screen-reader user:** 896 sequential stops are the main barrier; labelled states, focusable Day tabs, and 44px edit targets are positives.
- **Ward scheduler:** the missing weekend-rest tally and unusable group-scoped Coverage lens hide exactly the fairness/staffing questions they need to review.

## Questions considered

1. Is Coverage a real lens when the canonical ward cannot produce one meaningful lane?
2. Is the primary job reviewing the roster, editing assignments, or managing files? The header currently gives all three equal weight.
3. Should an OPTIMAL result sit beside a Coverage lens that cannot evaluate the ward’s stated requirements?
4. Is 896 focusable buttons a keyboard design, or exposed DOM mechanics?

## Evidence and limitations

- Assessment independence: preserved; design review and detector/browser audit did not see each other.
- Browser: isolated production/prototype servers and fresh contexts; localhost:3000 untouched; all temporary servers stopped.
- Existing exact Ward assembled gate: 38/38, two Ward journeys without retry, zero Docker/download residue.
- Focused roster browser: 45 passed, 1 failed from the Clear-test race; independent delayed probe confirmed product residue clears.
- Focused unit: 571 passed; backend Ward tests: 12 passed.
- Ward scale visual limitation: the visual design assessment used the committed 2-person fixture and verified 32×28 Ward behavior through the assembled test/source evidence, not a newly watched live solve.
