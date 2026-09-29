// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import { SuccessionForm } from "@/components/successions/succession-form";
import {
  emptySuccessionForm,
  SUCCESSION_MESSAGES,
  successionNeverRunsMessage,
} from "@/components/successions/successions-model";
import { AffinityForm } from "@/components/affinities/affinity-form";
import { AFFINITY_MESSAGES, emptyAffinityForm } from "@/components/affinities/affinities-model";
import { CoveringCardList } from "@/components/coverings/covering-card-list";
import { CardListItem } from "./card-editor-shell";

// Audit batch A4: the non-blocking warnings a rule form shows for a card that saves
// but will not behave as its author expects.

afterEach(() => cleanup());

const noop = () => {};
// Mon 5 Oct .. Sun 18 Oct 2026.
const STATE = {
  ...createEmptyScenarioUiState(),
  staff: [{ id: "Anna" }, { id: "Lil" }],
  shifts: [{ id: "D" }, { id: "N" }],
  rangeStart: "2026-10-05",
  rangeEnd: "2026-10-18",
};

function renderSuccession(date: string[], weight: number) {
  const initialForm = { ...emptySuccessionForm(), pattern: ["N", "D"], date, weight };
  render(
    <SuccessionForm
      state={STATE}
      mode="add"
      initialForm={initialForm}
      onSave={noop}
      onCancel={noop}
    />,
  );
}

describe("succession form (Q1, Q2)", () => {
  it("warns when the pattern fits no run of the chosen dates", () => {
    renderSuccession(["MONDAY"], -1);
    expect(screen.getByText(successionNeverRunsMessage(2))).toBeInTheDocument();
  });

  it("stays quiet when a window fits and the weight is soft", () => {
    renderSuccession(["ALL"], -1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("warns that +∞ forces the sequence at every start day", () => {
    renderSuccession(["ALL"], Infinity);
    expect(screen.getByText(SUCCESSION_MESSAGES.plusInf)).toBeInTheDocument();
  });
});

describe("pairing form (P2)", () => {
  function renderAffinity(weight: number) {
    render(
      <AffinityForm
        state={STATE}
        mode="add"
        initialForm={{ ...emptyAffinityForm(), weight }}
        onSave={noop}
        onCancel={noop}
      />,
    );
  }

  it("warns on +∞ that both sides must work every day", () => {
    renderAffinity(Infinity);
    expect(screen.getByText(AFFINITY_MESSAGES.plusInf)).toBeInTheDocument();
  });

  it("says nothing for a soft or -∞ weight", () => {
    renderAffinity(-Infinity);
    expect(screen.queryByText(AFFINITY_MESSAGES.plusInf)).toBeNull();
  });
});

describe("supervision card (G3)", () => {
  it("drops the Always enforced badge while the card is disabled", () => {
    const card = { uid: "c1", preceptors: ["Anna"], preceptees: ["Lil"], shiftTypes: ["D"] };
    const props = {
      onEdit: noop,
      onDuplicate: noop,
      onDelete: noop,
      onSetDisabled: noop,
      onReorder: noop,
    };
    const { rerender } = render(
      <CoveringCardList coverings={[{ ...card, weight: Infinity }]} {...props} />,
    );
    expect(screen.getByText("Always enforced")).toBeInTheDocument();
    rerender(
      <CoveringCardList coverings={[{ ...card, weight: Infinity, disabled: true }]} {...props} />,
    );
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByText("Always enforced")).toBeNull();
  });
});

describe("card number (G5)", () => {
  it("explains that order is not priority", () => {
    render(
      <ul>
        <CardListItem
          index={0}
          title="Night cap"
          fields={[]}
          actions={null}
          testId="card-0"
          changeKey="rule:counts:u1"
        />
      </ul>,
    );
    expect(screen.getByTitle("Order is for reference. Weight sets priority.")).toHaveTextContent(
      "1",
    );
  });
});
