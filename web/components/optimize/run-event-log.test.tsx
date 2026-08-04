// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RunLogEntry } from "@/lib/optimize";
import { RunEventLog } from "./run-event-log";

afterEach(() => cleanup());

/** jsdom has no layout, so drive the scroll geometry explicitly. */
function setGeometry(
  el: HTMLElement,
  {
    scrollTop,
    scrollHeight,
    clientHeight,
  }: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  },
) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
  el.scrollTop = scrollTop;
}

function entry(over: Partial<RunLogEntry>): RunLogEntry {
  return {
    seq: 1,
    kind: "lifecycle",
    label: "submitting",
    event: null,
    cursor: null,
    payload: null,
    detail: null,
    detailKind: null,
    elapsedSeconds: null,
    occurredAt: null,
    eventTime: null,
    ...over,
  };
}

describe("RunEventLog", () => {
  it("shows the active empty state while running", () => {
    render(<RunEventLog log={[]} active />);
    expect(screen.getByText("Waiting for optimization events…")).toBeInTheDocument();
    expect(screen.getByTestId("optimize-event-log")).toHaveTextContent("0 events");
  });

  it("shows the idle empty state", () => {
    render(<RunEventLog log={[]} active={false} />);
    expect(screen.getByText("No optimization events yet.")).toBeInTheDocument();
  });

  it("renders entries with their kind badge and detail", () => {
    render(
      <RunEventLog
        active
        log={[
          entry({
            seq: 1,
            kind: "progress",
            label: "progress",
            detail: "score=42, elapsed=2s",
            detailKind: "expression",
          }),
          entry({
            seq: 2,
            kind: "error",
            label: "stream-disconnected",
            detail: "boom",
            detailKind: "prose",
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("optimize-event-log")).toHaveTextContent("2 events");
    expect(screen.getByText("score=42, elapsed=2s")).toBeInTheDocument();
    expect(screen.getByText("stream-disconnected")).toBeInTheDocument();
  });

  // DESIGN.md §3 — the mono face is for codes, ids, counts and solver expressions. The
  // detail line is sometimes exactly that and sometimes a backend prose message, so BOTH
  // halves are asserted: a blanket `font-mono` on the element would put a sentence in
  // the data face, and dropping it would put a solver expression in prose.
  it("sets a machine-expression detail in the mono face and leaves prose on the body face", () => {
    const details: Array<[string, "expression" | "prose"]> = [
      ["state=running, queue=2", "expression"],
      ["early_completion=true", "expression"],
      ["outcome=optimal, score=42", "expression"],
      ["schedule.xlsx", "expression"],
      ["solve: Solving", "prose"],
      ["Connection lost after 3 attempts.", "prose"],
    ];
    render(
      <RunEventLog
        active
        log={details.map(([detail, detailKind], index) =>
          entry({ seq: index + 1, detail, detailKind }),
        )}
      />,
    );
    const rendered = screen.getAllByTestId("optimize-event-detail");
    expect(rendered.map((el) => el.textContent)).toEqual(details.map(([detail]) => detail));
    for (const el of rendered) {
      const classes = el.className.split(/\s+/);
      if (el.getAttribute("data-detail-kind") === "expression") {
        expect(classes, `${el.textContent} → mono data face`).toContain("font-mono");
      } else {
        expect(classes, `${el.textContent} is prose, not data`).not.toContain("font-mono");
      }
      // Size and ink are unchanged either way — only the face is selected here.
      expect(classes).toContain("text-meta");
      expect(classes).toContain("text-ink2");
    }
  });

  // An unclassified detail (null kind) must not be swept into the data face.
  it("leaves an unclassified detail on the body face", () => {
    render(
      <RunEventLog active log={[entry({ seq: 1, detail: "unclassified", detailKind: null })]} />,
    );
    expect(screen.getByTestId("optimize-event-detail").className).not.toContain("font-mono");
  });

  it("auto-scrolls to the tail only when the viewer is already near the bottom", () => {
    const { rerender } = render(<RunEventLog active log={[entry({ seq: 1, label: "a" })]} />);
    const container = screen.getByTestId("optimize-event-log-scroll");

    // Reader at the bottom → a new event follows the tail.
    setGeometry(container, { scrollTop: 100, scrollHeight: 200, clientHeight: 100 });
    fireEvent.scroll(container);
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 260 });
    rerender(
      <RunEventLog active log={[entry({ seq: 1, label: "a" }), entry({ seq: 2, label: "b" })]} />,
    );
    expect(container.scrollTop).toBe(260);

    // Reader scrolled UP → a new event must NOT yank them back down.
    setGeometry(container, { scrollTop: 0, scrollHeight: 260, clientHeight: 100 });
    fireEvent.scroll(container);
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 320 });
    rerender(
      <RunEventLog
        active
        log={[
          entry({ seq: 1, label: "a" }),
          entry({ seq: 2, label: "b" }),
          entry({ seq: 3, label: "c" }),
        ]}
      />,
    );
    expect(container.scrollTop).toBe(0);
  });
});
