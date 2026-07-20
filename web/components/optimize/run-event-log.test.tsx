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
          entry({ seq: 1, kind: "progress", label: "progress", detail: "score=42, elapsed=2s" }),
          entry({ seq: 2, kind: "error", label: "stream-disconnected", detail: "boom" }),
        ]}
      />,
    );
    expect(screen.getByTestId("optimize-event-log")).toHaveTextContent("2 events");
    expect(screen.getByText("score=42, elapsed=2s")).toBeInTheDocument();
    expect(screen.getByText("stream-disconnected")).toBeInTheDocument();
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
