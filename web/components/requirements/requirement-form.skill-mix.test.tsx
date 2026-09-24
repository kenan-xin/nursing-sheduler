// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RequirementForm } from "./requirement-form";
import { emptyRequirementForm, REQUIREMENT_MESSAGES } from "./requirements-model";
import { people, ward } from "@/lib/rules/ward-fixtures.test-support";

afterEach(cleanup);

const state = ward({
  staff: people("rn1", "rn2", "en1"),
  staffGroups: [{ id: "RN", members: ["rn1", "rn2"] }],
});
const initial = {
  ...emptyRequirementForm(),
  shiftType: ["N"],
  requiredNumPeople: 4,
  qualifiedPeople: ["ALL"],
  date: ["ALL"],
};

describe("Skill mix rows", () => {
  it("adds 'at least 2 from RN' and saves it", async () => {
    const onSave = vi.fn();
    render(
      <RequirementForm
        state={state}
        mode="add"
        initialForm={initial}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add skill mix" }));
    await userEvent.clear(screen.getByLabelText("Skill mix 1 minimum"));
    await userEvent.type(screen.getByLabelText("Skill mix 1 minimum"), "2");
    await userEvent.selectOptions(screen.getByLabelText("Skill mix 1 group"), "RN");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ skillMix: [{ people: "RN", minNumPeople: 2 }] }),
    );
  });

  it("shows the help text", () => {
    render(
      <RequirementForm
        state={state}
        mode="add"
        initialForm={initial}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "At least this many of the shift's nurses must come from the group. Anyone can fill the other places.",
      ),
    ).toBeInTheDocument();
  });

  it("is disabled while qualified people is not Everyone", () => {
    render(
      <RequirementForm
        state={state}
        mode="edit"
        initialForm={{ ...initial, qualifiedPeople: ["RN"] }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Add skill mix" })).toBeDisabled();
    expect(screen.getByText(REQUIREMENT_MESSAGES.skillMixNeedsEveryone + ".")).toBeInTheDocument();
  });

  it("removes a row", async () => {
    const onSave = vi.fn();
    render(
      <RequirementForm
        state={state}
        mode="edit"
        initialForm={{ ...initial, skillMix: [{ people: "RN", minNumPeople: 2 }] }}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove skill mix 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ skillMix: [] }));
  });

  it("shows the validation message when the minimum is above the required number", async () => {
    render(
      <RequirementForm
        state={state}
        mode="edit"
        initialForm={{ ...initial, skillMix: [{ people: "RN", minNumPeople: 5 }] }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(screen.getByText(REQUIREMENT_MESSAGES.skillMixAboveRequired)).toBeInTheDocument();
  });
});
