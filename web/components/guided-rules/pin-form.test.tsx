// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GuidedRulePin } from "@/lib/scenario";
import { PinForm } from "./pin-form";
import type { PinnableRecord } from "./types";

afterEach(() => {
  cleanup();
});

const RECORD_A: PinnableRecord = {
  kind: "requirements",
  constraintId: "r1",
  label: "Day cap",
  category: "Staffing",
  quickFieldOptions: [{ key: "requiredNumPeople", label: "People", value: 2 }],
};

const RECORD_B: PinnableRecord = {
  kind: "counts",
  constraintId: "c1",
  label: "Night ceiling",
  category: "Hours",
  quickFieldOptions: [{ key: "target", label: "Target", value: 3 }],
};

describe("PinForm — Problem A: editing a pin retains its quick-edit fields", () => {
  const pin: GuidedRulePin = {
    id: "p1",
    constraintKind: "requirements",
    constraintId: "r1",
    category: "Staffing",
    quickFields: ["requiredNumPeople"],
    description: "Cover the day shift",
  };

  it("shows the pinned quick field as selected (aria-pressed) instead of wiping it on mount", () => {
    render(
      <PinForm
        records={[RECORD_A]}
        initial={{ pin, title: "Day cap" }}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(screen.getByTestId("pin-form-field-requiredNumPeople")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("preserves quickFields on Save (edit mode no longer persists an empty set)", () => {
    const onSubmit = vi.fn();
    render(
      <PinForm
        records={[RECORD_A]}
        initial={{ pin, title: "Day cap" }}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByTestId("pin-form-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].quickFields).toEqual(["requiredNumPeople"]);
  });
});

describe("PinForm — Problem B: switching the picker renames the selected constraint, not the first", () => {
  it("re-syncs the title to record B's label after selecting A then B", () => {
    const onSubmit = vi.fn();
    render(<PinForm records={[RECORD_A, RECORD_B]} onCancel={() => {}} onSubmit={onSubmit} />);

    const select = screen.getByTestId("pin-form-record-select");
    // Select A first — title auto-fills to A's label.
    fireEvent.change(select, { target: { value: "requirements:r1" } });
    expect(screen.getByTestId("pin-form-title")).toHaveValue("Day cap");
    // Switch to B — the stale A label must not survive.
    fireEvent.change(select, { target: { value: "counts:c1" } });

    fireEvent.click(screen.getByTestId("pin-form-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submission = onSubmit.mock.calls[0][0];
    expect(submission.constraintId).toBe("c1");
    expect(submission.title).not.toBe("Day cap");
    expect(submission.title).toBe("Night ceiling");
  });
});

describe("PinForm — StrictMode: edit-mode quickFields survive a double-invoked mount effect", () => {
  const pin: GuidedRulePin = {
    id: "p1",
    constraintKind: "requirements",
    constraintId: "r1",
    category: "Staffing",
    quickFields: ["requiredNumPeople"],
    description: "Cover the day shift",
  };

  // Reproduces the Next App Router dev server: StrictMode double-invokes the
  // mount effect (setup -> cleanup -> setup). The old first-render `didMountRef`
  // guard let the second run call `setQuickFields([])` and wipe the edit-mode
  // init; the prev-key compare treats both runs as a no-op because `selectedKey`
  // never changed.
  it("keeps the pinned quick field selected when the mount effect runs twice", () => {
    const onSubmit = vi.fn();
    render(
      <React.StrictMode>
        <PinForm
          records={[RECORD_A]}
          initial={{ pin, title: "Day cap" }}
          onCancel={() => {}}
          onSubmit={onSubmit}
        />
      </React.StrictMode>,
    );

    expect(screen.getByTestId("pin-form-field-requiredNumPeople")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByTestId("pin-form-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].quickFields).toEqual(["requiredNumPeople"]);
  });
});

describe("PinForm — add mode: switching the picker still resets quickFields", () => {
  it("clears the prior record's ticked fields when a different record is selected", () => {
    const onSubmit = vi.fn();
    render(<PinForm records={[RECORD_A, RECORD_B]} onCancel={() => {}} onSubmit={onSubmit} />);

    const select = screen.getByTestId("pin-form-record-select");
    // Select A and tick its quick field.
    fireEvent.change(select, { target: { value: "requirements:r1" } });
    fireEvent.click(screen.getByTestId("pin-form-field-requiredNumPeople"));
    expect(screen.getByTestId("pin-form-field-requiredNumPeople")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Switch to B — the genuine key change must reset the selection.
    fireEvent.change(select, { target: { value: "counts:c1" } });
    expect(screen.getByTestId("pin-form-field-target")).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByTestId("pin-form-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submission = onSubmit.mock.calls[0][0];
    expect(submission.constraintId).toBe("c1");
    expect(submission.quickFields).toEqual([]);
  });
});
