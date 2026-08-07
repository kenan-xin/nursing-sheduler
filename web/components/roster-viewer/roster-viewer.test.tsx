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
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RosterViewer } from "./roster-viewer";
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
    render(<RosterViewer document={document} />);
    expect(screen.getByTestId("roster-grid")).toBeDefined();
    expect(screen.queryByTestId("roster-coverage-wide")).toBeNull();
    expect(screen.queryByTestId("roster-day")).toBeNull();
  });

  it("renders the lens toggle with Grid, Coverage, and Day options", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    expect(screen.getByTestId("roster-lens-grid")).toBeDefined();
    expect(screen.getByTestId("roster-lens-coverage")).toBeDefined();
    expect(screen.getByTestId("roster-lens-day")).toBeDefined();
  });

  it("switches to the Coverage lens on click", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    selectLens("coverage");
    expect(screen.getByTestId("roster-coverage-wide")).toBeDefined();
    expect(screen.queryByTestId("roster-grid")).toBeNull();
  });

  it("switches to the Day lens on click", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    selectLens("day");
    expect(screen.getByTestId("roster-day")).toBeDefined();
  });

  it("renders the provenance banner with solver status 'as solved'", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
    expect(screen.getByTestId("roster-provenance").textContent).toContain("edited since solve");
  });

  it("does NOT show 'edited since solve' when there are no edits", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    expect(grid.className).toContain("overflow-auto");
    expect(grid.style.maxHeight).toBe("66vh");
  });

  it("the corner header has the highest z-index (5)", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    const corner = grid.querySelector("th");
    expect(corner?.className).toContain("z-[5]");
  });

  it("date headers have z-index 3", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    const headers = grid.querySelectorAll("thead th");
    // The corner is headers[0] (z:5); date headers follow at z:3.
    expect(headers.length).toBeGreaterThan(1);
    expect(headers[1].className).toContain("z-[3]");
  });

  it("body first column cells have z-index 2", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    // The person cell is a row header (`<th scope="row">`), not a data cell.
    const firstBodyCell = grid.querySelector("tbody th");
    expect(firstBodyCell?.getAttribute("scope")).toBe("row");
    expect(firstBodyCell?.className).toContain("z-[2]");
  });

  it("header cells carry a 2px bottom border", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    const corner = grid.querySelector("th");
    expect(corner?.className).toContain("border-b-[2px]");
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
    render(<RosterViewer document={document} />);
    selectLens("coverage");
    expect(screen.getByTestId("roster-coverage-wide")).toBeDefined();
    expect(screen.queryByTestId("roster-coverage-stacked")).toBeNull();
  });

  it("shows 'coverage unavailable' for a shift with no baseline rather than a number", async () => {
    // The default fixture has D available and N unavailable.
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    selectLens("coverage");
    const wide = screen.getByTestId("roster-coverage-wide");
    // N lane should show "coverage unavailable" or "—".
    expect(wide.textContent).toMatch(/unavailable|—/);
  });

  it("shows 'Short' when staffed is below required", async () => {
    // The fixture's D has required:1. The solved grid has D on day 0 for person 0
    // only, so it's staffed. Let me check: day 0 has D for P1 and N for P2.
    // So D day 0 = 1 staffed vs required 1 = not short. Day 1: P1 OFF, P2 D → 1/1.
    // Day 2: P1 N, P2 OFF → D staffed 0, short! Day 3: P1 LEAVE, P2 D → 1/1.
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
    selectLens("day");
    const day = screen.getByTestId("roster-day");
    const tabs = day.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(document.context.calendar.length);
  });

  it("shows off/leave list at the bottom", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    selectLens("day");
    const day = screen.getByTestId("roster-day");
    expect(day.textContent).toContain("Off / leave");
  });
});

// ---------------------------------------------------------------------------
// Shift chip (DESIGN.md §5: 34×28, borderless)
// ---------------------------------------------------------------------------

describe("ShiftChip", () => {
  it("a worked shift renders a 34×28 chip with the ramp fill colour", () => {
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
    render(<RosterViewer document={document} />);
    selectLens("coverage");
    expect(screen.getByTestId("roster-coverage-stacked")).toBeDefined();
    expect(screen.queryByTestId("roster-coverage-wide")).toBeNull();
  });

  it("keeps Coverage wide on a WIDE CONTAINER inside a NARROW viewport", async () => {
    setViewportWidth(500);
    mockContainerWidth(1100);
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    selectLens("coverage");
    expect(screen.getByTestId("roster-coverage-wide")).toBeDefined();
    expect(screen.queryByTestId("roster-coverage-stacked")).toBeNull();
  });

  it("re-stacks live when the container shrinks past the threshold", async () => {
    setViewportWidth(1400);
    mockContainerWidth(1100);
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
    expect(screen.getByTestId("roster-day")).toBeDefined();
    expect(screen.queryByTestId("roster-grid")).toBeNull();
  });

  it("opens on the Grid lens at exactly the threshold and above", async () => {
    setViewportWidth(MOBILE_DEFAULT_LENS_VIEWPORT);
    mockContainerWidth(1200);
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
    const toggle = screen.getByTestId("roster-lens-toggle");
    expect(toggle.getAttribute("aria-label")).toBe("Roster lens");
    const grid = screen.getByTestId("roster-lens-grid");
    expect(grid.tagName).toBe("BUTTON");
    expect(grid.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("roster-lens-day").getAttribute("aria-pressed")).toBe("false");
  });

  it("the lens toggle updates aria-pressed when the lens changes", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    selectLens("day");
    expect(screen.getByTestId("roster-lens-day").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("roster-lens-grid").getAttribute("aria-pressed")).toBe("false");
  });

  it("the Day lens date strip is a keyboard-reachable tablist", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
    selectLens("coverage");
    const stacked = screen.getByTestId("roster-coverage-stacked");
    expect(stacked.className).not.toContain("overflow");
    expect(screen.queryByTestId("roster-coverage-wide")).toBeNull();
  });

  it("the header controls wrap rather than forcing a wider row", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    const toggle = screen.getByTestId("roster-lens-toggle");
    const header = toggle.parentElement;
    expect(header?.className).toContain("flex-wrap");
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
    const first = render(<RosterViewer document={document} />);
    selectLens("coverage");
    expect(screen.getByTestId("roster-coverage-wide")).toBeDefined();
    first.unmount();

    render(<RosterViewer document={document} />);
    expect(screen.getByTestId("roster-coverage-wide")).toBeDefined();
    expect(screen.queryByTestId("roster-grid")).toBeNull();
  });

  it("restores the focused day chosen before a remount", async () => {
    const document = await makeDocument();
    const first = render(<RosterViewer document={document} />);
    selectLens("day");
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    expect(tabs.length).toBeGreaterThan(1);
    fireEvent.click(tabs[tabs.length - 1]);
    expect(tabs[tabs.length - 1].getAttribute("aria-selected")).toBe("true");
    first.unmount();

    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
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
    const view = render(<RosterViewer document={first} />);
    selectLens("day");

    // Focus the third day: 2026-07-05.
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    fireEvent.click(tabs[2]);
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");

    // A different roster whose span still CONTAINS 2026-07-05, at a different index.
    const overlapping = await makeDocumentOverRange("2026-07-05", "2026-07-08");
    view.rerender(<RosterViewer document={overlapping} />);

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
    const view = render(<RosterViewer document={first} />);
    selectLens("day");
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    fireEvent.click(tabs[2]);
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");

    // An equal-length span sharing NO dates with the first.
    const disjoint = await makeDocumentOverRange("2026-09-10", "2026-09-13");
    view.rerender(<RosterViewer document={disjoint} />);

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
    const view = render(<RosterViewer document={first} />);
    selectLens("day");
    const tabs = [...screen.getByTestId("roster-day").querySelectorAll('[role="tab"]')];
    fireEvent.click(tabs[3]);

    const shorter = await makeDocumentOverRange("2026-10-01", "2026-10-02");
    view.rerender(<RosterViewer document={shorter} />);

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
    render(<RosterViewer document={document} />);
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

  it("states 'All shifts staffed' only when every lane was checkable", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    const summary = screen.getByTestId("roster-coverage-summary").textContent ?? "";
    // The default fixture has an unavailable lane, so the unqualified claim is
    // not available to it.
    expect(summary).not.toBe("All shifts staffed");
  });

  // THE DEFECT THIS REPLACES. With NO checkable lane the old summary computed
  // `underMinimum === 0` and rendered "All shifts staffed" — an all-clear over a
  // roster nothing had verified.
  it("never claims staffing when no lane is checkable", async () => {
    const document = await makeDocument({ unavailableShift: true });
    render(<RosterViewer document={document} />);
    const summary = screen.getByTestId("roster-coverage-summary").textContent ?? "";
    expect(summary).toContain("unavailable");
    expect(summary).not.toContain("All shifts staffed");
  });

  it("paints no healthy day dot when nothing on the day is checkable", async () => {
    const document = await makeDocument({ unavailableShift: true });
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
    selectLens("day");
    const tabs = dayTabs();
    const reachable = tabs.filter((tab) => tab.tabIndex === 0);
    expect(reachable.length).toBe(1);
    expect(reachable[0].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowRight and ArrowLeft move the selection and wrap", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
    selectLens("day");
    const strip = screen.getByRole("tablist");
    fireEvent.keyDown(strip, { key: "a" });
    expect(dayTabs()[0].getAttribute("aria-selected")).toBe("true");
  });

  it("carries each day's coverage state in its accessible name, not only its dot colour", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    selectLens("day");
    for (const tab of dayTabs()) {
      const name = tab.getAttribute("aria-label") ?? "";
      expect(name).toMatch(/staffed|under minimum|at minimum|coverage unavailable/);
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
  it("names staffed and required on every checkable footer cell", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
    const grid = screen.getByTestId("roster-grid");
    const cells = grid.querySelectorAll("tfoot td[data-short]");
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      const label = cell.getAttribute("aria-label") ?? "";
      expect(label).toMatch(/^(Short: staffed|Staffed) \d+, required \d+$/);
      // The title carries the same text, so a mouse user gets it too.
      expect(cell.getAttribute("title")).toBe(label);
    }
  });

  it("marks a short cell as Short in text, not only in colour", async () => {
    const document = await makeDocument();
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
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
    render(<RosterViewer document={document} />);
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
    const { container } = render(<RosterViewer document={document} />);
    // The viewer is read-only; none of these terms should appear.
    expect(container.textContent).not.toContain(term);
  });
});
