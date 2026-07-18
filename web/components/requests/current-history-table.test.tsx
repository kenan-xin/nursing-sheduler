// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CurrentHistoryTable, type CurrentHistoryPerson } from "./current-history-table";

afterEach(() => {
  cleanup();
});

describe("CurrentHistoryTable — empty state (FR-SR-40)", () => {
  it("shows the verbatim empty hint when there are no people", () => {
    render(<CurrentHistoryTable people={[]} />);
    expect(
      screen.getByText(
        "No history entries defined yet. Click on any history cell in the matrix above to add entries.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("history-row")).not.toBeInTheDocument();
  });
});

describe("CurrentHistoryTable — render (FR-SR-40)", () => {
  const people: CurrentHistoryPerson[] = [
    {
      key: "p-1",
      person: "Ada Lovelace",
      entries: [
        { hn: "H-3", label: "AM", kind: "worked" },
        { hn: "H-2", label: "OFF", kind: "off" },
        { hn: "H-1", label: "LEAVE", kind: "leave" },
      ],
    },
    {
      key: "p-2",
      person: "Grace Hopper",
      entries: [{ hn: "H-1", label: "PM", kind: "worked" }],
    },
  ];

  it("renders the header, count, and one row per person with each chip", () => {
    render(<CurrentHistoryTable people={people} />);

    expect(screen.getByText("Current people history")).toBeInTheDocument();
    expect(screen.getByTestId("history-count")).toHaveTextContent("2");
    expect(screen.queryByTestId("history-search")).not.toBeInTheDocument();

    expect(screen.getByTestId("history-row-p-1")).toBeInTheDocument();
    expect(screen.getByTestId("history-row-p-2")).toBeInTheDocument();

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();

    expect(screen.getByText("H-3")).toBeInTheDocument();
    expect(screen.getByText("H-2")).toBeInTheDocument();
    expect(screen.getAllByText("H-1")).toHaveLength(2);

    expect(screen.getByText("AM")).toBeInTheDocument();
    expect(screen.getByText("OFF")).toBeInTheDocument();
    expect(screen.getByText("LEAVE")).toBeInTheDocument();
    expect(screen.getByText("PM")).toBeInTheDocument();
  });

  it("only renders chips for the entries actually passed in", () => {
    render(<CurrentHistoryTable people={people} />);
    const adaRow = screen.getByTestId("history-row-p-1");
    const adaChips = adaRow.querySelectorAll('[data-testid^="history-chip-p-1-"]');
    expect(adaChips).toHaveLength(3);
  });

  it("assigns chip data-kind matching the entry kind (leave / off / worked)", () => {
    render(<CurrentHistoryTable people={people} />);
    expect(screen.getByTestId("history-chip-p-1-H-3")).toHaveAttribute("data-kind", "worked");
    expect(screen.getByTestId("history-chip-p-1-H-2")).toHaveAttribute("data-kind", "off");
    expect(screen.getByTestId("history-chip-p-1-H-1")).toHaveAttribute("data-kind", "leave");
    expect(screen.getByTestId("history-chip-p-2-H-1")).toHaveAttribute("data-kind", "worked");
  });
});
