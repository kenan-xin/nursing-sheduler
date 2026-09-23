# Roster Shift Colour Families Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the roster grid's per-id, overflow-prone shift colour ramp with a 4-family classifier (Morning/Evening/Night/Long day) derived from each shift's own start time and duration, and simplify the legend to match.

**Architecture:** `web/lib/roster-viewer/shift-ramp.ts` gets a pure `classifyShiftFamily()` function and a 5-entry ramp (4 families + 1 fallback) replacing the old 8-entry positional ramp; `assignShiftRamp()` keeps its exact signature so every existing caller is unaffected except the legend builder in `web/components/roster-viewer/roster-grid.tsx`, which switches from "one row per authored id" to "one row per family present". `DESIGN.md` is updated to describe both changes.

**Tech Stack:** TypeScript, React, Vitest + Testing Library (`web/`).

## Global Constraints

- No id-string parsing anywhere in the classifier — family comes only from `startTime`/`endTime`/`durationMinutes`. (Spec "Decision".)
- `assignShiftRamp()`'s signature and return type (`Map<string, ShiftRampEntry>`) do not change. (Spec "Architecture".)
- Classification order is Night → Long day → Morning → Evening, checked in that order. Night window is start hour ≥18:00 or <06:00; Long day threshold is duration ≥10h (600 minutes). (Spec "Classification rule".)
- The 4 family hex values are the existing literal DESIGN.md hexes, unchanged: Morning `#f8e2b8`/`#7a5310`/`#d4a038`, Evening `#f6dbcd`/`#9a4726`/`#cf7049`, Long day `#e4ecd0`/`#586a22`/`#8fa243`, Night `#d8e0f2`/`#374777`/`#6274ad`. The fallback "other" reuses the old dark-overflow hex `#2b2733`/`#ece6f2`/`#5c5468`. (Spec "Architecture".)
- The legend lists one row per family **present in the current scenario**, in the order Morning, Evening, Night, Long day, then Leave, then Off/rest; an absent family is omitted. (Spec "Architecture", "Edge cases".)
- All commands below run from the `web/` directory.

---

### Task 1: Shift family classifier

**Files:**
- Modify: `web/lib/roster-viewer/shift-ramp.ts` (full rewrite)
- Modify: `web/lib/roster-viewer/shift-ramp.test.ts` (full rewrite)
- Modify: `web/lib/roster-viewer/index.ts:4` (barrel export line)

**Interfaces:**
- Consumes: nothing new — `RosterContextShiftType` (`web/lib/roster/types.ts`) already carries `id`, `startTime?`, `endTime?`, `durationMinutes?`.
- Produces (for Task 2):
  - `export type ShiftFamily = "morning" | "evening" | "long" | "night" | "other";`
  - `export function classifyShiftFamily(shift: { startTime?: string; endTime?: string; durationMinutes?: number }): ShiftFamily`
  - `export const SHIFT_FAMILY_RAMP: Record<ShiftFamily, ShiftRampEntry>`
  - `export const SHIFT_FAMILY_LABEL: Record<ShiftFamily, string>` (`"Morning"`, `"Evening"`, `"Night"`, `"Long day"`, `"Other"`)
  - `export const SHIFT_FAMILY_GLYPH: Record<ShiftFamily, string>` (`"AM"`, `"PM"`, `"N"`, `"LD"`, `"?"`)
  - `export const SHIFT_FAMILY_ORDER: readonly ShiftFamily[]` (`["morning", "evening", "night", "long", "other"]`)
  - `assignShiftRamp<TShift extends { id: unknown; startTime?: string; endTime?: string; durationMinutes?: number }>(shiftTypes: readonly TShift[]): Map<string, ShiftRampEntry>` (unchanged signature, new internals)
  - `SHIFT_RAMP: readonly ShiftRampEntry[]` (unchanged export name, now 5 entries instead of 8)
  - All re-exported from `@/lib/roster-viewer` (the barrel), same as today's `SHIFT_RAMP`/`assignShiftRamp`.

- [ ] **Step 1: Replace the test file with classifier tests (TDD — write these against the not-yet-written implementation)**

Overwrite `web/lib/roster-viewer/shift-ramp.test.ts` with:

```typescript
import { describe, expect, it } from "vitest";
import { assignShiftRamp, classifyShiftFamily, SHIFT_FAMILY_RAMP, SHIFT_RAMP } from "./shift-ramp";

describe("SHIFT_RAMP", () => {
  it("has exactly five entries: four families plus the unparseable-time fallback", () => {
    expect(SHIFT_RAMP).toHaveLength(5);
  });

  it("entries are the literal DESIGN.md hexes", () => {
    expect(SHIFT_RAMP[0]).toEqual({ fill: "#f8e2b8", ink: "#7a5310", bar: "#d4a038" }); // morning
    expect(SHIFT_RAMP[4]).toEqual({ fill: "#2b2733", ink: "#ece6f2", bar: "#5c5468" }); // other
  });
});

describe("classifyShiftFamily", () => {
  // Ward-8 (core/tests/testcases/real/ward-8-shift-patterns-senior-on-every-shift.yaml)
  it("classifies Ward-8's am1/am2/am3 patterns as morning", () => {
    expect(classifyShiftFamily({ startTime: "08:00", endTime: "15:00" })).toBe("morning");
    expect(classifyShiftFamily({ startTime: "08:00", endTime: "16:00" })).toBe("morning");
    expect(classifyShiftFamily({ startTime: "08:00", endTime: "17:00" })).toBe("morning");
  });

  it("classifies Ward-8's pm1/pm2/pm3 patterns as evening", () => {
    expect(classifyShiftFamily({ startTime: "12:00", endTime: "21:00" })).toBe("evening");
    expect(classifyShiftFamily({ startTime: "13:00", endTime: "21:00" })).toBe("evening");
    expect(classifyShiftFamily({ startTime: "14:00", endTime: "21:00" })).toBe("evening");
  });

  it("classifies Ward-8's long pattern as long day, not morning, despite an 08:00 start", () => {
    expect(classifyShiftFamily({ startTime: "08:00", endTime: "20:30" })).toBe("long");
  });

  it("classifies Ward-8's night pattern as night, not long day, despite a 12.5h duration", () => {
    expect(classifyShiftFamily({ startTime: "20:00", endTime: "08:30" })).toBe("night");
  });

  // The real Ward 2 paper roster printout, same shift shapes under different names.
  it("classifies the Ward 2 printout's A15/A16/A18 as morning", () => {
    expect(classifyShiftFamily({ startTime: "08:00", endTime: "15:00" })).toBe("morning");
    expect(classifyShiftFamily({ startTime: "08:00", endTime: "18:00" })).toBe("morning");
  });

  it("classifies the Ward 2 printout's P12/P7/P2 as evening", () => {
    expect(classifyShiftFamily({ startTime: "12:00", endTime: "21:00" })).toBe("evening");
    expect(classifyShiftFamily({ startTime: "14:00", endTime: "21:00" })).toBe("evening");
  });

  it("classifies the Ward 2 printout's LA8 as long day", () => {
    expect(classifyShiftFamily({ startTime: "08:00", endTime: "20:30" })).toBe("long");
  });

  it("classifies the Ward 2 printout's LN8 as night", () => {
    expect(classifyShiftFamily({ startTime: "20:00", endTime: "08:30" })).toBe("night");
  });

  it("prefers authored durationMinutes over a start/end computation", () => {
    // A shift authored with an 11h durationMinutes crosses the long threshold
    // even though its start/end alone would compute 9h — proving
    // durationMinutes wins when present.
    expect(
      classifyShiftFamily({ startTime: "08:00", endTime: "17:00", durationMinutes: 11 * 60 }),
    ).toBe("long");
  });

  it("falls back to other when startTime is missing or unparseable", () => {
    expect(classifyShiftFamily({})).toBe("other");
    expect(classifyShiftFamily({ startTime: "not-a-time" })).toBe("other");
  });
});

describe("assignShiftRamp", () => {
  it("assigns every shift its family's ramp entry, not a per-id position", () => {
    const shifts = [
      { id: "am1", startTime: "08:00", endTime: "15:00" },
      { id: "am1+", startTime: "08:00", endTime: "15:00" },
      { id: "pm1", startTime: "12:00", endTime: "21:00" },
      { id: "long", startTime: "08:00", endTime: "20:30" },
      { id: "night", startTime: "20:00", endTime: "08:30" },
    ];
    const ramp = assignShiftRamp(shifts);
    // am1 and am1+ share the SAME family colour — that's the point, they're
    // both morning shifts. The `+` convention is never inspected.
    expect(ramp.get("s:am1")).toBe(SHIFT_FAMILY_RAMP.morning);
    expect(ramp.get("s:am1+")).toBe(SHIFT_FAMILY_RAMP.morning);
    expect(ramp.get("s:pm1")).toBe(SHIFT_FAMILY_RAMP.evening);
    expect(ramp.get("s:long")).toBe(SHIFT_FAMILY_RAMP.long);
    expect(ramp.get("s:night")).toBe(SHIFT_FAMILY_RAMP.night);
  });

  it("never overflows: Ward-8's real 16-shift catalog still resolves to exactly its 4 families", () => {
    const wardEight = [
      { id: "am1", startTime: "08:00", endTime: "15:00" },
      { id: "am1+", startTime: "08:00", endTime: "15:00" },
      { id: "am2", startTime: "08:00", endTime: "16:00" },
      { id: "am2+", startTime: "08:00", endTime: "16:00" },
      { id: "am3", startTime: "08:00", endTime: "17:00" },
      { id: "am3+", startTime: "08:00", endTime: "17:00" },
      { id: "pm1", startTime: "12:00", endTime: "21:00" },
      { id: "pm1+", startTime: "12:00", endTime: "21:00" },
      { id: "pm2", startTime: "13:00", endTime: "21:00" },
      { id: "pm2+", startTime: "13:00", endTime: "21:00" },
      { id: "pm3", startTime: "14:00", endTime: "21:00" },
      { id: "pm3+", startTime: "14:00", endTime: "21:00" },
      { id: "long", startTime: "08:00", endTime: "20:30" },
      { id: "long+", startTime: "08:00", endTime: "20:30" },
      { id: "night", startTime: "20:00", endTime: "08:30" },
      { id: "night+", startTime: "20:00", endTime: "08:30" },
    ];
    const ramp = assignShiftRamp(wardEight);
    const distinctColours = new Set([...ramp.values()].map((entry) => entry.fill));
    expect(distinctColours.size).toBe(4);
  });

  it("distinguishes numeric and string ids of the same value", () => {
    const shifts = [
      { id: 1, startTime: "08:00", endTime: "15:00" },
      { id: "1", startTime: "12:00", endTime: "21:00" },
    ];
    const ramp = assignShiftRamp(shifts);
    expect(ramp.get("n:1")).toBe(SHIFT_FAMILY_RAMP.morning);
    expect(ramp.get("s:1")).toBe(SHIFT_FAMILY_RAMP.evening);
  });
});
```

- [ ] **Step 2: Run the test file and confirm it fails to compile/run**

Run (from `web/`): `npx vitest run lib/roster-viewer/shift-ramp.test.ts`
Expected: FAIL — `classifyShiftFamily`, `SHIFT_FAMILY_RAMP` are not exported by `./shift-ramp` yet.

- [ ] **Step 3: Rewrite the implementation**

Overwrite `web/lib/roster-viewer/shift-ramp.ts` with:

```typescript
/**
 * The roster grid's shift colour system (DESIGN.md §2 "Shift colour
 * palette"). Every worked shift is assigned to one of four families —
 * Morning, Evening, Night, Long day — by its own `startTime` and duration,
 * never by parsing its id. Ward-authored naming conventions (`am1+`, `A18`,
 * `D+`, ...) vary per ward and are never inspected.
 */

/**
 * One ramp colour. `fill`+`ink` are the chip; `bar` is the legend dot and the
 * Day-view tag colour.
 */
export interface ShiftRampEntry {
  fill: string;
  ink: string;
  bar: string;
}

export type ShiftFamily = "morning" | "evening" | "long" | "night" | "other";

/**
 * The five ramp entries. Index 0-3 are the literal DESIGN.md hexes, unchanged
 * from the retired 8-entry ramp; index 4 is the fallback for a shift whose
 * time cannot be classified.
 */
export const SHIFT_RAMP: readonly ShiftRampEntry[] = [
  { fill: "#f8e2b8", ink: "#7a5310", bar: "#d4a038" }, // 0 morning — amber
  { fill: "#f6dbcd", ink: "#9a4726", bar: "#cf7049" }, // 1 evening — clay
  { fill: "#e4ecd0", ink: "#586a22", bar: "#8fa243" }, // 2 long day — olive
  { fill: "#d8e0f2", ink: "#374777", bar: "#6274ad" }, // 3 night — cool slate
  { fill: "#2b2733", ink: "#ece6f2", bar: "#5c5468" }, // 4 other (unparseable time)
] as const;

export const SHIFT_FAMILY_RAMP: Record<ShiftFamily, ShiftRampEntry> = {
  morning: SHIFT_RAMP[0],
  evening: SHIFT_RAMP[1],
  long: SHIFT_RAMP[2],
  night: SHIFT_RAMP[3],
  other: SHIFT_RAMP[4],
};

export const SHIFT_FAMILY_LABEL: Record<ShiftFamily, string> = {
  morning: "Morning",
  evening: "Evening",
  night: "Night",
  long: "Long day",
  other: "Other",
};

export const SHIFT_FAMILY_GLYPH: Record<ShiftFamily, string> = {
  morning: "AM",
  evening: "PM",
  night: "N",
  long: "LD",
  other: "?",
};

/** Legend display order — the order a ward's day actually runs. */
export const SHIFT_FAMILY_ORDER: readonly ShiftFamily[] = [
  "morning",
  "evening",
  "night",
  "long",
  "other",
];

/** A shift starting at or after this hour, or before `NIGHT_END_HOUR`, is Night. */
const NIGHT_START_HOUR = 18;
const NIGHT_END_HOUR = 6;

/** A shift lasting this many minutes or more (and not already Night) is Long day. */
const LONG_DURATION_MINUTES = 10 * 60;

/**
 * Classify a shift into its colour family from its own `startTime` and
 * duration. Order matters: Night is checked before Long day so a 12.5h
 * overnight shift (e.g. `night`, `LN8`, 20:00-08:30) lands in Night rather
 * than Long day.
 */
export function classifyShiftFamily(shift: {
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
}): ShiftFamily {
  const startMinutes = timeToMinutes(shift.startTime);
  if (startMinutes === null) return "other";

  const startHour = Math.floor(startMinutes / 60);
  if (startHour >= NIGHT_START_HOUR || startHour < NIGHT_END_HOUR) return "night";

  const duration = resolveDurationMinutes(shift);
  if (duration !== null && duration >= LONG_DURATION_MINUTES) return "long";

  return startHour < 12 ? "morning" : "evening";
}

/**
 * Assign each worked shift type its family's ramp entry, keyed by the same
 * type-aware id key every other id-keyed roster structure uses (F3's
 * `typedIdKey`), so a numeric id and a string id of the same value never
 * collide.
 */
export function assignShiftRamp<
  TShift extends { id: unknown; startTime?: string; endTime?: string; durationMinutes?: number },
>(shiftTypes: readonly TShift[]): Map<string, ShiftRampEntry> {
  const ramp = new Map<string, ShiftRampEntry>();
  for (const shift of shiftTypes) {
    ramp.set(typedKey(shift.id), SHIFT_FAMILY_RAMP[classifyShiftFamily(shift)]);
  }
  return ramp;
}

/** `"HH:MM"` → minutes since midnight, or `null` when unparseable/absent. */
function timeToMinutes(time: string | undefined): number | null {
  if (typeof time !== "string") return null;
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Prefer the ward's own authored `durationMinutes` (Option B, `models.py`)
 * when present — it is exactly the paid working minutes and needs no
 * day-wrap guessing. Otherwise derive it from `startTime`/`endTime`, treating
 * an end time not later than the start as crossing midnight.
 */
function resolveDurationMinutes(shift: {
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
}): number | null {
  if (typeof shift.durationMinutes === "number" && shift.durationMinutes > 0) {
    return shift.durationMinutes;
  }
  const start = timeToMinutes(shift.startTime);
  const end = timeToMinutes(shift.endTime);
  if (start === null || end === null) return null;
  return end > start ? end - start : end + 24 * 60 - start;
}

/**
 * A type-aware identity key matching F3's `typedIdKey`, so the ramp assignment
 * is consistent with every other id-keyed structure in the roster domain.
 */
function typedKey(id: unknown): string {
  return typeof id === "number" ? `n:${id}` : `s:${String(id)}`;
}
```

- [ ] **Step 4: Run the test file and confirm it passes**

Run: `npx vitest run lib/roster-viewer/shift-ramp.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Export the new symbols from the barrel**

In `web/lib/roster-viewer/index.ts`, replace line 4:

```typescript
export { SHIFT_RAMP, assignShiftRamp, type ShiftRampEntry } from "./shift-ramp";
```

with:

```typescript
export {
  assignShiftRamp,
  classifyShiftFamily,
  SHIFT_FAMILY_GLYPH,
  SHIFT_FAMILY_LABEL,
  SHIFT_FAMILY_ORDER,
  SHIFT_FAMILY_RAMP,
  SHIFT_RAMP,
  type ShiftFamily,
  type ShiftRampEntry,
} from "./shift-ramp";
```

- [ ] **Step 6: Run the full roster-viewer lib test suite**

Run: `npx vitest run lib/roster-viewer`
Expected: PASS. (This also exercises `web/components/roster-viewer/roster-viewer.test.tsx` indirectly only if it's under this path — it isn't, so this step covers `lib/roster-viewer/**` only; Task 2 covers the component test.)

- [ ] **Step 7: Commit**

```bash
git add web/lib/roster-viewer/shift-ramp.ts web/lib/roster-viewer/shift-ramp.test.ts web/lib/roster-viewer/index.ts
git commit -m "refactor(roster): classify shift colour by family, not per-id position"
```

---

### Task 2: Roster grid legend groups by family

**Files:**
- Modify: `web/components/roster-viewer/roster-grid.tsx` (imports, stale comment, `GridToolbar`, `buildLegendEntries`, its call site)
- Modify: `web/components/roster-viewer/roster-viewer.test.tsx` (two tests in the roster-grid-legend describe block, plus the import line)

**Interfaces:**
- Consumes (from Task 1): `classifyShiftFamily`, `SHIFT_FAMILY_GLYPH`, `SHIFT_FAMILY_LABEL`, `SHIFT_FAMILY_ORDER`, `SHIFT_FAMILY_RAMP`, `type ShiftFamily`, all from `@/lib/roster-viewer`.
- Produces: no new public interface — `RosterGrid`'s own props (`RosterGridProps`) are unchanged; only its internal `GridToolbar` loses its now-unused `ramp` prop.

- [ ] **Step 1: Update the two legend tests in `roster-viewer.test.tsx` to expect family grouping (TDD — write against the not-yet-changed component)**

First, update the import line near the top of the file. Find:

```typescript
import { ROSTER_VIEW_PREFERENCE_KEY, SHIFT_RAMP } from "@/lib/roster-viewer";
```

Replace with:

```typescript
import { ROSTER_VIEW_PREFERENCE_KEY, SHIFT_FAMILY_RAMP, SHIFT_RAMP } from "@/lib/roster-viewer";
```

Then find this test (inside the roster-grid-legend describe block):

```typescript
  it("keys EVERY authored shift with its id, its hours and the SAME ramp entry its cells use", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const items = [...screen.getAllByTestId("roster-grid-legend-item")];
    const shifts = items.map((item) => item.getAttribute("data-shift"));
    // Every scenario shift, plus the two day-states.
    expect(shifts).toEqual(["D", "N", "LV", "OFF"]);
    expect(items[0].textContent).toContain("09:00–17:00");
    expect(items[1].textContent).toContain("21:00–07:00");
    expect(items[2].textContent).toContain("Leave");
    expect(items[3].textContent).toContain("Off / rest");

    // The legend swatch paints the same colour the grid cell does — one ramp,
    // not a second colour table that can drift.
    const rampD = SHIFT_RAMP[0];
    const swatch = items[0].querySelector("span");
    expect(swatch?.style.backgroundColor).toBe(normaliseColour(rampD.fill));
  });

  it("NEGATIVE CONTROL: invents no Morning/Evening/Night category labels", async () => {
    // The ramp has eight entries and Ward 8 authors sixteen shifts, so colour
    // repeats. Naming a family from colour would be a claim the scenario never
    // made; the id and its hours are the only authority.
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const legend = screen.getByTestId("roster-grid-legend");
    for (const category of ["Morning", "Evening", "Night", "Long day", "AM", "PM"]) {
      expect(legend.textContent).not.toContain(category);
    }
  });
```

Replace both with:

```typescript
  it("groups shifts by their computed colour family, not by id", async () => {
    // Fixture shift D is 09:00–17:00 (Morning); N is 21:00–07:00 (Night —
    // its start hour falls in the night window). The "N" glyph below is the
    // FAMILY glyph for Night, coincidentally identical to the fixture's raw
    // id of the same name — the two are unrelated after this change.
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const items = [...screen.getAllByTestId("roster-grid-legend-item")];
    const shifts = items.map((item) => item.getAttribute("data-shift"));
    expect(shifts).toEqual(["AM", "N", "LV", "OFF"]);
    expect(items[0].textContent).toContain("Morning");
    expect(items[1].textContent).toContain("Night");
    expect(items[2].textContent).toContain("Leave");
    expect(items[3].textContent).toContain("Off / rest");

    // The legend swatch paints the same colour the grid cell does — one ramp,
    // not a second colour table that can drift.
    const swatch = items[0].querySelector("span");
    expect(swatch?.style.backgroundColor).toBe(normaliseColour(SHIFT_FAMILY_RAMP.morning.fill));
  });

  it("POSITIVE CONTROL: names the shift's colour family instead of listing its exact hours", async () => {
    // This inverts the prior decision (DESIGN.md §5): family colour sharing is
    // now intentional, so the legend names the family rather than each id's hours.
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const legend = screen.getByTestId("roster-grid-legend");
    expect(legend.textContent).toContain("Morning");
    expect(legend.textContent).toContain("Night");
    expect(legend.textContent).not.toContain("09:00–17:00");
    expect(legend.textContent).not.toContain("21:00–07:00");
  });
```

- [ ] **Step 2: Run the component test and confirm the two rewritten tests fail**

Run: `npx vitest run components/roster-viewer/roster-viewer.test.tsx -t "legend"`
Expected: FAIL on the two rewritten tests (the legend still keys by id, e.g. `shifts` is `["D", "N", "LV", "OFF"]` not `["AM", "N", "LV", "OFF"]`). Other legend tests in the same describe block (scroller/disclosure behaviour) should still pass, since they don't assert specific content.

- [ ] **Step 3: Update imports and the stale design comment in `roster-grid.tsx`**

Find:

```typescript
import {
  dateLabel,
  dateTitle,
  isNewMonth,
  rosterSpanTitle,
  shiftContextLabel,
  shiftTimeRange,
  uniformShiftRequirement,
  type CoverageGrid,
  type ShiftRampEntry,
  type Tallies,
} from "@/lib/roster-viewer";
```

Replace with:

```typescript
import {
  classifyShiftFamily,
  dateLabel,
  dateTitle,
  isNewMonth,
  rosterSpanTitle,
  SHIFT_FAMILY_GLYPH,
  SHIFT_FAMILY_LABEL,
  SHIFT_FAMILY_ORDER,
  SHIFT_FAMILY_RAMP,
  shiftTimeRange,
  uniformShiftRequirement,
  type CoverageGrid,
  type ShiftFamily,
  type ShiftRampEntry,
  type Tallies,
} from "@/lib/roster-viewer";
```

(`shiftContextLabel` is dropped — after Step 4 below it has no remaining caller in this file. `shiftTimeRange` stays; it is still used by the coverage-summary rows elsewhere in this file.)

Then find the comment block immediately above `function GridToolbar({`:

```typescript
 * The legend keys every AUTHORED shift with the exact ramp entry its cells use.
 * It does not group Ward 8's sixteen shifts into Morning/Evening/Night families:
 * the ramp has eight entries, so overflow colours repeat, and an inferred
 * category label would be a claim the scenario never made. The id and its hours
 * are the authority; colour is a scan aid.
 */
```

Replace with:

```typescript
 * The legend groups every AUTHORED shift into its computed colour family
 * (Morning/Evening/Night/Long day) rather than keying each id individually.
 * Family is derived from each shift's own startTime/duration
 * (`classifyShiftFamily`), never from its id string — a ward's naming
 * convention (a `+` senior twin, or anything else) is never inspected, and two
 * ids sharing a family colour is intentional, not overflow (DESIGN.md §2
 * "Shift colour palette").
 */
```

- [ ] **Step 4: Rewrite `buildLegendEntries` and drop the now-unused `ramp` plumbing through `GridToolbar`**

Find the `GridToolbar` function signature:

```typescript
function GridToolbar({
  context,
  ramp,
  isEditing,
}: {
  context: RosterContext;
  ramp: Map<string, ShiftRampEntry>;
  isEditing: boolean;
}) {
  const { width } = useRosterContentWidth();
  const entries = useMemo(() => buildLegendEntries(context, ramp), [context, ramp]);
```

Replace with:

```typescript
function GridToolbar({
  context,
  isEditing,
}: {
  context: RosterContext;
  isEditing: boolean;
}) {
  const { width } = useRosterContentWidth();
  const entries = useMemo(() => buildLegendEntries(context), [context]);
```

Find the call site inside `RosterGrid`'s JSX:

```typescript
      <GridToolbar context={context} ramp={ramp} isEditing={isEditing} />
```

Replace with:

```typescript
      <GridToolbar context={context} isEditing={isEditing} />
```

Find the `LegendEntry` interface's `shift`/`text` doc comments:

```typescript
interface LegendEntry {
  key: string;
  /** `data-shift` — the authored id, or `LV` / `OFF`. */
  shift: string;
  /** The chip glyph. */
  glyph: string;
  /** The text beside the chip: the authored hours, `Leave`, or `Off / rest`. */
  text: string | null;
```

Replace with:

```typescript
interface LegendEntry {
  key: string;
  /** `data-shift` — the family glyph (`AM`/`PM`/`N`/`LD`), or `LV` / `OFF`. */
  shift: string;
  /** The chip glyph. */
  glyph: string;
  /** The text beside the chip: the family name, `Leave`, or `Off / rest`. */
  text: string | null;
```

Finally, find the whole `buildLegendEntries` function:

```typescript
/**
 * The ONE legend-item builder (G8). Both the wide wrapped key and the `Shift
 * key` disclosure render this same list, so a constrained host can never be
 * served a shortened, regrouped, or differently coloured version of the key.
 */
function buildLegendEntries(
  context: RosterContext,
  ramp: Map<string, ShiftRampEntry>,
): LegendEntry[] {
  const entries: LegendEntry[] = context.shiftTypes.map((shift) => {
    const entry = ramp.get(typedIdKey(shift.id));
    return {
      key: typedIdKey(shift.id),
      shift: String(shift.id),
      glyph: String(shift.id),
      text: shiftTimeRange(shift),
      title: shiftContextLabel(shift),
      fill: entry?.fill ?? "var(--panel)",
      ink: entry?.ink ?? "var(--ink2)",
      bare: false,
    };
  });
  entries.push({
    key: "legend:LV",
    shift: "LV",
    glyph: "LV",
    text: "Leave",
    title: "Leave",
    fill: "var(--panel)",
    ink: "var(--ink3)",
    bare: false,
  });
  entries.push({
    key: "legend:OFF",
    shift: "OFF",
    glyph: "·",
    text: "Off / rest",
    title: "Off / rest",
    fill: "transparent",
    ink: "var(--ink3)",
    bare: true,
  });
  return entries;
}
```

Replace with:

```typescript
/**
 * The ONE legend-item builder (G8, revised). Both the wide wrapped key and the
 * `Shift key` disclosure render this same list, so a constrained host can
 * never be served a shortened, regrouped, or differently coloured version of
 * the key. The key lists one row per colour FAMILY present in this scenario's
 * shift catalog, not one row per authored id — colour is shared across a
 * family on purpose (DESIGN.md §5).
 */
function buildLegendEntries(context: RosterContext): LegendEntry[] {
  const present = new Set<ShiftFamily>();
  for (const shift of context.shiftTypes) {
    present.add(classifyShiftFamily(shift));
  }
  const entries: LegendEntry[] = SHIFT_FAMILY_ORDER.filter((family) => present.has(family)).map(
    (family) => {
      const entry = SHIFT_FAMILY_RAMP[family];
      return {
        key: `legend:${family}`,
        shift: SHIFT_FAMILY_GLYPH[family],
        glyph: SHIFT_FAMILY_GLYPH[family],
        text: SHIFT_FAMILY_LABEL[family],
        title: SHIFT_FAMILY_LABEL[family],
        fill: entry.fill,
        ink: entry.ink,
        bare: false,
      };
    },
  );
  entries.push({
    key: "legend:LV",
    shift: "LV",
    glyph: "LV",
    text: "Leave",
    title: "Leave",
    fill: "var(--panel)",
    ink: "var(--ink3)",
    bare: false,
  });
  entries.push({
    key: "legend:OFF",
    shift: "OFF",
    glyph: "·",
    text: "Off / rest",
    title: "Off / rest",
    fill: "transparent",
    ink: "var(--ink3)",
    bare: true,
  });
  return entries;
}
```

- [ ] **Step 5: Run the component test and confirm it passes**

Run: `npx vitest run components/roster-viewer/roster-viewer.test.tsx`
Expected: PASS, full file green (not just the `-t "legend"` subset — this also catches any other test that happened to depend on per-id legend rows).

- [ ] **Step 6: Run the broader component and lib suites to catch any missed caller**

Run: `npx vitest run components/roster-viewer lib/roster-viewer`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/components/roster-viewer/roster-grid.tsx web/components/roster-viewer/roster-viewer.test.tsx
git commit -m "refactor(roster): group the roster grid legend by shift colour family"
```

---

### Task 3: Update DESIGN.md

**Files:**
- Modify: `DESIGN.md` (§2 "Shift colour palette" table and intro; §5 "Roster grid" Legend bullet)

**Interfaces:**
- Consumes: the family names, hex values, and classification order from Task 1; the legend behaviour from Task 2. No code interface — this task is documentation-only.

- [ ] **Step 1: Replace the §2 "Shift colour palette" section**

Find (in `DESIGN.md`, under `## 2. Colors`):

```markdown
### Shift colour palette

Worked shifts are coloured **by start time**, from a fixed 8-entry ramp so mornings read warm and nights read cool. The one hard constraint: **adjacent entries must differ in hue, not just lightness** — two near-identical sands in a row made AM/PM/LD unreadable at chip size.

| # | Fill | Ink | Bar | Reads as |
|---|---|---|---|---|
| 1 | `#f8e2b8` | `#7a5310` | `#d4a038` | morning — amber |
| 2 | `#f6dbcd` | `#9a4726` | `#cf7049` | afternoon/evening — clay |
| 3 | `#e4ecd0` | `#586a22` | `#8fa243` | long day — olive |
| 4 | `#d8e0f2` | `#374777` | `#6274ad` | night — cool slate |
| 5 | `#e9dbf0` | `#653f8e` | `#9670bd` | plum |
| 6 | `#d3e9e3` | `#1b6a5d` | `#3d9587` | teal |
| 7 | `#f7dae2` | `#9a3153` | `#c66184` | rose |
| 8 | `#2b2733` | `#ece6f2` | `#5c5468` | dark (overflow) |

`fill`+`ink` are the chip; `bar` is the legend dot and day-view tag. These are **literal hexes, not theme tokens, and do not change in dark mode** — they are data marks and must stay comparable across themes. Reserved and never drawn from this ramp: leave (`--panel`) and rest (a `--faint` dot).
```

Replace with:

```markdown
### Shift colour palette

Worked shifts are coloured **by colour family** — Morning, Evening, Night, Long day — derived from each shift's own `startTime` and duration, never from its id. A ward's naming convention (`am1+`, `A18`, `D+`, or anything else) is never inspected; two ids in the same family intentionally share a colour.

| Family | Fill | Ink | Bar | Rule |
|---|---|---|---|---|
| Morning | `#f8e2b8` | `#7a5310` | `#d4a038` | start hour <12:00, and not Night or Long day |
| Evening | `#f6dbcd` | `#9a4726` | `#cf7049` | start hour ≥12:00, and not Night or Long day |
| Long day | `#e4ecd0` | `#586a22` | `#8fa243` | duration ≥10h, and start hour not in the Night window |
| Night | `#d8e0f2` | `#374777` | `#6274ad` | start hour ≥18:00 or <06:00 |
| Other | `#2b2733` | `#ece6f2` | `#5c5468` | fallback: a shift with no parseable start time |

Night is checked before Long day, so a 12.5h overnight shift lands in Night rather than Long day. `fill`+`ink` are the chip; `bar` is the legend dot and day-view tag. These are **literal hexes, not theme tokens, and do not change in dark mode** — they are data marks and must stay comparable across themes. Reserved and never drawn from this ramp: leave (`--panel`) and rest (a `--faint` dot).
```

- [ ] **Step 2: Replace the §5 "Roster grid" Legend bullet**

Find (under `### Roster grid`):

```markdown
- **Legend:** one item builder, two layouts, **never a scroller**. At `≥900px` of measured roster-CONTENT width (the layout ladder's own step, not the viewport) the complete key wraps inline; below it the same complete list moves into a native `<details>` disclosure labelled `Shift key`. Both render every authored id with its hours plus Leave and Off/rest, from the same builder and the same ramp — a constrained host is never served a shortened, regrouped or recoloured key. A second horizontal scroller is forbidden: the roster table is the only dense horizontal scroller on the route, and an `overflow-x:auto` strip here hid over half the key at 1440px and reported as a serious `scrollable-region-focusable` under axe. A custom ornamental scrollbar is not an alternative. Colour repeats past the ramp's eight entries, so **no inferred AM/PM or Morning/Evening/Night grouping** may be added — the id and its hours are the authority, colour is a scan aid.
```

Replace with:

```markdown
- **Legend:** one item builder, two layouts, **never a scroller**. At `≥900px` of measured roster-CONTENT width (the layout ladder's own step, not the viewport) the complete key wraps inline; below it the same complete list moves into a native `<details>` disclosure labelled `Shift key`. Both render the same list, from the same builder — a constrained host is never served a shortened or differently coloured version of the key. A second horizontal scroller is forbidden: the roster table is the only dense horizontal scroller on the route, and an `overflow-x:auto` strip here hid over half the key at 1440px and reported as a serious `scrollable-region-focusable` under axe. A custom ornamental scrollbar is not an alternative. The key lists one row per colour **family** actually present in the scenario (Morning/Evening/Night/Long day), plus Leave and Off/rest — not one row per authored id. A family absent from the scenario is omitted; a specific id's exact hours live on its chip and `aria-label`, not the legend.
```

- [ ] **Step 3: Commit**

```bash
git add DESIGN.md
git commit -m "docs(design): describe shift colour families, replacing the per-id ramp"
```
