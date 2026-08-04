// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The recoverable-error branch is the shell's rarest rendered state: it needs a
// corrupt IndexedDB record to appear at all, so it is exactly the surface a
// route-wide visual migration can leave behind without anything noticing. The
// R1 re-skin did leave it behind once — at the time the global `h1–h6` rule
// still carried v1's -0.02em, so this heading inherited it while every other R1
// heading moved to the v2 -0.015em. That rule is now -0.015em too, but the
// assertion below stays: it pins the component contract, and this branch is
// rare enough that a future drift would otherwise go unseen.
//
// `hydrateScenarioStore` is stubbed so the branch can be rendered at all: the
// real one runs on mount and drives the status straight to `ready`, which is
// why this state has never had a render test. The stub is created inside the
// factory because `vi.mock` is hoisted above every top-level binding.
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    hydrateScenarioStore: vi.fn(async () => {}),
    registerPagehideFlush: () => () => {},
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { HydrationGate } from "./hydration-gate";
import { useHotStore } from "@/lib/store";

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("HydrationGate — recoverable-error state", () => {
  function renderRecoverable() {
    useHotStore.setState({ hydrationStatus: "recoverable-error" });
    render(
      <HydrationGate>
        <div data-testid="gated-children" />
      </HydrationGate>,
    );
  }

  it("renders the recovery surface instead of the gated children", () => {
    renderRecoverable();
    // Guards the guard: if this branch stopped rendering, every typography
    // assertion below would vanish with it rather than fail.
    expect(screen.getByTestId("hydration-error")).toBeTruthy();
    expect(screen.queryByTestId("gated-children")).toBeNull();
    expect(screen.getByRole("button", { name: /reset to new schedule/i })).toBeTruthy();
  });

  it("tracks its heading at the v2 -0.015em, not a Tailwind default", () => {
    renderRecoverable();
    const heading = screen.getByTestId("hydration-error-heading");

    expect(heading.tagName).toBe("H2");
    // States the v2 value as a component contract; the global h1–h6 safety net
    // resolves to the same -0.015em.
    // `tracking-tight` is a different value again (-0.025em) and is not it.
    expect(classesOf(heading)).toContain("tracking-[-0.015em]");
    expect(classesOf(heading)).not.toContain("tracking-tight");
  });

  it("leaves the loading state's own markup alone", () => {
    // The sibling branch has no heading, so the fix must not have grown one.
    useHotStore.setState({ hydrationStatus: "hydrating" });
    render(
      <HydrationGate>
        <div data-testid="gated-children" />
      </HydrationGate>,
    );
    expect(screen.getByTestId("hydration-loading")).toBeTruthy();
    expect(screen.queryByTestId("hydration-error-heading")).toBeNull();
    expect(screen.queryByTestId("gated-children")).toBeNull();
  });
});
