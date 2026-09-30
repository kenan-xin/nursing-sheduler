// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createEmptyScenarioUiState, RECENT_SCHEDULES_LIMIT } from "@/lib/scenario";
import { loadScenario, scenarioCommands, useAuthorityStore, useScenarioStore } from "@/lib/store";
import { drainScenarioCommands, resetScenarioForTest } from "@/lib/store/test-authority";
import { lastEditedLabel, RecentSchedulesCard } from "./recent-schedules-card";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  await resetScenarioForTest();
  await drainScenarioCommands();
});

afterEach(() => {
  cleanup();
});

/** Load a Ward 3 schedule for one month of 2025; returns its id. */
async function loadMonth(month: string, ward = "Ward 3"): Promise<string> {
  const lastDay = new Date(Date.UTC(2025, Number(month), 0)).getUTCDate();
  const outcome = await loadScenario({
    ...createEmptyScenarioUiState(),
    meta: { apiVersion: "alpha", description: ward },
    rangeStart: `2025-${month}-01`,
    rangeEnd: `2025-${month}-${lastDay}`,
  });
  expect(outcome.ok).toBe(true);
  return useAuthorityStore.getState().scenarioId!;
}

function rowNamed(name: string): HTMLElement {
  const row = screen
    .getAllByTestId("recent-schedule-row")
    .find((candidate) => within(candidate).queryByText(name, { exact: true }));
  if (!row) throw new Error(`no row named ${name}`);
  return row;
}

describe("RecentSchedulesCard", () => {
  it("lists past schedules newest first with auto names, and marks the open one", async () => {
    await loadMonth("09");
    await loadMonth("10");
    await loadMonth("11");
    render(<RecentSchedulesCard />);

    const rows = await screen.findAllByTestId("recent-schedule-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Ward 3 · November 2025"),
      expect.stringContaining("Ward 3 · October 2025"),
      expect.stringContaining("Ward 3 · September 2025"),
    ]);
    expect(within(rows[0]!).getByText("Open here")).toBeInTheDocument();
    // The open one has no Open (or Delete) button: nothing to switch to.
    expect(within(rows[0]!).queryByRole("button", { name: /^Open / })).toBeNull();
    expect(within(rows[0]!).queryByRole("button", { name: /^Delete / })).toBeNull();
    expect(within(rows[1]!).getByText(/Last edited/)).toBeInTheDocument();
  });

  it("opens a past schedule in this tab", async () => {
    await loadMonth("09");
    await loadMonth("10");
    const onOpened = vi.fn();
    render(<RecentSchedulesCard onOpened={onOpened} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Ward 3 · September 2025" }));
    await waitFor(() => expect(useScenarioStore.getState().rangeStart).toBe("2025-09-01"));
    expect(onOpened).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        within(rowNamed("Ward 3 · September 2025")).getByText("Open here"),
      ).toBeInTheDocument(),
    );
  });

  it("renames with the keyboard, and an empty name brings the auto-name back", async () => {
    await loadMonth("09");
    render(<RecentSchedulesCard />);

    fireEvent.click(await screen.findByRole("button", { name: "Rename Ward 3 · September 2025" }));
    const input = screen.getByLabelText("Schedule name");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "September draft" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText("September draft")).toBeInTheDocument();
    // The auto-name stays visible beside a user name.
    expect(screen.getByText(/Ward 3 · September 2025 ·/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rename September draft" }));
    fireEvent.change(screen.getByLabelText("Schedule name"), { target: { value: "" } });
    fireEvent.submit(screen.getByLabelText("Schedule name").closest("form")!);
    expect(await screen.findByText("Ward 3 · September 2025")).toBeInTheDocument();

    // Escape cancels without saving.
    fireEvent.click(screen.getByRole("button", { name: "Rename Ward 3 · September 2025" }));
    fireEvent.keyDown(screen.getByLabelText("Schedule name"), { key: "Escape" });
    expect(screen.queryByLabelText("Schedule name")).toBeNull();
  });

  it("pins, asks the browser for persistent storage, and reports its answer honestly", async () => {
    await loadMonth("09");
    const requestPersist = vi.fn(async () => false);
    render(<RecentSchedulesCard requestPersist={requestPersist} />);

    const pin = await screen.findByRole("button", { name: "Pin Ward 3 · September 2025" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(pin);
    const unpin = await screen.findByRole("button", { name: "Unpin Ward 3 · September 2025" });
    expect(unpin).toHaveAttribute("aria-pressed", "true");
    expect(requestPersist).toHaveBeenCalledTimes(1);
    const { toast } = await import("sonner");
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("did not promise"));
    expect(within(rowNamed("Ward 3 · September 2025")).getByText("Pinned")).toBeInTheDocument();
  });

  it("deletes a past schedule only after confirming", async () => {
    await loadMonth("09");
    await loadMonth("10");
    render(<RecentSchedulesCard />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete Ward 3 · September 2025" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: 'Delete "Ward 3 · September 2025"?',
    });
    expect(dialog).toHaveTextContent("cannot be undone");
    expect(screen.getAllByTestId("recent-schedule-row")).toHaveLength(2);

    fireEvent.click(within(dialog).getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(screen.getAllByTestId("recent-schedule-row")).toHaveLength(1));
    expect(screen.queryByText("Ward 3 · September 2025")).toBeNull();
  });

  it("names the schedule the limit will remove before it happens", async () => {
    await loadMonth("01", "Oldest ward");
    for (let index = 1; index < RECENT_SCHEDULES_LIMIT; index += 1) await loadMonth("02");
    render(<RecentSchedulesCard />);

    const notice = await screen.findByTestId("recent-schedules-limit-notice");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveTextContent(
      'The next new or loaded schedule removes "Oldest ward · January 2025"',
    );
  });

  it("announces a schedule the limit removed", async () => {
    await loadMonth("01", "Oldest ward");
    for (let index = 1; index < RECENT_SCHEDULES_LIMIT; index += 1) await loadMonth("02");
    render(<RecentSchedulesCard />);
    await screen.findByTestId("recent-schedules-limit-notice");

    await loadMonth("03");
    const { toast } = await import("sonner");
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        `Removed "Oldest ward · January 2025" to stay within ${RECENT_SCHEDULES_LIMIT} unpinned schedules.`,
      ),
    );
  });
});

describe("RecentSchedulesCard — a reread outliving the card", () => {
  it("drops a list that settles after unmount instead of setting state on a dead tree", async () => {
    // The CI failure this pins (7vtc): a mount-time reread was still in flight when
    // the test file's jsdom was torn down, and its late `setSummaries` hit React's
    // `window.event` read. Here `window` is removed after unmount to stand in for
    // that teardown; a late setState would throw inside the voided refresh.
    let fail!: (error: Error) => void;
    const listSpy = vi
      .spyOn(scenarioCommands, "listSchedules")
      .mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const { unmount } = render(<RecentSchedulesCard />);
      await waitFor(() => expect(listSpy).toHaveBeenCalled());
      unmount();
      vi.stubGlobal("window", undefined);
      fail(new Error("storage gone"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      vi.unstubAllGlobals();
      process.off("unhandledRejection", onRejection);
      listSpy.mockRestore();
    }
    expect(rejections).toEqual([]);
  });
});

describe("lastEditedLabel", () => {
  it("reads as relative time", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    expect(lastEditedLabel("2026-09-27T12:00:00Z", now)).toBe("Last edited 3 days ago");
    expect(lastEditedLabel("2026-09-30T11:59:40Z", now)).toBe("Last edited just now");
  });
});
