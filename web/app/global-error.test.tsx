// @vitest-environment jsdom
//
// bd nursing-sheduler-6t1y — the root global error boundary.
//
// `app/global-error.tsx` is the last-resort boundary: Next renders it only when
// the ROOT layout itself throws (including a crash in `(app)/layout.tsx`'s
// AppShell), because `app/(app)/error.tsx` does not wrap the layout above its own
// segment. It replaces the root layout, so it renders its own <html>/<body> and
// cannot keep the shell. This proves its own contract: the message, and Retry
// wired to `reset()`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GlobalError from "./global-error";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function show() {
  const reset = vi.fn();
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<GlobalError error={new Error("boom")} reset={reset} />);
  return { reset };
}

describe("the global error boundary", () => {
  it("shows a short message and a Retry", () => {
    show();
    const state = screen.getByTestId("app-error-state");
    expect(state).toHaveTextContent(/something went wrong/i);
    expect(state).toHaveTextContent(/could not finish loading/i);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("calls reset() when Retry is pressed", async () => {
    const { reset } = show();
    await userEvent.click(screen.getByTestId("app-error-retry"));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
