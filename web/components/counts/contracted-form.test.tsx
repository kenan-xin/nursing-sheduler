// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { ContractedForm } from "./contracted-form";
import { emptyContractedForm, type ContractedFormState } from "./contracted-model";

// qq0.23d editor advisory: the contracted form recomputes an uncredited-leave
// finding from the CURRENT draft + live scenario pins through the shared detector,
// names the affected people, and offers the one-click `Add LEAVE · 16` repair. The
// advisory + action are bound to the source card's enablement (critique P2).

function leaveScenario(overrides: Partial<ScenarioUiState> = {}): ScenarioUiState {
  return {
    ...createEmptyScenarioUiState(),
    staff: [{ id: "Anna" }, { id: "Lil" }],
    shifts: [{ id: "D" }, { id: "N" }],
    rangeStart: "2026-01-01",
    rangeEnd: "2026-01-31",
    reqData: [{ kind: "leave", person: "Anna", date: "2026-01-05" }],
    ...overrides,
  };
}

function unsafeDraft(overrides: Partial<ContractedFormState> = {}): ContractedFormState {
  return {
    ...emptyContractedForm(),
    person: ["ALL"],
    countDates: ["ALL"],
    countShiftTypes: ["D"],
    countShiftTypeCoefficients: [["D", 16]],
    targetExact: "160h",
    ...overrides,
  };
}

const NOOP = { onSave: () => {}, onCancel: () => {} };

afterEach(() => {
  cleanup();
});

describe("ContractedForm — uncredited-leave advisory (qq0.23d)", () => {
  it("shows the advisory naming the affected person for an enabled unsafe draft", () => {
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="edit"
        initialForm={unsafeDraft()}
        isEnabled
        {...NOOP}
      />,
    );
    const advisory = screen.getByTestId("contracted-leave-advisory");
    expect(advisory).toBeTruthy();
    // Non-blocking, announced politely (a11y): a status region, not an alert.
    expect(advisory.getAttribute("role")).toBe("status");
    expect(advisory.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByTestId("contracted-leave-advisory-text").textContent).toContain("Anna");
    // The repair action reads the raw half-hour credit the transform actually adds.
    expect(screen.getByTestId("contracted-add-leave").textContent).toContain("Add LEAVE · 16");
  });

  it("clicking Add LEAVE clears the advisory without persisting (draft-only, no onSave)", () => {
    const onSave = vi.fn();
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="edit"
        initialForm={unsafeDraft()}
        isEnabled
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId("contracted-leave-advisory")).toBeTruthy();
    fireEvent.click(screen.getByTestId("contracted-add-leave"));
    // The draft now credits LEAVE, so the recomputed advisory disappears — and the
    // repair never persists: only the explicit Update path calls onSave.
    expect(screen.queryByTestId("contracted-leave-advisory")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Add LEAVE then Update persists the credited draft in a single onSave call", () => {
    const onSave = vi.fn();
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="edit"
        initialForm={unsafeDraft()}
        isEnabled
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("contracted-add-leave"));
    // The single existing Update path commits selector + coefficient together (one
    // `updateContracted` → one `mutateScenario` → one undo step).
    fireEvent.click(screen.getByTestId("card-editor-submit"));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as ContractedFormState;
    expect(saved.countShiftTypes).toContain("LEAVE");
    expect(saved.countShiftTypeCoefficients).toContainEqual(["LEAVE", 16]);
  });

  it("suppresses the advisory + action when the source card is disabled (isEnabled=false)", () => {
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="edit"
        initialForm={unsafeDraft()}
        isEnabled={false}
        {...NOOP}
      />,
    );
    expect(screen.queryByTestId("contracted-leave-advisory")).toBeNull();
    expect(screen.queryByTestId("contracted-add-leave")).toBeNull();
  });

  it("shows no advisory when the draft already credits LEAVE", () => {
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="edit"
        initialForm={unsafeDraft({ countShiftTypes: ["D", "LEAVE"] })}
        isEnabled
        {...NOOP}
      />,
    );
    expect(screen.queryByTestId("contracted-leave-advisory")).toBeNull();
  });
});

// R4 — the user-reported selected-segment defect, guarded at the authoring layer.
//
// The browser-side proof (computed colour + real WCAG contrast across all eight
// theme x accent cells) lives in `e2e/counts.spec.ts`; jsdom computes no colours,
// so it cannot repeat that and does not pretend to. What it CAN do is fail fast on
// the authoring mistake itself, which is the thing a future edit would reintroduce:
// a foreground class on the selected segment's subtree. That is a genuinely
// different guard, not a weaker copy of the same one — the E2E catches a broken
// RESULT, this catches the broken INSTRUCTION, and the second is what a reviewer
// reads in the diff.
describe("ContractedForm — policy toggle selected foreground (R4 user-reported defect)", () => {
  /** Every Tailwind text-colour utility in a class list. */
  function foregroundClasses(el: Element): string[] {
    return Array.from(el.classList).filter((c) => /^(?:[a-z-]+:)*text-(?!label|meta|body)/.test(c));
  }

  it("paints the selected segment with the canonical --brand/--onbrand pair", () => {
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="add"
        initialForm={unsafeDraft()}
        isEnabled
        {...NOOP}
      />,
    );
    const exact = screen.getByTestId("contracted-policy-exact");
    expect(exact.getAttribute("aria-pressed")).toBe("true");
    expect(Array.from(exact.classList)).toContain("bg-brand");
    expect(Array.from(exact.classList)).toContain("text-onbrand");
    // `--brandink` is a DARKENED --brand in light mode, so it was brand-on-brand.
    expect(Array.from(exact.classList)).not.toContain("text-brandink");
  });

  it("leaves every descendant of the selected segment without a foreground override", () => {
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="add"
        initialForm={unsafeDraft()}
        isEnabled
        {...NOOP}
      />,
    );
    const exact = screen.getByTestId("contracted-policy-exact");
    // The formula span is the exact child that forced `text-ink3` and made the
    // user's "Exact  x = T" unreadable. Nothing under a solid fill may set its own
    // foreground — inheriting the pair is the whole contract.
    for (const child of Array.from(exact.querySelectorAll("*"))) {
      expect(
        foregroundClasses(child),
        `"${child.textContent}" opts out of the fill's paired foreground`,
      ).toEqual([]);
    }
    expect(exact.textContent).toContain("x = T");
  });

  it("keeps the tertiary formula ink on the UNSELECTED segment, which is not on a fill", () => {
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="add"
        initialForm={unsafeDraft()}
        isEnabled
        {...NOOP}
      />,
    );
    const range = screen.getByTestId("contracted-policy-range");
    expect(range.getAttribute("aria-pressed")).toBe("false");
    expect(Array.from(range.classList)).not.toContain("bg-brand");
    // De-emphasising the formula is correct here: this segment sits on the well
    // track, not on a brand fill. The rule is about fills, not about hints.
    const hint = range.querySelector("span");
    expect(foregroundClasses(hint!)).toEqual(["text-ink3"]);
  });

  it("moves the pair to whichever segment is selected", () => {
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="add"
        initialForm={unsafeDraft()}
        isEnabled
        {...NOOP}
      />,
    );
    fireEvent.click(screen.getByTestId("contracted-policy-range"));
    const range = screen.getByTestId("contracted-policy-range");
    expect(Array.from(range.classList)).toContain("bg-brand");
    expect(Array.from(range.classList)).toContain("text-onbrand");
    for (const child of Array.from(range.querySelectorAll("*"))) {
      expect(foregroundClasses(child)).toEqual([]);
    }
    expect(Array.from(screen.getByTestId("contracted-policy-exact").classList)).not.toContain(
      "bg-brand",
    );
  });
});
