// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CoveringsEditor } from "./coverings-editor";
import { drainScenarioPersist, newScenario, useHotStore, useScenarioStore } from "@/lib/store";

// T13 cold-audit regression (completion audit 2026-07-18, P1 finding): the editor
// instructions panel once told authors to set Weight to 1 for a soft preference or
// +Infinity for a hard rule. The hard/inert covering model intentionally has no
// editable weight, so that wording directly contradicts the implementation and
// ScreenCards.dc.html:442. These tests render the live CoveringsEditor against the
// real scenario store, open the help affordance, and pin the corrected copy so the
// stale soft-weight instruction fails loudly if it ever resurfaces.

beforeEach(async () => {
  newScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
});

afterEach(() => {
  cleanup();
});

function openHelpAndReadInstructions(): string {
  fireEvent.click(screen.getByTestId("card-editor-help-toggle"));
  const panel = screen.getByTestId("card-editor-instructions");
  return within(panel).getByRole("list").textContent ?? "";
}

describe("CoveringsEditor instructions — hard/inert copy (T13 audit)", () => {
  it("renders the always-enforced sentence and tells the author the solver ignores weight", () => {
    render(<CoveringsEditor />);
    const text = openHelpAndReadInstructions();
    expect(text).toMatch(/always enforced as a hard rule/i);
    expect(text).toMatch(/solver ignores (its )?weight/i);
    expect(text).toMatch(/no soft\/hard dial/i);
  });

  it("does not tell authors to set Weight to 1 for a soft preference", () => {
    render(<CoveringsEditor />);
    const text = openHelpAndReadInstructions();
    expect(text.toLowerCase()).not.toContain("soft preference");
  });

  it("does not instruct setting Weight to +Infinity for a hard rule", () => {
    render(<CoveringsEditor />);
    const text = openHelpAndReadInstructions();
    expect(text).not.toMatch(/\+infinity/i);
  });

  it("does not expose any editable 'Set the Weight' instruction", () => {
    render(<CoveringsEditor />);
    const text = openHelpAndReadInstructions();
    expect(text.toLowerCase()).not.toContain("set the weight");
  });
});
