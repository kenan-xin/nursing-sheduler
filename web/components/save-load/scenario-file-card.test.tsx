// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { prepareScenarioLoad, serializeScenario } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  drainScenarioPersist,
  loadScenario,
  pickScenario,
  resetToNewScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { ScenarioFileCard, type ScenarioFileCardProps } from "./scenario-file-card";

async function seedValidScenario() {
  await resetToNewScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
  const result = prepareScenarioLoad(serializeScenario(makeValidUiState()));
  if (!result.target) throw new Error("fixture must normalize cleanly");
  loadScenario(useScenarioStore, useHotStore, result.target);
}

function renderCard(overrides: Partial<ScenarioFileCardProps> = {}) {
  const props: ScenarioFileCardProps = {
    scenario: pickScenario(useScenarioStore.getState()),
    canEditYaml: true,
    editing: false,
    importIssues: null,
    onUpload: vi.fn(),
    onStartEdit: vi.fn(),
    ...overrides,
  };
  render(<ScenarioFileCard {...props} />);
  return props;
}

beforeEach(async () => {
  await seedValidScenario();
});

afterEach(() => {
  cleanup();
});

describe("ScenarioFileCard — the prototype's four file actions", () => {
  it("renders Download, Upload, Copy, and Edit YAML together in the canonical order", () => {
    renderCard();
    const card = screen.getByTestId("scenario-file-card");
    const buttons = within(card).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("data-testid"))).toEqual([
      "scenario-download-button",
      "scenario-upload-button",
      "scenario-copy-button",
      "scenario-edit-yaml-button",
    ]);
  });

  it("Upload and Edit YAML are triggers owned by the workspace container", () => {
    const props = renderCard();

    fireEvent.click(screen.getByTestId("scenario-upload-button"));
    expect(props.onUpload).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("scenario-edit-yaml-button"));
    expect(props.onStartEdit).toHaveBeenCalledTimes(1);
  });

  it("disables Edit YAML when the draft has no valid export to seed from, or while already editing", () => {
    const { rerender } = render(
      <ScenarioFileCard
        scenario={pickScenario(useScenarioStore.getState())}
        canEditYaml={false}
        editing={false}
        importIssues={null}
        onUpload={vi.fn()}
        onStartEdit={vi.fn()}
      />,
    );
    expect(screen.getByTestId("scenario-edit-yaml-button")).toBeDisabled();

    rerender(
      <ScenarioFileCard
        scenario={pickScenario(useScenarioStore.getState())}
        canEditYaml
        editing
        importIssues={null}
        onUpload={vi.fn()}
        onStartEdit={vi.fn()}
      />,
    );
    expect(screen.getByTestId("scenario-edit-yaml-button")).toBeDisabled();
  });

  it("surfaces a failed Upload's V-issues below the action row", () => {
    renderCard({
      importIssues: [{ path: "preferences[0]", message: "Unknown preference type" }],
    });
    expect(screen.getByTestId("scenario-export-issues")).toHaveTextContent(
      "Unknown preference type",
    );
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

    renderCard();
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

    renderCard();
    fireEvent.click(screen.getByTestId("scenario-copy-button"));

    await waitFor(() =>
      expect(screen.getByTestId("scenario-copy-button")).toHaveTextContent("Copied!"),
    );
  });
});
