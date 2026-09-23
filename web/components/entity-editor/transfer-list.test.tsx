// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { entityKey, sameEntityId, type EntityId } from "./core";
import { TransferList, type TransferOption } from "./transfer-list";

// Focused contract for the shared two-pane transfer selector. F2 is its sole
// VISUAL owner before F4, so this suite pins both halves:
//   • the public behaviour that must survive the re-skin byte-for-byte — full
//     control by the `selected` prop, per-pane filtering, add-all/clear-all,
//     group-before-item sectioning, inert disabled options, caller-order
//     preservation, exact typed identity, and the accessible row labels both
//     consumers depend on;
//   • the v2 surface reading — pane roles, square full-bleed bands, and real
//     44px coarse-pointer rows.
// It is generic over the value type, so it is exercised in BOTH consumer shapes:
// the entity editor's typed `EntityId` identity and the card editors' string refs.

afterEach(() => {
  cleanup();
});

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

/** A controlled harness mirroring how the owning form drives its local draft. */
function Harness<V>({
  initial = [],
  onToggleSpy,
  ...props
}: {
  initial?: V[];
  onToggleSpy?: (value: V) => void;
} & Omit<React.ComponentProps<typeof TransferList<V>>, "selected" | "onToggle">) {
  const [selected, setSelected] = React.useState<V[]>(initial);
  const sameValue = props.sameValue ?? ((a: V, b: V) => String(a) === String(b));
  return (
    <TransferList<V>
      {...props}
      selected={selected}
      onToggle={(value) => {
        onToggleSpy?.(value);
        setSelected((current) =>
          current.some((v) => sameValue(v, value))
            ? current.filter((v) => !sameValue(v, value))
            : [...current, value],
        );
      }}
    />
  );
}

const PEOPLE: TransferOption<string>[] = [
  { value: "Aisha", label: "Aisha" },
  { value: "Ben", label: "Ben" },
  { value: "Chloe", label: "Chloe" },
];

describe("TransferList — controlled membership", () => {
  it("is driven entirely by `selected`; a toggle only reports upward", () => {
    const onToggle = vi.fn();
    // No harness state: `selected` is fixed, so the pane contents must not move.
    render(
      <TransferList
        idPrefix="g1"
        items={PEOPLE}
        selected={["Aisha"]}
        onToggle={onToggle}
        selectedTitle="MEMBERS"
        selectedTestKey="members"
      />,
    );
    const available = screen.getByTestId("transfer-available-g1");
    const chosen = screen.getByTestId("transfer-members-g1");
    expect(within(chosen).getByText("Aisha")).toBeInTheDocument();
    expect(within(available).queryByText("Aisha")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add Ben" }));
    expect(onToggle).toHaveBeenCalledWith("Ben");
    // Still exactly the prop it was given — the component holds no membership.
    expect(within(chosen).queryByText("Ben")).not.toBeInTheDocument();
  });

  it("moves an option between panes, and back", () => {
    render(<Harness<string> idPrefix="g1" items={PEOPLE} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Chloe" }));
    expect(
      within(screen.getByTestId("transfer-selected-g1")).getByText("Chloe"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove Chloe" }));
    expect(
      within(screen.getByTestId("transfer-available-g1")).getByText("Chloe"),
    ).toBeInTheDocument();
  });

  it("preserves the caller's selection ORDER rather than the option order", () => {
    render(
      <TransferList
        idPrefix="g1"
        items={PEOPLE}
        selected={["Chloe", "Aisha"]}
        onToggle={() => {}}
      />,
    );
    const rows = within(screen.getByTestId("transfer-selected-g1")).getAllByRole("button", {
      name: /^Remove /,
    });
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Remove Chloe", "Remove Aisha"]);
  });

  it("still renders a selected value that is not among the options", () => {
    render(<TransferList idPrefix="g1" items={PEOPLE} selected={["ghost"]} onToggle={() => {}} />);
    expect(
      within(screen.getByTestId("transfer-selected-g1")).getByText("ghost"),
    ).toBeInTheDocument();
  });

  it("add-all adds every addable option; clear-all empties the selection", () => {
    render(<Harness<string> idPrefix="g1" items={PEOPLE} />);
    fireEvent.click(screen.getByTestId("transfer-add-all-g1"));
    const chosen = screen.getByTestId("transfer-selected-g1");
    for (const person of ["Aisha", "Ben", "Chloe"]) {
      expect(within(chosen).getByText(person)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("transfer-add-all-g1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("transfer-clear-g1"));
    expect(within(chosen).queryByText("Aisha")).not.toBeInTheDocument();
  });
});

describe("TransferList — filtering", () => {
  it("filters the available pane and scopes add-all to the matches", () => {
    render(<Harness<string> idPrefix="g1" items={PEOPLE} />);
    fireEvent.change(screen.getByTestId("transfer-search-g1"), { target: { value: "ch" } });

    const available = screen.getByTestId("transfer-available-g1");
    expect(within(available).getByText("Chloe")).toBeInTheDocument();
    expect(within(available).queryByText("Aisha")).not.toBeInTheDocument();
    expect(screen.getByTestId("transfer-add-all-g1")).toHaveTextContent("Add all 1 matching");
  });

  it("reports a no-match state distinctly from an empty pane", () => {
    render(<Harness<string> idPrefix="g1" items={PEOPLE} />);
    fireEvent.change(screen.getByTestId("transfer-search-g1"), { target: { value: "zzz" } });
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("transfer-search-g1"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("transfer-add-all-g1"));
    expect(screen.getByText("Everything is selected.")).toBeInTheDocument();
  });

  it("hides the search box when the consumer opts out", () => {
    render(<Harness<string> idPrefix="g1" items={PEOPLE} showSearch={false} />);
    expect(screen.queryByTestId("transfer-search-g1")).not.toBeInTheDocument();
  });

  it("reveals the selected-side filter only past the threshold", () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ value: `p${i}`, label: `P${i}` }));
    const { rerender } = render(
      <TransferList
        idPrefix="g1"
        items={many}
        selected={["p0"]}
        onToggle={() => {}}
        selFilterThreshold={2}
      />,
    );
    expect(screen.queryByTestId("transfer-sel-search-g1")).not.toBeInTheDocument();

    rerender(
      <TransferList
        idPrefix="g1"
        items={many}
        selected={["p0", "p1", "p2"]}
        onToggle={() => {}}
        selFilterThreshold={2}
      />,
    );
    fireEvent.change(screen.getByTestId("transfer-sel-search-g1"), { target: { value: "P1" } });
    const chosen = screen.getByTestId("transfer-selected-g1");
    expect(within(chosen).getByText("P1")).toBeInTheDocument();
    expect(within(chosen).queryByText("P0")).not.toBeInTheDocument();
  });
});

describe("TransferList — groups and disabled options", () => {
  const groups: TransferOption<string>[] = [
    { value: "NIGHTS", label: "NIGHTS", isGroup: true },
    {
      value: "TAINTED",
      label: "TAINTED",
      isGroup: true,
      disabled: true,
      disabledReason: "has OFF",
    },
  ];

  it("sections groups before items in both panes", () => {
    render(<Harness<string> idPrefix="g1" items={PEOPLE} groups={groups} itemLabel="NURSES" />);
    const available = screen.getByTestId("transfer-available-g1");
    expect(within(available).getByText("GROUPS")).toBeInTheDocument();
    expect(within(available).getByText("NURSES")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add NIGHTS" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Aisha" }));
    const chosen = screen.getByTestId("transfer-selected-g1");
    expect(within(chosen).getByText("GROUPS")).toBeInTheDocument();
    expect(within(chosen).getByText("NURSES")).toBeInTheDocument();
  });

  it("renders a disabled option visible but inert, with its reason", () => {
    render(<Harness<string> idPrefix="g1" items={PEOPLE} groups={groups} />);
    expect(screen.queryByRole("button", { name: "Add TAINTED" })).not.toBeInTheDocument();
    const row = screen.getByTitle("has OFF");
    expect(row).toHaveTextContent("TAINTED");
    expect(classesOf(row)).toContain("cursor-not-allowed");
  });

  it("excludes a disabled option from add-all", () => {
    render(<Harness<string> idPrefix="g1" items={PEOPLE} groups={groups} />);
    // 3 people + 1 selectable group; the disabled group is not counted.
    expect(screen.getByTestId("transfer-add-all-g1")).toHaveTextContent("Add all 4");
    fireEvent.click(screen.getByTestId("transfer-add-all-g1"));
    expect(
      within(screen.getByTestId("transfer-selected-g1")).queryByText("TAINTED"),
    ).not.toBeInTheDocument();
  });
});

describe("TransferList — exact typed identity for the entity-editor consumer", () => {
  it('never collapses numeric 1 and string "1"', () => {
    const items: TransferOption<EntityId>[] = [
      { value: 1, label: "1" },
      { value: "1", label: "one" },
    ];
    const onToggle = vi.fn();
    render(
      <TransferList<EntityId>
        idPrefix="nums"
        items={items}
        selected={[1]}
        onToggle={onToggle}
        keyOf={entityKey}
        sameValue={sameEntityId}
      />,
    );
    // Numeric 1 is selected; string "1" is a DIFFERENT option and stays available.
    // Matched by the row's accessible name, not its text: the pane's count band
    // also reads "1", and a text match cannot tell the two apart.
    expect(
      within(screen.getByTestId("transfer-selected-nums")).getByRole("button", {
        name: "Remove 1",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add one" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add one" }));
    expect(onToggle).toHaveBeenCalledWith("1");
  });

  it("uses the consumer's aria-label wording for both configurations", () => {
    const { rerender } = render(
      <TransferList
        idPrefix="g1"
        items={PEOPLE}
        selected={["Aisha"]}
        onToggle={() => {}}
        addAria={(label) => `Add ${label} to group`}
        removeAria={(label) => `Remove ${label} from group`}
        selectedTitle="MEMBERS"
        selectedTestKey="members"
      />,
    );
    expect(screen.getByRole("button", { name: "Add Ben to group" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Aisha from group" })).toBeInTheDocument();
    expect(screen.getByText("MEMBERS")).toBeInTheDocument();

    rerender(
      <TransferList
        idPrefix="g1"
        items={PEOPLE}
        selected={["Aisha"]}
        onToggle={() => {}}
        addAria={(label) => `Add ${label} to group`}
        removeAria={(label) => `Remove ${label} from group`}
        selectedTitle="IN GROUP"
        selectedTestKey="in-group"
      />,
    );
    expect(screen.getByTestId("transfer-in-group-g1")).toBeInTheDocument();
    expect(screen.getByText("IN GROUP")).toBeInTheDocument();
  });

  it("labels both search boxes for assistive tech", () => {
    render(
      <TransferList
        idPrefix="g1"
        items={PEOPLE}
        selected={["Aisha", "Ben"]}
        onToggle={() => {}}
        selFilterThreshold={1}
        selectedTitle="MEMBERS"
      />,
    );
    expect(screen.getByLabelText("Search available")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter members")).toBeInTheDocument();
  });
});

describe("TransferList — v2 surface reading", () => {
  it("gives each pane its ladder role, and the SELECTED pane the selection role", () => {
    render(<Harness<string> idPrefix="g1" items={PEOPLE} initial={["Aisha"]} />);
    const available = classesOf(screen.getByTestId("transfer-available-g1"));
    expect(available).toContain("bg-surface");
    expect(available).toContain("border-line");
    expect(available).toContain("shadow-1");
    expect(available).toContain("rounded-card");
    // `overflow-hidden` is what clips the square band and footer to the card radius.
    expect(available).toContain("overflow-hidden");

    const chosen = classesOf(screen.getByTestId("transfer-selected-g1"));
    expect(chosen).toContain("border-brand");
    expect(chosen).toContain("shadow-2");
    expect(chosen).toContain("rounded-card");
  });

  it("keeps the full-bleed count band and footer square", () => {
    render(<Harness<string> idPrefix="g1" items={PEOPLE} initial={["Aisha"]} />);
    const band = screen.getByText("AVAILABLE").parentElement;
    expect(classesOf(band)).toContain("rounded-none");
    expect(classesOf(band)).toContain("bg-panel");
    expect(classesOf(screen.getByTestId("transfer-add-all-g1"))).toContain("rounded-none");
    expect(classesOf(screen.getByTestId("transfer-clear-g1"))).toContain("rounded-none");
  });

  it("makes every option row a real 44px target on a coarse pointer", () => {
    render(
      <Harness<string>
        idPrefix="g1"
        items={PEOPLE}
        groups={[{ value: "X", label: "X", isGroup: true, disabled: true, disabledReason: "why" }]}
        initial={["Aisha"]}
      />,
    );
    const rows = [
      screen.getByRole("button", { name: "Add Ben" }),
      screen.getByRole("button", { name: "Remove Aisha" }),
      screen.getByTestId("transfer-add-all-g1"),
      screen.getByTestId("transfer-clear-g1"),
      screen.getByTitle("why"),
    ];
    for (const row of rows) {
      expect(classesOf(row), row.textContent ?? "").toContain("pointer-coarse:min-h-touch");
    }
  });

  it("puts the pane search on the control geometry and touch height", () => {
    render(<Harness<string> idPrefix="g1" items={PEOPLE} />);
    const classes = classesOf(screen.getByTestId("transfer-search-g1"));
    expect(classes).toContain("h-control");
    expect(classes).toContain("rounded-control");
    expect(classes).toContain("pointer-coarse:min-h-touch");
  });
});
