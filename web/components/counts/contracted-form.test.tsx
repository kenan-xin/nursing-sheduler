// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { ContractedForm } from "./contracted-form";
import {
  CONTRACTED_MESSAGES,
  emptyContractedForm,
  type ContractedFormState,
} from "./contracted-model";

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

// Fidelity Batch 3 (bmw.3) — the re-skinned form against the guided prototype:
// the "IN PLAIN ENGLISH" panel carrying the Refresh action, the target authored on
// the half-hour grid behind the large `{h}h` readout, and ONE solver-details
// collapsible in place of the separate locked-encoding well + raw-target override.
//
// These assert the identifiers and copy the re-skin introduces, so none of them can
// pass against the pre-batch component: it had no `contracted-plain-english`, no
// half-hour target input, no `contracted-solver-summary`, and neither an
// "Apply update" nor a "Cancel preview" button.

/** The `unsafeDraft` plus the LEAVE coverage the commit gate requires. */
function committableDraft(overrides: Partial<ContractedFormState> = {}): ContractedFormState {
  return unsafeDraft({
    countShiftTypes: ["D", "LEAVE"],
    countShiftTypeCoefficients: [
      ["D", 16],
      ["LEAVE", 16],
    ],
    ...overrides,
  });
}

describe("ContractedForm — IN PLAIN ENGLISH panel (bmw.3)", () => {
  it("states the contract from the live draft and owns the Refresh action", () => {
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="add"
        initialForm={committableDraft()}
        isEnabled
        {...NOOP}
      />,
    );
    expect(screen.getByTestId("contracted-plain-english-sentence").textContent).toBe(
      "Every nurse works exactly 160h across ALL. A paid-leave day credits 8h toward that total; a rest day (OFF) counts 0.",
    );
    // Placement: the Refresh action lives IN the panel header, not in a sibling block.
    const panel = screen.getByTestId("contracted-plain-english");
    expect(panel.contains(screen.getByTestId("contracted-refresh-button"))).toBe(true);
  });

  it("re-words the sentence when the policy and target change", () => {
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="add"
        initialForm={committableDraft()}
        isEnabled
        {...NOOP}
      />,
    );
    fireEvent.click(screen.getByTestId("contracted-policy-range"));
    fireEvent.change(screen.getByTestId("contracted-target-min"), { target: { value: "300" } });
    fireEvent.change(screen.getByTestId("contracted-target-max"), { target: { value: "340" } });
    expect(screen.getByTestId("contracted-plain-english-sentence").textContent).toContain(
      "between 150h and 170h",
    );
  });
});

describe("ContractedForm — form copy (bmw.3)", () => {
  it("heads the form and labels submit with the prototype's words", () => {
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="add"
        initialForm={committableDraft()}
        isEnabled
        {...NOOP}
      />,
    );
    expect(screen.getByText("Add Contracted Hours")).toBeTruthy();
    expect(screen.getByTestId("card-editor-submit").textContent).toContain("Add contract");
  });

  it("switches the heading and submit label in edit mode", () => {
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="edit"
        initialForm={committableDraft()}
        isEnabled
        {...NOOP}
      />,
    );
    expect(screen.getByText("Edit Contracted Hours")).toBeTruthy();
    expect(screen.getByTestId("card-editor-submit").textContent).toContain("Update contract");
  });
});

describe("ContractedForm — half-hour target on the guided slider (bmw.3)", () => {
  it("authors the target in half-hours and reads it back in hours", () => {
    const onSave = vi.fn();
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="add"
        initialForm={committableDraft()}
        isEnabled
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("contracted-target-exact") as HTMLInputElement;
    // The draft's human-hours "160h" IS 320 half-hours.
    expect(input.value).toBe("320");
    expect(screen.getByTestId("contracted-target-readout").textContent).toBe("160h");
    expect(screen.getByTestId("contracted-target-slider")).toBeTruthy();

    fireEvent.change(input, { target: { value: "330" } });
    expect(screen.getByTestId("contracted-target-readout").textContent).toBe("165h");
    // The draft keeps its human-hours encoding, so the saved card is unchanged.
    fireEvent.click(screen.getByTestId("card-editor-submit"));
    expect((onSave.mock.calls[0][0] as ContractedFormState).targetExact).toBe("165h");
  });

  it("rejects an off-grid half-hour target instead of truncating it", () => {
    const onSave = vi.fn();
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="add"
        initialForm={committableDraft()}
        isEnabled
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("contracted-target-exact") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3.5" } });
    expect(input.value).toBe("320");
    fireEvent.change(input, { target: { value: "-8" } });
    expect(input.value).toBe("320");
    fireEvent.click(screen.getByTestId("card-editor-submit"));
    expect((onSave.mock.calls[0][0] as ContractedFormState).targetExact).toBe("160h");
  });

  it("clearing the target drops the value so the required error fires on save", () => {
    const onSave = vi.fn();
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="add"
        initialForm={committableDraft()}
        isEnabled
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("contracted-target-exact") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByTestId("contracted-target-readout").textContent).toBe("—h");
    fireEvent.click(screen.getByTestId("card-editor-submit"));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows both range bounds as half-hour inputs with a combined readout", () => {
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="add"
        initialForm={committableDraft({ policy: "range" })}
        isEnabled
        {...NOOP}
      />,
    );
    const min = screen.getByTestId("contracted-target-min") as HTMLInputElement;
    const max = screen.getByTestId("contracted-target-max") as HTMLInputElement;
    fireEvent.change(min, { target: { value: "300" } });
    fireEvent.change(max, { target: { value: "340" } });
    expect(screen.getByTestId("contracted-target-readout").textContent).toBe("150h – 170h");
    expect(screen.getByTestId("contracted-solver-summary").textContent).toBe("300 ≤ x ≤ 340 · +∞");
  });
});

describe("ContractedForm — one target error line (bmw.3)", () => {
  it("reports an empty range's missing bounds once, not twice", () => {
    const onSave = vi.fn();
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="add"
        initialForm={committableDraft({ policy: "range" })}
        isEnabled
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("card-editor-submit"));
    expect(onSave).not.toHaveBeenCalled();
    // Both bounds are missing and both report the SAME message; the cell shows one.
    expect(screen.getAllByText(CONTRACTED_MESSAGES.target)).toHaveLength(1);
  });

  it("reports the min > max ordering error", () => {
    const onSave = vi.fn();
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="add"
        initialForm={committableDraft({ policy: "range" })}
        isEnabled
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("contracted-target-min"), { target: { value: "340" } });
    fireEvent.change(screen.getByTestId("contracted-target-max"), { target: { value: "300" } });
    fireEvent.click(screen.getByTestId("card-editor-submit"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getAllByText(CONTRACTED_MESSAGES.rangeOrder)).toHaveLength(1);
  });
});

describe("ContractedForm — consolidated solver details (bmw.3)", () => {
  it("shows the concrete expression and the locked weight in one collapsible", () => {
    render(
      <ContractedForm
        state={leaveScenario()}
        mode="add"
        initialForm={committableDraft()}
        isEnabled
        {...NOOP}
      />,
    );
    // The separate "locked encoding" well is gone — that content lives here.
    expect(screen.queryByTestId("contracted-locked-encoding")).toBeNull();
    const details = screen.getByTestId("contracted-solver-details");
    expect(details.tagName).toBe("DETAILS");
    expect(details.hasAttribute("open")).toBe(false);
    expect(screen.getByTestId("contracted-solver-details-toggle").textContent).toContain(
      "Solver details & overrides",
    );
    // The summary states the CONCRETE half-hour encoding, not an abstract `x = T`.
    expect(screen.getByTestId("contracted-solver-summary").textContent).toBe("x = 320 · +∞");
    expect(screen.getByTestId("contracted-raw-encoding").textContent).toBe("x = 320");
    expect(screen.getByTestId("contracted-locked-weight").textContent).toBe("+∞");
  });
});

describe("ContractedForm — Refresh placement and aggregate preview (bmw.3)", () => {
  /** A scenario whose single worked shift has a half-hour-derivable duration. */
  function derivableScenario(): ScenarioUiState {
    return {
      ...createEmptyScenarioUiState(),
      staff: [{ id: "Anna" }],
      shifts: [{ id: "D", durationMinutes: 480 }],
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-31",
    };
  }

  it("opens the aggregate banner under the panel and applies the derivation", () => {
    const onSave = vi.fn();
    render(
      <ContractedForm
        state={derivableScenario()}
        mode="add"
        initialForm={{
          ...emptyContractedForm(),
          person: ["ALL"],
          countDates: ["ALL"],
          countShiftTypes: ["D"],
          countShiftTypeCoefficients: [["D", ""]],
          targetExact: "160h",
        }}
        isEnabled
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByTestId("contracted-refresh-preview")).toBeNull();
    fireEvent.click(screen.getByTestId("contracted-refresh-button"));
    const preview = screen.getByTestId("contracted-refresh-preview");
    // The aggregate banner is the prototype's headline + four counts.
    expect(preview.textContent).toContain("Shift Types changed — review before applying");
    expect(screen.getByTestId("contracted-refresh-count-added").textContent).toContain("1 added");
    expect(screen.getByTestId("contracted-refresh-count-removed").textContent).toContain(
      "0 removed",
    );
    // The per-id rows stay: the aggregate alone hides what a coefficient becomes.
    expect(screen.getByTestId("contracted-refresh-row-D").getAttribute("data-category")).toBe(
      "added",
    );
    expect(screen.getByTestId("contracted-refresh-confirm").textContent).toContain("Apply update");
    expect(screen.getByTestId("contracted-refresh-cancel").textContent).toContain("Cancel preview");

    fireEvent.click(screen.getByTestId("contracted-refresh-confirm"));
    expect(screen.queryByTestId("contracted-refresh-preview")).toBeNull();
    fireEvent.click(screen.getByTestId("card-editor-submit"));
    const saved = onSave.mock.calls[0][0] as ContractedFormState;
    expect(saved.countShiftTypeCoefficients).toContainEqual(["D", 16]);
  });
});

describe("ContractedForm — per-row derived-coefficient hints (9a8)", () => {
  /** One derivable worked shift (D, 8h), one off-grid shift (N, 460 min) and LEAVE. */
  function hintScenario(): ScenarioUiState {
    return {
      ...createEmptyScenarioUiState(),
      staff: [{ id: "Anna" }],
      shifts: [
        { id: "D", durationMinutes: 480 },
        { id: "N", durationMinutes: 460 },
      ],
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-31",
    };
  }

  function renderHints() {
    render(
      <ContractedForm
        state={hintScenario()}
        mode="add"
        initialForm={{
          ...emptyContractedForm(),
          person: ["ALL"],
          countDates: ["ALL"],
          countShiftTypes: ["D", "N", "LEAVE"],
          countShiftTypeCoefficients: [
            ["D", 16],
            ["N", ""],
            ["LEAVE", 16],
          ],
          targetExact: "160h",
        }}
        isEnabled
        {...NOOP}
      />,
    );
  }

  it("hints a worked shift's working time and a leave day's credit per row", () => {
    renderHints();
    const testId = "contracted-coefficient-fields-hint";
    expect(screen.getByTestId(`${testId}-D`).textContent).toBe("8h × 2 · from working time");
    expect(screen.getByTestId(`${testId}-LEAVE`).textContent).toBe("8h credit · editable");
    // N's 460-minute duration is off the half-hour grid — set by hand.
    expect(screen.getByTestId(`${testId}-N`).textContent).toBe("no working time — set manually");
  });
});
