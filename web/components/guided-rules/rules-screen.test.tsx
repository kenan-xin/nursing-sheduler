// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { drainScenarioPersist, newScenario, useHotStore, useScenarioStore } from "@/lib/store";
import { RulesScreen } from "./rules-screen";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => "/rules",
}));

beforeEach(async () => {
  pushMock.mockClear();
  newScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
});

afterEach(() => {
  cleanup();
});

function seedRequirement() {
  useScenarioStore.getState().mutateScenario((state) => ({
    cardsByKind: {
      ...state.cardsByKind,
      requirements: [
        { uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1, description: "Day cap" },
      ],
    },
  }));
}

describe("RulesScreen — empty scenario", () => {
  it("always shows the built-in structural rule, locked and enabled", () => {
    render(<RulesScreen />);
    expect(screen.getByText("At most one shift per day")).toBeInTheDocument();
    const row = screen.getByTestId(/rule-row-builtin/);
    expect(within(row).getByText(/built-in/i)).toBeInTheDocument();
  });

  it("shows the empty state when no advanced constraints exist", () => {
    render(<RulesScreen />);
    expect(screen.getByTestId("rules-empty-state")).toBeInTheDocument();
  });
});

describe("RulesScreen — a linked (auto-derived) rule row", () => {
  beforeEach(() => {
    seedRequirement();
  });

  it("derives a row from the card with its own description as title", () => {
    render(<RulesScreen />);
    expect(screen.getByText("Day cap")).toBeInTheDocument();
  });

  it("toggling the switch off writes the card's disabled marker", () => {
    render(<RulesScreen />);
    const toggle = screen.getByTestId("rule-toggle-requirements:r1");
    fireEvent.click(toggle);
    expect(useScenarioStore.getState().cardsByKind.requirements[0].disabled).toBe(true);
  });

  it("Adjust opens the quick-edit panel and commits a valid value on blur", () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-requirements:r1"));
    const input = screen.getByTestId("rule-adjust-input-requirements:r1-requiredNumPeople");
    fireEvent.change(input, { target: { value: "5" } });
    // Typing alone must not write the store — the commit happens on blur.
    expect(useScenarioStore.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(2);
    fireEvent.blur(input, { target: { value: "5" } });
    expect(useScenarioStore.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(5);
  });

  it("commits a multi-digit Adjust value as exactly one undo entry (no per-keystroke commit)", () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-requirements:r1"));
    const input = screen.getByTestId("rule-adjust-input-requirements:r1-requiredNumPeople");
    const before = useScenarioStore.temporal.getState().pastStates.length;
    // Type "15" over "2": intermediate "1" must never reach the store or history.
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.change(input, { target: { value: "15" } });
    expect(useScenarioStore.temporal.getState().pastStates.length).toBe(before);
    expect(useScenarioStore.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(2);
    fireEvent.blur(input, { target: { value: "15" } });
    expect(useScenarioStore.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(15);
    expect(useScenarioStore.temporal.getState().pastStates.length).toBe(before + 1);
    // A single Undo returns to the pre-edit value (2), never an intermediate "1".
    useScenarioStore.temporal.getState().undo();
    expect(useScenarioStore.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(2);
  });

  it("shows a live error while typing an invalid value but does not commit until valid", () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-requirements:r1"));
    const input = screen.getByTestId("rule-adjust-input-requirements:r1-requiredNumPeople");
    const before = useScenarioStore.temporal.getState().pastStates.length;
    fireEvent.change(input, { target: { value: "-1" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.blur(input, { target: { value: "-1" } });
    // An invalid draft never commits, on change or blur.
    expect(useScenarioStore.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(2);
    expect(useScenarioStore.temporal.getState().pastStates.length).toBe(before);
  });

  it("Adjust shows a validation error for an invalid value and does not commit it", () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-requirements:r1"));
    const input = screen.getByTestId("rule-adjust-input-requirements:r1-requiredNumPeople");
    fireEvent.change(input, { target: { value: "-1" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(useScenarioStore.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(2);
  });

  it("records the toggle/adjust as tracked mutations (undo restores)", () => {
    render(<RulesScreen />);
    const before = useScenarioStore.temporal.getState().pastStates.length;
    fireEvent.click(screen.getByTestId("rule-toggle-requirements:r1"));
    expect(useScenarioStore.temporal.getState().pastStates.length).toBe(before + 1);
  });
});

describe("RulesScreen — a hard-weight (±Infinity) Adjust control", () => {
  function seedSuccession(weight: number) {
    useScenarioStore.getState().mutateScenario((state) => ({
      cardsByKind: {
        ...state.cardsByKind,
        successions: [
          { uid: "s1", person: ["P1"], pattern: ["N", "D"], weight, description: "No N→D" },
        ],
      },
    }));
  }

  it("renders a hard (-Infinity) weight legibly rather than as a blank box", () => {
    seedSuccession(-Infinity);
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-successions:s1"));
    const input = screen.getByTestId("rule-adjust-input-successions:s1-weight") as HTMLInputElement;
    expect(input.value).toBe("-Infinity");
    expect(input.value).not.toBe("");
  });

  it("keeps a hard weight on blur without downgrading it to a finite value", () => {
    seedSuccession(-Infinity);
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-successions:s1"));
    const input = screen.getByTestId("rule-adjust-input-successions:s1-weight");
    // Blur with the untouched draft — the hard weight must survive, not become 0/NaN.
    fireEvent.blur(input, { target: { value: (input as HTMLInputElement).value } });
    expect(useScenarioStore.getState().cardsByKind.successions[0].weight).toBe(-Infinity);
  });

  it("switches soft→hard and preserves the Infinity sign", () => {
    seedSuccession(-2);
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-successions:s1"));
    fireEvent.click(screen.getByTestId("rule-adjust-minus-inf-successions:s1-weight"));
    expect(useScenarioStore.getState().cardsByKind.successions[0].weight).toBe(-Infinity);
    fireEvent.click(screen.getByTestId("rule-adjust-plus-inf-successions:s1-weight"));
    expect(useScenarioStore.getState().cardsByKind.successions[0].weight).toBe(Infinity);
  });

  it("switches hard→soft by typing a finite weight, as one undo entry", () => {
    seedSuccession(Infinity);
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-successions:s1"));
    const input = screen.getByTestId("rule-adjust-input-successions:s1-weight");
    const before = useScenarioStore.temporal.getState().pastStates.length;
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.blur(input, { target: { value: "25" } });
    expect(useScenarioStore.getState().cardsByKind.successions[0].weight).toBe(25);
    expect(useScenarioStore.temporal.getState().pastStates.length).toBe(before + 1);
  });
});

describe("RulesScreen — pinning a constraint", () => {
  beforeEach(() => {
    seedRequirement();
  });

  it("Customise library reveals the pin banner, and pinning surfaces a Pinned badge", () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rules-admin-toggle"));
    fireEvent.click(screen.getByTestId("rules-new-pin"));

    fireEvent.change(screen.getByTestId("pin-form-record-select"), {
      target: { value: "requirements:r1" },
    });
    fireEvent.click(screen.getByTestId("pin-form-submit"));

    expect(screen.getByTestId("rule-pinned-badge-requirements:r1")).toBeInTheDocument();
    expect(useScenarioStore.getState().guidedRulePins).toHaveLength(1);
  });

  it("unpinning removes only the shortcut, never the source constraint", () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rules-admin-toggle"));
    fireEvent.click(screen.getByTestId("rules-new-pin"));
    fireEvent.change(screen.getByTestId("pin-form-record-select"), {
      target: { value: "requirements:r1" },
    });
    fireEvent.click(screen.getByTestId("pin-form-submit"));

    fireEvent.click(screen.getByTestId("rule-unpin-requirements:r1"));

    expect(useScenarioStore.getState().guidedRulePins).toHaveLength(0);
    expect(useScenarioStore.getState().cardsByKind.requirements).toHaveLength(1);
  });

  it("pinning an already-pinned constraint replaces the existing pin rather than duplicating it (T14d)", () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rules-admin-toggle"));

    fireEvent.click(screen.getByTestId("rules-new-pin"));
    fireEvent.change(screen.getByTestId("pin-form-record-select"), {
      target: { value: "requirements:r1" },
    });
    fireEvent.click(screen.getByTestId("pin-form-submit"));
    expect(useScenarioStore.getState().guidedRulePins).toHaveLength(1);
    const firstPinId = useScenarioStore.getState().guidedRulePins[0].id;

    fireEvent.click(screen.getByTestId("rules-new-pin"));
    fireEvent.change(screen.getByTestId("pin-form-record-select"), {
      target: { value: "requirements:r1" },
    });
    fireEvent.click(screen.getByTestId("pin-form-category-Custom shortcuts"));
    fireEvent.click(screen.getByTestId("pin-form-submit"));

    const pins = useScenarioStore.getState().guidedRulePins;
    expect(pins).toHaveLength(1);
    expect(pins[0].id).toBe(firstPinId);
    expect(pins[0].category).toBe("Custom shortcuts");
  });
});

describe("RulesScreen — one tracked mutation per Pin/Repin submit (T14d)", () => {
  beforeEach(() => {
    seedRequirement();
  });

  it("a Pin submit with an unchanged title creates exactly one history entry", () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rules-admin-toggle"));
    fireEvent.click(screen.getByTestId("rules-new-pin"));
    fireEvent.change(screen.getByTestId("pin-form-record-select"), {
      target: { value: "requirements:r1" },
    });
    // The title auto-fills to the source's current title ("Day cap") — left untouched.
    expect(screen.getByTestId("pin-form-title")).toHaveValue("Day cap");

    const before = useScenarioStore.temporal.getState().pastStates.length;
    fireEvent.click(screen.getByTestId("pin-form-submit"));

    expect(useScenarioStore.temporal.getState().pastStates.length).toBe(before + 1);
    expect(useScenarioStore.getState().cardsByKind.requirements[0].description).toBe("Day cap");
    expect(useScenarioStore.getState().guidedRulePins).toHaveLength(1);
  });

  it("a Pin submit with a changed title composes the rename into the SAME history entry; Undo reverts both together", () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rules-admin-toggle"));
    fireEvent.click(screen.getByTestId("rules-new-pin"));
    fireEvent.change(screen.getByTestId("pin-form-record-select"), {
      target: { value: "requirements:r1" },
    });
    fireEvent.change(screen.getByTestId("pin-form-title"), { target: { value: "Renamed rule" } });

    const before = useScenarioStore.temporal.getState().pastStates.length;
    fireEvent.click(screen.getByTestId("pin-form-submit"));

    expect(useScenarioStore.temporal.getState().pastStates.length).toBe(before + 1);
    expect(useScenarioStore.getState().cardsByKind.requirements[0].description).toBe(
      "Renamed rule",
    );
    expect(useScenarioStore.getState().guidedRulePins).toHaveLength(1);

    useScenarioStore.temporal.getState().undo();

    expect(useScenarioStore.getState().cardsByKind.requirements[0].description).toBe("Day cap");
    expect(useScenarioStore.getState().guidedRulePins).toHaveLength(0);
  });

  it("a Repin submit (metadata-only, title unchanged) also creates exactly one history entry", () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rules-admin-toggle"));
    fireEvent.click(screen.getByTestId("rules-new-pin"));
    fireEvent.change(screen.getByTestId("pin-form-record-select"), {
      target: { value: "requirements:r1" },
    });
    fireEvent.click(screen.getByTestId("pin-form-submit"));

    fireEvent.click(screen.getByTestId("rule-edit-shortcut-requirements:r1"));
    const before = useScenarioStore.temporal.getState().pastStates.length;
    fireEvent.click(screen.getByTestId("pin-form-category-Custom shortcuts"));
    fireEvent.click(screen.getByTestId("pin-form-submit"));

    expect(useScenarioStore.temporal.getState().pastStates.length).toBe(before + 1);
    expect(useScenarioStore.getState().guidedRulePins[0].category).toBe("Custom shortcuts");
    expect(useScenarioStore.getState().cardsByKind.requirements[0].description).toBe("Day cap");
  });
});

describe("RulesScreen — stale pins (T14d)", () => {
  it("does not show the stale-pin notice when there are no stale pins", () => {
    render(<RulesScreen />);
    expect(screen.queryByTestId("rules-stale-pin-notice")).not.toBeInTheDocument();
  });

  it("shows an actionable stale-pin notice and cleans up every stale pin in one atomic mutation", () => {
    useScenarioStore.getState().mutateScenario({
      guidedRulePins: [
        {
          id: "orphan",
          constraintKind: "requirements",
          constraintId: "gone",
          category: "Staffing",
          quickFields: [],
        },
      ],
    });
    render(<RulesScreen />);
    expect(screen.getByTestId("rules-stale-pin-notice")).toBeInTheDocument();

    const before = useScenarioStore.temporal.getState().pastStates.length;
    fireEvent.click(screen.getByTestId("rules-cleanup-stale-pins"));

    expect(useScenarioStore.getState().guidedRulePins).toEqual([]);
    expect(useScenarioStore.temporal.getState().pastStates.length).toBe(before + 1);
    expect(screen.queryByTestId("rules-stale-pin-notice")).not.toBeInTheDocument();
  });

  it("clears every stale pin at once, including a superseded legacy duplicate, without touching a live pin", () => {
    seedRequirement();
    useScenarioStore.getState().mutateScenario((state) => ({
      cardsByKind: {
        ...state.cardsByKind,
        counts: [
          {
            uid: "c1",
            person: "ALL",
            countDates: "ALL",
            countShiftTypes: "D",
            expression: "x >= T",
            target: 1,
            weight: 1,
          },
        ],
      },
      guidedRulePins: [
        // Superseded duplicate for the same source as `live` — reported stale.
        {
          id: "dup-older",
          constraintKind: "counts",
          constraintId: "c1",
          category: "Hours",
          quickFields: [],
        },
        {
          id: "live",
          constraintKind: "requirements",
          constraintId: "r1",
          category: "Staffing",
          quickFields: [],
        },
        {
          id: "dup-newer",
          constraintKind: "counts",
          constraintId: "c1",
          category: "Custom shortcuts",
          quickFields: [],
        },
      ],
    }));
    render(<RulesScreen />);
    expect(screen.getByTestId("rules-stale-pin-notice")).toHaveTextContent("1 pinned shortcut");

    fireEvent.click(screen.getByTestId("rules-cleanup-stale-pins"));

    const pins = useScenarioStore.getState().guidedRulePins;
    expect(pins.map((p) => p.id)).toEqual(["live", "dup-newer"]);
  });
});

describe("RulesScreen — Pin form accessibility (T14d)", () => {
  beforeEach(() => {
    seedRequirement();
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rules-admin-toggle"));
    fireEvent.click(screen.getByTestId("rules-new-pin"));
    fireEvent.change(screen.getByTestId("pin-form-record-select"), {
      target: { value: "requirements:r1" },
    });
  });

  it("exposes the category picker as a labelled radiogroup with exactly one checked radio", () => {
    const group = screen.getByRole("radiogroup", { name: "Category" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(6);
    const checked = radios.filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveTextContent("Custom shortcuts");
  });

  it("moves selection and roving focus with arrow keys inside the category radiogroup", () => {
    const first = screen.getByTestId("pin-form-category-Staffing");
    fireEvent.keyDown(first, { key: "ArrowRight" });

    const next = screen.getByTestId("pin-form-category-Sequencing");
    expect(next).toHaveAttribute("aria-checked", "true");
    expect(next).toHaveFocus();
    expect(first).toHaveAttribute("aria-checked", "false");
  });

  it("exposes the quick-field picker as a labelled group of pressed-state toggle buttons", () => {
    const group = screen.getByRole("group", { name: "Quick-edit numbers" });
    const button = within(group).getByTestId("pin-form-field-requiredNumPeople");
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
  });
});

describe("RulesScreen — unsupported (advanced-shaped) records", () => {
  it("shows a locked read-only fallback instead of hiding or flattening the record", () => {
    useScenarioStore.getState().mutateScenario((state) => ({
      cardsByKind: {
        ...state.cardsByKind,
        requirements: [{ uid: "r2", shiftType: ["D", "N"], requiredNumPeople: 1, weight: -1 }],
      },
    }));
    render(<RulesScreen />);
    expect(screen.getByTestId("rule-row-requirements:r2")).toBeInTheDocument();
    expect(screen.queryByTestId("rule-adjust-toggle-requirements:r2")).not.toBeInTheDocument();
    expect(screen.getByText(/adjust it in Advanced/i)).toBeInTheDocument();
  });
});
