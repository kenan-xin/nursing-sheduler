// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UiPerson, UiRequestCell } from "@/lib/scenario";
import {
  historyColumnLabels,
  historyColumnCount,
  type RequestColumn,
  type RequestRow,
} from "@/components/requests/requests-model";
import { cellPreferenceSet } from "@/components/requests/requests-model";
import {
  RequestsMatrix,
  buildCellsByCoord,
  coordKey,
  type RequestsMatrixProps,
} from "./requests-matrix";

// jsdom (as of the pinned version) has no ResizeObserver; @tanstack/react-virtual
// observes the scroll element's size, so a minimal stub is required for it to render.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  // jsdom never lays out elements (clientHeight is always 0), so the virtualizer's
  // scroll-element measurement would otherwise report an empty viewport and render
  // nothing. Force a generous viewport so every row in these small fixtures is "visible".
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    value: 1000,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const people: UiPerson[] = [{ id: "Alice", history: ["N", "OFF"] }, { id: "Bob" }];

const rows: RequestRow[] = [
  { isGroup: true, id: "NightOwls", label: "NightOwls", members: ["Alice", "Bob"] },
  { isGroup: false, id: "Alice", label: "1. Alice", personIndex: 1 },
  { isGroup: false, id: "Bob", label: "2. Bob", personIndex: 2 },
];

const historyCount = historyColumnCount(people); // max(2) + 1 = 3
const historyLabels = historyColumnLabels(historyCount); // ["H-3", "H-2", "H-1"]

const columns: RequestColumn[] = [
  { kind: "date-group", ref: "ALL", label: "ALL", synthetic: true, count: 2 },
  { kind: "date-item", ref: "2026-05-01", iso: "2026-05-01", label: "05/01", weekend: false },
  { kind: "date-item", ref: "2026-05-02", iso: "2026-05-02", label: "05/02", weekend: true },
];

const reqData: UiRequestCell[] = [
  { kind: "request", person: "Alice", date: "2026-05-01", shiftType: "AM", weight: 5 },
  { kind: "leave", person: "Bob", date: "2026-05-01" },
  { kind: "off", person: "Alice", date: "ALL", weight: -3 },
];

function makeProps(overrides: Partial<RequestsMatrixProps> = {}): RequestsMatrixProps {
  return {
    rows,
    columns,
    people,
    historyCount,
    historyLabels,
    reqData,
    shiftTypeOrderIndex: () => 0,
    mode: "normal",
    onCellClick: vi.fn(),
    onHistoryClick: vi.fn(),
    onCellPointerDown: vi.fn(),
    onCellPointerEnter: vi.fn(),
    onHistoryPointerDown: vi.fn(),
    onHistoryPointerEnter: vi.fn(),
    ...overrides,
  };
}

describe("RequestsMatrix", () => {
  it("renders the sticky Nurse header, history headers, and date columns", () => {
    render(<RequestsMatrix {...makeProps()} />);
    expect(screen.getByTestId("requests-matrix-header")).toHaveTextContent("Nurse");
    expect(screen.getByTestId("hist-head-0")).toHaveTextContent("H-3");
    expect(screen.getByTestId("hist-head-2")).toHaveTextContent("H-1");
    expect(screen.getByTestId("col-head-0")).toHaveTextContent("ALL");
    expect(screen.getByTestId("col-head-1")).toHaveTextContent("05/01");
  });

  it("group rows render inert em-dash history cells and are not clickable", () => {
    const onHistoryClick = vi.fn();
    render(<RequestsMatrix {...makeProps({ onHistoryClick })} />);
    const cell = screen.getByTestId("hist-NightOwls-1");
    expect(cell).toHaveTextContent("—");
    fireEvent.click(cell);
    expect(onHistoryClick).not.toHaveBeenCalled();
  });

  it("a clickable history slot with a value fires onHistoryClick in normal mode (FR-SR-08/18)", () => {
    const onHistoryClick = vi.fn();
    render(<RequestsMatrix {...makeProps({ onHistoryClick })} />);
    // Alice: offset = count(3) - history.length(2) = 1; index 1 -> history[0] = "N".
    const cell = screen.getByTestId("hist-Alice-1");
    expect(cell).toHaveTextContent("N");
    fireEvent.click(cell);
    expect(onHistoryClick).toHaveBeenCalledWith("Alice", 1);
  });

  it("a non-clickable padding history slot does not fire onHistoryClick", () => {
    const onHistoryClick = vi.fn();
    render(<RequestsMatrix {...makeProps({ onHistoryClick })} />);
    // Bob: offset = 3 - 0 = 3; clickable only from index >= offset - 1 = 2.
    const inert = screen.getByTestId("hist-Bob-0");
    fireEvent.click(inert);
    expect(onHistoryClick).not.toHaveBeenCalled();
  });

  it("the one clickable padding slot ahead of an empty history still fires onHistoryClick", () => {
    const onHistoryClick = vi.fn();
    render(<RequestsMatrix {...makeProps({ onHistoryClick })} />);
    const clickablePadding = screen.getByTestId("hist-Bob-2");
    fireEvent.click(clickablePadding);
    expect(onHistoryClick).toHaveBeenCalledWith("Bob", 2);
  });

  it("normal mode: clicking a request cell fires onCellClick with (person, colRef)", () => {
    const onCellClick = vi.fn();
    render(<RequestsMatrix {...makeProps({ onCellClick })} />);
    const cell = screen.getByTestId("cell-Alice-2026-05-01");
    fireEvent.click(cell);
    expect(onCellClick).toHaveBeenCalledWith("Alice", "2026-05-01");
  });

  it("quick mode: pointerdown/pointerenter drive paint staging instead of onClick", () => {
    const onCellClick = vi.fn();
    const onCellPointerDown = vi.fn();
    const onCellPointerEnter = vi.fn();
    render(
      <RequestsMatrix
        {...makeProps({ mode: "quick", onCellClick, onCellPointerDown, onCellPointerEnter })}
      />,
    );
    const cell = screen.getByTestId("cell-Alice-2026-05-01");
    fireEvent.pointerDown(cell);
    fireEvent.pointerEnter(cell);
    fireEvent.click(cell);
    expect(onCellPointerDown).toHaveBeenCalledWith("Alice", "2026-05-01");
    expect(onCellPointerEnter).toHaveBeenCalledWith("Alice", "2026-05-01");
    expect(onCellClick).not.toHaveBeenCalled();
  });

  it("a leave cell renders the brand-pin treatment (FR-SR-46/49 display)", () => {
    render(<RequestsMatrix {...makeProps()} />);
    const cell = screen.getByTestId("cell-Bob-2026-05-01");
    expect(cell).toHaveTextContent("Leave");
    expect(cell.className).toContain("bg-brandtint");
  });

  it("an off-only cell renders distinct from a leave cell", () => {
    render(<RequestsMatrix {...makeProps()} />);
    const cell = screen.getByTestId("cell-Alice-ALL");
    expect(cell.className).toContain("bg-errortint");
  });

  it("an empty coordinate renders blank with no crash", () => {
    render(<RequestsMatrix {...makeProps()} />);
    const cell = screen.getByTestId("cell-Bob-ALL");
    expect(cell).toHaveTextContent("");
  });

  it("highlights a staged coordinate", () => {
    const stagedKeys = new Set([JSON.stringify(["Alice", "2026-05-02"])]);
    render(<RequestsMatrix {...makeProps({ stagedKeys })} />);
    const cell = screen.getByTestId("cell-Alice-2026-05-02");
    expect(cell.className).toContain("outline-brand");
  });

  it("degrades gracefully when rows or columns are empty", () => {
    render(<RequestsMatrix {...makeProps({ rows: [] })} />);
    expect(screen.getByTestId("requests-matrix-empty")).toBeInTheDocument();
  });
});

// The per-cell `cellPreferenceSet` scan + `JSON.stringify` was replaced by a
// single `buildCellsByCoord(reqData)` memo with O(1) `map.get(coordKey(...))`
// lookups. These assert the memoized lookup returns EXACTLY the membership the
// old per-cell scan did (identical semantics; pure perf refactor).
describe("buildCellsByCoord (matrix cell-membership memo)", () => {
  const multiCoordReqData: UiRequestCell[] = [
    { kind: "request", person: "Alice", date: "2026-05-01", shiftType: "AM", weight: 5 },
    { kind: "off", person: "Alice", date: "2026-05-01", weight: -2 },
    { kind: "leave", person: "Bob", date: "2026-05-01" },
    { kind: "off", person: "Alice", date: "ALL", weight: -3 },
  ];

  it("lookup returns the same membership (and order) as cellPreferenceSet, per coordinate", () => {
    const map = buildCellsByCoord(multiCoordReqData);
    const coords: [string, string][] = [
      ["Alice", "2026-05-01"], // two coexisting cells, order preserved
      ["Bob", "2026-05-01"], // single leave cell
      ["Alice", "ALL"], // single off cell
      ["Bob", "ALL"], // empty coordinate -> undefined (empty set)
    ];
    for (const [person, date] of coords) {
      const viaMap = map.get(coordKey(person, date)) ?? [];
      expect(viaMap).toEqual(cellPreferenceSet(multiCoordReqData, person, date));
    }
  });

  it("is built once from reqData rather than scanned per cell", () => {
    // A distinct entry per non-empty coordinate; each holds only its own cells,
    // so the whole matrix is served by one pass over reqData (this Map), not a
    // full-reqData scan per rendered cell.
    const map = buildCellsByCoord(multiCoordReqData);
    expect(map.size).toBe(3);
    expect(map.get(coordKey("Alice", "2026-05-01"))).toHaveLength(2);
  });
});
