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

describe("RulesScreen — categories", () => {
  it("renders the six plain-English headings in order when every kind is present", () => {
    useScenarioStore.getState().mutateScenario({
      cardsByKind: {
        requirements: [{ uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1 }],
        successions: [{ uid: "s1", person: ["P1"], pattern: ["N", "D"], weight: -1 }],
        counts: [
          {
            uid: "c1",
            person: "ALL",
            countDates: "ALL",
            countShiftTypes: "N",
            expression: "x >= T",
            target: 3,
            weight: 1,
          },
        ],
        affinities: [
          {
            uid: "a1",
            people1: ["P1"],
            people2: ["P2"],
            shiftTypes: ["D"],
            date: "ALL",
            weight: 1,
          },
        ],
        coverings: [
          { uid: "v1", preceptors: ["P1"], preceptees: ["P2"], shiftTypes: ["D"], weight: -1 },
        ],
      },
    });
    render(<RulesScreen />);
    const headings = screen
      .getAllByTestId(/^rule-category-/)
      .map((el) => el.getAttribute("data-testid")!.replace("rule-category-", ""));
    expect(headings).toEqual([
      "Always on",
      "Staffing levels",
      "Shift sequences",
      "Hours & contracts",
      "Who works together",
      "Supervision",
    ]);
  });

  it("has no Customise library affordance left anywhere on the screen", () => {
    seedRequirement();
    render(<RulesScreen />);
    expect(screen.queryByTestId("rules-admin-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rules-new-pin")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rules-stale-pin-notice")).not.toBeInTheDocument();
    expect(screen.queryByText(/customise library/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bpin\b/i)).not.toBeInTheDocument();
  });
});

describe("RulesScreen — renaming a rule", () => {
  /** Open the rename input on `rowId`, type `title` and save. */
  function renameRow(rowId: string, title: string) {
    fireEvent.click(screen.getByTestId(`rule-rename-${rowId}`));
    fireEvent.change(screen.getByTestId(`rule-rename-input-${rowId}`), {
      target: { value: title },
    });
    fireEvent.click(screen.getByTestId(`rule-rename-save-${rowId}`));
  }

  it("renames a card row by writing the source constraint's own description", () => {
    seedRequirement();
    render(<RulesScreen />);
    renameRow("requirements:r1", "Day shift cover");

    expect(useScenarioStore.getState().cardsByKind.requirements[0].description).toBe(
      "Day shift cover",
    );
    expect(screen.getByText("Day shift cover")).toBeInTheDocument();
  });

  it("renames the locked built-in row, which cannot be switched off but can be relabelled", () => {
    render(<RulesScreen />);
    const rowId = "builtin:max-one-shift-per-day";
    expect(screen.getByTestId(`rule-toggle-${rowId}`)).toHaveAttribute("aria-disabled", "true");
    renameRow(rowId, "One shift a day");

    expect(useScenarioStore.getState().maxOneShiftPerDay?.description).toBe("One shift a day");
    expect(screen.getByText("One shift a day")).toBeInTheDocument();
  });

  it("renames a read-only 'Set in Advanced only' row, whose shape it cannot affect", () => {
    useScenarioStore.getState().mutateScenario((state) => ({
      cardsByKind: {
        ...state.cardsByKind,
        requirements: [{ uid: "r2", shiftType: ["D", "N"], requiredNumPeople: 1, weight: -1 }],
      },
    }));
    render(<RulesScreen />);
    renameRow("requirements:r2", "Day and night cover");

    const card = useScenarioStore.getState().cardsByKind.requirements[0];
    expect(card.description).toBe("Day and night cover");
    // Renaming never converts the record into a Guided-editable shape.
    expect(screen.getByText(/adjust it in Advanced/i)).toBeInTheDocument();
    expect(screen.queryByTestId("rule-adjust-toggle-requirements:r2")).not.toBeInTheDocument();
  });

  it("an unchanged title writes nothing at all", () => {
    seedRequirement();
    render(<RulesScreen />);
    const before = useScenarioStore.temporal.getState().pastStates.length;
    const stateBefore = useScenarioStore.getState().cardsByKind;

    renameRow("requirements:r1", "Day cap");

    expect(useScenarioStore.temporal.getState().pastStates.length).toBe(before);
    expect(useScenarioStore.getState().cardsByKind).toBe(stateBefore);
  });

  it("a rename is exactly one undo entry, and Undo restores the previous title", () => {
    seedRequirement();
    render(<RulesScreen />);
    const before = useScenarioStore.temporal.getState().pastStates.length;

    renameRow("requirements:r1", "Day shift cover");

    expect(useScenarioStore.temporal.getState().pastStates.length).toBe(before + 1);
    useScenarioStore.temporal.getState().undo();
    expect(useScenarioStore.getState().cardsByKind.requirements[0].description).toBe("Day cap");
  });

  it("cancelling leaves the title untouched", () => {
    seedRequirement();
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-rename-requirements:r1"));
    fireEvent.change(screen.getByTestId("rule-rename-input-requirements:r1"), {
      target: { value: "Never saved" },
    });
    fireEvent.click(screen.getByTestId("rule-rename-cancel-requirements:r1"));

    expect(useScenarioStore.getState().cardsByKind.requirements[0].description).toBe("Day cap");
    expect(screen.getByText("Day cap")).toBeInTheDocument();
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
