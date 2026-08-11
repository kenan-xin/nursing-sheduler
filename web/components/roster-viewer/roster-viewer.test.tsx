// @vitest-environment jsdom

// Roster viewer component tests (F4).
//
// These tests verify the load-bearing contracts from DESIGN.md and the ticket:
// the three lenses render, the sticky geometry is present, the shift chip is
// 34×28 borderless, coverage shows unavailable rather than a fabricated number,
// the container-width hook drives Coverage stacking, the Day lens defaults on
// mobile, and the forbidden-copy surface (no Forget/Abandon/Optimize-again/
// recovery terminology) is absent.

import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { act, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RosterViewer } from "./roster-viewer";
import { RosterContentWidthProvider } from "./roster-content-width";
import { ShiftChip } from "./shift-chip";
import { COVERAGE_STACK_THRESHOLD, MOBILE_DEFAULT_LENS_VIEWPORT } from "./use-container-width";
import type { RosterDocument, RosterDayState } from "@/lib/roster";
import { ROSTER_VIEW_PREFERENCE_KEY, SHIFT_RAMP } from "@/lib/roster-viewer";
import {
  fixtureCanonicalDocument,
  fixtureContainer,
  fixtureRosterDocument,
} from "@/lib/roster/test-fixtures";
import { PREFERENCE_TYPE } from "@/lib/scenario";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Layout harness
//
// jsdom performs no layout: `getBoundingClientRect` is all zeroes and
// `ResizeObserver` does not exist. The container-width contract is the whole
// point of several tests below, so we drive both explicitly rather than letting
// them silently collapse to width 0 (which would make every assertion pass for
// the wrong reason).
// ---------------------------------------------------------------------------

/**
 * The viewer under its PRODUCTION width authority.
 *
 * G7 lifted the single roster-content measurement above both the document action
 * row and the lens surface, so the viewer no longer measures anything itself.
 * Every test mounts it through the same provider production does; measuring it
 * some other way here would prove a layout the app does not ship.
 */
function Viewer(props: ComponentProps<typeof RosterViewer>) {
  return (
    <RosterContentWidthProvider>
      <RosterViewer {...props} />
    </RosterContentWidthProvider>
  );
}

/** Live observers, so a test can push a new width the way a real resize would. */
const observerCallbacks = new Set<(width: number) => void>();

function installResizeObserver() {
  globalThis.ResizeObserver = class {
    #notify: (width: number) => void;
    constructor(callback: ResizeObserverCallback) {
      this.#notify = (width: number) => {
        callback(
          [{ contentRect: { width } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      };
    }
    observe() {
      observerCallbacks.add(this.#notify);
    }
    unobserve() {
      observerCallbacks.delete(this.#notify);
    }
    disconnect() {
      observerCallbacks.delete(this.#notify);
    }
  } as unknown as typeof ResizeObserver;
}

/** Push a new container width to every live observer, as a real resize would. */
function resizeObservedElements(width: number) {
  for (const notify of observerCallbacks) notify(width);
}

/** Make every element measure `width` px wide (the mount-time measurement). */
function mockContainerWidth(width: number) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height: 600,
    top: 0,
    left: 0,
    bottom: 600,
    right: width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

/** Switch lens through a React-dispatched event so the state update is flushed. */
function selectLens(lens: "grid" | "coverage" | "day") {
  fireEvent.click(screen.getByTestId(`roster-lens-${lens}`));
}

/**
 * jsdom normalises inline colours to `rgb(...)`, so a raw hex from the ramp can
 * never compare equal. Round-trip the expected value through the same parser.
 */
function normaliseColour(value: string): string {
  const probe = window.document.createElement("span");
  probe.style.backgroundColor = value;
  return probe.style.backgroundColor;
}

async function makeDocument(overrides?: { unavailableShift?: boolean }): Promise<RosterDocument> {
  const doc = fixtureCanonicalDocument();
  if (overrides?.unavailableShift) {
    // Remove the D requirement so D becomes unavailable and N stays unavailable.
    doc.preferences = doc.preferences.filter(
      (p) => p.type !== PREFERENCE_TYPE.shiftTypeRequirement,
    );
  }
  return fixtureRosterDocument({ document: doc });
}

/**
 * A document whose staffing is stated the way Ward 8 states it: one AGGREGATE
 * group requirement over both shifts, plus one QUALIFICATION-scoped requirement
 * on a single shift. Neither shape can produce a per-shift headcount, so this is
 * the fixture the anti-inference controls need.
 *
 * With the fixture grid (`P1: D OFF N LEAVE`, `P2: N D OFF D`):
 *   • day 0 — `AllShifts` has 2 of 2; the qualified `N` slot is held by P2, who
 *     is not qualified, so it is BOTH Short 1 and Unqualified 1;
 *   • day 1 — `AllShifts` has 1 of 2, so the day is red from a GROUP shortage
 *     while neither member shift has a target of its own.
 */
async function makeGroupDocument(): Promise<RosterDocument> {
  const doc = fixtureCanonicalDocument();
  doc.shiftTypes.groups = [{ id: "AllShifts", members: ["D", "N"] }];
  doc.preferences = [
    { type: PREFERENCE_TYPE.maxOneShiftPerDay },
    {
      type: PREFERENCE_TYPE.shiftTypeRequirement,
      shiftType: "AllShifts",
      requiredNumPeople: 2,
      date: "ALL",
      weight: -1,
    },
    {
      type: PREFERENCE_TYPE.shiftTypeRequirement,
      shiftType: "N",
      requiredNumPeople: 1,
      qualifiedPeople: ["P1"],
      date: "ALL",
      weight: -1,
    },
  ];
  return fixtureRosterDocument({ document: doc });
}

/**
 * A document whose only requirement is scoped to ONE date (`2026-07-04`, index 1)
 * and asks for more people than the roster puts on `D` there.
 *
 * The point is discriminating in both directions: the scoped date must show
 * `staffed/required` and go red, and every other date must show a bare count
 * with no target at all.
 */
async function makeScopedDocument(): Promise<RosterDocument> {
  const doc = fixtureCanonicalDocument();
  doc.preferences = [
    { type: PREFERENCE_TYPE.maxOneShiftPerDay },
    {
      type: PREFERENCE_TYPE.shiftTypeRequirement,
      shiftType: "D",
      requiredNumPeople: 2,
      date: "2026-07-04",
      weight: -1,
    },
  ];
  return fixtureRosterDocument({ document: doc });
}

/**
 * A document with ONE satisfied requirement and ONE that cannot be resolved.
 *
 * The mixed state is the whole point: skipping the unavailable half and
 * reporting the satisfied half painted a healthy dot over a date carrying a
 * requirement nothing had checked.
 */
async function makeMixedUnavailableDocument(): Promise<RosterDocument> {
  const doc = fixtureCanonicalDocument();
  doc.preferences = [
    { type: PREFERENCE_TYPE.maxOneShiftPerDay },
    {
      type: PREFERENCE_TYPE.shiftTypeRequirement,
      shiftType: "D",
      requiredNumPeople: 1,
      date: "ALL",
      weight: -1,
    },
    {
      type: PREFERENCE_TYPE.shiftTypeRequirement,
      shiftType: "NoSuchShift",
      requiredNumPeople: 1,
      date: "ALL",
      weight: -1,
    },
  ];
  return fixtureRosterDocument({ document: doc });
}

/**
 * A satisfiable requirement on every day, beside an unresolvable one scoped to
 * the FIRST date only.
 *
 * The scope is the whole point: the malformed rule governs 2026-07-03 and no
 * other date, so only that date may fail closed. Days 1 and 3 satisfy `D = 1`
 * and must stay healthy; day 2 has nobody on `D` and is genuinely short, which
 * keeps the mismatch branch live in the same document.
 */
async function makeScopedUnavailableDocument(): Promise<RosterDocument> {
  const doc = fixtureCanonicalDocument();
  doc.preferences = [
    { type: PREFERENCE_TYPE.maxOneShiftPerDay },
    {
      type: PREFERENCE_TYPE.shiftTypeRequirement,
      shiftType: "D",
      requiredNumPeople: 1,
      date: "ALL",
      weight: -1,
    },
    {
      type: PREFERENCE_TYPE.shiftTypeRequirement,
      shiftType: "NoSuchShift",
      requiredNumPeople: 1,
      date: "2026-07-03",
      weight: -1,
    },
  ];
  return fixtureRosterDocument({ document: doc });
}

/**
 * A document over a DIFFERENT four-day span. Equal length is the point: the old
 * carry-over bug was invisible to a length clamp, so only a same-length swap
 * with different dates can expose it.
 */
async function makeDocumentOverRange(startDate: string, endDate: string): Promise<RosterDocument> {
  const dates = expandDates(startDate, endDate);
  const holiday = dates[dates.length - 1];

  const doc = fixtureCanonicalDocument();
  doc.dates = { range: { startDate, endDate }, groups: [{ id: "PH", members: [holiday] }] };

  // The container carries its own date axis, and assembly rejects any divergence
  // from the submission — so both sides must move together. The solved grid and
  // coordinate map are sliced to match, since a shorter span has fewer columns.
  const base = fixtureContainer();
  const container = {
    ...base,
    dates: dates.map((iso) => ({ iso })),
    solvedDays: base.solvedDays.map((row) => row.slice(0, dates.length)),
    coordinateMap: {
      ...base.coordinateMap,
      dateColumns: base.coordinateMap.dateColumns.slice(0, dates.length),
    },
  };

  return fixtureRosterDocument({ document: doc, container });
}

/** Inclusive ISO date expansion, matching how the product expands a range. */
function expandDates(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${endDate}T00:00:00Z`);
  for (let t = Date.parse(`${startDate}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// This repo's vitest runs with `globals: false`, so RTL's auto-cleanup never
// registers. Every component suite here unmounts explicitly; without this a
// second `render` leaves the first tree mounted and `getByTestId` finds two.
afterEach(() => {
  cleanup();
  observerCallbacks.clear();
  vi.restoreAllMocks();
  // The viewer now PERSISTS its lens and focused day across reloads. Without
  // this reset one test's lens choice becomes the next test's restored default,
  // which silently breaks every "opens on X by default" assertion.
  window.localStorage.clear();
});

describe("RosterViewer", () => {
  beforeEach(() => {
    // jsdom has no ResizeObserver; polyfill so the container-width hook works.
    installResizeObserver();
    // jsdom layout: getBoundingClientRect returns 0s by default.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1200,
      height: 600,
      top: 0,
      left: 0,
      bottom: 600,
      right: 1200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });

  it("renders the Grid lens by default on a wide viewport", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    expect(screen.getByTestId("roster-grid")).toBeDefined();
    expect(screen.queryByTestId("roster-coverage-wide")).toBeNull();
    expect(screen.queryByTestId("roster-day")).toBeNull();
  });

  it("renders the lens toggle with Grid, Coverage, and Day options", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    expect(screen.getByTestId("roster-lens-grid")).toBeDefined();
    expect(screen.getByTestId("roster-lens-coverage")).toBeDefined();
    expect(screen.getByTestId("roster-lens-day")).toBeDefined();
  });

  it("switches to the Coverage lens on click", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    expect(screen.getByTestId("roster-coverage-wide")).toBeDefined();
    expect(screen.queryByTestId("roster-grid")).toBeNull();
  });

  it("switches to the Day lens on click", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    expect(screen.getByTestId("roster-day")).toBeDefined();
  });

  it("renders the provenance banner with solver status 'as solved'", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const banner = screen.getByTestId("roster-provenance");
    expect(banner.textContent).toContain("OPTIMAL");
    expect(banner.textContent).toContain("as solved");
  });

  it("shows 'edited since solve' when the document has edits", async () => {
    const base = await makeDocument();
    const D: RosterDayState = { kind: "shift", shiftId: "D" };
    const document: RosterDocument = {
      ...base,
      solvedDays: base.solvedDays,
      edits: [{ personIdx: 0, dateIdx: 0, day: D }],
    };
    render(<Viewer document={document} />);
    expect(screen.getByTestId("roster-provenance").textContent).toContain("edited since solve");
  });

  it("does NOT show 'edited since solve' when there are no edits", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    expect(screen.getByTestId("roster-provenance").textContent).not.toContain("edited since solve");
  });
});

// ---------------------------------------------------------------------------
// Grid geometry (DESIGN.md §5 load-bearing rules)
// ---------------------------------------------------------------------------

describe("RosterGrid geometry", () => {
  beforeEach(() => {
    installResizeObserver();
  });

  it("the roster card owns overflow:auto and max-height:66vh", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    expect(grid.className).toContain("overflow-auto");
    expect(grid.style.maxHeight).toBe("66vh");
  });

  it("the corner header has the highest z-index (5)", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    const corner = grid.querySelector("th");
    expect(corner?.className).toContain("z-[5]");
  });

  it("date headers have z-index 3", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    const headers = grid.querySelectorAll("thead th");
    // The corner is headers[0] (z:5); date headers follow at z:3.
    expect(headers.length).toBeGreaterThan(1);
    expect(headers[1].className).toContain("z-[3]");
  });

  it("body first column cells have z-index 2", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    // The person cell is a row header (`<th scope="row">`), not a data cell.
    const firstBodyCell = grid.querySelector("tbody th");
    expect(firstBodyCell?.getAttribute("scope")).toBe("row");
    expect(firstBodyCell?.className).toContain("z-[2]");
  });

  it("header cells carry a 2px bottom border", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    const corner = grid.querySelector("th");
    expect(corner?.className).toContain("border-b-[2px]");
  });

  it("keeps ordinary sticky date headers opaque while body cells stay transparent", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    const dateHeader = grid.querySelector("thead th:nth-child(2)");
    const bodyCell = grid.querySelector("tbody tr td:nth-child(2)");
    expect(dateHeader?.className).toContain("bg-surface");
    expect(dateHeader?.className).not.toContain("bg-transparent");
    expect(bodyCell?.className).toContain("bg-transparent");
  });
});

// ---------------------------------------------------------------------------
// Coverage lens
// ---------------------------------------------------------------------------

describe("RosterCoverage", () => {
  beforeEach(() => {
    installResizeObserver();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1200,
      height: 600,
      top: 0,
      left: 0,
      bottom: 600,
      right: 1200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });

  it("renders the wide layout above the stacking threshold", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    expect(screen.getByTestId("roster-coverage-wide")).toBeDefined();
    expect(screen.queryByTestId("roster-coverage-stacked")).toBeNull();
  });

  it("renders BOTH planes: declared requirements, then de-duplicated exact shifts", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    expect(screen.getByTestId("roster-coverage-declared")).toBeDefined();
    expect(screen.getByTestId("roster-coverage-exact")).toBeDefined();
    // Every concrete shift appears exactly once in the Exact shifts plane, even
    // though a shift may feed several declared equations.
    const rows = [...screen.getAllByTestId("roster-exact-shift-row")].map((row) =>
      row.getAttribute("data-shift"),
    );
    expect(rows).toEqual(["D", "N"]);
  });

  it("names every assigned person by their FULL authored id, never initials", async () => {
    // `Alice Ng` and `7` are the de-anonymized fixture ids; initials would
    // collapse them and, on the Ward, collide outright.
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    const people = [...screen.getAllByTestId("roster-coverage-person")].map((chip) =>
      chip.getAttribute("data-person"),
    );
    expect(people).toContain("Alice Ng");
    expect(people).toContain("7");
    for (const chip of screen.getAllByTestId("roster-coverage-person")) {
      expect(chip.textContent).toBe(chip.getAttribute("data-person"));
    }
  });

  it("NEGATIVE CONTROL: an exact lane with no declared target shows a count and no quota", async () => {
    // The fixture declares a requirement for `D` only. `N` is worked but has no
    // target, so it must state its headcount and never a `/required` or Short.
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    const nLane = [...screen.getAllByTestId("roster-exact-shift-row")].find(
      (row) => row.getAttribute("data-shift") === "N",
    );
    expect(nLane).toBeDefined();
    expect(nLane?.textContent).not.toContain("/");
    expect(nLane?.textContent).not.toContain("Short");
    expect(nLane?.querySelector('[data-short="true"]')).toBeNull();
  });

  it("shows 'Short' when staffed is below required", async () => {
    // The fixture's D has required:1. The solved grid has D on day 0 for person 0
    // only, so it's staffed. Let me check: day 0 has D for P1 and N for P2.
    // So D day 0 = 1 staffed vs required 1 = not short. Day 1: P1 OFF, P2 D → 1/1.
    // Day 2: P1 N, P2 OFF → D staffed 0, short! Day 3: P1 LEAVE, P2 D → 1/1.
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    const wide = screen.getByTestId("roster-coverage-wide");
    // Day 2 (dateIdx 2) should have a Short cell for D.
    expect(wide.textContent).toContain("Short");
  });
});

// ---------------------------------------------------------------------------
// Day lens
// ---------------------------------------------------------------------------

describe("RosterDay", () => {
  beforeEach(() => {
    installResizeObserver();
  });

  it("renders a date strip with health dots", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    const day = screen.getByTestId("roster-day");
    const tabs = day.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(document.context.calendar.length);
  });

  it("shows off/leave list at the bottom", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    const day = screen.getByTestId("roster-day");
    expect(day.textContent).toContain("Off / leave");
  });
});

// ---------------------------------------------------------------------------
// Shift chip (DESIGN.md §5: 34×28, borderless)
// ---------------------------------------------------------------------------

describe("ShiftChip", () => {
  it("a worked shift renders a min-34×28 chip with the ramp fill colour", () => {
    const shift: RosterDayState = { kind: "shift", shiftId: "D" };
    const ramp = new Map([["s:D", SHIFT_RAMP[0]]]);
    const { container } = render(<ShiftChip day={shift} ramp={ramp.get("s:D") ?? null} />);
    const chip = container.querySelector("span");
    expect(chip).not.toBeNull();
    expect(chip?.style.minWidth).toBe("34px");
    expect(chip?.style.height).toBe("28px");
    expect(chip?.style.backgroundColor).toBe(normaliseColour(SHIFT_RAMP[0].fill));
    // No border on a worked chip (DESIGN.md §5: "no border").
    expect(chip?.style.border).toBe("");
  });

  // G8: Ward 8's `long`, `long+`, `night` and `night+` ran glyph-to-edge inside
  // the colour box. The MEASURED fit and separation claims need a layout engine
  // and live in e2e/roster-viewer.spec.ts; what jsdom pins is the geometry
  // contract those measurements depend on.
  it("gives every chip variant a 6px inline inset inside a border-box 34-minimum", () => {
    const cases: Array<{ day: RosterDayState; ramp: (typeof SHIFT_RAMP)[number] | null }> = [
      { day: { kind: "shift", shiftId: "night+" }, ramp: SHIFT_RAMP[0] },
      { day: { kind: "leave" }, ramp: null },
      { day: { kind: "off" }, ramp: null },
    ];
    for (const { day, ramp } of cases) {
      const { container, unmount } = render(<ShiftChip day={day} ramp={ramp} />);
      const chip = container.querySelector("span");
      expect(chip?.style.paddingInline).toBe("6px");
      // Border-box is what keeps the inset INSIDE the 34px minimum, so a short
      // id still measures 34 rather than 46 and 28 columns do not all widen.
      expect(chip?.style.boxSizing).toBe("border-box");
      expect(chip?.style.minWidth).toBe("34px");
      expect(chip?.style.height).toBe("28px");
      // A MINIMUM, never a fixed width: a long authored label must be free to
      // grow to its own content rather than clip.
      expect(chip?.style.width).toBe("");
      unmount();
    }
  });

  it("leave is neutral (no brand tint/border)", () => {
    const leave: RosterDayState = { kind: "leave" };
    const { container } = render(<ShiftChip day={leave} ramp={null} />);
    const chip = container.querySelector("span");
    expect(chip).not.toBeNull();
    expect(chip?.className).toContain("bg-panel");
    expect(chip?.className).not.toContain("brandtint");
    expect(chip?.className).not.toContain("brand");
  });

  it("rest is a bare dot at the same box size", () => {
    const off: RosterDayState = { kind: "off" };
    const { container } = render(<ShiftChip day={off} ramp={null} />);
    const chip = container.querySelector("span");
    expect(chip).not.toBeNull();
    expect(chip?.style.minWidth).toBe("34px");
    expect(chip?.style.height).toBe("28px");
    expect(chip?.textContent).toBe("·");
  });
});

// ---------------------------------------------------------------------------
// Container-width hook
// ---------------------------------------------------------------------------

describe("useContainerWidth", () => {
  beforeEach(() => {
    installResizeObserver();
  });

  it("pins the stacking threshold at 760px", () => {
    expect(COVERAGE_STACK_THRESHOLD).toBe(760);
  });

  // THE DISCRIMINATING CLAIM. A viewport media query would render the wide
  // layout here, because the viewport is 1400px. Only a container observer
  // stacks. This is what makes a future docked assistant — which narrows the
  // roster while the window stays wide — lay out correctly.
  it("stacks Coverage on a NARROW CONTAINER inside a WIDE viewport", async () => {
    setViewportWidth(1400);
    mockContainerWidth(600);
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    expect(screen.getByTestId("roster-coverage-stacked")).toBeDefined();
    expect(screen.queryByTestId("roster-coverage-wide")).toBeNull();
  });

  it("keeps Coverage wide on a WIDE CONTAINER inside a NARROW viewport", async () => {
    setViewportWidth(500);
    mockContainerWidth(1100);
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    expect(screen.getByTestId("roster-coverage-wide")).toBeDefined();
    expect(screen.queryByTestId("roster-coverage-stacked")).toBeNull();
  });

  it("re-stacks live when the container shrinks past the threshold", async () => {
    setViewportWidth(1400);
    mockContainerWidth(1100);
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    expect(screen.getByTestId("roster-coverage-wide")).toBeDefined();

    // The docked-assistant case: the container narrows, the viewport does not.
    act(() => {
      resizeObservedElements(600);
    });
    expect(screen.getByTestId("roster-coverage-stacked")).toBeDefined();
    expect(screen.queryByTestId("roster-coverage-wide")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mobile default lens (ticket: "mobile defaults to Day")
// ---------------------------------------------------------------------------

describe("mobile default lens", () => {
  beforeEach(() => {
    installResizeObserver();
  });

  it("opens on the Day lens below the mobile viewport threshold", async () => {
    setViewportWidth(MOBILE_DEFAULT_LENS_VIEWPORT - 1);
    mockContainerWidth(370);
    const document = await makeDocument();
    render(<Viewer document={document} />);
    expect(screen.getByTestId("roster-day")).toBeDefined();
    expect(screen.queryByTestId("roster-grid")).toBeNull();
  });

  it("opens on the Grid lens at exactly the threshold and above", async () => {
    setViewportWidth(MOBILE_DEFAULT_LENS_VIEWPORT);
    mockContainerWidth(1200);
    const document = await makeDocument();
    render(<Viewer document={document} />);
    expect(screen.getByTestId("roster-grid")).toBeDefined();
    expect(screen.queryByTestId("roster-day")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Accessibility and keyboard
// ---------------------------------------------------------------------------

describe("accessibility", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(1400);
    mockContainerWidth(1200);
  });

  it("the lens toggle is a labelled group of real buttons with pressed state", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const toggle = screen.getByTestId("roster-lens-toggle");
    expect(toggle.getAttribute("aria-label")).toBe("Roster lens");
    const grid = screen.getByTestId("roster-lens-grid");
    expect(grid.tagName).toBe("BUTTON");
    expect(grid.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("roster-lens-day").getAttribute("aria-pressed")).toBe("false");
  });

  it("the lens toggle updates aria-pressed when the lens changes", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    expect(screen.getByTestId("roster-lens-day").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("roster-lens-grid").getAttribute("aria-pressed")).toBe("false");
  });

  it("the Day lens date strip is a keyboard-reachable tablist", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    const day = screen.getByTestId("roster-day");
    const tabs = day.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(document.context.calendar.length);
    // Exactly one selected, and every tab is a focusable button.
    const selected = day.querySelectorAll('[role="tab"][aria-selected="true"]');
    expect(selected.length).toBe(1);
    for (const tab of tabs) expect(tab.tagName).toBe("BUTTON");
  });

  it("selecting a different day moves the selected tab", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    const day = screen.getByTestId("roster-day");
    const tabs = [...day.querySelectorAll('[role="tab"]')];
    expect(tabs.length).toBeGreaterThan(1);
    fireEvent.click(tabs[1]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].getAttribute("aria-selected")).toBe("false");
  });

  it("the Grid lens is a real table with a row header per person", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    expect(grid.querySelector("table")).not.toBeNull();
    expect(grid.querySelectorAll("tbody tr").length).toBe(document.context.people.length);
    // Every person row is NAMED by a row header, so a screen reader can announce
    // "<person>, <date>" for a cell instead of a bare chip.
    const rowHeaders = grid.querySelectorAll('tbody th[scope="row"]');
    expect(rowHeaders.length).toBe(document.context.people.length);
  });

  it("decorative ramp swatches are hidden from assistive tech", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    const wide = screen.getByTestId("roster-coverage-wide");
    // Every pure-colour swatch carries aria-hidden; none is an unlabelled
    // element announcing nothing.
    const swatches = wide.querySelectorAll("span.size-2\\.5");
    expect(swatches.length).toBeGreaterThan(0);
    for (const swatch of swatches) expect(swatch.getAttribute("aria-hidden")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// No page-level horizontal overflow (the Grid scrolls inside its OWN card)
// ---------------------------------------------------------------------------

describe("page overflow containment", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(390);
    mockContainerWidth(370);
  });

  it("the Grid card owns the scroll; no ancestor inside the viewer scrolls", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("grid");
    const viewer = screen.getByTestId("roster-viewer");
    const grid = screen.getByTestId("roster-grid");
    expect(grid.className).toContain("overflow-auto");
    // Walk from the grid up to the viewer root: no intermediate scroller.
    let node = grid.parentElement;
    while (node !== null && node !== viewer) {
      expect(node.className).not.toContain("overflow-auto");
      expect(node.className).not.toContain("overflow-x-auto");
      node = node.parentElement;
    }
  });

  it("Coverage stacks on a phone instead of scrolling horizontally", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    const stacked = screen.getByTestId("roster-coverage-stacked");
    expect(stacked.className).not.toContain("overflow");
    expect(screen.queryByTestId("roster-coverage-wide")).toBeNull();
  });

  it("the header controls wrap rather than forcing a wider row", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const toggle = screen.getByTestId("roster-lens-toggle");
    // G8: the lens toggle's parent is now the atomic Undo+lens control GROUP;
    // the WRAPPING row is that group's parent.
    const group = toggle.parentElement;
    expect(group?.dataset.testid ?? group?.getAttribute("data-testid")).toBe(
      "roster-control-group",
    );
    expect(group?.parentElement?.className).toContain("flex-wrap");
  });
});

// ---------------------------------------------------------------------------
// Undo + lens as ONE aligned control group (G8)
//
// The MEASURED alignment claim (equal heights, equal centres, stable wrapping at
// 759/820) can only be made in a browser and lives in e2e/roster-viewer.spec.ts.
// What jsdom can prove is the STRUCTURE that alignment depends on: one atomic
// flex parent, stretch alignment, `shrink-0` so the pair wraps together, and an
// Undo that no longer pins its own fixed height.
// ---------------------------------------------------------------------------

describe("Undo + lens control group", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(1400);
    mockContainerWidth(1200);
  });

  it("wraps Undo and the lens selector in one shrink-0 stretch group", async () => {
    const document = await makeDocument();
    render(
      <Viewer
        document={document}
        editing={{
          selectedCell: null,
          selectCell: () => {},
          setCell: () => {},
          swapCells: () => {},
          undo: () => {},
          canUndo: true,
        }}
      />,
    );
    const group = screen.getByTestId("roster-control-group");
    expect(group.className).toContain("items-stretch");
    // `shrink-0` is what makes the parent wrap the PAIR rather than splitting
    // Undo onto one row and the lens onto the next at 759/820px.
    expect(group.className).toContain("shrink-0");
    // Both controls are children of that one group, in reading order.
    expect(group.contains(screen.getByTestId("roster-undo"))).toBe(true);
    expect(group.contains(screen.getByTestId("roster-lens-toggle"))).toBe(true);
  });

  it("lets Undo stretch to the segmented control's height instead of pinning 32px", async () => {
    const document = await makeDocument();
    render(
      <Viewer
        document={document}
        editing={{
          selectedCell: null,
          selectCell: () => {},
          setCell: () => {},
          swapCells: () => {},
          undo: () => {},
          canUndo: true,
        }}
      />,
    );
    const undo = screen.getByTestId("roster-undo");
    // `h-auto` MERGED AWAY the size="sm" `h-control-sm`; if tailwind-merge ever
    // stopped classifying the custom control token both would survive and the
    // emitted CSS order would silently decide, which is the exact trap
    // lib/utils.ts registers against.
    expect(undo.className).toContain("h-auto");
    expect(undo.className).not.toContain("h-control-sm");
    // The coarse-pointer floor is NOT mergeable away by a height override.
    expect(undo.className).toContain("pointer-coarse:min-h-touch");
  });

  it("keeps Undo's disabled semantics unchanged", async () => {
    const document = await makeDocument();
    render(
      <Viewer
        document={document}
        editing={{
          selectedCell: null,
          selectCell: () => {},
          setCell: () => {},
          swapCells: () => {},
          undo: () => {},
          canUndo: false,
        }}
      />,
    );
    const undo = screen.getByTestId("roster-undo");
    expect(undo).toBeDisabled();
    expect(undo).toHaveAttribute("title", "Nothing to undo");
  });
});

// ---------------------------------------------------------------------------
// Lens / focused-day persistence across reload (Core Flows)
// ---------------------------------------------------------------------------

describe("view persistence", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(1400);
    mockContainerWidth(1200);
  });

  // THE DEFECT THIS REPLACES. Lens and focused day lived only in `useState`, so
  // a reload always snapped back to Grid and today — discarding the view the user
  // had deliberately set up. Unmount/remount is the in-process equivalent of the
  // reload: a brand-new component instance reading the same storage.
  it("restores the lens chosen before a remount", async () => {
    const document = await makeDocument();
    const first = render(<Viewer document={document} />);
    selectLens("coverage");
    expect(screen.getByTestId("roster-coverage-wide")).toBeDefined();
    first.unmount();

    render(<Viewer document={document} />);
    expect(screen.getByTestId("roster-coverage-wide")).toBeDefined();
    expect(screen.queryByTestId("roster-grid")).toBeNull();
  });

  it("restores the focused day chosen before a remount", async () => {
    const document = await makeDocument();
    const first = render(<Viewer document={document} />);
    selectLens("day");
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    expect(tabs.length).toBeGreaterThan(1);
    fireEvent.click(tabs[tabs.length - 1]);
    expect(tabs[tabs.length - 1].getAttribute("aria-selected")).toBe("true");
    first.unmount();

    render(<Viewer document={document} />);
    const restored = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    expect(restored[restored.length - 1].getAttribute("aria-selected")).toBe("true");
  });

  // THE RANGE CHECK. The focused day is persisted as an ISO DATE, so restoring
  // it against a SHORTER roster asks a meaningful question. A stored index would
  // have silently landed on whatever day now occupies that slot.
  it("discards a restored day that this roster does not contain", async () => {
    window.localStorage.setItem(
      ROSTER_VIEW_PREFERENCE_KEY,
      JSON.stringify({ lens: "day", focusedIso: "1999-01-01" }),
    );
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    // Falls back to today / first day rather than a stale or out-of-range index.
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  });

  // ---------------------------------------------------------------------------
  // In-place roster replacement (React preserves state at the same position)
  // ---------------------------------------------------------------------------

  // THE DEFECT THIS REPLACES. `focusedDay` is an INDEX. Rerendering the same
  // mounted viewer with a different roster kept that index, so the user was
  // silently moved to whatever date now occupied the slot — and the persistence
  // effect then wrote that unrelated date as though they had chosen it. A length
  // clamp could not see this: the calendars are the same length.
  it("re-resolves the focused DATE when a different roster replaces it in place", async () => {
    const first = await makeDocument(); // 2026-07-03 .. 2026-07-06
    const view = render(<Viewer document={first} />);
    selectLens("day");

    // Focus the third day: 2026-07-05.
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    fireEvent.click(tabs[2]);
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");

    // A different roster whose span still CONTAINS 2026-07-05, at a different index.
    const overlapping = await makeDocumentOverRange("2026-07-05", "2026-07-08");
    view.rerender(<Viewer document={overlapping} />);

    const after = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    // Date identity is preserved: 2026-07-05 is now index 0, not index 2.
    expect(after[0].getAttribute("aria-selected")).toBe("true");
    expect(after[2].getAttribute("aria-selected")).toBe("false");
    // And the persisted value follows the date, not the slot.
    expect(
      JSON.parse(window.localStorage.getItem(ROSTER_VIEW_PREFERENCE_KEY) ?? "{}"),
    ).toMatchObject({ focusedIso: "2026-07-05" });
  });

  it("falls back to the documented default when the focused date is absent", async () => {
    const first = await makeDocument();
    const view = render(<Viewer document={first} />);
    selectLens("day");
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    fireEvent.click(tabs[2]);
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");

    // An equal-length span sharing NO dates with the first.
    const disjoint = await makeDocumentOverRange("2026-09-10", "2026-09-13");
    view.rerender(<Viewer document={disjoint} />);

    const after = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    // The fallback (today is outside this span, so the first day), NOT index 2.
    expect(after[0].getAttribute("aria-selected")).toBe("true");
    expect(after[2].getAttribute("aria-selected")).toBe("false");
    expect(
      JSON.parse(window.localStorage.getItem(ROSTER_VIEW_PREFERENCE_KEY) ?? "{}"),
    ).toMatchObject({ focusedIso: "2026-09-10" });
  });

  it("still clamps when the replacement roster is shorter", async () => {
    const first = await makeDocument();
    const view = render(<Viewer document={first} />);
    selectLens("day");
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    fireEvent.click(tabs[3]);

    const shorter = await makeDocumentOverRange("2026-10-01", "2026-10-02");
    view.rerender(<Viewer document={shorter} />);

    const after = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    expect(after.length).toBe(2);
    expect(after[0].getAttribute("aria-selected")).toBe("true");
  });

  it("ignores a stored lens this build does not render", async () => {
    window.localStorage.setItem(
      ROSTER_VIEW_PREFERENCE_KEY,
      JSON.stringify({ lens: "timeline", focusedIso: null }),
    );
    const document = await makeDocument();
    render(<Viewer document={document} />);
    expect(screen.getByTestId("roster-grid")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Coverage evidence semantics — unknown is never success
// ---------------------------------------------------------------------------

describe("coverage summary honesty", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(1400);
    mockContainerWidth(1200);
  });

  it("states the claim against DECLARED requirements, not against exact-shift lanes", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const summary = screen.getByTestId("roster-coverage-summary").textContent ?? "";
    // The fixture's `D` requirement is unmet on at least one day, so the
    // summary must not read as an all-clear.
    expect(summary).toContain("not met");
    expect(summary).not.toContain("All requirements met");
  });

  // THE DEFECT THIS REPLACES. With NO checkable equation the old summary computed
  // `underMinimum === 0` and rendered "All shifts staffed" — an all-clear over a
  // roster nothing had verified.
  it("never claims staffing when nothing is checkable", async () => {
    const document = await makeDocument({ unavailableShift: true });
    render(<Viewer document={document} />);
    const summary = screen.getByTestId("roster-coverage-summary").textContent ?? "";
    expect(summary).toBe("Coverage unavailable");
  });

  it("paints no healthy day dot when nothing on the day is checkable", async () => {
    const document = await makeDocument({ unavailableShift: true });
    render(<Viewer document={document} />);
    selectLens("day");
    const dots = screen.getByTestId("roster-day").querySelectorAll("[data-health]");
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) {
      expect(dot.getAttribute("data-health")).toBe("unknown");
      // The success colour is the specific thing that must not appear.
      expect(dot.className).not.toContain("bg-success");
    }
  });
});

// ---------------------------------------------------------------------------
// Tab keyboard model and non-colour status (DESIGN.md)
// ---------------------------------------------------------------------------

describe("day strip keyboard model", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(1400);
    mockContainerWidth(1200);
  });

  function dayTabs(): HTMLElement[] {
    return [...screen.getByTestId("roster-day").querySelectorAll<HTMLElement>('[role="tab"]')];
  }

  // THE DEFECT THIS REPLACES. The strip declared `role="tablist"` while behaving
  // like a row of independent buttons: every date was its own tab stop and no
  // arrow key did anything. A declared role the widget does not honour misleads
  // exactly the users who depend on it.
  it("is ONE tab stop — only the selected tab is reachable by Tab", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    const tabs = dayTabs();
    const reachable = tabs.filter((tab) => tab.tabIndex === 0);
    expect(reachable.length).toBe(1);
    expect(reachable[0].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowRight and ArrowLeft move the selection and wrap", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    const strip = screen.getByRole("tablist");
    const last = dayTabs().length - 1;

    fireEvent.keyDown(strip, { key: "ArrowRight" });
    expect(dayTabs()[1].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(strip, { key: "ArrowLeft" });
    expect(dayTabs()[0].getAttribute("aria-selected")).toBe("true");

    // Wrapping backwards from the first lands on the last.
    fireEvent.keyDown(strip, { key: "ArrowLeft" });
    expect(dayTabs()[last].getAttribute("aria-selected")).toBe("true");
  });

  it("Home and End jump to the first and last day", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    const strip = screen.getByRole("tablist");
    const last = dayTabs().length - 1;

    fireEvent.keyDown(strip, { key: "End" });
    expect(dayTabs()[last].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(strip, { key: "Home" });
    expect(dayTabs()[0].getAttribute("aria-selected")).toBe("true");
  });

  it("leaves unrelated keys alone", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    const strip = screen.getByRole("tablist");
    fireEvent.keyDown(strip, { key: "a" });
    expect(dayTabs()[0].getAttribute("aria-selected")).toBe("true");
  });

  it("carries each day's coverage state in its accessible name, not only its dot colour", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    for (const tab of dayTabs()) {
      const name = tab.getAttribute("aria-label") ?? "";
      expect(name).toMatch(/staffed|requirement not met|at the stated minimum|not fully checkable/);
    }
  });
});

describe("grid short cells carry a textual state", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(1400);
    mockContainerWidth(1200);
  });

  // Colour-only status fails DESIGN.md and anyone who cannot see the red fill.
  // The digit itself is identical in both states, so the name is the only
  // difference available to a screen reader.
  it("names the staffed count on every footer cell, and the target only where one is declared", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    const cells = grid.querySelectorAll("tfoot td[data-short]");
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      const label = cell.getAttribute("aria-label") ?? "";
      expect(label).toMatch(
        /^(Short: staffed \d+, required \d+|Staffed \d+, required \d+|Staffed \d+, no target declared for this shift)$/,
      );
      // The title carries the same text, so a mouse user gets it too.
      expect(cell.getAttribute("title")).toBe(label);
    }
    // The `N` lane has no declared target and must say so rather than borrowing
    // one from the `D` requirement.
    const labels = [...cells].map((cell) => cell.getAttribute("aria-label") ?? "");
    expect(labels.some((label) => label.includes("no target declared"))).toBe(true);
  });

  it("marks a short cell as Short in text, not only in colour", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    const short = grid.querySelector('tfoot td[data-short="true"]');
    expect(short).not.toBeNull();
    expect(short?.getAttribute("aria-label")).toMatch(/^Short: staffed/);
  });
});

// ---------------------------------------------------------------------------
// Neutral / square data surfaces (DESIGN.md)
// ---------------------------------------------------------------------------

describe("data surface styling rules", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(1400);
    mockContainerWidth(1200);
  });

  // Brand tint is the system's SELECTION language. Spending it on a leave marker
  // both misreads as selected and contradicts the neutral-leave rule the
  // ShiftChip already follows — the Day lens was the one place it survived.
  it("renders Day-lens Leave neutrally, with no brand treatment", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    // The fixture's Leave falls on the last day, so walk the strip to it rather
    // than asserting against a day that has none.
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "End" });
    const day = screen.getByTestId("roster-day");
    const leaveChips = [...day.querySelectorAll("span")].filter((node) =>
      (node.textContent ?? "").includes("· Leave"),
    );
    expect(leaveChips.length).toBeGreaterThan(0);
    for (const chip of leaveChips) {
      expect(chip.className).not.toContain("brandtint");
      expect(chip.className).not.toContain("brandink");
      expect(chip.className).toContain("bg-panel");
    }
  });

  it("keeps Coverage data cells square", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    const wide = screen.getByTestId("roster-coverage-wide");
    const cells = wide.querySelectorAll('[class*="min-h-\\[72px\\]"]');
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.className).not.toContain("rounded-chip");
      expect(cell.className).not.toContain("rounded-card");
    }
  });
});

// ---------------------------------------------------------------------------
// Forbidden copy — the settled non-technical surface (F2 decision)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Grid toolbar — the prototype's missing key (G7)
// ---------------------------------------------------------------------------

describe("Grid toolbar", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(1400);
    mockContainerWidth(1200);
  });

  it("shows the roster span as a small label, not a second display heading", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const span = screen.getByTestId("roster-grid-span");
    expect(span.textContent).toBe("2026-07-03 → 2026-07-06");
    // The route owns the only page heading; the toolbar must not add another.
    const viewer = screen.getByTestId("roster-viewer");
    expect(viewer.querySelectorAll("h1, h2").length).toBe(0);
  });

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

  it("NEVER makes the legend a second horizontal scroller, at either width", async () => {
    // G8 replaces the internally scrolling strip. The strip hid more than half
    // the key even at 1440px, was reported by Axe as a keyboard-inaccessible
    // scroll region, and on the user's platform the native scrollbar overlaid
    // and clipped the labels. Both layouts below wrap; neither scrolls.
    const document = await makeDocument();
    const view = render(<Viewer document={document} />);

    const wide = screen.getByTestId("roster-grid-legend");
    expect(wide.className).toContain("flex-wrap");
    expect(wide.className).not.toContain("overflow-x-auto");
    expect(wide.className).not.toContain("overflow-x-scroll");
    // `min-w-0` stays load-bearing: without it a non-wrapping row inside a
    // default `min-width:auto` flex item pushes the DOCUMENT sideways.
    expect(wide.className).toContain("min-w-0");
    // The toolbar is a sibling of the scroller, never inside it.
    expect(screen.getByTestId("roster-grid").contains(wide)).toBe(false);
    view.unmount();

    mockContainerWidth(500);
    render(<Viewer document={document} />);
    const narrow = screen.getByTestId("roster-grid-legend");
    expect(narrow.className).toContain("flex-wrap");
    expect(narrow.className).not.toContain("overflow-x-auto");
    expect(screen.getByTestId("roster-grid").contains(narrow)).toBe(false);
  });

  it("wraps the FULL key inline at or above 900px of roster content", async () => {
    const document = await makeDocument();
    mockContainerWidth(900);
    render(<Viewer document={document} />);
    // No disclosure to open: the whole key is already on the page.
    expect(screen.queryByTestId("roster-grid-legend-disclosure")).toBeNull();
    expect(screen.getByTestId("roster-grid-legend")).toBeVisible();
  });

  it("moves the SAME complete key behind a keyboard-operable Shift key disclosure below 900px", async () => {
    const document = await makeDocument();

    // Measure the wide key first, so the narrow one is compared against the
    // real authored list rather than against a hard-coded count that would
    // drift with the fixture.
    const wideView = render(<Viewer document={document} />);
    const wideItems = screen
      .getAllByTestId("roster-grid-legend-item")
      .map((el) => `${el.getAttribute("data-shift")}|${el.textContent}`);
    expect(wideItems.length).toBeGreaterThan(0);
    wideView.unmount();

    mockContainerWidth(899);
    render(<Viewer document={document} />);

    const disclosure = screen.getByTestId("roster-grid-legend-disclosure");
    expect(disclosure.tagName).toBe("DETAILS");
    const summary = screen.getByTestId("roster-grid-legend-summary");
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.textContent).toContain("Shift key");

    // The panel holds the IDENTICAL list — same ids, same time ranges, same
    // Leave and Off/rest, in the same order. A shortened or regrouped narrow
    // key is the failure this whole change exists to prevent.
    const narrowItems = screen
      .getAllByTestId("roster-grid-legend-item")
      .map((el) => `${el.getAttribute("data-shift")}|${el.textContent}`);
    expect(narrowItems).toEqual(wideItems);
    expect(narrowItems.some((entry) => entry.startsWith("LV|"))).toBe(true);
    expect(narrowItems.some((entry) => entry.startsWith("OFF|"))).toBe(true);
  });

  it("switches back to the inline key when the container grows past 900px", async () => {
    const document = await makeDocument();
    mockContainerWidth(500);
    render(<Viewer document={document} />);
    expect(screen.getByTestId("roster-grid-legend-disclosure")).toBeTruthy();

    // A real resize, through the same observer production uses.
    act(() => resizeObservedElements(1100));
    expect(screen.queryByTestId("roster-grid-legend-disclosure")).toBeNull();
    expect(screen.getByTestId("roster-grid-legend")).toBeVisible();
  });

  it("shows device-neutral editing guidance only while editing is available", async () => {
    const document = await makeDocument();
    const view = render(<Viewer document={document} />);
    expect(screen.queryByTestId("roster-grid-guidance")).toBeNull();
    view.unmount();

    render(
      <Viewer
        document={document}
        editing={{
          selectedCell: null,
          selectCell: () => {},
          setCell: () => {},
          swapCells: () => {},
          undo: () => {},
          canUndo: false,
        }}
      />,
    );
    expect(screen.getByTestId("roster-grid-guidance").textContent).toBe(
      "Select a cell to change · drag to swap",
    );
  });

  it("marks a holiday header with a marker AND a complete accessible date label", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    const markers = grid.querySelectorAll('[data-testid="roster-grid-holiday"]');
    // The fixture names exactly one public holiday.
    expect(markers.length).toBe(1);
    const header = markers[0].closest("th");
    expect(header?.getAttribute("title")).toBe("2026-07-06 · Mon · Public holiday");
    // The marker supplements text; it is never the only signal.
    expect(header?.textContent).toContain("Public holiday");
  });
});

describe("weekend rest tally", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(1400);
    mockContainerWidth(1200);
  });

  it("counts weekend OFF days per nurse", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    const cells = [...screen.getAllByTestId("roster-weekend-rest")];
    expect(cells.length).toBe(document.context.people.length);
    // The fixture's weekend is 2026-07-04 (Sat) / 07-05 (Sun). P1 is OFF on the
    // Saturday, P2 on the Sunday.
    expect(cells[0].getAttribute("data-weekend-rest")).toBe("1");
    expect(cells[1].getAttribute("data-weekend-rest")).toBe("1");
    // Informational, not an error verdict: the label says what it counts.
    expect(cells[1].getAttribute("title")).toContain("weekend rest days");
  });

  it("flags a nurse who worked every weekend day, and recomputes live on an edit", async () => {
    const base = await makeDocument();
    // P2's only weekend rest is the Sunday; put them on a shift and they have none.
    const worked: RosterDayState = { kind: "shift", shiftId: "D" };
    const document = { ...base, edits: [{ personIdx: 1, dateIdx: 2, day: worked }] };
    render(<Viewer document={document} />);
    const cells = [...screen.getAllByTestId("roster-weekend-rest")];
    expect(cells[1].getAttribute("data-weekend-rest")).toBe("0");
    expect(cells[1].className).toContain("errortint");
    expect(cells[0].className).not.toContain("errortint");
  });
});

// ---------------------------------------------------------------------------
// Anti-inference — a group or qualified target never migrates onto an exact lane
// ---------------------------------------------------------------------------

describe("anti-inference", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(1400);
    mockContainerWidth(1200);
  });

  it("lets a GROUP shortage turn a day red while every member panel stays free of an invented minimum", async () => {
    const document = await makeGroupDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    // Day 1 has one worked shift against a group requirement of two.
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    fireEvent.click(tabs[1]);

    const declared = [...screen.getAllByTestId("roster-day-requirement")];
    const group = declared.find((row) => row.getAttribute("data-scope") === "AllShifts");
    expect(group?.getAttribute("data-mismatch")).toBe("true");
    expect(group?.textContent).toContain("Short 1");

    // ...and not one exact-shift panel claims a target or a shortage.
    for (const panel of screen.getAllByTestId("roster-day-shift-panel")) {
      expect(panel.getAttribute("data-short")).toBe("false");
      expect(panel.textContent).not.toContain("Short");
      expect(panel.textContent).not.toContain("min ");
    }
    // The day dot follows the declared equation, not the exact lanes.
    expect(tabs[1].querySelector("[data-health]")?.getAttribute("data-health")).toBe("under");
  });

  it("turns a QUALIFIED row red while the exact-shift panel still visibly names the unqualified assignee", async () => {
    const document = await makeGroupDocument();
    render(<Viewer document={document} />);
    selectLens("day");

    const qualified = [...screen.getAllByTestId("roster-day-requirement")].find(
      (row) => row.getAttribute("data-scope") === "N",
    );
    expect(qualified?.getAttribute("data-mismatch")).toBe("true");
    expect(qualified?.textContent).toContain("Unqualified 1");
    expect(qualified?.textContent).toContain("Short 1");

    // The invalid assignment is SHOWN, not hidden: `7` is the de-anonymized id
    // of the unqualified nurse standing on the senior-only slot.
    const nPanel = [...screen.getAllByTestId("roster-day-shift-panel")].find(
      (panel) => panel.getAttribute("data-shift") === "N",
    );
    expect(nPanel?.querySelector('[data-person="7"]')).not.toBeNull();
    // ...and the panel itself still invents no minimum.
    expect(nPanel?.getAttribute("data-short")).toBe("false");
  });

  it("keeps a group target off the Grid footer lanes", async () => {
    const document = await makeGroupDocument();
    render(<Viewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    for (const cell of grid.querySelectorAll("tfoot td[data-short]")) {
      expect(cell.getAttribute("data-short")).toBe("false");
      expect(cell.getAttribute("aria-label")).toContain("no target declared");
    }
  });
});

// ---------------------------------------------------------------------------
// Day-scoped exact-shift targets (cold-review P1 #1)
// ---------------------------------------------------------------------------

describe("date-scoped exact-shift targets", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(1400);
    mockContainerWidth(1200);
  });

  it("GRID shows the target on the scoped date and omits it on every other date", async () => {
    const document = await makeScopedDocument();
    render(<Viewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    // The `D` lane is the first footer row; its cells are one per calendar day.
    const dRow = grid.querySelectorAll("tfoot tr")[0];
    const cells = [...dRow.querySelectorAll("td[data-short]")];
    expect(cells).toHaveLength(document.context.calendar.length);

    // 2026-07-04 is index 1: one nurse on D against a declared 2.
    expect(cells[1].getAttribute("aria-label")).toBe("Short: staffed 1, required 2");
    expect(cells[1].getAttribute("data-short")).toBe("true");

    // THE ANTI-INFERENCE HALF. No other date inherits that quota, including the
    // one where D is equally staffed.
    for (const dateIdx of [0, 2, 3]) {
      expect(cells[dateIdx].getAttribute("aria-label")).toMatch(/no target declared/);
      expect(cells[dateIdx].getAttribute("data-short")).toBe("false");
    }

    // The LANE label states no `min N`, because the target is not the lane's.
    expect(dRow.querySelector("td")?.textContent).not.toContain("min ");
  });

  it("DAY shows the target on the scoped date and omits it on every other date", async () => {
    const document = await makeScopedDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];

    fireEvent.click(tabs[1]);
    const scoped = [...screen.getAllByTestId("roster-day-shift-panel")].find(
      (panel) => panel.getAttribute("data-shift") === "D",
    );
    expect(scoped?.getAttribute("data-short")).toBe("true");
    expect(scoped?.textContent).toContain("/2");
    expect(scoped?.textContent).toContain("min 2");

    fireEvent.click(tabs[0]);
    const offScope = [...screen.getAllByTestId("roster-day-shift-panel")].find(
      (panel) => panel.getAttribute("data-shift") === "D",
    );
    expect(offScope?.getAttribute("data-short")).toBe("false");
    expect(offScope?.textContent).not.toContain("/2");
    expect(offScope?.textContent).not.toContain("min ");
  });

  it("COVERAGE agrees with Grid and Day about the same scoped cell", async () => {
    const document = await makeScopedDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    const dLane = [...screen.getAllByTestId("roster-exact-shift-row")].find(
      (row) => row.getAttribute("data-shift") === "D",
    );
    const cells = [...(dLane?.querySelectorAll("[data-staffed]") ?? [])];
    expect(cells[1].getAttribute("data-short")).toBe("true");
    expect(cells[1].getAttribute("aria-label")).toContain("of 2 required");
    expect(cells[0].getAttribute("data-short")).toBe("false");
    expect(cells[0].getAttribute("aria-label")).not.toContain("required");
  });
});

// ---------------------------------------------------------------------------
// Day health fails closed on mixed unavailable states (cold-review P1 #2)
// ---------------------------------------------------------------------------

describe("day health with a mix of satisfied and unavailable requirements", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(1400);
    mockContainerWidth(1200);
  });

  it("never paints a healthy dot while an applicable requirement is unavailable", async () => {
    const document = await makeMixedUnavailableDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    expect(tabs).toHaveLength(4);

    const health = tabs.map((tab) =>
      tab.querySelector("[data-health]")?.getAttribute("data-health"),
    );
    // THE DEFECT THIS REPLACES. Days 0, 1 and 3 each satisfy the valid `D = 1`
    // requirement, so the old implementation skipped the unresolvable sibling
    // and painted them `ok` — a green all-clear over a requirement nothing had
    // checked. Day 2 has nobody on `D` at all, so it is genuinely `under`, which
    // keeps the mismatch branch live in the same fixture.
    expect(health).toEqual(["unknown", "unknown", "under", "unknown"]);
    // Not one day may claim health, whichever branch it took.
    for (const tab of tabs) {
      const dot = tab.querySelector("[data-health]");
      expect(dot?.className).not.toContain("bg-success");
      // Colour is not the only carrier: the accessible name says so too, and it
      // must NOT claim the day is staffed.
      expect(tab.getAttribute("aria-label")).not.toContain("staffed");
    }
    for (const dateIdx of [0, 1, 3]) {
      expect(tabs[dateIdx].getAttribute("aria-label")).toContain("not fully checkable");
    }
  });

  it("proves the satisfied half really is satisfied, so the dot is not unknown by accident", async () => {
    const document = await makeMixedUnavailableDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    const rows = [...screen.getAllByTestId("roster-requirement-row")];
    const satisfied = rows.find((row) => row.getAttribute("data-scope") === "D");
    const broken = rows.find((row) => row.getAttribute("data-scope") === "NoSuchShift");

    const satisfiedCell = satisfied?.querySelector("[data-status]");
    expect(satisfiedCell?.getAttribute("data-status")).toBe("checked");
    expect(satisfiedCell?.getAttribute("data-mismatch")).toBe("false");

    const brokenCell = broken?.querySelector("[data-status]");
    expect(brokenCell?.getAttribute("data-status")).toBe("unavailable");
    // The reason is stated in plain language, not left as a blank cell.
    expect(broken?.textContent).toContain("does not resolve in this scenario");
  });

  it("still reports a hard mismatch ahead of an unavailable sibling", async () => {
    // NEGATIVE CONTROL for the fail-closed change: `unknown` must not swallow a
    // genuine shortage, which is the more actionable answer.
    const base = await makeMixedUnavailableDocument();
    // Move P1 off D on day 0 so the satisfied `D = 1` requirement goes short.
    const document = { ...base, edits: [{ personIdx: 0, dateIdx: 0, day: { kind: "off" } }] };
    render(<Viewer document={document as RosterDocument} />);
    selectLens("day");
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    expect(tabs[0].querySelector("[data-health]")?.getAttribute("data-health")).toBe("under");
    expect(tabs[0].getAttribute("aria-label")).toContain("requirement not met");
    // ...while a day without the shortage still fails closed on the unavailable.
    expect(tabs[1].querySelector("[data-health]")?.getAttribute("data-health")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// A scoped unavailable equation stays off the days it does not govern
// (closure re-review P1)
// ---------------------------------------------------------------------------

describe("date-scoped unavailable requirements", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(1400);
    mockContainerWidth(1200);
  });

  it("fails closed ONLY on the date it governs, leaving the other days healthy", async () => {
    const document = await makeScopedUnavailableDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    expect(tabs).toHaveLength(4);

    // THE DEFECT THIS REPLACES. The unresolvable rule is scoped to 2026-07-03
    // alone, but was returned as unavailable before the dates were consulted —
    // so all four days went `unknown`. Day 2 is genuinely short of `D`, which
    // keeps the mismatch branch live rather than testing one state four times.
    const health = tabs.map((tab) =>
      tab.querySelector("[data-health]")?.getAttribute("data-health"),
    );
    expect(health).toEqual(["unknown", "ok", "under", "ok"]);

    expect(tabs[0].getAttribute("aria-label")).toContain("not fully checkable");
    expect(tabs[1].getAttribute("aria-label")).toContain("staffed");
    expect(tabs[1].querySelector("[data-health]")?.className).toContain("bg-success");
  });

  it("renders the unavailable row as NOT APPLICABLE off-scope, with no warning cell", async () => {
    const document = await makeScopedUnavailableDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    const broken = [...screen.getAllByTestId("roster-requirement-row")].find(
      (row) => row.getAttribute("data-scope") === "NoSuchShift",
    );
    const cells = [...(broken?.querySelectorAll("[data-status]") ?? [])];
    expect(cells).toHaveLength(4);

    expect(cells[0].getAttribute("data-status")).toBe("unavailable");
    expect(cells[0].className).toContain("bg-warntint");
    for (const dateIdx of [1, 2, 3]) {
      expect(cells[dateIdx].getAttribute("data-status")).toBe("not-applicable");
      // Off-scope must not carry the warning treatment for a rule that does not
      // apply there. Asserted against the unavailable branch's OWN classes, not
      // the substring `warntint` — the fixture's last day is a public holiday
      // and its stripe legitimately references that token.
      expect(cells[dateIdx].className).not.toContain("bg-warntint");
      expect(cells[dateIdx].className).not.toContain("border-warn");
      expect(cells[dateIdx].textContent).toContain("n/a");
    }

    // The Day lens omits the row entirely on a date it does not govern.
    selectLens("day");
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    fireEvent.click(tabs[1]);
    const scopes = [...screen.getAllByTestId("roster-day-requirement")].map((row) =>
      row.getAttribute("data-scope"),
    );
    expect(scopes).toEqual(["D"]);
  });

  it("NEGATIVE CONTROL: an UNSCOPED unresolved rule still fails closed on every day", async () => {
    // Over-correcting would make every unavailable equation excuse itself. This
    // document's broken rule has no date scope, so it applies everywhere.
    const document = await makeMixedUnavailableDocument();
    render(<Viewer document={document} />);
    selectLens("day");
    const health = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')].map(
      (tab) => tab.querySelector("[data-health]")?.getAttribute("data-health"),
    );
    expect(health).toEqual(["unknown", "unknown", "under", "unknown"]);
  });
});

describe("Coverage geometry", () => {
  beforeEach(() => {
    installResizeObserver();
    setViewportWidth(1400);
    mockContainerWidth(1200);
  });

  it("uses a 212px sticky context lane and 128px day tracks that scroll inside the card", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    const wide = screen.getByTestId("roster-coverage-wide");
    expect(wide.className).toContain("overflow-auto");
    expect(wide.style.maxHeight).toBe("66vh");

    const rows = [
      ...screen.getAllByTestId("roster-requirement-row"),
      ...screen.getAllByTestId("roster-exact-shift-row"),
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.style.gridTemplateColumns).toBe(
        `212px repeat(${document.context.calendar.length}, 128px)`,
      );
      // The context lane stays put while the day tracks scroll under it.
      expect((row.firstElementChild as HTMLElement).className).toContain("sticky");
    }
  });

  it("carries a compact legend and the shift's hours as context", async () => {
    const document = await makeDocument();
    render(<Viewer document={document} />);
    selectLens("coverage");
    expect(screen.getByTestId("roster-coverage-legend").textContent).toContain(
      "Hard constraint not met",
    );
    const dLane = [...screen.getAllByTestId("roster-exact-shift-row")].find(
      (row) => row.getAttribute("data-shift") === "D",
    );
    expect(dLane?.textContent).toContain("09:00–17:00");
  });
});

describe("Forbidden terminology", () => {
  beforeEach(() => {
    installResizeObserver();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1200,
      height: 600,
      top: 0,
      left: 0,
      bottom: 600,
      right: 1200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });

  const FORBIDDEN = [
    "Forget",
    "Abandon",
    "Optimize again",
    "Optimise again",
    "snapshot",
    "backend job",
    "cleanup token",
    "storage epoch",
    "recovery record",
  ];

  it.each(FORBIDDEN)("the viewer does not surface '%s'", async (term) => {
    const document = await makeDocument();
    const { container } = render(<Viewer document={document} />);
    // The viewer is read-only; none of these terms should appear.
    expect(container.textContent).not.toContain(term);
  });
});
