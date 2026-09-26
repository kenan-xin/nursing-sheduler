// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { prepareScenarioLoad, serializeScenario } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { loadScenario, scenarioCommands } from "@/lib/store";
import { AnonymiseCard } from "./anonymise-card";
import { resetScenarioForTest, drainScenarioCommands } from "@/lib/store/test-authority";

async function seedValidScenario() {
  await resetScenarioForTest();
  await drainScenarioCommands();
  const result = prepareScenarioLoad(serializeScenario(makeValidUiState()));
  if (!result.target) throw new Error("fixture must normalize cleanly");
  loadScenario(result.target);
}

beforeEach(async () => {
  await seedValidScenario();
});

afterEach(async () => {
  cleanup();
});

describe("AnonymiseCard — render (no infinite-loop regression)", () => {
  // Same latent `useScenarioStore(pickScenario)` loop guard as the other
  // save-load store consumers — a render loop would throw and fail this test.
  it("mounts without a render loop", async () => {
    render(<AnonymiseCard />);
    expect(screen.getByTestId("anonymise-card")).toBeInTheDocument();
  });
});

describe("AnonymiseCard — scatter fallback warning (FR-SL-38 / V20 / AC-SL-24)", () => {
  // The fixture's only date group is "FirstTwo" — neither WORKDAY nor
  // NON-WORKDAY is present, so turning Scatter on should surface the fallback
  // warning with both group ids named.
  it("shows the fallback warning once Scatter is toggled on", async () => {
    render(<AnonymiseCard />);
    expect(screen.queryByTestId("anonymise-scatter-fallback-warning")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("anonymise-toggle-scatter"));

    expect(screen.getByTestId("anonymise-scatter-fallback-warning")).toHaveTextContent(
      "Warning: WORKDAY and NON-WORKDAY groups are missing. Scattering will fall back to WEEKDAY and WEEKEND groups.",
    );
  });

  it("hides the warning again when Scatter is toggled back off", async () => {
    render(<AnonymiseCard />);
    fireEvent.click(screen.getByTestId("anonymise-toggle-scatter"));
    expect(screen.getByTestId("anonymise-scatter-fallback-warning")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("anonymise-toggle-scatter"));

    expect(screen.queryByTestId("anonymise-scatter-fallback-warning")).not.toBeInTheDocument();
  });
});

describe("AnonymiseCard — a blocked download reads as an export, not a save", () => {
  // An empty range makes Scatter's source validation fail, so the shared
  // blocking-issue list renders. Nothing is being saved here, so the heading
  // must name the export (the card's own action), not a save.
  it("labels the blocking-issue list with the export clause", async () => {
    await seedValidScenario();
    await act(async () => {
      await scenarioCommands.mutate({ rangeStart: "", rangeEnd: "" });
    });
    render(<AnonymiseCard />);
    fireEvent.click(screen.getByTestId("anonymise-toggle-scatter"));
    fireEvent.click(screen.getByTestId("anonymise-download-button"));

    const list = await screen.findByTestId("scenario-export-issues");
    expect(list).toHaveTextContent("must be fixed before this scenario can be exported.");
    expect(list).not.toHaveTextContent("can be saved");
  });
});
