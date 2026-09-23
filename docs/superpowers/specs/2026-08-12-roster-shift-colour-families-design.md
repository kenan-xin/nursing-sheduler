# Roster grid: shift colour by family, not by id

**Status:** approved, pending implementation plan
**Date:** 2026-08-12

## Problem

The `/roster` grid's chip colour comes from `assignShiftRamp()` (`web/lib/roster-viewer/shift-ramp.ts`), which sorts every distinct worked-shift id by start time and hands out one of 8 fixed colours by position. The 8th slot is a dark "overflow" swatch, and every id past the 7th falls into it.

Real wards exceed 7 distinct shift ids routinely, because most wards declare a senior-only twin of every base pattern (`am1`/`am1+`, etc.) — the naming convention is entirely ward-defined and not detectable from the id string. Confirmed against fixtures in this repo:

- `large-ward-with-87-people-2025-11.yaml`: 11 distinct shift ids
- the deleted `ward-8-shift-patterns-senior-on-every-shift.yaml`: 16 ids (8 base patterns × senior twin)
- `sg-28day-160h-compliance-14-nurses.yaml`: 18 ids
- a real paper roster printout (Ward 2, `WorkforceOptimizer` export) the user supplied: 8 worked-shift ids (`A15`/`A16`/`A18`, `P12`/`P7`/`P2`, `LA8`, `LN8`)

Any of these blows past the 7-colour ceiling. The result, visible in the reported screenshot: 9 of Ward-8's 16 shift ids (every `pm*`, `night*`, and `long+`) render as the identical dark chip, so more than half the grid is only readable by squinting at small white-on-black text. This is the "cluttered and untidy" complaint — not a density or spacing problem, a colour-collision problem.

The "Rota" mockup supplied for comparison looks clean because it only has ~5 shift categories total (AM/PM/N/LD/LV), never approaching the ramp's ceiling.

The user also supplied a real paper roster printout in current clinical use, which is almost entirely monochrome — work shifts carry no colour at all; colour is reserved for leave/holiday exceptions, and seniority is read from a grade prefix on the name, not from shift colour. This was evaluated as a possible colour philosophy (`colour reserved for exceptions only`) but explicitly rejected in favour of full colour-by-family, matching the mockup; the printout's monochrome look is treated as a print/photocopy artifact, not a deliberate reference for this redesign.

## Decision

Replace per-id ramp position with a **shift family classifier**: every worked shift is assigned to one of four families — **Morning, Evening, Night, Long day** — computed live from its own `startTime`/duration, the same data every ward already authors in the Shifts setup step. No id-string parsing (`+`, `-S`, or any other convention is never inspected), no schema change, and it works on any ward's data the first time it's loaded, including data authored after this ships.

Senior/non-senior distinction is **not** given its own colour or marker. It is not reliably detectable (naming is ward-defined, and there's no `isSenior` field on `ShiftType` — the only signal is an indirect `qualifiedPeople` restriction on a preference, which doesn't always mean "senior"). The shift id text on the chip remains the source of truth for that distinction, unchanged from today.

A family colour was validated in the browser companion against Ward-8's actual 16-id, 6-nurse, 7-day slice: the "today" rendering reproduced the reported wall-of-black; the "proposed" rendering showed the same data in 4 clearly distinct hues. User confirmed it looks right.

## Classification rule

Applied in this order, using each shift's `startTime` and computed duration:

1. Start hour in the night window (≥18:00 or <06:00) → **Night**
2. Else duration ≥10h → **Long day**
3. Else start before noon → **Morning**
4. Else → **Evening**

Night is checked first so a long overnight shift (e.g. `night`/`LN8`, 20:00–08:30, 12.5h) lands in Night rather than Long day. Verified against both real datasets found during this investigation:

| Ward | Ids | Hours | Family |
|---|---|---|---|
| Ward-8 | `am1/am2/am3(+)` | 08:00 start, 6.5–8h | Morning |
| Ward-8 | `pm1/pm2/pm3(+)` | 12:00–14:00 start, ~9h | Evening |
| Ward-8 | `long(+)` | 08:00 start, 12.5h | Long day |
| Ward-8 | `night(+)` | 20:00 start, 12.5h | Night |
| Ward 2 printout | `A15/A16/A18` | 08:00 start, 7–9h | Morning |
| Ward 2 printout | `P12/P7/P2` | 12:00–14:00 start, ~9h | Evening |
| Ward 2 printout | `LA8` | 08:00 start, 12.5h | Long day |
| Ward 2 printout | `LN8` | 20:00 start, 12.5h | Night |

Threshold values (18:00/06:00 night window, 10h long cutoff) are named constants in one place, so an unusual ward pattern found later is a one-line tuning change, not a rewrite.

## Architecture

`web/lib/roster-viewer/shift-ramp.ts`:

- `SHIFT_RAMP`'s 8 entries (4 real hues + plum/teal/rose + dark overflow) shrink to the **4 family swatches already described in the file's own existing comments** — amber/Morning, clay/Evening, olive/Long day, slate/Night — using the same literal hexes, plus one small neutral fallback swatch for a shift whose time can't be parsed at all. No new colours are invented.
- `assignShiftRamp(shiftTypes)` keeps its existing signature and return shape (`Map<string, ShiftRampEntry>`), so `ShiftChip` and every other caller are unaffected. Only the internal logic changes: classify each shift via the ordered rule above instead of sorting by position.
- The "overflow" concept is retired entirely for worked shifts: since the 4 families are exhaustive over all start times, no real shift ever needs the catch-all. The catch-all remains only for the edge case of an unparseable time.

`ShiftChip` (`web/components/roster-viewer/shift-chip.tsx`): unchanged. Still renders the shift's own id as its label; only the `ShiftRampEntry` it's given differs.

Legend (wherever it's currently built in `roster-section.tsx`/`roster-grid.tsx`): changes from "one row per authored id, with hours" to "one row per family actually present in the loaded scenario" — Morning, Evening, Night, Long day, plus the existing Leave and Off/rest — mirroring the mockup. Family presence is computed live from the scenario's shift catalog; a family with no shifts in the current scenario is omitted. A specific id's exact hours are no longer listed in the legend; they remain visible on the chip and its `aria-label`.

## Edge cases

- A shift with no parseable start/end time renders with the neutral fallback swatch rather than being force-classified into a family it may not belong to.
- A family absent from the current scenario doesn't appear in the legend (already a live, per-scenario computation — no static list to keep in sync).
- Nothing about this depends on id naming, so a ward inventing a brand-new shift name classifies correctly on first load.

## Testing

- Replace `shift-ramp.test.ts`'s "8 entries / overflow" assertions with classifier tests using the Ward-8 and Ward-2-printout shift catalogs as real fixtures (both tables above), plus the existing edge cases (numeric vs. string id, missing `startTime`).
- A legend test confirming it renders one swatch per family present, not per id, against a multi-family scenario.

## Documentation impact

`DESIGN.md` needs updating in two places that this decision reverses:

- §2 "Shift colour palette": currently documents an 8-entry ramp assigned by per-id start-time position; needs to describe the 4-family classifier instead.
- §5 "Roster grid" legend rule: currently mandates the legend list every authored id with its hours ("a constrained host is never served a shortened, regrouped or recoloured key"); needs to permit the family-grouped legend described above.

## Out of scope

- Leave-type-specific colouring (the real printout differentiates `AL`, `AL2`, `BDL`, `FCL`, `MATF`, etc. by colour; this app currently renders all leave as one neutral `LV` chip). Not touched here — a separate, later decision if wanted.
- Any visual marker for senior/qualified-only slots. Explicitly rejected above; text label carries that information.
- Any change to chip geometry, grid density, or typography — the complaint traced entirely to colour collision, not layout.
