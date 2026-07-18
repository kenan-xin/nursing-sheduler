// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { prepareScenarioLoad, serializeScenario } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  drainScenarioPersist,
  loadScenario,
  resetToNewScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { ScenarioFileCard } from "./scenario-file-card";

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

describe("ScenarioFileCard — render (no infinite-loop regression)", () => {
  // Renders the component against the real store. `useScenarioStore(pickScenario)`
  // builds a fresh object each call; without `useShallow` this loops
  // ("Maximum update depth exceeded"), which throws and fails this render.
  it("mounts without a render loop", () => {
    render(<ScenarioFileCard />);
    expect(screen.getByTestId("scenario-file-card")).toBeInTheDocument();
    expect(screen.getByTestId("scenario-download-button")).toBeInTheDocument();
  });
});

describe("ScenarioFileCard — Copy clipboard failure (FR-SL-09)", () => {
  // navigator.clipboard is not implemented by jsdom, so each test stubs a
  // fresh writeText to control resolve/reject timing.
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
    });
  });

  it('a rejected writeText leaves the label as "Copy" and logs the error, without a false "Copied!"', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<ScenarioFileCard />);
    fireEvent.click(screen.getByTestId("scenario-copy-button"));

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith("Failed to copy to clipboard:", expect.any(Error)),
    );
    expect(screen.getByTestId("scenario-copy-button")).toHaveTextContent("Copy");
    expect(screen.queryByText("Copied!")).not.toBeInTheDocument();

    consoleError.mockRestore();
  });

  it('a resolved writeText shows "Copied!" and reverts after the label window', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<ScenarioFileCard />);
    fireEvent.click(screen.getByTestId("scenario-copy-button"));

    await waitFor(() =>
      expect(screen.getByTestId("scenario-copy-button")).toHaveTextContent("Copied!"),
    );
  });
});
