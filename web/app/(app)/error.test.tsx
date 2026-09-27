// @vitest-environment jsdom
//
// bd nursing-sheduler-6t1y — the (app) route-group error boundary.
//
// The behaviour under test is not "an error component exists": it is that a
// crashed screen is replaced by a SHORT, retryable state instead of Next's bare
// error page. That the app shell stays visible around it is a consequence of
// where the file sits — `app/(app)/error.tsx` is rendered INSIDE
// `app/(app)/layout.tsx`'s AppShell, so Next nests this UI within the shell and
// only the crashing screen's content is swapped. That placement is a framework
// fact, not something this unit test can render; what it proves is the boundary's
// own contract: it shows the message, offers Retry, and Retry calls `reset()`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AppError from "./error";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function show() {
  const reset = vi.fn();
  // The boundary logs the crash to the console; silence it so the suite output
  // stays readable. The third test below asserts that log explicitly.
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<AppError error={new Error("boom")} reset={reset} />);
  return { reset };
}

describe("the (app) error boundary", () => {
  it("shows a short message and a Retry instead of a bare error page", () => {
    show();
    const state = screen.getByTestId("app-error-state");
    expect(state).toHaveTextContent(/this screen could not load/i);
    expect(state).toHaveTextContent(/something went wrong/i);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("calls reset() when Retry is pressed", async () => {
    const { reset } = show();
    await userEvent.click(screen.getByTestId("app-error-retry"));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("logs the error to the console and nowhere else", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("boom");
    render(<AppError error={error} reset={vi.fn()} />);
    expect(spy).toHaveBeenCalledWith(error);
  });
});
