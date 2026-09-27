// @vitest-environment jsdom
//
// A requirement card's "Exceptions" field lists the cover effects read-only, apart
// from the hand-written per-date overrides (d582, spec §6): on 14 Oct the need is 2
// because Haseena (Ward 3) is covering. It links to Staff, where covers are managed.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ScenarioUiState } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { scenarioCommands } from "@/lib/store";
import { drainScenarioCommands, resetScenarioForTest } from "@/lib/store/test-authority";
import { RequirementCardList } from "./requirement-card-list";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/shift-type-requirements",
}));

const CARD = {
  uid: "r-all",
  description: "All nurses",
  shiftType: "N",
  requiredNumPeople: 3,
  qualifiedPeople: "ALL",
  date: "ALL",
  weight: -1,
  requiredNumPeopleOverrides: [["2026-10-12", 2] as [string, number]],
};

function state(): ScenarioUiState {
  return {
    ...makeValidUiState(),
    staff: [],
    staffGroups: [],
    shifts: [
      { id: "D", description: "Day" },
      { id: "N", description: "Night" },
    ],
    shiftGroups: [],
    dateGroups: [],
    reqData: [],
    rangeStart: "2026-10-12",
    rangeEnd: "2026-10-20",
    cardsByKind: {
      requirements: [CARD],
      successions: [],
      counts: [],
      affinities: [],
      coverings: [],
    },
    temporaryCover: [{ name: "Haseena (Ward 3)", date: "2026-10-14", shiftType: "N", groups: [] }],
  } as ScenarioUiState;
}

const noop = () => undefined;

beforeEach(async () => {
  await resetScenarioForTest();
  await drainScenarioCommands();
  await act(async () => {
    await scenarioCommands.mutate(state());
  });
});
afterEach(() => cleanup());

describe("Requirement card list — cover effects", () => {
  it("Requirements Exceptions lists cover effects read-only", () => {
    render(
      <RequirementCardList
        requirements={[CARD as never]}
        onEdit={noop}
        onDuplicate={noop}
        onDelete={noop}
        onSetDisabled={noop}
        onReorder={noop}
      />,
    );
    expect(screen.getByText("Exceptions")).toBeInTheDocument();
    expect(screen.getByText(/14 Oct: 2 · Haseena \(Ward 3\) covering/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /staff/i })).toHaveAttribute("href", "/people");
    // Read-only: the field carries no control.
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
