// @vitest-environment jsdom
//
// The Staff screen's "Temporary cover" section (d582, spec §6). It is the third
// card on `/people`, below Staff groups. These tests drive the section through
// `PeopleTable` (so the mount position is part of the proof) and assert against the
// durable store, the real F1 roster storage and the pure `temporary-cover` module
// the section reads — no component-internal mocks.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ScenarioUiState } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  currentRosterStorage,
  rosterStorage,
  scenarioCommands,
  useScenarioStore,
} from "@/lib/store";
import type { RosterDocument } from "@/lib/roster";
import { fixtureRosterDocument } from "@/lib/roster/test-fixtures";
import { drainScenarioCommands, resetScenarioForTest, undoDepth } from "@/lib/store/test-authority";
import { clearChangeHighlight } from "@/lib/change-highlight/store";
import {
  awaitCoverEditOutcome,
  requestCoverEdit,
  useCoverEditStore,
} from "@/lib/scenario/cover-edit-request";
import { PeopleTable } from "./people-table";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/people",
}));

const EMPTY_CARDS: ScenarioUiState["cardsByKind"] = {
  requirements: [],
  successions: [],
  counts: [],
  affinities: [],
  coverings: [],
};

function requirementCard(over: Partial<ScenarioUiState["cardsByKind"]["requirements"][number]>) {
  return {
    uid: "r-all",
    description: "All nurses",
    shiftType: "N",
    requiredNumPeople: 3,
    qualifiedPeople: "ALL",
    date: "ALL",
    weight: -1,
    ...over,
  };
}

/** A minimal valid state: two worked shifts, one RN group, one N shift requirement. */
function coverState(over: Partial<ScenarioUiState> = {}): ScenarioUiState {
  return {
    ...makeValidUiState(),
    staff: [],
    staffGroups: [{ id: "RN", members: [] }],
    shifts: [
      { id: "D", description: "Day" },
      { id: "N", description: "Night" },
    ],
    shiftGroups: [],
    dateGroups: [],
    reqData: [],
    rangeStart: "2026-10-12",
    rangeEnd: "2026-10-20",
    cardsByKind: { ...EMPTY_CARDS, requirements: [requirementCard({})] },
    temporaryCover: [],
    ...over,
  };
}

const COVER = {
  name: "Haseena (Ward 3)",
  date: "2026-10-14",
  shiftType: "N",
  groups: [] as string[],
};

async function seed(patch: Partial<ScenarioUiState>) {
  await act(async () => {
    await scenarioCommands.mutate(patch);
  });
}

async function seedWorkingRoster() {
  const document = await fixtureRosterDocument();
  // The open schedule's own roster (plq5 P2).
  const storage = currentRosterStorage();
  const epoch = await storage.getClearEpoch();
  const outcome = await storage.promoteDocumentToWorking({
    document,
    validate: (value) => ({ ok: true as const, document: value as RosterDocument }),
    expectedWorkingRevision: null,
    expectedClearEpoch: epoch,
  });
  if (outcome.status !== "promoted") throw new Error(`seed failed: ${outcome.status}`);
}

/** Fill the inline editor and save it (one undo entry). */
async function fillAndSave(entry: { name: string; date: string; shiftType: string }) {
  fireEvent.click(screen.getByTestId("temporary-cover-add"));
  fireEvent.change(screen.getByTestId("temporary-cover-name"), { target: { value: entry.name } });
  fireEvent.change(screen.getByTestId("temporary-cover-date"), { target: { value: entry.date } });
  fireEvent.change(screen.getByTestId("temporary-cover-shift"), {
    target: { value: entry.shiftType },
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("temporary-cover-save"));
    await drainScenarioCommands();
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetScenarioForTest();
  await drainScenarioCommands();
  await rosterStorage.clearRosterData().catch(() => undefined);
});
afterEach(() => cleanup());

describe("Temporary cover section — empty state and rows", () => {
  it("empty state reads 'No temporary cover'", async () => {
    await seed(coverState());
    render(<PeopleTable />);
    expect(screen.getByTestId("temporary-cover-empty")).toHaveTextContent("No temporary cover");
  });

  it('Effect reads "N on 14 Oct: 3 → 2 (All nurses)"', async () => {
    await seed(coverState({ temporaryCover: [COVER] }));
    render(<PeopleTable />);
    expect(screen.getByTestId("temporary-cover-effect-0")).toHaveTextContent(
      "N on 14 Oct: 3 → 2 (All nurses)",
    );
  });

  it("flagged cover shows its warning badge", async () => {
    await seed(coverState({ temporaryCover: [{ ...COVER, date: "2026-11-01" }] }));
    render(<PeopleTable />);
    expect(screen.getByTestId("temporary-cover-flag-0")).toHaveTextContent(
      "Outside the roster period",
    );
  });

  it("clamp shows the extra-cover warning", async () => {
    await seed(
      coverState({
        cardsByKind: { ...EMPTY_CARDS, requirements: [requirementCard({ requiredNumPeople: 2 })] },
        temporaryCover: [COVER, { ...COVER, name: "B (Ward 1)" }, { ...COVER, name: "C (Ward 2)" }],
      }),
    );
    render(<PeopleTable />);
    expect(screen.getByTestId("temporary-cover-effect-0")).toHaveTextContent(
      "N on 14 Oct: 2 → 0 (All nurses)",
    );
    expect(screen.getByTestId("temporary-cover-extra-0")).toHaveTextContent(
      "3 covers are booked, so 1 is extra",
    );
  });

  it('restricted card shows "Under <rule>, only RN work N. Haseena is not in RN."', async () => {
    await seed(
      coverState({
        cardsByKind: {
          ...EMPTY_CARDS,
          requirements: [
            requirementCard({ uid: "r-rn", description: "RN nights", qualifiedPeople: "RN" }),
          ],
        },
        temporaryCover: [COVER],
      }),
    );
    render(<PeopleTable />);
    expect(screen.getByTestId("temporary-cover-restricted-0")).toHaveTextContent(
      "Under RN nights, only RN work N. Haseena (Ward 3) is not in RN.",
    );
  });
});

describe("Temporary cover section — editor validation", () => {
  it("refuses a duplicate name and date", async () => {
    await seed(coverState({ temporaryCover: [COVER] }));
    render(<PeopleTable />);
    fireEvent.click(screen.getByTestId("temporary-cover-add"));
    fireEvent.change(screen.getByTestId("temporary-cover-name"), {
      target: { value: "Haseena (Ward 3)" },
    });
    fireEvent.change(screen.getByTestId("temporary-cover-date"), {
      target: { value: "2026-10-14" },
    });
    fireEvent.change(screen.getByTestId("temporary-cover-shift"), { target: { value: "N" } });
    fireEvent.click(screen.getByTestId("temporary-cover-save"));

    expect(screen.getByTestId("temporary-cover-error")).toHaveTextContent(
      "Haseena (Ward 3) already covers N on 14 Oct.",
    );
    await drainScenarioCommands();
    expect(useScenarioStore.getState().temporaryCover).toHaveLength(1);
  });

  it("refuses a second shift for one name on one date", async () => {
    await seed(coverState({ temporaryCover: [COVER] }));
    render(<PeopleTable />);
    fireEvent.click(screen.getByTestId("temporary-cover-add"));
    fireEvent.change(screen.getByTestId("temporary-cover-name"), {
      target: { value: "Haseena (Ward 3)" },
    });
    fireEvent.change(screen.getByTestId("temporary-cover-date"), {
      target: { value: "2026-10-14" },
    });
    fireEvent.change(screen.getByTestId("temporary-cover-shift"), { target: { value: "D" } });
    fireEvent.click(screen.getByTestId("temporary-cover-save"));

    expect(screen.getByTestId("temporary-cover-error")).toHaveTextContent("one shift a day");
  });
});

describe("Temporary cover section — store discipline", () => {
  it("add, edit and delete are one undo step each", async () => {
    await seed(coverState());
    render(<PeopleTable />);
    const base = await undoDepth();

    await fillAndSave({ name: "Haseena (Ward 3)", date: "2026-10-14", shiftType: "N" });
    expect(await undoDepth()).toBe(base + 1);

    fireEvent.click(screen.getByTestId("temporary-cover-edit-0"));
    fireEvent.change(screen.getByTestId("temporary-cover-name"), {
      target: { value: "Haseena (Ward 4)" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("temporary-cover-save"));
      await drainScenarioCommands();
    });
    expect(await undoDepth()).toBe(base + 2);

    await act(async () => {
      fireEvent.click(screen.getByTestId("temporary-cover-delete-0"));
      await drainScenarioCommands();
    });
    expect(await undoDepth()).toBe(base + 3);
    expect(useScenarioStore.getState().temporaryCover).toHaveLength(0);
  });
});

describe("Temporary cover section — re-optimize callout", () => {
  it("callout appears after Save when a roster exists, and Run Optimize does not start a run", async () => {
    await seedWorkingRoster();
    await seed(coverState());
    render(<PeopleTable />);

    await fillAndSave({ name: "Haseena (Ward 3)", date: "2026-10-14", shiftType: "N" });

    const callout = await screen.findByTestId("temporary-cover-callout");
    expect(callout).toHaveTextContent(
      "Night on 14 Oct now needs 2 from the ward. Run Optimize again so the roster plans around Haseena (Ward 3).",
    );

    // The action is a plain navigation, not a run.
    const run = screen.getByTestId("temporary-cover-run-optimize");
    expect(run).toHaveAttribute("href", "/optimize-and-export");
    fireEvent.click(run);
    expect(pushMock).toHaveBeenCalledWith("/optimize-and-export");
  });
});

describe("Temporary cover section — the assistant's Apply fills the form in view", () => {
  /** A commit that stands in for the proposal's durable Apply: one write, one undo step. */
  function writingCommit(next: () => ScenarioUiState["temporaryCover"]) {
    return vi.fn(async () => {
      await scenarioCommands.mutate(() => ({ temporaryCover: next() }));
      return { ok: true as const };
    });
  }

  afterEach(() => {
    clearChangeHighlight();
    useCoverEditStore.setState({ pending: null, taken: false, last: null });
  });

  it("opens the prefilled editor, presses its own Save, then highlights and announces the row", async () => {
    await seed(coverState());
    render(<PeopleTable />);
    const base = await undoDepth();
    const commit = writingCommit(() => [COVER]);

    const outcome = awaitCoverEditOutcome();
    await act(async () => {
      requestCoverEdit({ edits: [{ kind: "add", entry: COVER }], commit });
    });

    await expect(outcome).resolves.toBe("applied");
    await act(async () => drainScenarioCommands());
    expect(commit).toHaveBeenCalledTimes(1);
    expect(await undoDepth()).toBe(base + 1);
    expect(screen.queryByTestId("temporary-cover-editor")).toBeNull();
    expect(screen.getByTestId("temporary-cover-row-0")).toHaveAttribute(
      "data-change-highlight",
      "true",
    );
    expect(screen.getByTestId("temporary-cover-status")).toHaveTextContent(
      "Added temporary cover Haseena (Ward 3).",
    );
  });

  it("fills the fields one by one in view when motion is allowed", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query }));
    try {
      await seed(coverState());
      render(<PeopleTable />);
      const outcome = awaitCoverEditOutcome();
      act(() => {
        requestCoverEdit({
          edits: [{ kind: "add", entry: COVER }],
          commit: writingCommit(() => [COVER]),
        });
      });
      // The name lands before the date: the user watches the form being filled.
      expect(await screen.findByTestId("temporary-cover-name")).toHaveValue("Haseena (Ward 3)");
      expect(screen.getByTestId("temporary-cover-date")).toHaveValue("");
      await act(async () => {
        await expect(outcome).resolves.toBe("applied");
      });
      expect(screen.queryByTestId("temporary-cover-editor")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a validation failure leaves the editor open and writes nothing", async () => {
    await seed(coverState({ temporaryCover: [COVER] }));
    render(<PeopleTable />);
    const commit = writingCommit(() => [COVER, COVER]);

    const outcome = awaitCoverEditOutcome();
    await act(async () => {
      requestCoverEdit({ edits: [{ kind: "add", entry: COVER }], commit });
    });

    await expect(outcome).resolves.toBe("rejected");
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByTestId("temporary-cover-editor")).toBeInTheDocument();
    expect(screen.getByTestId("temporary-cover-name")).toHaveValue("Haseena (Ward 3)");
    expect(screen.getByTestId("temporary-cover-error")).toHaveTextContent(
      "Haseena (Ward 3) already covers N on 14 Oct.",
    );
    expect(useScenarioStore.getState().temporaryCover).toHaveLength(1);
  });

  it("a refused Save (a stale Preview) leaves the editor open with the reason", async () => {
    await seed(coverState());
    render(<PeopleTable />);
    const commit = vi.fn(async () => ({
      ok: false as const,
      message: "The schedule changed while you were reviewing, so nothing was applied.",
    }));

    const outcome = awaitCoverEditOutcome();
    await act(async () => {
      requestCoverEdit({ edits: [{ kind: "add", entry: COVER }], commit });
    });

    await expect(outcome).resolves.toBe("rejected");
    expect(screen.getByTestId("temporary-cover-error")).toHaveTextContent(
      "The schedule changed while you were reviewing",
    );
    expect(useScenarioStore.getState().temporaryCover).toHaveLength(0);
  });

  it("remove_temporary_cover Apply deletes in the form", async () => {
    await seed(coverState({ temporaryCover: [COVER] }));
    render(<PeopleTable />);
    const commit = writingCommit(() => []);

    const outcome = awaitCoverEditOutcome();
    await act(async () => {
      requestCoverEdit({
        edits: [{ kind: "remove", name: COVER.name, date: COVER.date, shiftType: "N" }],
        commit,
      });
    });

    await expect(outcome).resolves.toBe("applied");
    await act(async () => drainScenarioCommands());
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useScenarioStore.getState().temporaryCover).toHaveLength(0);
    expect(screen.getByTestId("temporary-cover-status")).toHaveTextContent(
      "Removed temporary cover Haseena (Ward 3).",
    );
  });

  it("does not overwrite a cover the user is still editing", async () => {
    await seed(coverState());
    render(<PeopleTable />);
    fireEvent.click(screen.getByTestId("temporary-cover-add"));
    fireEvent.change(screen.getByTestId("temporary-cover-name"), { target: { value: "Mine" } });
    const commit = writingCommit(() => [COVER]);

    const outcome = awaitCoverEditOutcome();
    await act(async () => {
      requestCoverEdit({ edits: [{ kind: "add", entry: COVER }], commit });
    });

    await expect(outcome).resolves.toBe("rejected");
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByTestId("temporary-cover-name")).toHaveValue("Mine");
  });
});
