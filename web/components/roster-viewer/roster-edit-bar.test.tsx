// @vitest-environment jsdom

// RosterEditBar accessibility contract (nursing-sheduler-w0e.13).
//
// Base UI's Combobox marks everything outside the combobox input's ancestor chain
// `aria-hidden` while the popup is open — including this bar's own OFF / LV buttons
// and its Cancel button. The popup is non-modal and focus is untrapped, so those
// controls stayed in sequential focus navigation: Tab landed on content a screen
// reader user cannot perceive, which is exactly what axe reports as
// `aria-hidden-focus`. The bar takes them out of the tab order for that window.
// These tests hold it to the rule axe states: nothing inside an `aria-hidden`
// subtree may be tabbable.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { priyaContext } from "@/lib/roster-viewer/swap-fixtures";
import { RosterEditBar } from "./roster-edit-bar";

afterEach(cleanup);

/** Anything the browser would put in the tab order. */
const TABBABLE_SELECTOR = "a[href], button, input, select, textarea, [tabindex]";

/**
 * Every tabbable element that sits inside an `aria-hidden="true"` subtree.
 *
 * Both directions matter: the `aria-hidden` node may BE the tabbable element (the
 * Cancel button is hidden directly) or merely CONTAIN it (the OFF / LV wrapper).
 * This is the same population axe's `aria-hidden-focus` checks walk
 * (`virtualNode.tabbableElements`), so a tabindex of -1 is what clears it — the
 * element stays focusable programmatically, it is simply no longer reachable by Tab.
 */
function tabbableInsideAriaHidden(): HTMLElement[] {
  const offenders = new Set<HTMLElement>();
  for (const hidden of document.querySelectorAll<HTMLElement>('[aria-hidden="true"]')) {
    for (const candidate of [hidden, ...hidden.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)]) {
      if (candidate.tabIndex >= 0 && !candidate.hasAttribute("disabled")) offenders.add(candidate);
    }
  }
  return [...offenders];
}

function label(el: HTMLElement): string {
  return `${el.tagName.toLowerCase()}[data-testid=${el.dataset.testid ?? "—"}]`;
}

function renderBar() {
  return render(
    <RosterEditBar
      context={priyaContext()}
      selected={{ personIdx: 0, dateIdx: 0 }}
      current={{ kind: "shift", shiftId: "AM" }}
      onSetCell={() => {}}
      onCancel={() => {}}
    />,
  );
}

/** Open the shift chooser the way a user does — a real pointer sequence. */
async function openPicker() {
  await userEvent.click(screen.getByTestId("roster-shift-picker"));
  await screen.findByTestId("roster-shift-option-AM");
}

describe("RosterEditBar — edit scope (audit C-08)", () => {
  it("says a hand edit is roster-only and the next run will not keep it", () => {
    renderBar();
    expect(screen.getByTestId("roster-edit-scope")).toHaveTextContent(
      "Roster only. The next run will not keep this.",
    );
  });
});

describe("RosterEditBar — aria-hidden must not cover tabbable content", () => {
  it("hides no tabbable content from assistive tech while the picker is closed", () => {
    renderBar();
    expect(tabbableInsideAriaHidden()).toEqual([]);
    expect(screen.getByTestId("roster-edit-option-OFF").tabIndex).toBe(0);
    expect(screen.getByTestId("roster-edit-option-LV").tabIndex).toBe(0);
    expect(screen.getByTestId("roster-edit-bar-cancel").tabIndex).toBe(0);
  });

  it("leaves no tabbable element inside an aria-hidden subtree once the picker is open", async () => {
    renderBar();
    await openPicker();

    // Base UI did hide the bar's own controls — the fix is that they leave the tab
    // order, not that the hiding stopped.
    expect(
      screen.getByTestId("roster-edit-option-OFF").closest('[aria-hidden="true"]'),
    ).not.toBeNull();
    expect(screen.getByTestId("roster-edit-bar-cancel")).toHaveAttribute("aria-hidden", "true");

    const offenders = tabbableInsideAriaHidden();
    expect(
      offenders.map(label),
      "tabbable elements hidden from assistive tech while the shift picker is open",
    ).toEqual([]);
  });

  it("gives the bar's controls their tab stops back once the picker closes", async () => {
    renderBar();
    await openPicker();
    expect(screen.getByTestId("roster-edit-option-OFF").tabIndex).toBe(-1);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("roster-shift-option-AM")).toBeNull());

    expect(tabbableInsideAriaHidden()).toEqual([]);
    expect(screen.getByTestId("roster-edit-bar-cancel").tabIndex).toBe(0);
    expect(screen.getByTestId("roster-edit-option-OFF").tabIndex).toBe(0);
    expect(screen.getByTestId("roster-edit-option-LV").tabIndex).toBe(0);
  });

  // The non-modal contract: taking the controls out of the TAB ORDER must not take
  // them away from the pointer (mui/base-ui#5528's stated reason to prefer this over
  // `inert`, which would block pointer interaction too).
  it("keeps the bar's controls pointer-operable while the picker is open", async () => {
    let cancelled = 0;
    render(
      <RosterEditBar
        context={priyaContext()}
        selected={{ personIdx: 0, dateIdx: 0 }}
        current={{ kind: "shift", shiftId: "AM" }}
        onSetCell={() => {}}
        onCancel={() => {
          cancelled += 1;
        }}
      />,
    );
    await openPicker();

    await userEvent.click(screen.getByTestId("roster-edit-bar-cancel"));
    expect(cancelled).toBe(1);
  });
});
