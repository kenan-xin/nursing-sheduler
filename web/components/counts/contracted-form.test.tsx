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
