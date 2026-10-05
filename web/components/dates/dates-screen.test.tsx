// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { scenarioCommands, useScenarioStore } from "@/lib/store";
import { resetScenarioForTest, drainScenarioCommands } from "@/lib/store/test-authority";
import { DatesScreen } from "./dates-screen";

// llmu: a date-group member change drops the date exceptions the group no longer
// covers (setGroupMembers); the Save must say so and offer Undo, not drop silently.

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/dates",
}));

beforeEach(async () => {
  vi.clearAllMocks();
  await resetScenarioForTest();
  await drainScenarioCommands();
});
afterEach(() => cleanup());

const overrides = () =>
  useScenarioStore.getState().cardsByKind.requirements[0]?.requiredNumPeopleOverrides ?? [];

describe("DatesScreen — date-group Save", () => {
  it("reports the date exceptions a member change drops, with Undo", async () => {
    const empty = createEmptyScenarioUiState();
    await act(async () => {
      await scenarioCommands.mutate({
        rangeStart: "2026-07-01",
        rangeEnd: "2026-07-31",
        shifts: [{ id: "D" }],
        dateGroups: [{ id: "PH", members: ["02"] }],
        cardsByKind: {
          ...empty.cardsByKind,
          requirements: [
            {
              uid: "r1",
              shiftType: ["D"],
              requiredNumPeople: 3,
              qualifiedPeople: ["ALL"],
              date: ["PH"],
              requiredNumPeopleOverrides: [["2026-07-02", 1]],
              weight: -1,
            },
          ],
        },
      } as Partial<ScenarioUiState>);
    });
    render(<DatesScreen />);

    fireEvent.click(screen.getByTestId("editable-group-edit-PH"));
    fireEvent.click(screen.getByTestId("date-scope-picker-clear"));
    fireEvent.click(screen.getByTestId("date-group-save"));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Saved date group “PH”; removed 1 date exception.",
        expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
      ),
    );
    await drainScenarioCommands();
    expect(overrides()).toEqual([]);

    const action = vi.mocked(toast).mock.calls[0][1]?.action as unknown as { onClick: () => void };
    await act(async () => {
      action.onClick();
      await drainScenarioCommands();
    });
    expect(overrides()).toEqual([["2026-07-02", 1]]);
  });

  it("stays quiet when the member change drops nothing", async () => {
    await act(async () => {
      await scenarioCommands.mutate({
        rangeStart: "2026-07-01",
        rangeEnd: "2026-07-31",
        dateGroups: [{ id: "PH", members: ["02"] }],
      });
    });
    render(<DatesScreen />);

    fireEvent.click(screen.getByTestId("editable-group-edit-PH"));
    fireEvent.click(screen.getByTestId("date-scope-picker-clear"));
    fireEvent.click(screen.getByTestId("date-group-save"));

    await drainScenarioCommands();
    expect(useScenarioStore.getState().dateGroups.find((g) => g.id === "PH")?.members).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });
});
