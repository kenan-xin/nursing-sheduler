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

// ---------------------------------------------------------------------------
// v2 intent tone (ScreenRequests `dot`/`capColor` model). The intent marker and
// caption carry the canonical semantic tone derived from existing row state:
// leave → brand, the off day-state → error, a worked preference → success (+)
// or warn (−). The weight column aligns negative → warn (an avoid, not an
// error). Presentation only; this pins the tone per row kind so a regression to
// the neutral marker is caught at the component level.
// ---------------------------------------------------------------------------
describe("CurrentRequestsTable — v2 intent tone", () => {
  const tokens = (el: HTMLElement) => el.className.split(/\s+/);

  function renderOne(row: Partial<CurrentRequestRow> & { key: string }) {
    return render(
      <CurrentRequestsTable
        rows={[
          {
            person: "Ada",
            personIsGroup: false,
            dateLabel: "Mon",
            dateIsGroup: false,
            shiftLabel: "AM",
            weightLabel: "+5",
            weightTone: "positive",
            caption: "wants",
            ...row,
          },
        ]}
      />,
    );
  }

  it("a leave pin marks brand and captions brandink", () => {
    renderOne({
      key: "lv",
      shiftLabel: "LEAVE",
      weightLabel: "pinned",
      weightTone: "pin",
      caption: "paid leave · hard pin",
    });
    const dot = screen.getByTestId("requests-intent-dot");
    expect(dot).toHaveAttribute("data-intent", "leave");
    expect(tokens(dot)).toContain("text-brand");
    expect(tokens(screen.getByTestId("requests-caption"))).toContain("text-brandink");
  });

  it("an off day-state marks error regardless of off-weight sign", () => {
    renderOne({
      key: "off",
      shiftLabel: "OFF",
      weightLabel: "+2",
      weightTone: "positive",
      caption: "wants off",
    });
    const dot = screen.getByTestId("requests-intent-dot");
    expect(dot).toHaveAttribute("data-intent", "off");
    expect(tokens(dot)).toContain("text-error");
    // The caption follows the weight sign, not the day-state.
    expect(tokens(screen.getByTestId("requests-caption"))).toContain("text-success");
  });

  it("a positive worked preference marks success and captions success", () => {
    renderOne({
      key: "pos",
      shiftLabel: "AM",
      weightLabel: "+5",
      weightTone: "positive",
      caption: "wants",
    });
    const dot = screen.getByTestId("requests-intent-dot");
    expect(dot).toHaveAttribute("data-intent", "positive");
    expect(tokens(dot)).toContain("text-success");
    expect(tokens(screen.getByTestId("requests-caption"))).toContain("text-success");
  });

  it("a negative worked preference marks warn and captions warn (not error)", () => {
    renderOne({
      key: "neg",
      shiftLabel: "PM",
      weightLabel: "−3",
      weightTone: "negative",
      caption: "avoids",
    });
    const dot = screen.getByTestId("requests-intent-dot");
    expect(dot).toHaveAttribute("data-intent", "negative");
    expect(tokens(dot)).toContain("text-warn");
    expect(tokens(dot)).not.toContain("text-error");
    expect(tokens(screen.getByTestId("requests-caption"))).toContain("text-warn");
  });

  it("the intent dot is full tone, not the muted neutral marker", () => {
    renderOne({
      key: "pos2",
      shiftLabel: "AM",
      weightLabel: "+5",
      weightTone: "positive",
      caption: "wants",
    });
    const dot = screen.getByTestId("requests-intent-dot");
    // opacity-70 and the inline ink3 style were the discarded neutral treatment.
    expect(tokens(dot)).not.toContain("opacity-70");
    expect(dot).not.toHaveAttribute("style");
  });

  // The canonical model splits the neutral case across the two columns: the
  // weight is muted (wColor ink3) while the caption stays readable prose
  // (capColor ink2). Collapsing them into one map — in either direction — is a
  // fidelity regression this pins.
  it("a plain OFF request mutes the weight to ink3 but keeps the caption at ink2", () => {
    renderOne({
      key: "off0",
      shiftLabel: "OFF",
      weightLabel: "—",
      weightTone: "neutral",
      caption: "requests off",
    });
    expect(tokens(screen.getByTestId("requests-weight"))).toContain("text-ink3");
    expect(tokens(screen.getByTestId("requests-caption"))).toContain("text-ink2");
    // The two neutral tones are genuinely different tiers, not aliases.
    expect(tokens(screen.getByTestId("requests-caption"))).not.toContain("text-ink3");
    // The day-state still drives the marker.
    expect(screen.getByTestId("requests-intent-dot")).toHaveAttribute("data-intent", "off");
  });

  // A hard-coded inline colour silently defeats every tone map above (the
  // className stays correct while the paint does not), so no toned surface in
  // this row may carry one.
  it("no inline colour overrides the tone maps", () => {
    renderOne({
      key: "pin",
      shiftLabel: "LEAVE",
      weightLabel: "pinned",
      weightTone: "pin",
      caption: "paid leave · hard pin",
    });
    for (const id of [
      "requests-weight",
      "requests-caption",
      "requests-intent-dot",
      "requests-count",
    ]) {
      expect(screen.getByTestId(id), `${id} carries no inline style`).not.toHaveAttribute("style");
    }
    expect(tokens(screen.getByTestId("requests-weight"))).toContain("text-brandink");
  });
});
