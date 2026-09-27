// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { __resetForTests } from "@/components/theme/theme-store";
import { useModeStore } from "@/lib/mode/mode";
import { useNavGuardStore } from "./nav-guard-store";
import { TopBar } from "./top-bar";

// Prototype D2: the top bar carries the theme control, so it is reachable
// without opening the nav drawer (the footer copy lives inside the rail, which
// is `display:none` below the 920px nav breakpoint). This file holds the one
// fact no other suite does — that the ALWAYS-VISIBLE chrome, not just the rail
// footer, renders a working theme toggle.
//
// The bar's siblings are proved by their own suites and are stubbed so this file
// needs no scenario database and no assistant.

vi.mock("next/navigation", () => ({
  usePathname: () => "/dates",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("@/components/ai/assistant-launcher", () => ({ AssistantLauncher: () => null }));
vi.mock("./undo-redo-controls", () => ({ UndoRedoControls: () => null }));
vi.mock("./persistence-status", () => ({ PersistenceStatus: () => null }));
vi.mock("./mobile-nav", () => ({ MobileNav: () => null }));

// The scenario-context slot renders whatever name the projection holds. Pin one
// long enough to exceed the slot's `max-w-[36ch]` so the truncation contract is
// testable without a scenario database (see the file header).
const LONG_SCENARIO_NAME = vi.hoisted(
  () =>
    "Ward 8 East extended weekend night cover rotation, winter pressures escalation, east annex",
);

vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    useScenarioStore: ((selector: (state: { meta: { description: string } }) => unknown) =>
      selector({
        meta: { description: LONG_SCENARIO_NAME },
      })) as unknown as typeof actual.useScenarioStore,
  };
});

function renderTopBar() {
  return render(
    <ThemeProvider>
      <TopBar />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  __resetForTests();
  document.documentElement.className = "";
  useModeStore.setState({ mode: "guided" });
  useNavGuardStore.setState({ drafts: new Map(), pendingIntent: null, open: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TopBar — always-visible theme control (D2)", () => {
  it("renders the theme toggle inside the top bar, not only in the nav drawer", () => {
    renderTopBar();
    const toggle = screen.getByRole("button", { name: /switch to dark theme/i });
    expect(screen.getByTestId("top-bar").contains(toggle)).toBe(true);
  });

  it("flips the theme from the top bar", async () => {
    const user = userEvent.setup();
    renderTopBar();
    await user.click(screen.getByRole("button", { name: /switch to dark theme/i }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByRole("button", { name: /switch to light theme/i })).toBeInTheDocument();
  });
});

describe("TopBar — long scenario name (w0e.25)", () => {
  // The slot is `max-w-[36ch] truncate`, so any realistic ward name is clipped.
  // Without a `title` the clipped text is unrecoverable — the full value has to
  // ride on the element, per bd memory `long-user-text-no-overflow`.
  it("exposes the full scenario name as the context's title", () => {
    renderTopBar();
    const context = screen.getByTestId("scenario-context");
    expect(context).toHaveTextContent(LONG_SCENARIO_NAME);
    expect(context).toHaveAttribute("title", LONG_SCENARIO_NAME);
  });
});
