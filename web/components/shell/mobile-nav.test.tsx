// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobileNav } from "./mobile-nav";

// The drawer is the app's ONLY side-geometry overlay. It is a variant of the
// shared Dialog shell rather than a fork, so these tests pin the two things a
// fork would drift on: the drawer's own surface role (sidebar plane, the
// directional --sh-side cast, square) and the fact that it still gets the same
// portal, canonical scrim, focus containment and dismissal routes as a modal.
//
// `AppSideNav` is stubbed: its own composition is proved by the shell suites,
// and the contract under test here is the drawer around it — including that the
// close control still reaches the reserved `headerActions` slot, and that a
// completed navigation dismisses the drawer.

vi.mock("./app-side-nav", () => ({
  AppSideNav: ({
    onAfterNavigate,
    headerActions,
  }: {
    onAfterNavigate?: () => void;
    headerActions?: React.ReactNode;
  }) => (
    <div data-testid="side-nav-stub">
      {headerActions}
      <button type="button" data-testid="side-nav-link" onClick={() => onAfterNavigate?.()}>
        Dates
      </button>
    </div>
  ),
}));

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

async function openDrawer() {
  render(<MobileNav />);
  await userEvent.click(screen.getByTestId("mobile-nav-trigger"));
  return screen.getByTestId("mobile-nav-drawer");
}

afterEach(() => cleanup());

describe("MobileNav — drawer geometry and surface role", () => {
  it("is closed until the trigger is pressed, and the trigger is the real control", async () => {
    render(<MobileNav />);
    expect(screen.queryByTestId("mobile-nav-drawer")).not.toBeInTheDocument();
    const trigger = screen.getByTestId("mobile-nav-trigger");
    // Base UI `render`/trigger composition: the trigger IS the button, with no
    // wrapper-only element between it and the accessible name.
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("data-slot", "dialog-trigger");
    await userEvent.click(trigger);
    expect(screen.getByTestId("mobile-nav-drawer")).toBeInTheDocument();
  });

  it("takes the drawer surface role: sidebar plane, side cast, square", async () => {
    const drawer = await openDrawer();
    const classes = classesOf(drawer);
    expect(drawer).toHaveAttribute("data-variant", "side");
    expect(classes).toContain("bg-sidebar");
    expect(classes).toContain("shadow-side");
    expect(classes).toContain("rounded-none");
    // A drawer is NOT the centred raised card, and never borrows its shadow.
    expect(classes).not.toContain("rounded-card");
    expect(classes).not.toContain("shadow-3");
    // Prototype metrics: 250px capped at 84vw, anchored to the left edge.
    expect(classes).toContain("w-[250px]");
    expect(classes).toContain("max-w-[84vw]");
    expect(classes).toContain("inset-y-0");
    expect(classes).toContain("left-0");
  });

  it("uses the canonical scrim under the drawer — never a fixed near-black RGBA", async () => {
    await openDrawer();
    const overlay = document.querySelector("[data-slot='dialog-overlay']");
    const classes = classesOf(overlay);
    expect(classes).toContain("bg-scrim");
    expect(classes).not.toContain("bg-black");
    expect(classes).not.toContain("rgba");
  });

  it("portals the drawer and gives it an accessible name and description", async () => {
    const drawer = await openDrawer();
    expect(drawer.closest("[data-slot='dialog-portal']")).not.toBeNull();
    expect(drawer).toHaveAccessibleName("Navigation");
    expect(drawer).toHaveAccessibleDescription("Application navigation");
  });

  it("renders the same AppSideNav composition, with the close control in its header slot", async () => {
    await openDrawer();
    const stub = screen.getByTestId("side-nav-stub");
    expect(stub).toContainElement(screen.getByTestId("mobile-nav-close"));
  });
});

describe("MobileNav — modal behaviour and every dismissal route", () => {
  it("traps focus inside the drawer and locks page scroll while open", async () => {
    const drawer = await openDrawer();
    await waitFor(() => expect(drawer).toContainElement(document.activeElement as HTMLElement));
    // Base UI's modal scroll lock pins the document while the drawer is open.
    expect(document.body.style.overflow || document.documentElement.style.overflow).not.toBe("");
  });

  it("closes on Escape", async () => {
    await openDrawer();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("mobile-nav-drawer")).not.toBeInTheDocument());
  });

  it("closes on a backdrop press", async () => {
    await openDrawer();
    const overlay = document.querySelector("[data-slot='dialog-overlay']") as HTMLElement;
    await userEvent.click(overlay);
    await waitFor(() => expect(screen.queryByTestId("mobile-nav-drawer")).not.toBeInTheDocument());
  });

  it("closes on the close control", async () => {
    await openDrawer();
    await userEvent.click(screen.getByTestId("mobile-nav-close"));
    await waitFor(() => expect(screen.queryByTestId("mobile-nav-drawer")).not.toBeInTheDocument());
  });

  it("closes after a successful navigation", async () => {
    await openDrawer();
    await userEvent.click(screen.getByTestId("side-nav-link"));
    await waitFor(() => expect(screen.queryByTestId("mobile-nav-drawer")).not.toBeInTheDocument());
  });

  it("restores focus to the menu trigger after closing", async () => {
    await openDrawer();
    await userEvent.click(screen.getByTestId("mobile-nav-close"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("mobile-nav-trigger")),
    );
  });
});
