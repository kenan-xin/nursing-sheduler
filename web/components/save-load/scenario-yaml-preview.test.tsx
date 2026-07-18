// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { prepareExport, prepareScenarioLoad, serializeScenario } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  drainScenarioPersist,
  loadScenario,
  pickScenario,
  resetToNewScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { ScenarioYamlPreview } from "./scenario-yaml-preview";

function currentState() {
  return useScenarioStore.getState();
}

function stateSnapshot(): string {
  return JSON.stringify(pickScenario(currentState()));
}

function currentYaml(): string {
  const result = prepareExport(pickScenario(currentState()));
  if (!result.ok) throw new Error("expected a valid draft");
  return result.yaml;
}

function editYaml(text: string) {
  const textarea = screen.getByTestId("scenario-yaml-textarea") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
}

/** Seeds a valid baseline scenario through the real import pipeline, so the
 *  preview starts from an exportable draft rather than the blank new-scenario
 *  state (which fails `prepareExport` until a roster range is set). */
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

describe("ScenarioYamlPreview — Edit YAML mode", () => {
  it("Edit reveals a textarea seeded with the current prepareExport YAML", () => {
    render(<ScenarioYamlPreview />);
    const yaml = currentYaml();

    fireEvent.click(screen.getByTestId("yaml-edit-toggle"));

    const textarea = screen.getByTestId("scenario-yaml-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe(yaml);
    expect(screen.queryByTestId("scenario-yaml-content")).not.toBeInTheDocument();
  });

  it("Apply on a valid edit replaces state through the same load pipeline as Upload", async () => {
    render(<ScenarioYamlPreview />);

    fireEvent.click(screen.getByTestId("yaml-edit-toggle"));
    editYaml(serializeScenario(makeValidUiState()));
    fireEvent.click(screen.getByTestId("yaml-apply-button"));

    await waitFor(() => expect(currentState().rangeStart).toBe("2026-05-14"));
    expect(currentState().staff.map((p) => p.id)).toEqual(["Alice", "Bob"]);
    expect(useScenarioStore.temporal.getState().pastStates.length).toBe(0);

    // Editing mode closes back to the read-only preview once the replace commits.
    await waitFor(() =>
      expect(screen.queryByTestId("scenario-yaml-textarea")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("scenario-yaml-content")).toBeInTheDocument();
  });

  it("Apply on invalid YAML (`::bad::`) surfaces an inline parse error and leaves state untouched", async () => {
    render(<ScenarioYamlPreview />);
    const before = stateSnapshot();

    fireEvent.click(screen.getByTestId("yaml-edit-toggle"));
    editYaml("::bad::");
    fireEvent.click(screen.getByTestId("yaml-apply-button"));

    await screen.findByTestId("scenario-export-issues");
    expect(stateSnapshot()).toBe(before);
    // Still editing — Apply failed, the draft is not discarded.
    expect(screen.getByTestId("scenario-yaml-textarea")).toBeInTheDocument();
  });

  it("Cancel restores the read-only preview with no state change", () => {
    render(<ScenarioYamlPreview />);
    const before = stateSnapshot();
    const yaml = currentYaml();

    fireEvent.click(screen.getByTestId("yaml-edit-toggle"));
    editYaml("::bad::");
    fireEvent.click(screen.getByTestId("yaml-cancel-button"));

    expect(screen.queryByTestId("scenario-yaml-textarea")).not.toBeInTheDocument();
    expect(screen.getByTestId("scenario-yaml-content").textContent).toBe(yaml);
    expect(stateSnapshot()).toBe(before);
  });
});
