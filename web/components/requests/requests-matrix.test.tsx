// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    // The third argument is the exact element that was activated — the container
    // needs it to restore focus, and a coordinate alone cannot supply it.
    expect(onHistoryClick).toHaveBeenCalledExactlyOnceWith("Alice", 1, cell);
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
    expect(onHistoryClick).toHaveBeenCalledExactlyOnceWith("Bob", 2, clickablePadding);
  });

  it("normal mode: clicking a request cell fires onCellClick with (person, colRef, origin)", () => {
    const onCellClick = vi.fn();
    render(<RequestsMatrix {...makeProps({ onCellClick })} />);
    const cell = screen.getByTestId("cell-Alice-2026-05-01");
    fireEvent.click(cell);
    expect(onCellClick).toHaveBeenCalledExactlyOnceWith("Alice", "2026-05-01", cell);
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

// ---------------------------------------------------------------------------
// Keyboard operability of the matrix origins.
//
// The two editors promise focus back to the cell that opened them, which is only
// possible if that cell is a real control: focusable, named, and openable
// without a pointer. What must NOT happen is the opposite over-reach — a
// quick-paint drag target or an inert history pad advertising a button it does
// not implement.
// ---------------------------------------------------------------------------

describe("RequestsMatrix — actionable origins are native buttons", () => {
  it("a normal-mode request cell IS a native button, not an ARIA impersonation", () => {
    render(<RequestsMatrix {...makeProps()} />);
    const cell = screen.getByTestId("cell-Alice-2026-05-01");
    expect(cell.tagName).toBe("BUTTON");
    // `type` is explicit: the HTML default is `submit`, which would post a form.
    expect(cell).toHaveAttribute("type", "button");
    // The role is IMPLICIT — no `role` attribute should be restating it.
    expect(cell).not.toHaveAttribute("role");
    // Discovered by its own accessible name, not by testid — the implicit role
    // is what makes this queryable at all.
    expect(cell).toBe(screen.getByRole("button", { name: /^Edit 1\. Alice on 05\/01/ }));
    expect(cell).toHaveAccessibleName(/1\. Alice/);
    expect(cell).toHaveAccessibleName(/05\/01/);
  });

  it("a normal-mode actionable history slot IS a native button naming its position", () => {
    render(<RequestsMatrix {...makeProps()} />);
    const slot = screen.getByTestId("hist-Alice-1");
    expect(slot.tagName).toBe("BUTTON");
    expect(slot).toHaveAttribute("type", "button");
    expect(slot).not.toHaveAttribute("role");
    expect(slot).toHaveAccessibleName(/H-2/);
    expect(slot).toHaveAccessibleName(/1\. Alice/);
  });

  it("is a tab stop natively, with no hand-written tabindex", () => {
    render(<RequestsMatrix {...makeProps()} />);
    const cell = screen.getByTestId("cell-Alice-2026-05-01");
    // A native button is focusable and tabbable without an explicit attribute.
    // (The product-scale tab-order concern is unchanged and tracked as P4.)
    expect(cell).not.toHaveAttribute("tabindex");
    cell.focus();
    expect(cell).toHaveFocus();
  });

  it("keeps the exact presentation contract the div carried", () => {
    render(<RequestsMatrix {...makeProps()} />);
    const cell = screen.getByTestId("cell-Alice-2026-05-01");
    // Geometry and paint live entirely in these classes, which is why the
    // element swap is layout-neutral (proven live in Chromium). Border tokens
    // are deliberately absent here: this cell carries a request, so the visual
    // recipe's all-sides `border` wins the tailwind-merge over `border-b`/`-r`.
    for (const token of [
      "flex",
      "items-center",
      "justify-center",
      "overflow-hidden",
      "px-1",
      "text-center",
    ]) {
      expect(cell.className).toContain(token);
    }
    expect(cell).toHaveAttribute("title");

    // An empty cell keeps the plain hairline edges.
    const emptyCell = screen.getByTestId("cell-Bob-ALL");
    for (const token of ["border-b", "border-r"]) {
      expect(emptyCell.className).toContain(token);
    }

    const slot = screen.getByTestId("hist-Alice-1");
    for (const token of ["flex", "items-center", "justify-center", "border-b", "border-r"]) {
      expect(slot.className).toContain(token);
    }
  });

  it.each(["{Enter}", " "])(
    "native %s activation opens the cell editor exactly once, with the focused cell as the origin",
    async (key) => {
      const onCellClick = vi.fn();
      render(<RequestsMatrix {...makeProps({ onCellClick })} />);
      const cell = screen.getByTestId("cell-Alice-2026-05-01");
      cell.focus();
      expect(cell).toHaveFocus();
      await userEvent.keyboard(key);
      // Exactly once: the browser synthesizes ONE click from the key press, and
      // there is no hand-written keydown handler left to fire a second time.
      expect(onCellClick).toHaveBeenCalledExactlyOnceWith("Alice", "2026-05-01", cell);
    },
  );

  it.each(["{Enter}", " "])(
    "native %s activation opens the history editor exactly once, with the focused slot as the origin",
    async (key) => {
      const onHistoryClick = vi.fn();
      render(<RequestsMatrix {...makeProps({ onHistoryClick })} />);
      const slot = screen.getByTestId("hist-Alice-1");
      slot.focus();
      await userEvent.keyboard(key);
      expect(onHistoryClick).toHaveBeenCalledExactlyOnceWith("Alice", 1, slot);
    },
  );

  it("a pointer click and a key press never stack into a double activation", async () => {
    const onCellClick = vi.fn();
    render(<RequestsMatrix {...makeProps({ onCellClick })} />);
    const cell = screen.getByTestId("cell-Alice-2026-05-01");
    await userEvent.click(cell);
    expect(onCellClick).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    expect(onCellClick).toHaveBeenCalledTimes(2);
    await userEvent.keyboard("{Enter}");
    expect(onCellClick).toHaveBeenCalledTimes(3);
    // Every call carried the same element and coordinate — one activation each.
    for (const call of onCellClick.mock.calls) {
      expect(call).toEqual(["Alice", "2026-05-01", cell]);
    }
  });

  it("an unrelated key does nothing", async () => {
    const onCellClick = vi.fn();
    render(<RequestsMatrix {...makeProps({ onCellClick })} />);
    const cell = screen.getByTestId("cell-Alice-2026-05-01");
    cell.focus();
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard("a");
    expect(onCellClick).not.toHaveBeenCalled();
  });
});

describe("RequestsMatrix — non-actionable cells never become buttons", () => {
  it("quick-paint cells stay divs and drag targets", async () => {
    const onCellClick = vi.fn();
    const onCellPointerDown = vi.fn();
    render(<RequestsMatrix {...makeProps({ mode: "quick", onCellClick, onCellPointerDown })} />);
    const cell = screen.getByTestId("cell-Alice-2026-05-01");
    expect(cell.tagName).toBe("DIV");
    expect(cell).not.toHaveAttribute("role", "button");
    expect(cell).not.toHaveAttribute("tabindex");
    fireEvent.keyDown(cell, { key: "Enter" });
    fireEvent.keyDown(cell, { key: " " });
    expect(onCellClick).not.toHaveBeenCalled();
    // The drag seam is untouched by the element swap.
    fireEvent.pointerDown(cell);
    expect(onCellPointerDown).toHaveBeenCalledExactlyOnceWith("Alice", "2026-05-01");
  });

  it("quick-paint history slots stay divs and drag targets", () => {
    const onHistoryClick = vi.fn();
    const onHistoryPointerDown = vi.fn();
    render(
      <RequestsMatrix {...makeProps({ mode: "quick", onHistoryClick, onHistoryPointerDown })} />,
    );
    const slot = screen.getByTestId("hist-Alice-1");
    expect(slot.tagName).toBe("DIV");
    expect(slot).not.toHaveAttribute("role", "button");
    expect(slot).not.toHaveAttribute("tabindex");
    fireEvent.keyDown(slot, { key: "Enter" });
    expect(onHistoryClick).not.toHaveBeenCalled();
    fireEvent.pointerDown(slot);
    expect(onHistoryPointerDown).toHaveBeenCalledExactlyOnceWith("Alice", 1);
  });

  it("non-clickable history padding is an inert div in normal mode", () => {
    const onHistoryClick = vi.fn();
    render(<RequestsMatrix {...makeProps({ onHistoryClick })} />);
    // Bob: offset = 3 - 0 = 3; clickable only from index >= offset - 1 = 2.
    const inert = screen.getByTestId("hist-Bob-0");
    expect(inert.tagName).toBe("DIV");
    expect(inert).not.toHaveAttribute("role", "button");
    expect(inert).not.toHaveAttribute("tabindex");
    fireEvent.keyDown(inert, { key: "Enter" });
    expect(onHistoryClick).not.toHaveBeenCalled();
  });

  it("a group row's em-dash history cell is an inert div", () => {
    const onHistoryClick = vi.fn();
    render(<RequestsMatrix {...makeProps({ onHistoryClick })} />);
    const groupCell = screen.getByTestId("hist-NightOwls-1");
    expect(groupCell.tagName).toBe("DIV");
    expect(groupCell).not.toHaveAttribute("role", "button");
    expect(groupCell).not.toHaveAttribute("tabindex");
    fireEvent.keyDown(groupCell, { key: "Enter" });
    expect(onHistoryClick).not.toHaveBeenCalled();
  });

  it("exposes exactly the actionable origins as buttons — no inert cell leaks in", () => {
    render(<RequestsMatrix {...makeProps()} />);
    const buttons = screen.getAllByRole("button");
    // Every button is an actionable origin…
    for (const button of buttons) {
      const testid = button.getAttribute("data-testid") ?? "";
      expect(testid).toMatch(/^(cell|hist)-/);
    }
    // …and the known-inert coordinates are absent from that set.
    for (const inertTestId of ["hist-Bob-0", "hist-Bob-1", "hist-NightOwls-1"]) {
      expect(buttons).not.toContain(screen.getByTestId(inertTestId));
    }
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
