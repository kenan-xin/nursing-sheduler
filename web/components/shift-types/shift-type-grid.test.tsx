// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { RequirementCard, ScenarioUiState } from "@/lib/scenario";
import { useScenarioStore, scenarioCommands } from "@/lib/store";
import { changeKeys } from "@/lib/change-highlight/keys";
import { clearChangeHighlight, showChangeHighlight } from "@/lib/change-highlight/store";
import { ShiftTypeGrid } from "./shift-type-grid";
import { resetScenarioForTest, drainScenarioCommands, undoDepth } from "@/lib/store/test-authority";

// DR-3 presentation contract for the bespoke Shifts card-grid. Everything commits
// through the real repository authority (one composed state ⇒ one undo entry). The
// Min/Preferred staffing tie-in is DR-4 and is deliberately absent here — this suite
// proves the card SHELL: reserved OFF/LEAVE locked, working-time reuse + derivation,
// bare-duration preservation, clear-working-time, rename cascade, drag/keyboard
// reorder, and the shared GroupsSection driven with the Shift config.

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/shift-types",
}));

async function seed(patch: Partial<ScenarioUiState>) {
  await act(async () => {
    await scenarioCommands.mutate(patch);
  });
}
async function shifts() {
  await drainScenarioCommands();
  return useScenarioStore.getState().shifts;
}
async function shiftGroups() {
  await drainScenarioCommands();
  return useScenarioStore.getState().shiftGroups;
}
async function historyLength(): Promise<number> {
  await drainScenarioCommands();
  return undoDepth();
}
/**
 * Let a clicked Save settle. T03: the card's Save awaits a queued repository
 * command, so its success toast, its on-card refusal notice, and the committed
 * projection all land a microtask later — draining inside `act` is the
 * deterministic seam for that, not a timeout.
 */
async function settleSave() {
  await act(async () => {
    await drainScenarioCommands();
  });
}
async function requirements() {
  await drainScenarioCommands();
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
async function seedRequirements(cards: RequirementCard[], patch: Partial<ScenarioUiState> = {}) {
  await seed({
    ...patch,
    cardsByKind: {
      ...useScenarioStore.getState().cardsByKind,
      requirements: cards,
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetScenarioForTest();
  await drainScenarioCommands();
  await seed({ shifts: [], shiftGroups: [] });
});

afterEach(async () => {
  cleanup();
});

describe("ShiftTypeGrid — reserved day-states", () => {
  it("renders OFF/LEAVE locked (AUTO) with a reason and no edit control", async () => {
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
  it("adds a clock shift, shows the derivation, and persists working time", async () => {
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("add-shift-toggle"));
    fireEvent.change(screen.getByTestId("shift-add-code"), { target: { value: "Day" } });
    fireEvent.change(screen.getByTestId("shift-add-name"), { target: { value: "Day shift" } });
    fireEvent.change(screen.getByTestId("shift-add-start"), { target: { value: "08:00" } });
    fireEvent.change(screen.getByTestId("shift-add-end"), { target: { value: "16:00" } });

    // Working(auto) derivation is visible whenever start+end are set.
    const duration = screen.getByTestId("shift-add-duration");
    expect(duration).toHaveTextContent("8h");
    // No rest is written "− 0", keeping the caption one arithmetic shape throughout.
    expect(duration).toHaveTextContent("= 8h − 0");

    fireEvent.click(screen.getByTestId("shift-add-save"));

    // The code input now stores its value uppercase, so typing "Day" saves as "DAY".
    expect((await shifts()).find((s) => s.id === "DAY")).toMatchObject({
      id: "DAY",
      description: "Day shift",
      startTime: "08:00",
      endTime: "16:00",
      durationMinutes: 480,
    });
  });

  it("reads a half-hour shift in decimal hours with a compact rest caption", async () => {
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("add-shift-toggle"));
    fireEvent.change(screen.getByTestId("shift-add-start"), { target: { value: "07:00" } });
    fireEvent.change(screen.getByTestId("shift-add-end"), { target: { value: "19:00" } });
    fireEvent.change(screen.getByTestId("shift-add-rest"), { target: { value: "30" } });

    // Rest keeps the prototype's hours-and-minutes form, with the zero hour dropped.
    const rest = screen.getByTestId("shift-add-rest") as HTMLSelectElement;
    expect(rest.selectedOptions[0]?.textContent).toBe("30m");

    // The paid figure is decimal (the prototype's fmtH) and the caption below it
    // carries the whole derivation. The leading `=` is load-bearing: without it
    // "11.5h − 30m" reads as a subtraction still to do.
    const duration = screen.getByTestId("shift-add-duration");
    expect(duration).toHaveTextContent("11.5h");
    expect(duration).toHaveTextContent("= 12h − 30m");
    expect(duration).toHaveAttribute("title", "11.5h working = 12h on floor − 30m rest");
  });

  it("shows the +1 day overnight badge for a wrap-around clock", async () => {
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("add-shift-toggle"));
    fireEvent.change(screen.getByTestId("shift-add-start"), { target: { value: "20:00" } });
    fireEvent.change(screen.getByTestId("shift-add-end"), { target: { value: "04:00" } });

    expect(screen.getByText("+1 day")).toBeInTheDocument();
    expect(screen.getByTestId("shift-add-duration")).toHaveTextContent("8h");
  });

  it("blocks save on an equal start/end and surfaces the working-time error", async () => {
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
  it("preserves a bare durationMinutes through an unrelated edit (no clocks injected)", async () => {
    await seed({ shifts: [{ id: "Flex", durationMinutes: 480 }], shiftGroups: [] });
    render(<ShiftTypeGrid />);

    expect(screen.getByTestId("shift-code-string:Flex")).toHaveClass("uppercase");
    fireEvent.click(screen.getByTestId("shift-edit-string:Flex"));
    fireEvent.change(screen.getByTestId("shift-edit-string:Flex-name"), {
      target: { value: "Flexible shift" },
    });
    fireEvent.click(screen.getByTestId("shift-edit-string:Flex-save"));

    const flex = (await shifts()).find((s) => s.id === "Flex");
    expect(flex?.durationMinutes).toBe(480);
    expect(flex?.startTime ?? null).toBeNull();
    expect(flex?.endTime ?? null).toBeNull();
    expect(flex?.description).toBe("Flexible shift");
  });

  it("clears working time on edit and persists it as removal", async () => {
    await seed({
      shifts: [{ id: "Day", startTime: "08:00", endTime: "16:00", durationMinutes: 480 }],
      shiftGroups: [],
    });
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-start"), { target: { value: "" } });
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-end"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));

    const day = (await shifts()).find((s) => s.id === "Day");
    expect(day?.startTime ?? null).toBeNull();
    expect(day?.endTime ?? null).toBeNull();
    expect(day?.durationMinutes ?? null).toBeNull();
    expect(day?.restMinutes ?? null).toBeNull();
  });

  it("renames the code in one Save and cascades the group membership", async () => {
    await seed({
      shifts: [{ id: "Day" }],
      shiftGroups: [{ id: "Working", members: ["Day"] }],
    });
    render(<ShiftTypeGrid />);

    const before = await historyLength();
    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-code"), {
      target: { value: "AM" },
    });
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));

    expect((await shifts()).map((s) => s.id)).toEqual(["AM"]);
    expect((await shiftGroups()).find((g) => g.id === "Working")?.members).toEqual(["AM"]);
    expect(await historyLength()).toBe(before + 1);
  });
});

describe("ShiftTypeGrid — staffing states", () => {
  it("distinguishes no requirement (—) from a real zero and offers safe creation", async () => {
    await seed({ shifts: [{ id: "Day" }, { id: "Night" }], shiftGroups: [] });
    await seedRequirements([requirement({ shiftType: ["Night"], requiredNumPeople: 0 })]);
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

    expect(await requirements()).toHaveLength(2);
    expect((await requirements())[1]).toMatchObject({
      shiftType: ["Day"],
      qualifiedPeople: ["ALL"],
      date: ["ALL"],
      requiredNumPeople: 3,
      weight: -1,
    });
  });

  it("treats a disabled baseline as no coverage and never edits the inactive card", async () => {
    const disabled = requirement({ disabled: true });
    await seed({ shifts: [{ id: "Day" }], shiftGroups: [] });
    await seedRequirements([disabled]);
    render(<ShiftTypeGrid />);

    expect(screen.getByTestId("staffing-min-string:Day")).toHaveTextContent("—");
    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    expect(screen.getByTestId("shift-edit-string:Day-staffing-create-note")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-required"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));

    expect(await requirements()).toHaveLength(2);
    expect((await requirements())[0]).toBe(disabled);
    expect((await requirements())[1].requiredNumPeople).toBe(4);
  });

  it("renders an editable baseline with linked qualifier/date context chips", async () => {
    await seed({ shifts: [{ id: "Day" }], shiftGroups: [] });
    await seedRequirements(
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

  it("shows a rule's per-date exceptions beside the base Minimum", async () => {
    await seed({
      shifts: [{ id: "Day" }],
      shiftGroups: [],
      rangeStart: "2026-07-01",
      rangeEnd: "2026-07-07",
    });
    await seedRequirements([
      requirement({
        requiredNumPeopleOverrides: [
          ["2026-07-03", 1],
          ["2026-07-05", 3],
        ],
      }),
    ]);
    render(<ShiftTypeGrid />);

    // The base head count is untouched — the per-date exceptions sit beside it.
    expect(screen.getByTestId("staffing-min-string:Day")).toHaveTextContent("2");
    expect(screen.getByTestId("staffing-exceptions-string:Day")).toHaveTextContent(
      "3 Jul: 1 · 5 Jul: 3",
    );
  });

  it("shows exceptions for a read-only rule too", async () => {
    await seed({ shifts: [{ id: "Day" }], shiftGroups: [] });
    await seedRequirements([
      requirement({
        qualifiedPeople: ["Seniors"],
        requiredNumPeopleOverrides: [["2026-07-03", 1]],
      }),
    ]);
    render(<ShiftTypeGrid />);

    const region = screen.getByTestId("staffing-readonly-string:Day");
    expect(within(region).getByTestId("staffing-exceptions-string:Day")).toHaveTextContent(
      "3 Jul: 1",
    );
  });

  it("surfaces per-date exceptions in the edit form under Minimum nurses and deep-links to Requirements", async () => {
    await seed({ shifts: [{ id: "Day" }], shiftGroups: [] });
    await seedRequirements([
      requirement({
        requiredNumPeopleOverrides: [
          ["2026-07-03", 1],
          ["2026-07-05", 3],
        ],
      }),
    ]);
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    const line = screen.getByTestId("shift-edit-string:Day-staffing-exceptions");
    expect(line).toHaveTextContent("Exceptions: 3 Jul: 1 · 5 Jul: 3 — edit in Requirements");
    expect(within(line).getByRole("link", { name: "edit in Requirements" })).toHaveAttribute(
      "href",
      "/shift-type-requirements",
    );
  });

  it("omits the edit-form exceptions line when the rule has no per-date overrides", async () => {
    await seed({ shifts: [{ id: "Day" }], shiftGroups: [] });
    await seedRequirements([requirement()]);
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    expect(
      screen.queryByTestId("shift-edit-string:Day-staffing-exceptions"),
    ).not.toBeInTheDocument();
  });

  it("surfaces duplicate baselines while editing the first one", async () => {
    await seed({ shifts: [{ id: "Day" }], shiftGroups: [] });
    await seedRequirements([
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
    expect((await requirements()).map((card) => card.requiredNumPeople)).toEqual([5, 8]);
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
    async ({ card, patch, rule }) => {
      await seed({ shifts: [{ id: "Day" }], shiftGroups: [], ...patch });
      await seedRequirements([card]);
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
      expect(await requirements()).toHaveLength(1);
      expect((await requirements())[0].uid).toBe(card.uid);
    },
  );

  it("gates numeric IDs with an explanation and never renders numeric staffing inputs", async () => {
    await seed({ shifts: [{ id: 7 }], shiftGroups: [] });
    render(<ShiftTypeGrid />);

    expect(screen.getByTestId("staffing-numeric-number:7")).toHaveTextContent(
      "Give this shift a text code to set staffing here.",
    );
    fireEvent.click(screen.getByTestId("shift-edit-number:7"));
    expect(screen.getByTestId("shift-edit-number:7-staffing-numeric")).toBeInTheDocument();
    expect(screen.queryByTestId("shift-edit-number:7-required")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("shift-edit-number:7-save"));
    expect(await requirements()).toHaveLength(0);
  });

  it("forbids a new numeric-only code with an inline error and blocks save", async () => {
    render(<ShiftTypeGrid />);
    fireEvent.click(screen.getByTestId("add-shift-toggle"));
    fireEvent.change(screen.getByTestId("shift-add-code"), { target: { value: "1" } });
    expect(screen.getByText(/at least one letter/i)).toBeInTheDocument();
    expect(screen.getByTestId("shift-add-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("shift-add-code"), { target: { value: "N2" } });
    expect(screen.queryByText(/at least one letter/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("shift-add-save")).not.toBeDisabled();
  });

  it("blocks Enter from bypassing the numeric-only-code guard (button-disabled is not the only gate)", async () => {
    render(<ShiftTypeGrid />);
    fireEvent.click(screen.getByTestId("add-shift-toggle"));
    fireEvent.change(screen.getByTestId("shift-add-code"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("shift-add-required"), { target: { value: "3" } });
    // Enter in the Code input routes to save(), which must honor the same guard the
    // disabled button enforces — committing neither the shift nor a numeric selector.
    fireEvent.keyDown(screen.getByTestId("shift-add-code"), { key: "Enter" });

    expect(await shifts()).toHaveLength(0);
    expect(await requirements()).toHaveLength(0);
    expect(screen.getByTestId("shift-add-form")).toBeInTheDocument();
  });
});

describe("ShiftTypeGrid — atomic staffing save", () => {
  it("keeps rename cascades and post-rename refs in one real-store undo entry", async () => {
    await seed({
      shifts: [{ id: "Day" }],
      shiftGroups: [{ id: "WORKING", members: ["Day"] }],
    });
    await seedRequirements([requirement()]);
    render(<ShiftTypeGrid />);

    const before = await historyLength();
    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-code"), {
      target: { value: "AM" },
    });
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-required"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));
    await settleSave();

    expect(await historyLength()).toBe(before + 1);
    expect((await shifts()).map((shift) => shift.id)).toEqual(["AM"]);
    expect((await shiftGroups())[0].members).toEqual(["AM"]);
    expect((await requirements())[0]).toMatchObject({
      shiftType: ["AM"],
      requiredNumPeople: 4,
    });
  });

  it("aborts a stale baseline with an on-card notice and zero additional writes", async () => {
    const original = requirement();
    await seed({ shifts: [{ id: "Day" }], shiftGroups: [] });
    await seedRequirements([original]);
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    await seedRequirements([{ ...original, requiredNumPeople: 7 }]);
    const beforeSave = await historyLength();
    const liveBefore = (await requirements())[0];

    fireEvent.change(screen.getByTestId("shift-edit-string:Day-required"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));
    await settleSave();

    expect(screen.getByTestId("shift-edit-string:Day-save-error")).toHaveTextContent(
      /changed elsewhere.*reopen/i,
    );
    expect(await historyLength()).toBe(beforeSave);
    expect((await requirements())[0]).toBe(liveBefore);
    expect((await shifts())[0].id).toBe("Day");
  });

  it("surfaces validation and rename-collision failures on-card with zero writes", async () => {
    // The second id is seeded uppercase ("NIGHT") so that typing any case below,
    // once the code input's own uppercase transform runs, exactly collides with
    // it — exact-identity duplicate detection (validation.ts) never case-folds.
    await seed({ shifts: [{ id: "Day" }, { id: "NIGHT" }], shiftGroups: [] });
    await seedRequirements([requirement()]);
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    const beforeInvalid = await historyLength();
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-required"), {
      target: { value: "-1" },
    });
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));
    await settleSave();
    expect(screen.getByTestId("shift-edit-string:Day-save-error")).toHaveTextContent(
      "Required number of people must be at least 0",
    );
    expect(await historyLength()).toBe(beforeInvalid);

    fireEvent.change(screen.getByTestId("shift-edit-string:Day-code"), {
      target: { value: "Night" },
    });
    expect(screen.getByText(/already used/i)).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("shift-edit-string:Day-save")).toBeDisabled();
    expect(await historyLength()).toBe(beforeInvalid);
  });

  it("shows EDGE-PR-03 before save, then persists preferred/weight collapse", async () => {
    await seed({ shifts: [{ id: "Day" }], shiftGroups: [] });
    await seedRequirements([requirement({ preferredNumPeople: 3, weight: -25 })]);
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("shift-edit-string:Day"));
    fireEvent.change(screen.getByTestId("shift-edit-string:Day-preferred"), {
      target: { value: "2" },
    });
    expect(screen.getByTestId("shift-edit-string:Day-preferred-collapse")).toHaveTextContent(
      "weight reset from -25 to -1",
    );
    fireEvent.click(screen.getByTestId("shift-edit-string:Day-save"));
    await settleSave();

    expect((await requirements())[0].preferredNumPeople).toBeUndefined();
    expect((await requirements())[0].weight).toBe(-1);
    expect(screen.getByTestId("staffing-editable-string:Day")).toHaveTextContent("Preferred—");
  });
});

describe("ShiftTypeGrid — reorder", () => {
  it("reorders cards by keyboard (Up/Down) — one commit / one undo entry", async () => {
    await seed({ shifts: [{ id: "A" }, { id: "B" }, { id: "C" }], shiftGroups: [] });
    render(<ShiftTypeGrid />);

    // Boundary controls are disabled (self-explanatory, never write).
    expect(screen.getByTestId("shift-move-up-string:A")).toBeDisabled();
    expect(screen.getByTestId("shift-move-down-string:C")).toBeDisabled();

    const before = await historyLength();
    fireEvent.click(screen.getByTestId("shift-move-down-string:A"));

    expect((await shifts()).map((s) => s.id)).toEqual(["B", "A", "C"]);
    expect(await historyLength()).toBe(before + 1);

    await act(async () => {
      await scenarioCommands.undo();
    });
    expect((await shifts()).map((s) => s.id)).toEqual(["A", "B", "C"]);
  });
});

describe("ShiftTypeGrid — Shift groups (shared GroupsSection, Shift config)", () => {
  it("uses the 'N TYPES' count noun and duplicates a group keeping members", async () => {
    await seed({
      shifts: [{ id: "Day" }, { id: "Night" }],
      shiftGroups: [{ id: "Working", members: ["Day", "Night"] }],
    });
    render(<ShiftTypeGrid />);

    // Shift config: count noun is "N TYPES" (not "N members").
    expect(
      within(screen.getByTestId("group-row-Working")).getByText("2 TYPES"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("group-dup-Working"));

    expect((await shiftGroups()).find((g) => g.id === "Working copy")?.members).toEqual([
      "Day",
      "Night",
    ]);
  });

  it("hides the member search box (Shift config) in the group editor", async () => {
    await seed({ shifts: [{ id: "Day" }], shiftGroups: [{ id: "Working", members: [] }] });
    render(<ShiftTypeGrid />);

    fireEvent.click(screen.getByTestId("group-edit-Working"));
    expect(screen.queryByTestId("transfer-search-Working")).not.toBeInTheDocument();
    expect(screen.getByText("IN GROUP")).toBeInTheDocument();
  });
});

describe("ShiftTypeGrid — change highlight", () => {
  afterEach(() => clearChangeHighlight());
  it("outlines the shift card and shift group an Apply added", async () => {
    await seed({
      shifts: [{ id: "Day" }, { id: "EVE" }],
      shiftGroups: [{ id: "Late", members: ["EVE"] }],
    });
    render(<ShiftTypeGrid />);
    act(() => showChangeHighlight([changeKeys.shift("EVE"), changeKeys.shiftGroup("Late")]));
    expect(screen.getByTestId("shift-card-string:EVE")).toHaveAttribute(
      "data-change-highlight",
      "true",
    );
    expect(screen.getByTestId("shift-card-string:Day")).not.toHaveAttribute(
      "data-change-highlight",
    );
    expect(screen.getByTestId("group-row-Late")).toHaveAttribute("data-change-highlight", "true");
  });
});
