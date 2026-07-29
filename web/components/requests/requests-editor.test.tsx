// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import type { ScenarioUiState } from "@/lib/scenario";
import {
  drainScenarioPersist,
  resetToNewScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { RequestsEditor } from "./requests-editor";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// jsdom has no ResizeObserver and never lays out elements — stub both so the
// virtualized matrix renders its rows (mirrors requests-matrix.test.tsx).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const BASE_SEED: Partial<ScenarioUiState> = {
  rangeStart: "2026-01-01",
  rangeEnd: "2026-01-03",
  staff: [
    { id: "Aisha", history: [] },
    { id: "Chloe", history: [] },
  ],
  shifts: [{ id: "AM" }, { id: "PM" }],
  shiftGroups: [{ id: "AnyDay", members: ["AM", "PM"] }],
};

function seed(patch: Partial<ScenarioUiState>) {
  act(() => {
    useScenarioStore.getState().mutateScenario(patch);
  });
}

function uploadCsv(text: string) {
  const input = screen.getByTestId("requests-csv-file-input") as HTMLInputElement;
  const file = new File([text], "upload.csv", { type: "text/csv" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

function staffHistory(personId: string): string[] {
  return useScenarioStore.getState().staff.find((p) => p.id === personId)?.history ?? [];
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    value: 1000,
  });
  await resetToNewScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RequestsEditor — derived table day-state precedence (P1)", () => {
  it("leave+request and off+request conflicts yield exactly one row each; the footer agrees", () => {
    seed({
      ...BASE_SEED,
      reqData: [
        { kind: "leave", person: "Aisha", date: "01" },
        { kind: "request", person: "Aisha", date: "01", shiftType: "AM", weight: 5 },
        { kind: "off", person: "Chloe", date: "02", weight: -3 },
        { kind: "request", person: "Chloe", date: "02", shiftType: "PM", weight: 2 },
      ],
    });
    render(<RequestsEditor />);

    // 4 raw cells, but each coordinate resolves to its day-state: 2 rows.
    const rows = screen.getAllByTestId("requests-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Aisha");
    expect(rows[0]).toHaveTextContent("LEAVE");
    expect(rows[0]).toHaveTextContent("pinned");
    expect(rows[1]).toHaveTextContent("Chloe");
    expect(rows[1]).toHaveTextContent("OFF");
    expect(rows[1]).toHaveTextContent("-3");

    // The header count and the footer count both read the RESOLVED list.
    expect(screen.getByTestId("requests-count")).toHaveTextContent("2");
    expect(screen.getByTestId("requests-footer")).toHaveTextContent("2 requests");
  });
});

describe("RequestsEditor — CSV controls are Quick-Add-only (FR-SR-34)", () => {
  it("both CSV controls are absent in Normal mode and present in Quick mode", () => {
    seed(BASE_SEED);
    render(<RequestsEditor />);

    expect(screen.queryByTestId("requests-open-requests-csv")).not.toBeInTheDocument();
    expect(screen.queryByTestId("requests-open-history-csv")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("requests-tab-quick"));
    expect(screen.getByTestId("requests-open-requests-csv")).toBeInTheDocument();
    expect(screen.getByTestId("requests-open-history-csv")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("requests-tab-normal"));
    expect(screen.queryByTestId("requests-open-requests-csv")).not.toBeInTheDocument();
    expect(screen.queryByTestId("requests-open-history-csv")).not.toBeInTheDocument();
  });

  it("within Quick mode, Requests CSV is disabled only by an unparseable weight (0 stays valid)", () => {
    seed(BASE_SEED);
    render(<RequestsEditor />);
    fireEvent.click(screen.getByTestId("requests-tab-quick"));

    // Default weight text "0" — a valid (removal) weight → enabled.
    expect(screen.getByTestId("requests-open-requests-csv")).not.toBeDisabled();

    fireEvent.change(screen.getByTestId("quick-paint-weight-input"), {
      target: { value: "abc" },
    });
    expect(screen.getByTestId("requests-open-requests-csv")).toBeDisabled();

    fireEvent.change(screen.getByTestId("quick-paint-weight-input"), { target: { value: "0" } });
    expect(screen.getByTestId("requests-open-requests-csv")).not.toBeDisabled();
  });
});

describe("RequestsEditor — history item set includes OFF/LEAVE (P1)", () => {
  it("the Normal history editor offers worked items + OFF + LEAVE, but no groups", () => {
    seed(BASE_SEED);
    render(<RequestsEditor />);
    fireEvent.click(screen.getByTestId("hist-Aisha-0"));

    expect(screen.getByTestId("history-editor")).toBeInTheDocument();
    expect(screen.getByTestId("history-editor-option-AM")).toBeInTheDocument();
    expect(screen.getByTestId("history-editor-option-PM")).toBeInTheDocument();
    expect(screen.getByTestId("history-editor-option-OFF")).toBeInTheDocument();
    expect(screen.getByTestId("history-editor-option-LEAVE")).toBeInTheDocument();
    expect(screen.queryByTestId("history-editor-option-AnyDay")).not.toBeInTheDocument();
  });

  it("the people-history CSV accepts OFF and LEAVE", async () => {
    seed(BASE_SEED);
    render(<RequestsEditor />);
    fireEvent.click(screen.getByTestId("requests-tab-quick"));
    fireEvent.click(screen.getByTestId("requests-open-history-csv"));

    uploadCsv("Aisha,OFF,2\nChloe,LEAVE,1");
    await waitFor(() => expect(staffHistory("Aisha")).toEqual(["OFF", "OFF"]));
    expect(staffHistory("Chloe")).toEqual(["LEAVE"]);
    expect(toast.success).toHaveBeenCalled();
  });

  it("the people-history CSV rejects a shift-type group with the verbatim error", async () => {
    seed(BASE_SEED);
    render(<RequestsEditor />);
    fireEvent.click(screen.getByTestId("requests-tab-quick"));
    fireEvent.click(screen.getByTestId("requests-open-history-csv"));

    uploadCsv("Aisha,AnyDay,2\nChloe,AM,1");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain('Invalid shift type "AnyDay"');
    // A rejected upload mutates nothing.
    expect(staffHistory("Aisha")).toEqual([]);
    expect(staffHistory("Chloe")).toEqual([]);
  });
});

describe("RequestsEditor — Normal history editor saves AND closes (FR-SR-19)", () => {
  it("selecting an option commits and closes the modal", () => {
    seed(BASE_SEED);
    render(<RequestsEditor />);
    fireEvent.click(screen.getByTestId("hist-Aisha-0"));
    expect(screen.getByTestId("history-editor")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("history-editor-option-AM"));
    expect(screen.queryByTestId("history-editor")).not.toBeInTheDocument();
    expect(staffHistory("Aisha")).toEqual(["AM"]);
  });

  it("-- Clear -- truncates through the position and closes the modal", () => {
    seed({ ...BASE_SEED, staff: [{ id: "Aisha", history: ["AM", "PM"] }, { id: "Chloe" }] });
    render(<RequestsEditor />);
    // historyCount = 3; hist-Aisha-1 renders history[0] ("AM", the newest slot).
    fireEvent.click(screen.getByTestId("hist-Aisha-1"));
    expect(screen.getByTestId("history-editor")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("history-editor-clear"));
    expect(screen.queryByTestId("history-editor")).not.toBeInTheDocument();
    // Clearing through position 0 drops the newest entry, keeping the older tail.
    expect(staffHistory("Aisha")).toEqual(["PM"]);
  });
});

// ---------------------------------------------------------------------------
// Focus restoration to the EXACT originating cell (F3 round-four P1).
//
// The container holds the initiating element alongside the coordinate. These
// tests are written against element IDENTITY (`toBe(cell)`), not against a
// re-query by testid, because a coordinate-derived lookup is exactly the
// implementation this seam must not have: it would pass even if the container
// had thrown the element away.
// ---------------------------------------------------------------------------

describe("RequestsEditor — Cell Preference restores focus to its exact origin", () => {
  function openCellEditor() {
    seed(BASE_SEED);
    render(<RequestsEditor />);
    const cell = screen.getByTestId("cell-Aisha-01");
    cell.focus();
    fireEvent.click(cell);
    expect(screen.getByTestId("cell-preference-editor")).toBeInTheDocument();
    return cell;
  }

  it("Cancel returns focus to the very cell that opened it", async () => {
    const cell = openCellEditor();
    fireEvent.click(screen.getByTestId("cell-editor-cancel"));
    await waitFor(() => expect(document.activeElement).toBe(cell));
  });

  it("Escape returns focus to the very cell that opened it", async () => {
    const cell = openCellEditor();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("cell-preference-editor")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(cell));
  });

  it("Save commits AND returns focus to the very cell that opened it", async () => {
    const cell = openCellEditor();
    fireEvent.click(screen.getByTestId("cell-editor-tab-leave"));
    fireEvent.click(screen.getByTestId("cell-editor-save"));
    await waitFor(() => expect(screen.queryByTestId("cell-preference-editor")).toBeNull());
    // The commit re-renders the matrix; React reconciles the same key to the same
    // DOM node, so the captured element is still the live cell.
    expect(useScenarioStore.getState().reqData).toMatchObject([
      { kind: "leave", person: "Aisha", date: "01" },
    ]);
    await waitFor(() => expect(document.activeElement).toBe(cell));
  });

  it("Clear cell returns focus to the very cell that opened it", async () => {
    const cell = openCellEditor();
    fireEvent.click(screen.getByTestId("cell-editor-clear"));
    await waitFor(() => expect(document.activeElement).toBe(cell));
  });

  it("opens from the keyboard and returns focus there too", async () => {
    seed(BASE_SEED);
    render(<RequestsEditor />);
    const cell = screen.getByTestId("cell-Chloe-02");
    cell.focus();
    // The origin is a native button, so activation is the browser's synthesized
    // click from the key press — a bare `keyDown` no longer stands in for it.
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("cell-preference-editor")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("cell-editor-cancel"));
    await waitFor(() => expect(document.activeElement).toBe(cell));
  });

  it("does not steal focus when the captured origin has left the document", async () => {
    const cell = openCellEditor();
    // Simulate the row being recycled by the virtualizer while the editor is open.
    cell.remove();
    expect(cell.isConnected).toBe(false);
    const parked = document.createElement("button");
    document.body.append(parked);

    fireEvent.click(screen.getByTestId("cell-editor-cancel"));
    await waitFor(() => expect(screen.queryByTestId("cell-preference-editor")).toBeNull());
    parked.focus();
    // No focus() on a disconnected node, no fallback to body, and no hunt for a
    // lookalike cell: whatever the user is on stays put.
    await waitFor(() => expect(document.activeElement).toBe(parked));
    parked.remove();
  });
});

describe("RequestsEditor — History Editor restores focus to its exact origin", () => {
  const HISTORY_SEED: Partial<ScenarioUiState> = {
    ...BASE_SEED,
    staff: [
      { id: "Aisha", history: ["PM", "AM"] },
      { id: "Chloe", history: [] },
    ],
  };

  function openHistoryEditor() {
    seed(HISTORY_SEED);
    render(<RequestsEditor />);
    const slot = screen.getByTestId("hist-Aisha-1");
    slot.focus();
    fireEvent.click(slot);
    expect(screen.getByTestId("history-editor")).toBeInTheDocument();
    return slot;
  }

  it("Done returns focus to the very history slot that opened it", async () => {
    const slot = openHistoryEditor();
    fireEvent.click(screen.getByTestId("history-editor-done"));
    await waitFor(() => expect(document.activeElement).toBe(slot));
  });

  it("the close control returns focus to the very history slot", async () => {
    const slot = openHistoryEditor();
    fireEvent.click(screen.getByTestId("history-editor-close"));
    await waitFor(() => expect(document.activeElement).toBe(slot));
  });

  it("Escape returns focus to the very history slot", async () => {
    const slot = openHistoryEditor();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("history-editor")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(slot));
  });

  it("an option selection commits AND returns focus to the very history slot", async () => {
    const slot = openHistoryEditor();
    fireEvent.click(screen.getByTestId("history-editor-option-AM"));
    await waitFor(() => expect(screen.queryByTestId("history-editor")).toBeNull());
    expect(staffHistory("Aisha")).toContain("AM");
    await waitFor(() => expect(document.activeElement).toBe(slot));
  });

  it("Clear commits AND returns focus to the very history slot", async () => {
    const slot = openHistoryEditor();
    fireEvent.click(screen.getByTestId("history-editor-clear"));
    await waitFor(() => expect(screen.queryByTestId("history-editor")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(slot));
  });

  it("opens from the keyboard and returns focus there too", async () => {
    seed(HISTORY_SEED);
    render(<RequestsEditor />);
    const slot = screen.getByTestId("hist-Aisha-2");
    slot.focus();
    await userEvent.keyboard(" ");
    expect(screen.getByTestId("history-editor")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("history-editor-done"));
    await waitFor(() => expect(document.activeElement).toBe(slot));
  });

  it("does not steal focus when the captured history origin has left the document", async () => {
    const slot = openHistoryEditor();
    slot.remove();
    const parked = document.createElement("button");
    document.body.append(parked);

    fireEvent.click(screen.getByTestId("history-editor-done"));
    await waitFor(() => expect(screen.queryByTestId("history-editor")).toBeNull());
    parked.focus();
    await waitFor(() => expect(document.activeElement).toBe(parked));
    parked.remove();
  });
});

describe("RequestsEditor — leave copy (FR-SR-48)", () => {
  it("does not promise a built-in 8h contracted-hours credit", () => {
    seed(BASE_SEED);
    render(<RequestsEditor />);
    expect(screen.queryByText(/credits 8h/i)).not.toBeInTheDocument();
  });
});
