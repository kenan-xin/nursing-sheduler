// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { prepareScenarioLoad, serializeScenario } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  drainScenarioPersist,
  loadScenario,
  resetToNewScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { AnonymiseCard } from "./anonymise-card";

async function seedValidScenario() {
  await resetToNewScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
  const result = prepareScenarioLoad(serializeScenario(makeValidUiState()));
  if (!result.target) throw new Error("fixture must normalize cleanly");
  loadScenario(useScenarioStore, useHotStore, result.target);
}

beforeEach(async () => {
  await seedValidScenario();
});

afterEach(() => {
  cleanup();
});

describe("AnonymiseCard — render (no infinite-loop regression)", () => {
  // Same latent `useScenarioStore(pickScenario)` loop guard as the other
  // save-load store consumers — a render loop would throw and fail this test.
  it("mounts without a render loop", () => {
    render(<AnonymiseCard />);
    expect(screen.getByTestId("anonymise-card")).toBeInTheDocument();
  });
});

describe("AnonymiseCard — scatter fallback warning (FR-SL-38 / V20 / AC-SL-24)", () => {
  // The fixture's only date group is "FirstTwo" — neither WORKDAY nor
  // NON-WORKDAY is present, so turning Scatter on should surface the fallback
  // warning with both group ids named.
  it("shows the fallback warning once Scatter is toggled on", () => {
    render(<AnonymiseCard />);
    expect(screen.queryByTestId("anonymise-scatter-fallback-warning")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("anonymise-toggle-scatter"));

    expect(screen.getByTestId("anonymise-scatter-fallback-warning")).toHaveTextContent(
      "Warning: WORKDAY and NON-WORKDAY groups are missing. Scattering will fall back to WEEKDAY and WEEKEND groups.",
    );
  });

  it("hides the warning again when Scatter is toggled back off", () => {
    render(<AnonymiseCard />);
    fireEvent.click(screen.getByTestId("anonymise-toggle-scatter"));
    expect(screen.getByTestId("anonymise-scatter-fallback-warning")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("anonymise-toggle-scatter"));

    expect(screen.queryByTestId("anonymise-scatter-fallback-warning")).not.toBeInTheDocument();
  });
});
