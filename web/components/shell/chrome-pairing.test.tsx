// @vitest-environment jsdom
//
// The RENDERED half of revert path (3) in `chrome-contrast.test.ts`: each chrome fill
// carries the ON-colour its own token declares, so the AA pairs that file audits in
// `app/globals.css` describe what the shell actually paints.
//
// custom-AST ticket 3 moved this off three `readFileSync` reads of shell TSX. The old check
// asked whether the FILE mentioned `bg-chrome` and `text-onbrand` somewhere in its bytes;
// this asks the rendered element, which is the thing the user sees and the thing the CSS
// contrast pair is about. Its complement -- the retired v1 ink-ramp pairing must not come
// back ANYWHERE in those three files, which no render can prove -- is the
// `chrome-ink-ramp-pairing` ast-grep rule.
//
// jsdom applies no stylesheet, so nothing here claims a resolved colour; the classes are
// the contract, and `e2e/v2-visual-system.spec.ts` measures the paint.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useModeStore } from "@/lib/mode/mode";
import { AppSideNav } from "./app-side-nav";
import { ModeToggle } from "./mode-toggle";
import { TopBar } from "./top-bar";
import { useNavGuardStore } from "./nav-guard-store";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dates",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

// The app mark is the subject; its siblings are proved by their own suites and are stubbed
// so this file needs no database, no scenario fixture and no assistant.
vi.mock("@/components/ai/assistant-launcher", () => ({ AssistantLauncher: () => null }));
vi.mock("./undo-redo-controls", () => ({ UndoRedoControls: () => null }));
vi.mock("./persistence-status", () => ({ PersistenceStatus: () => null }));
vi.mock("./mobile-nav", () => ({ MobileNav: () => null }));
vi.mock("./sidebar-nav", () => ({ NavList: () => null }));
vi.mock("@/components/theme/theme-toggle", () => ({
  ThemeToggle: () => null,
  AccentControl: () => null,
}));

function tokensOf(element: Element): string[] {
  return (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** The single element painted with the chrome plane in the rendered tree. */
function appMark(): Element {
  const marks = document.querySelectorAll(".bg-chrome");
  expect(marks, "exactly one chrome-plane element is expected").toHaveLength(1);
  return marks[0];
}

beforeEach(() => {
  useModeStore.setState({ mode: "guided" });
  useNavGuardStore.setState({ drafts: new Map(), pendingIntent: null, open: false });
});

afterEach(() => {
  cleanup();
});

describe("the app mark pairs the chrome plane with the accent's own ON-colour", () => {
  it.each([
    ["the top bar", () => render(<TopBar />)],
    ["the side nav", () => render(<AppSideNav />)],
  ])("%s paints bg-chrome with text-onbrand, never the ink ramp", (_name, mount) => {
    mount();
    const tokens = tokensOf(appMark());

    expect(tokens).toContain("text-onbrand");
    // `--chrome` IS the accent, so both ink-ramp foregrounds are wrong on it: `text-ink`
    // inverts, and `text-on-ink` is the ON-colour of a different fill that merely happened
    // to look close in light mode.
    expect(tokens).not.toContain("text-on-ink");
    expect(tokens).not.toContain("text-ink");
  });
});

describe("the mode toggle's active segment lifts to the L1 plane with brand ink", () => {
  it("paints the selected tab bg-surface + text-brandink and the rest on the ink ramp", () => {
    render(<ModeToggle />);

    const selected = screen.getByTestId("mode-toggle-guided");
    const unselected = screen.getByTestId("mode-toggle-advanced");
    expect(selected).toHaveAttribute("aria-selected", "true");

    const active = tokensOf(selected);
    expect(active).toContain("bg-surface");
    expect(active).toContain("text-brandink");
    // The retired v1 pair: `bg-ink` / `text-on-ink` here is the dark-chrome segment coming
    // back, which is the exact revert the guard exists for.
    expect(active).not.toContain("bg-ink");
    expect(active).not.toContain("text-on-ink");

    // Non-vacuity: the two tabs must actually differ, or an unstyled control would satisfy
    // every negative above.
    expect(tokensOf(unselected)).not.toContain("bg-surface");
    expect(tokensOf(unselected)).toContain("text-ink2");
  });
});
