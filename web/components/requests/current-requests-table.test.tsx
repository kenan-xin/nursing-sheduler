// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CurrentRequestsTable, type CurrentRequestRow } from "./current-requests-table";

afterEach(() => {
  cleanup();
});

const baseRow: CurrentRequestRow = {
  key: "row-1",
  person: "Ada Lovelace",
  personIsGroup: false,
  dateLabel: "Mon 14 Jul",
  dateIsGroup: false,
  shiftLabel: "AM",
  weightLabel: "+5",
  weightTone: "positive",
  caption: "wants",
};

describe("CurrentRequestsTable — empty state (FR-SR-39)", () => {
  it("shows the verbatim empty hint when there are no rows", () => {
    render(<CurrentRequestsTable rows={[]} />);
    expect(
      screen.getByText(
        "No shift requests defined yet. Click on any cell in the matrix above to add preferences.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("requests-row")).not.toBeInTheDocument();
  });
});

describe("CurrentRequestsTable — render (FR-SR-39)", () => {
  it("renders the header, count, search input, and one row per request", () => {
    const rows: CurrentRequestRow[] = [
      baseRow,
      {
        ...baseRow,
        key: "row-2",
        person: "Group A",
        personIsGroup: true,
        dateLabel: "WEEKEND",
        dateIsGroup: true,
        shiftLabel: "OFF",
        weightLabel: "pinned",
        weightTone: "pin",
        caption: "paid leave · hard pin",
      },
    ];

    render(<CurrentRequestsTable rows={rows} />);

    expect(screen.getByText("Current shift requests")).toBeInTheDocument();
    expect(screen.getByTestId("requests-count")).toHaveTextContent("2");
    expect(screen.getByTestId("requests-search")).toBeInTheDocument();

    const renderedRows = screen.getAllByTestId("requests-row");
    expect(renderedRows).toHaveLength(2);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Group A")).toBeInTheDocument();
    expect(screen.getByText("Mon 14 Jul")).toBeInTheDocument();
    expect(screen.getByText("WEEKEND")).toBeInTheDocument();
    expect(screen.getByText("AM")).toBeInTheDocument();
    expect(screen.getByText("OFF")).toBeInTheDocument();
    expect(screen.getByText("+5")).toBeInTheDocument();
    expect(screen.getByText("pinned")).toBeInTheDocument();
    expect(screen.getByText("wants")).toBeInTheDocument();
    expect(screen.getByText("paid leave · hard pin")).toBeInTheDocument();
  });

  it("renders the column header labels Person / Date / Shift / Weight / Intent", () => {
    render(<CurrentRequestsTable rows={[baseRow]} />);
    for (const label of ["Person", "Date", "Shift", "Weight", "Intent"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe("CurrentRequestsTable — search filter (FR-SR-39)", () => {
  const rows: CurrentRequestRow[] = [
    baseRow,
    {
      ...baseRow,
      key: "row-2",
      person: "Grace Hopper",
      dateLabel: "Tue 15 Jul",
      shiftLabel: "PM",
      weightLabel: "−3",
      weightTone: "negative",
      caption: "avoids",
    },
    {
      ...baseRow,
      key: "row-3",
      person: "NIGHT-TEAM",
      personIsGroup: true,
      dateLabel: "ALL",
      dateIsGroup: true,
      shiftLabel: "LEAVE",
      weightLabel: "+∞",
      weightTone: "pin",
      caption: "paid leave · hard pin",
    },
  ];

  it("filters rows by case-insensitive substring over person/date/shift/weight/caption", () => {
    render(<CurrentRequestsTable rows={rows} />);
    expect(screen.getAllByTestId("requests-row")).toHaveLength(3);

    const search = screen.getByTestId("requests-search");

    fireEvent.change(search, { target: { value: "grace" } });
    expect(screen.getAllByTestId("requests-row")).toHaveLength(1);
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "wants" } });
    expect(screen.getAllByTestId("requests-row")).toHaveLength(1);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "leave" } });
    expect(screen.getAllByTestId("requests-row")).toHaveLength(1);
    expect(screen.getByText("NIGHT-TEAM")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "all" } });
    expect(screen.getAllByTestId("requests-row")).toHaveLength(1);
    expect(screen.getByText("NIGHT-TEAM")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "AVOIDS" } });
    expect(screen.getAllByTestId("requests-row")).toHaveLength(1);
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "−3" } });
    expect(screen.getAllByTestId("requests-row")).toHaveLength(1);
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
  });

  it("shows the verbatim no-match hint when the query has no hits, with the query quoted", () => {
    render(<CurrentRequestsTable rows={rows} />);
    const search = screen.getByTestId("requests-search");
    fireEvent.change(search, { target: { value: "zzz-nothing" } });

    expect(screen.getByTestId("requests-no-match")).toHaveTextContent(
      "No requests match \u201czzz-nothing\u201d.",
    );
    expect(screen.queryByTestId("requests-row")).not.toBeInTheDocument();
  });

  it("restores all rows when the search is cleared", () => {
    render(<CurrentRequestsTable rows={rows} />);
    const search = screen.getByTestId("requests-search");
    fireEvent.change(search, { target: { value: "grace" } });
    expect(screen.getAllByTestId("requests-row")).toHaveLength(1);

    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getAllByTestId("requests-row")).toHaveLength(3);
  });
});
