// @vitest-environment jsdom
//
// jyz2 regression: a workspace saved by the pre-d582 production build (main b3b8903)
// has no `scenario.temporaryCover` in its Dexie envelope and may carry the retired
// `staff[].temporary` flag. The Staff screen crashed on `undefined.map` for it. This
// seeds that exact durable shape, reloads through the real authority bring-up, and
// renders the Staff screen.
import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { scenarioCommands, useScenarioStore } from "@/lib/store";
import {
  clearTestAuthority,
  drainScenarioCommands,
  freshAuthorityDbName,
  installTestAuthority,
} from "@/lib/store/test-authority";
import { PeopleTable } from "./people-table";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/people",
}));

afterEach(() => {
  cleanup();
  clearTestAuthority();
});

it("renders the Staff screen for an envelope saved before temporaryCover existed", async () => {
  const databaseName = freshAuthorityDbName();
  const first = await installTestAuthority({ databaseName });
  const { temporaryCover: _absent, ...state } = makeValidUiState();
  await scenarioCommands.mutate({ ...state, temporaryCover: [] });
  await drainScenarioCommands();

  // Rewrite the durable envelope into the exact pre-d582 shape.
  const scenarioId = (await first.db.scenarioEnvelopes.toArray())[0].scenarioId;
  const envelope = (await first.db.scenarioEnvelopes.get(scenarioId))!;
  const { temporaryCover: _dropped, ...oldScenario } = envelope.scenario;
  const oldStaff = [...oldScenario.staff, { id: "Agency Kim", history: [], temporary: true }];
  await first.db.scenarioEnvelopes.put({
    ...envelope,
    scenario: { ...oldScenario, staff: oldStaff } as typeof envelope.scenario,
  });
  clearTestAuthority();
  first.db.close();

  // The reload: the new build brings the saved workspace up from IndexedDB.
  await installTestAuthority({ databaseName, tabId: first.tabId });
  expect(useScenarioStore.getState().temporaryCover).toEqual([]);

  render(<PeopleTable />);
  expect(screen.getByTestId("temporary-cover-empty")).toBeInTheDocument();
  expect(screen.getByText("Agency Kim")).toBeInTheDocument();

  // Writes work again, and the legacy flag rides along untouched (no data loss).
  let outcome: { ok: boolean } | undefined;
  await act(async () => {
    outcome = await scenarioCommands.mutate({ rangeEnd: "2026-05-21" });
    await drainScenarioCommands();
  });
  expect(outcome).toMatchObject({ ok: true });
  expect(useScenarioStore.getState().staff.find((p) => p.id === "Agency Kim")).toMatchObject({
    temporary: true,
  });
});
