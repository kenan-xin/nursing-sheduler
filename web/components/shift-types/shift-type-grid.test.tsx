// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { RequirementCard, ScenarioUiState } from "@/lib/scenario";
import {
  drainScenarioPersist,
  resetToNewScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { ShiftTypeGrid } from "./shift-type-grid";

// DR-3 presentation contract for the bespoke Shifts card-grid. Everything commits
// through the real scenario store (one composed state ⇒ one zundo entry). The
// Min/Preferred staffing tie-in is DR-4 and is deliberately absent here — this suite
// proves the card SHELL: reserved OFF/LEAVE locked, working-time reuse + derivation,
// bare-duration preservation, clear-working-time, rename cascade, drag/keyboard
// reorder, and the shared GroupsSection driven with the Shift config.

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/shift-types",
}));

function seed(patch: Partial<ScenarioUiState>) {
  act(() => {
    useScenarioStore.getState().mutateScenario(patch);
  });
}
function shifts() {
  return useScenarioStore.getState().shifts;
}
function shiftGroups() {
  return useScenarioStore.getState().shiftGroups;
}
function historyLength() {
  return useScenarioStore.temporal.getState().pastStates.length;
}
function requirements() {
  return useScenarioStore.getState().cardsByKind.requirements;
}
function requirement(overrides: Partial<RequirementCard> = {}): RequirementCard {
  return {
    uid: "req-day",
    shiftType: ["Day"],
    requiredNumPeople: 2,
    qualifiedPeople: ["ALL"],
    date: ["ALL"],
    weight: -50,
    ...overrides,
  };
}
function seedRequirements(cards: RequirementCard[], patch: Partial<ScenarioUiState> = {}) {
  seed({
    ...patch,
    cardsByKind: {
      ...useScenarioStore.getState().cardsByKind,
      requirements: cards,
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetToNewScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
  seed({ shifts: [], shiftGroups: [] });
});

afterEach(() => {
  cleanup();
});

describe("ShiftTypeGrid — reserved day-states", () => {
  it("renders OFF/LEAVE locked (AUTO) with a reason and no edit control", () => {
    render(<ShiftTypeGrid />);

    const off = screen.getByTestId("synthetic-OFF");
    const leave = screen.getByTestId("synthetic-LEAVE");
    expect(off).toBeInTheDocument();
    expect(leave).toBeInTheDocument();

    // Lock + plain-language reason, never a raw disabled control.
    expect(within(off).getByText("Auto")).toBeInTheDocument();
    expect(screen.getByTestId("synthetic-OFF-reason")).toBeInTheDocument();
    expect(within(off).queryByRole("button")).toBeNull();
    // Reserved cards are never editable and carry no drag affordance.
    expect(screen.queryByTestId("shift-edit-OFF")).toBeNull();
    expect(off).not.toHaveAttribute("draggable");
  });
});

describe("ShiftTypeGrid — add + working-time reuse", () => {
  it("adds a clock shift, shows the derivation, and persists working time", () => {
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("add-shift-toggle"));
    fireEvent.change(screen.getByTestId("shift-add-code"), { target: { value: "Day" } });
    fireEvent.change(screen.getByTestId("shift-add-name"), { target: { value: "Day shift" } });
    fireEvent.change(screen.getByTestId("shift-add-start"), { target: { value: "08:00" } });
    fireEvent.change(screen.getByTestId("shift-add-end"), { target: { value: "16:00" } });

    // Working(auto) derivation is visible whenever start+end are set.
    const duration = screen.getByTestId("shift-add-duration");
    expect(duration).toHaveTextContent("8h");
    expect(duration).toHaveTextContent(/no rest/);

    fireEvent.click(screen.getByTestId("shift-add-save"));

    expect(shifts().find((s) => s.id === "Day")).toMatchObject({
      id: "Day",
      description: "Day shift",
      startTime: "08:00",
      endTime: "16:00",
      durationMinutes: 480,
    });
  });

  it("shows the +1 day overnight badge for a wrap-around clock", () => {
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("add-shift-toggle"));
    fireEvent.change(screen.getByTestId("shift-add-start"), { target: { value: "20:00" } });
    fireEvent.change(screen.getByTestId("shift-add-end"), { target: { value: "04:00" } });

    expect(screen.getByText("+1 day")).toBeInTheDocument();
    expect(screen.getByTestId("shift-add-duration")).toHaveTextContent("8h");
  });

  it("blocks save on an equal start/end and surfaces the working-time error", () => {
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("add-shift-toggle"));
    fireEvent.change(screen.getByTestId("shift-add-code"), { target: { value: "Bad" } });
    fireEvent.change(screen.getByTestId("shift-add-start"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByTestId("shift-add-end"), { target: { value: "09:00" } });

    expect(screen.getByTestId("shift-add-wt-error")).toBeInTheDocument();
    expect(screen.getByTestId("shift-add-save")).toBeDisabled();
  });
});

describe("ShiftTypeGrid — edit", () => {
  it("preserves a bare durationMinutes through an unrelated edit (no clocks injected)", () => {
    seed({ shifts: [{ id: "Flex", durationMinutes: 480 }], shiftGroups: [] });
    render(<ShiftTypeGrid />);

    expect(screen.getByTestId("shift-code-string:Flex")).toHaveClass("uppercase");
    fireEvent.click(screen.getByTestId("shift-edit-string:Flex"));
    fireEvent.change(screen.getByTestId("shift-edit-string:Flex-name"), {
      target: { value: "Flexible shift" },
    });
    fireEvent.click(screen.getByTestId("shift-edit-string:Flex-save"));

    const flex = shifts().find((s) => s.id === "Flex");
    expect(flex?.durationMinutes).toBe(480);
    expect(flex?.startTime ?? null).toBeNull();
    expect(flex?.endTime ?? null).toBeNull();
    expect(flex?.description).toBe("Flexible shift");
  });

  it("clears working time on edit and persists it as removal", () => {
    seed({
      shifts: [{ id: "Day", startTime: "08:00", endTime: "16:00", durationMinutes: 480 }],
      shiftGroups: [],
    });
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-wt-clear"));
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));

    const day = shifts().find((s) => s.id === "Day");
    expect(day?.startTime ?? null).toBeNull();
    expect(day?.endTime ?? null).toBeNull();
    expect(day?.durationMinutes ?? null).toBeNull();
    expect(day?.restMinutes ?? null).toBeNull();
  });

  it("renames the code in one Save and cascades the group membership", () => {
    seed({
      shifts: [{ id: "Day" }],
      shiftGroups: [{ id: "Working", members: ["Day"] }],
    });
    render(<ShiftTypeGrid />);

    const before = historyLength();
    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-code"), {
      target: { value: "AM" },
    });
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));

    expect(shifts().map((s) => s.id)).toEqual(["AM"]);
    expect(shiftGroups().find((g) => g.id === "Working")?.members).toEqual(["AM"]);
    expect(historyLength()).toBe(before + 1);
  });
});

describe("ShiftTypeGrid — staffing states", () => {
  it("distinguishes no requirement (—) from a real zero and offers safe creation", () => {
    seed({ shifts: [{ id: "Day" }, { id: "Night" }], shiftGroups: [] });
    seedRequirements([requirement({ shiftType: ["Night"], requiredNumPeople: 0 })]);
    render(<ShiftTypeGrid />);

    expect(screen.getByTestId("staffing-min-string:Day")).toHaveTextContent("—");
    expect(screen.getByTestId("staffing-min-string:Night")).toHaveTextContent("0");

    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    expect(screen.getByTestId("shift-edit-string:Day-staffing-create-note")).toHaveTextContent(
      "Creates a rule for all nurses on every date.",
    );
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-required"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));

    expect(requirements()).toHaveLength(2);
    expect(requirements()[1]).toMatchObject({
      shiftType: ["Day"],
      qualifiedPeople: ["ALL"],
      date: ["ALL"],
      requiredNumPeople: 3,
      weight: -1,
    });
  });

  it("treats a disabled baseline as no coverage and never edits the inactive card", () => {
    const disabled = requirement({ disabled: true });
    seed({ shifts: [{ id: "Day" }], shiftGroups: [] });
    seedRequirements([disabled]);
    render(<ShiftTypeGrid />);

    expect(screen.getByTestId("staffing-min-string:Day")).toHaveTextContent("—");
    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    expect(screen.getByTestId("shift-edit-string:Day-staffing-create-note")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-required"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));

    expect(requirements()).toHaveLength(2);
    expect(requirements()[0]).toBe(disabled);
    expect(requirements()[1].requiredNumPeople).toBe(4);
  });

  it("renders an editable baseline with linked qualifier/date context chips", () => {
    seed({ shifts: [{ id: "Day" }], shiftGroups: [] });
    seedRequirements(
      [
        requirement(),
        requirement({ uid: "qualified", qualifiedPeople: ["Seniors"] }),
        requirement({ uid: "weekend", date: ["2026-07-05"] }),
      ],
      {
        rangeStart: "2026-07-01",
        rangeEnd: "2026-07-07",
      },
    );
    render(<ShiftTypeGrid />);

    expect(screen.getByTestId("staffing-editable-string:Day")).toBeInTheDocument();
    for (const name of [
      "Seniors only, manage staffing requirements",
      "+1 date variant, manage staffing requirements",
    ]) {
      expect(screen.getByRole("link", { name })).toHaveAttribute(
        "href",
        "/shift-type-requirements",
      );
    }
    expect(screen.queryByTestId("requirement-delete")).not.toBeInTheDocument();
  });

  it("surfaces duplicate baselines while editing the first one", () => {
    seed({ shifts: [{ id: "Day" }], shiftGroups: [] });
    seedRequirements([
      requirement({ uid: "first" }),
      requirement({ uid: "second", requiredNumPeople: 8 }),
    ]);
    render(<ShiftTypeGrid />);

    expect(
      screen.getByRole("link", {
        name: "+1 overlapping baseline, manage staffing requirements",
      }),
    ).toHaveAttribute("href", "/shift-type-requirements");

    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-required"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));
    expect(requirements().map((card) => card.requiredNumPeople)).toEqual([5, 8]);
  });

  it.each([
    {
      name: "qualified",
      card: requirement({ qualifiedPeople: ["Seniors"] }),
      patch: {},
      rule: "Set by a skill rule (Seniors: 2 nurses).",
    },
    {
      name: "date",
      card: requirement({ date: ["2026-07-01"] }),
      patch: { rangeStart: "2026-07-01", rangeEnd: "2026-07-07" },
      rule: "Set by a date rule (2026-07-01: 2 nurses).",
    },
    {
      name: "group",
      card: requirement({ shiftType: ["WORKING"] }),
      patch: { shiftGroups: [{ id: "WORKING", members: ["Day"] }] },
      rule: "Set by the WORKING group — it staffs every shift in the group together (2 nurses).",
    },
    {
      name: "multi-target",
      card: requirement({ shiftType: ["Day", "Night"] }),
      patch: { shifts: [{ id: "Day" }, { id: "Night" }] },
      rule: "Set by a rule that staffs Day + Night together (2 nurses).",
    },
  ])(
    "renders $name-only coverage read-only with value, reason, and deep-link",
    ({ card, patch, rule }) => {
      seed({ shifts: [{ id: "Day" }], shiftGroups: [], ...patch });
      seedRequirements([card]);
      render(<ShiftTypeGrid />);

      const region = screen.getByTestId("staffing-readonly-string:Day");
      expect(within(region).getByTestId("staffing-min-string:Day")).toHaveTextContent("2");
      expect(within(region).getByText(rule)).toBeInTheDocument();
      expect(within(region).getByText(/make the roster impossible to build/i)).toBeInTheDocument();
      expect(within(region).getByRole("link")).toHaveAttribute("href", "/shift-type-requirements");

      fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
      expect(screen.getByTestId("shift-edit-string:Day-staffing-readonly")).toBeInTheDocument();
      expect(screen.queryByTestId("shift-edit-string:Day-required")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));
      expect(requirements()).toHaveLength(1);
      expect(requirements()[0].uid).toBe(card.uid);
    },
  );

  it("gates numeric IDs with an explanation and never renders numeric staffing inputs", () => {
    seed({ shifts: [{ id: 7 }], shiftGroups: [] });
    render(<ShiftTypeGrid />);

    expect(screen.getByTestId("staffing-numeric-number:7")).toHaveTextContent(
      "Give this shift a text code to set staffing here.",
    );
    fireEvent.click(screen.getByTestId("shift-edit-number:7"));
    expect(screen.getByTestId("shift-edit-number:7-staffing-numeric")).toBeInTheDocument();
    expect(screen.queryByTestId("shift-edit-number:7-required")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("shift-edit-number:7-save"));
    expect(requirements()).toHaveLength(0);
  });

  it("forbids a new numeric-only code with an inline error and blocks save", () => {
    render(<ShiftTypeGrid />);
    fireEvent.click(screen.getByTestId("add-shift-toggle"));
    fireEvent.change(screen.getByTestId("shift-add-code"), { target: { value: "1" } });
    expect(screen.getByText(/at least one letter/i)).toBeInTheDocument();
    expect(screen.getByTestId("shift-add-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("shift-add-code"), { target: { value: "N2" } });
    expect(screen.queryByText(/at least one letter/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("shift-add-save")).not.toBeDisabled();
  });
});

describe("ShiftTypeGrid — atomic staffing save", () => {
  it("keeps rename cascades and post-rename refs in one real-store undo entry", () => {
    seed({
      shifts: [{ id: "Day" }],
      shiftGroups: [{ id: "WORKING", members: ["Day"] }],
    });
    seedRequirements([requirement()]);
    render(<ShiftTypeGrid />);

    const before = historyLength();
    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-code"), {
      target: { value: "AM" },
    });
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-required"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));

    expect(historyLength()).toBe(before + 1);
    expect(shifts().map((shift) => shift.id)).toEqual(["AM"]);
    expect(shiftGroups()[0].members).toEqual(["AM"]);
    expect(requirements()[0]).toMatchObject({
      shiftType: ["AM"],
      requiredNumPeople: 4,
    });
  });

  it("aborts a stale baseline with an on-card notice and zero additional writes", () => {
    const original = requirement();
    seed({ shifts: [{ id: "Day" }], shiftGroups: [] });
    seedRequirements([original]);
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    seedRequirements([{ ...original, requiredNumPeople: 7 }]);
    const beforeSave = historyLength();
    const liveBefore = requirements()[0];

    fireEvent.change(screen.getByTestId("shift-edit-string:Day-required"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));

    expect(screen.getByTestId("shift-edit-string:Day-save-error")).toHaveTextContent(
      /changed elsewhere.*reopen/i,
    );
    expect(historyLength()).toBe(beforeSave);
    expect(requirements()[0]).toBe(liveBefore);
    expect(shifts()[0].id).toBe("Day");
  });

  it("surfaces validation and rename-collision failures on-card with zero writes", () => {
    seed({ shifts: [{ id: "Day" }, { id: "Night" }], shiftGroups: [] });
    seedRequirements([requirement()]);
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    const beforeInvalid = historyLength();
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-required"), {
      target: { value: "-1" },
    });
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));
    expect(screen.getByTestId("shift-edit-string:Day-save-error")).toHaveTextContent(
      "Required number of people must be at least 0",
    );
    expect(historyLength()).toBe(beforeInvalid);

    fireEvent.change(screen.getByTestId("shift-edit-string:Day-code"), {
      target: { value: "Night" },
    });
    expect(screen.getByText(/already used/i)).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("shift-edit-string:Day-save")).toBeDisabled();
    expect(historyLength()).toBe(beforeInvalid);
  });

  it("shows EDGE-PR-03 before save, then persists preferred/weight collapse", () => {
    seed({ shifts: [{ id: "Day" }], shiftGroups: [] });
    seedRequirements([requirement({ preferredNumPeople: 3, weight: -25 })]);
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-preferred"), {
      target: { value: "2" },
    });
    expect(screen.getByTestId("shift-edit-string:Day-preferred-collapse")).toHaveTextContent(
      "weight reset from -25 to -1",
    );
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));

    expect(requirements()[0].preferredNumPeople).toBeUndefined();
    expect(requirements()[0].weight).toBe(-1);
    expect(screen.getByTestId("staffing-editable-string:Day")).toHaveTextContent("Preferred—");
  });
});

describe("ShiftTypeGrid — reorder", () => {
  it("reorders cards by keyboard (Up/Down) — one commit / one undo entry", () => {
    seed({ shifts: [{ id: "A" }, { id: "B" }, { id: "C" }], shiftGroups: [] });
    render(<ShiftTypeGrid />);

    // Boundary controls are disabled (self-explanatory, never write).
    expect(screen.getByTestId("shift-move-up-string:A")).toBeDisabled();
    expect(screen.getByTestId("shift-move-down-string:C")).toBeDisabled();

    const before = historyLength();
    fireEvent.click(screen.getByTestId("shift-move-down-string:A"));

    expect(shifts().map((s) => s.id)).toEqual(["B", "A", "C"]);
    expect(historyLength()).toBe(before + 1);

    act(() => {
      useScenarioStore.temporal.getState().undo();
    });
    expect(shifts().map((s) => s.id)).toEqual(["A", "B", "C"]);
  });
});

describe("ShiftTypeGrid — Shift groups (shared GroupsSection, Shift config)", () => {
  it("uses the 'N TYPES' count noun and duplicates a group keeping members", () => {
    seed({
      shifts: [{ id: "Day" }, { id: "Night" }],
      shiftGroups: [{ id: "Working", members: ["Day", "Night"] }],
    });
    render(<ShiftTypeGrid />);

    // Shift config: count noun is "N TYPES" (not "N members").
    expect(
      within(screen.getByTestId("group-row-Working")).getByText("2 TYPES"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("group-dup-Working"));

    expect(shiftGroups().find((g) => g.id === "Working copy")?.members).toEqual(["Day", "Night"]);
  });

  it("hides the member search box (Shift config) in the group editor", () => {
    seed({ shifts: [{ id: "Day" }], shiftGroups: [{ id: "Working", members: [] }] });
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("group-edit-Working"));
    expect(screen.queryByTestId("transfer-search-Working")).not.toBeInTheDocument();
    expect(screen.getByText("IN GROUP")).toBeInTheDocument();
  });
});
