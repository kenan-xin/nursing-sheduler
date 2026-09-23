// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { resetRosterCaptureGate } from "@/lib/optimize";
import { RosterScreen } from "./roster-screen";

// G4 closure — the dedicated /roster route. The screen is a thin shell that
// mounts the existing F4 surface (RosterSection), the shared capture gate, and
// the prototype-faithful page header. These tests pin the SHELL contract the
// dedicated screen adds: the page testid, the prototype-aligned heading and
// eyebrow copy, and the empty-state surface that lets a user reach the Load /
// Import / Clear actions without first visiting Optimize.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/roster",
}));

beforeEach(() => {
  resetRosterCaptureGate();
});

afterEach(() => {
  cleanup();
});

describe("RosterScreen — page shell", () => {
  it("renders the v2 screen root with the Roster label", () => {
    render(<RosterScreen />);
    const screen_ = screen.getByTestId("screen");
    expect(screen_.getAttribute("data-screen")).toBe("Roster");
  });

  it("renders the prototype-faithful page heading and Output · Roster eyebrow", () => {
    render(<RosterScreen />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Review & adjust the roster",
    );
    expect(screen.getByText("Output · Roster")).toBeInTheDocument();
  });
});

describe("RosterScreen — empty state", () => {
  it("renders the empty-state surface on first load with no working roster", async () => {
    render(<RosterScreen />);
    // RosterSection's empty-state mount owns the import/clear actions and the
    // "No roster loaded yet" callout — the surface this route always reaches
    // first on a fresh browser.
    await waitFor(() => expect(screen.getByTestId("roster-section-empty")).toBeInTheDocument());
    expect(screen.getByText("No roster loaded yet")).toBeInTheDocument();
    expect(screen.getByTestId("roster-empty-actions")).toBeInTheDocument();
  });
});
