// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { pickScenario, scenarioCommands } from "@/lib/store";
import { drainScenarioCommands, resetScenarioForTest } from "@/lib/store/test-authority";
import { LadderPreflight } from "./ladder-preflight";

beforeEach(async () => {
  await resetScenarioForTest();
  await drainScenarioCommands();
});

afterEach(() => cleanup());

async function seed(reqWeight: number) {
  const state = makeValidUiState();
  await act(async () => {
    await scenarioCommands.mutate({
      ...pickScenario(state),
      reqData: state.reqData.map((cell) =>
        cell.kind === "leave" ? cell : { ...cell, weight: reqWeight },
      ),
    });
  });
}

describe("LadderPreflight (rnrt)", () => {
  it("warns, without blocking, about each weight off the priority ladder", async () => {
    await seed(1);
    render(<LadderPreflight />);
    const callout = screen.getByTestId("optimize-ladder-preflight");
    expect(callout).toHaveTextContent("Some weights break the priority order");
    expect(callout).toHaveTextContent("a nurse wish takes 20 to 40");
    expect(callout).toHaveTextContent("Optimize still runs");
  });

  it("shows nothing when every weight is on the ladder", async () => {
    await seed(20);
    render(<LadderPreflight />);
    expect(screen.queryByTestId("optimize-ladder-preflight")).toBeNull();
  });
});
