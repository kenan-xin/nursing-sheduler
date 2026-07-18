// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ModeToggle } from "./mode-toggle";
import { useModeStore } from "@/lib/mode/mode";
import { useNavGuardStore } from "./nav-guard-store";

// T08f P2 — a canceled future mode transition must never leave roving-tab
// focus on the not-yet-selected tab. Today `isRouteValidForMode` always
// returns `true` (no shipped route is Advanced-only), so this path is
// unreachable through real product code; the mock below stands in for T08d's
// eventual invalid-route case via the route-registry seam the review asked for.
vi.mock("next/navigation", () => ({
  usePathname: () => "/dates",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./route-registry", () => ({
  isRouteValidForMode: () => false,
}));

describe("ModeToggle — focus follows commit, not request (T08f P2)", () => {
  beforeEach(() => {
    useModeStore.setState({ mode: "guided" });
    useNavGuardStore.setState({ drafts: new Map(), pendingIntent: null, open: false });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not move focus to the target tab while the transition is only staged", () => {
    // An invalid target route (mocked) + an open draft stages instead of
    // committing — nothing has changed mode yet.
    useNavGuardStore.getState().registerDraft({ id: "d", label: "Draft" });
    render(<ModeToggle />);

    screen.getByTestId("mode-toggle-advanced").click();

    expect(useNavGuardStore.getState().pendingIntent).not.toBeNull();
    expect(useModeStore.getState().mode).toBe("guided");
    expect(document.activeElement).not.toBe(screen.getByTestId("mode-toggle-advanced"));
  });

  it("moves focus to the target tab only once Confirm actually commits the mode", () => {
    useNavGuardStore.getState().registerDraft({ id: "d", label: "Draft" });
    render(<ModeToggle />);

    screen.getByTestId("mode-toggle-advanced").click();
    useNavGuardStore.getState().confirm();

    expect(useModeStore.getState().mode).toBe("advanced");
    expect(document.activeElement).toBe(screen.getByTestId("mode-toggle-advanced"));
  });

  it("Cancel leaves both mode and focus exactly where they were", () => {
    useNavGuardStore.getState().registerDraft({ id: "d", label: "Draft" });
    render(<ModeToggle />);
    const guidedTab = screen.getByTestId("mode-toggle-guided");
    guidedTab.focus();

    screen.getByTestId("mode-toggle-advanced").click();
    useNavGuardStore.getState().cancel();

    expect(useModeStore.getState().mode).toBe("guided");
    expect(document.activeElement).toBe(guidedTab);
  });

  it("restores focus to the still-selected tab when Cancel follows a pointer click (T08d repair P2)", () => {
    // jsdom's synthetic `.click()` does NOT move DOM focus the way a real
    // browser does on a pointer click — that's exactly why this regression
    // (T08d repair P2, real-browser coverage in mode-aware-shell.spec.ts)
    // wasn't caught by the two tests above. This test reproduces the browser
    // behavior explicitly: the clicked (target) button receives focus BEFORE
    // its own onClick handler runs.
    useNavGuardStore.getState().registerDraft({ id: "d", label: "Draft" });
    render(<ModeToggle />);
    const guidedTab = screen.getByTestId("mode-toggle-guided");
    const advancedTab = screen.getByTestId("mode-toggle-advanced");
    guidedTab.focus();

    advancedTab.focus(); // simulates the browser's native click-focus
    advancedTab.click();
    expect(useNavGuardStore.getState().pendingIntent).not.toBeNull();
    expect(document.activeElement).toBe(advancedTab); // still unselected at this point

    useNavGuardStore.getState().cancel();

    expect(useModeStore.getState().mode).toBe("guided");
    // Focus must land back on the still-selected Guided tab, never stay on
    // the now-cancelled, unselected Advanced tab (tabIndex=-1).
    expect(document.activeElement).toBe(guidedTab);
  });
});
