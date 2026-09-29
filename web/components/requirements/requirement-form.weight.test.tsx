// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RequirementForm } from "./requirement-form";
import { emptyRequirementForm } from "./requirements-model";
import { people, ward } from "@/lib/rules/ward-fixtures.test-support";

afterEach(cleanup);

const state = ward({ staff: people("rn1", "rn2") });

describe("Requirement weight with a preferred number", () => {
  it("offers no infinite weight and says how to make a hard count", () => {
    render(
      <RequirementForm
        state={state}
        mode="add"
        initialForm={{
          ...emptyRequirementForm(),
          shiftType: ["N"],
          requiredNumPeople: 2,
          preferredNumPeople: 3,
          qualifiedPeople: ["ALL"],
          date: ["ALL"],
        }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("weight-field-input")).toBeInTheDocument();
    expect(screen.queryByTestId("weight-field-plus-inf")).toBeNull();
    expect(screen.queryByTestId("weight-field-minus-inf")).toBeNull();
    expect(screen.getByText(/For a hard count, leave Preferred empty\./)).toBeInTheDocument();
  });
});
