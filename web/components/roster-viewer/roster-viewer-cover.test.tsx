// @vitest-environment jsdom
//
// Coverage on the roster reads temporary cover on read (d582, spec §4): the roster
// file's ledger rebuilds the authored need, and the scenario's covers RIGHT NOW
// lower it. The scenario is the real durable store (fake IndexedDB), written through
// `scenarioCommands` exactly as the Staff screen writes it.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RosterDocument } from "@/lib/roster";
import { fixtureCanonicalDocument, fixtureRosterDocument } from "@/lib/roster/test-fixtures";
import { PREFERENCE_TYPE } from "@/lib/scenario";
import { makeTemporaryCover } from "@/lib/scenario/test-fixtures";
import { resetScenarioForTest, scenarioCommands } from "@/lib/store/test-authority";
import { RosterContentWidthProvider } from "./roster-content-width";
import { RosterViewer } from "./roster-viewer";

beforeEach(async () => {
  await resetScenarioForTest();
  // jsdom does no layout: give the viewer a wide container so Coverage renders its
  // exact-shift lanes.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

/** The fixture with one requirement: `count` on D on 2026-07-04 (one person works it). */
function documentNeeding(count: number): ReturnType<typeof fixtureCanonicalDocument> {
  const doc = fixtureCanonicalDocument();
  doc.preferences = [
    { type: PREFERENCE_TYPE.maxOneShiftPerDay },
    {
      type: PREFERENCE_TYPE.shiftTypeRequirement,
      shiftType: "D",
      requiredNumPeople: count,
      date: "2026-07-04",
      weight: -1,
    },
  ];
  return doc;
}

/** Authored 2, solved with one cover already subtracted (submitted 1, ledger 1). */
function solvedWithCover(): Promise<RosterDocument> {
  return fixtureRosterDocument({
    document: documentNeeding(1),
    cover: {
      entries: [{ name: "Haseena (Ward 3)", iso: "2026-07-04", shiftId: "D", groups: [] }],
      decrements: [{ pref: 1, iso: "2026-07-04", required: 1 }],
    },
  });
}

async function liveCover(): Promise<void> {
  await scenarioCommands.mutate({
    temporaryCover: [makeTemporaryCover({ date: "2026-07-04", shiftType: "D" })],
  });
}

/** The D cell on 2026-07-04 in the Coverage lens. */
function dCell(): Element {
  fireEvent.click(screen.getByTestId("roster-lens-coverage"));
  const lane = screen
    .getAllByTestId("roster-exact-shift-row")
    .find((row) => row.getAttribute("data-shift") === "D");
  return [...(lane?.querySelectorAll("[data-staffed]") ?? [])][1];
}

function mount(document: RosterDocument) {
  render(
    <RosterContentWidthProvider>
      <RosterViewer document={document} />
    </RosterContentWidthProvider>,
  );
}

describe("setup changed since the solve (C-20)", () => {
  const shifts = [{ id: "D" }, { id: "N" }];

  it("is quiet while Setup still matches the roster", async () => {
    await scenarioCommands.mutate({ staff: [{ id: "Alice Ng" }, { id: 7 }], shifts });
    mount(await fixtureRosterDocument());
    expect(screen.queryByTestId("roster-setup-changed")).toBeNull();
  });

  it("says so after a person is renamed or removed", async () => {
    await scenarioCommands.mutate({ staff: [{ id: "Alice Ng" }, { id: "Bo" }], shifts });
    mount(await fixtureRosterDocument());
    expect(screen.getByTestId("roster-setup-changed")).toHaveTextContent(
      "Setup changed since this roster was solved",
    );
  });

  it("says so after a shift type is removed", async () => {
    await scenarioCommands.mutate({
      staff: [{ id: "Alice Ng" }, { id: 7 }],
      shifts: [{ id: "D" }],
    });
    mount(await fixtureRosterDocument());
    expect(screen.getByTestId("roster-setup-changed")).toBeDefined();
  });
});

describe("hand edits are rule-checked (C-19)", () => {
  function mountEditing(
    document: RosterDocument,
    selectedCell: { personIdx: number; dateIdx: number },
  ) {
    render(
      <RosterContentWidthProvider>
        <RosterViewer
          document={document}
          editing={{
            selectedCell,
            selectCell: vi.fn(),
            setCell: vi.fn(),
            swapCells: vi.fn(),
            undo: vi.fn(),
            canUndo: false,
          }}
        />
      </RosterContentWidthProvider>,
    );
  }

  it("warns on the edit bar when an edit breaks a rule, and keeps the edit", async () => {
    // P2 works the one D needed on 4 Jul.
    mountEditing(await fixtureRosterDocument({ document: documentNeeding(1) }), {
      personIdx: 1,
      dateIdx: 1,
    });
    fireEvent.click(screen.getByTestId("roster-edit-option-OFF"));
    const warning = screen.getByTestId("roster-edit-warnings");
    expect(warning).toHaveTextContent("This change breaks a rule. It is kept.");
    expect(warning).toHaveTextContent("has 0 of the 1");
  });

  it("stays quiet when the edit breaks nothing", async () => {
    // P2's N on 3 Jul is needed by no rule.
    mountEditing(await fixtureRosterDocument({ document: documentNeeding(1) }), {
      personIdx: 1,
      dateIdx: 0,
    });
    fireEvent.click(screen.getByTestId("roster-edit-option-OFF"));
    expect(screen.queryByTestId("roster-edit-warnings")).toBeNull();
  });
});

describe("temporary cover on the roster (d582)", () => {
  it("control: with no cover the scoped cell is short", async () => {
    mount(await fixtureRosterDocument({ document: documentNeeding(2) }));
    expect(dCell().getAttribute("data-short")).toBe("true");
  });

  it("a cover added after the solve lowers the need at once", async () => {
    await liveCover();
    mount(await fixtureRosterDocument({ document: documentNeeding(2) }));
    expect(dCell().getAttribute("data-short")).toBe("false");
  });

  it("a solved cover later removed raises the need at once", async () => {
    mount(await solvedWithCover());
    expect(dCell().getAttribute("data-short")).toBe("true");
    expect(dCell().getAttribute("aria-label")).toContain("/2 from the ward");
  });

  it("a solved cover still in the scenario keeps the ward need", async () => {
    await liveCover();
    mount(await solvedWithCover());
    expect(dCell().getAttribute("data-short")).toBe("false");
  });
});
