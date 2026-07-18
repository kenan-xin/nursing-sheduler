// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { stringify } from "yaml";
import {
  currentAppVersion,
  serializeScenario,
  toCanonicalScenarioDocument,
  type CanonicalScenarioDocument,
} from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  drainScenarioPersist,
  pickScenario,
  resetToNewScenario,
  selectIsDirty,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { LoadControls } from "./load-controls";

const YAML_OPTIONS = { version: "1.2" as const };

function currentState() {
  return useScenarioStore.getState();
}

function stateSnapshot(): string {
  return JSON.stringify(pickScenario(currentState()));
}

/** A backend-valid YAML string whose stamped `appVersion` equals the test env's
 *  `currentAppVersion()` ("unknown", `NEXT_PUBLIC_APP_VERSION` unset) — so the
 *  version gate resolves `match` and Load proceeds without the confirm modal. */
function validYaml(): string {
  return serializeScenario(makeValidUiState());
}

/** The same valid document, but stamped with an explicit `appVersion`
 *  (bypassing `serializeScenario`'s re-stamp) — drives the version-confirm gate. */
function withAppVersion(fileVersion: string | undefined): string {
  const doc: CanonicalScenarioDocument = { ...toCanonicalScenarioDocument(makeValidUiState()) };
  if (fileVersion === undefined) delete (doc as { appVersion?: string }).appVersion;
  else doc.appVersion = fileVersion;
  return stringify(doc, YAML_OPTIONS);
}

/** A valid document with an extra nested-reference-syntax preference — a
 *  non-blocking V12 warning survivor (FR-SL-25). */
function advancedSyntaxYaml(): string {
  const doc = toCanonicalScenarioDocument(makeValidUiState());
  doc.appVersion = currentAppVersion();
  doc.preferences.push({
    type: "shift type successions",
    person: "Alice",
    pattern: [["D", "E"]],
    weight: 1,
  } as CanonicalScenarioDocument["preferences"][number]);
  return stringify(doc, YAML_OPTIONS);
}

function uploadTextFile(text: string, name = "scenario.yaml") {
  const input = screen.getByTestId("upload-file-input") as HTMLInputElement;
  const file = new File([text], name, { type: "text/yaml" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(async () => {
  await resetToNewScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
});

afterEach(() => {
  cleanup();
});

describe("LoadControls", () => {
  it("a valid file with a matching app version loads directly: full-state replace, history cleared, clean baseline", async () => {
    render(<LoadControls />);

    fireEvent.click(screen.getByTestId("load-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile(validYaml());

    await waitFor(() => expect(currentState().rangeStart).toBe("2026-05-14"));
    expect(currentState().staff.map((p) => p.id)).toEqual(["Alice", "Bob"]);
    expect(useScenarioStore.temporal.getState().pastStates.length).toBe(0);
    expect(selectIsDirty(currentState())).toBe(false);
    expect(screen.queryByTestId("confirm-dialog-confirm")).not.toBeInTheDocument();
  });

  it("invalid YAML blocks the load: V-issues shown, loadScenario not called, store untouched", async () => {
    render(<LoadControls />);
    const before = stateSnapshot();

    fireEvent.click(screen.getByTestId("load-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile("preferences: [unterminated, flow");

    await screen.findByTestId("scenario-export-issues");
    expect(stateSnapshot()).toBe(before);
  });

  it("an import-schema-invalid document also blocks with no state change", async () => {
    render(<LoadControls />);
    const before = stateSnapshot();

    fireEvent.click(screen.getByTestId("load-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile("apiVersion: alpha\n");

    await screen.findByTestId("scenario-export-issues");
    expect(stateSnapshot()).toBe(before);
  });

  it("an app-version mismatch shows the confirm modal; Cancel is a no-op (state intact)", async () => {
    render(<LoadControls />);
    const before = stateSnapshot();

    fireEvent.click(screen.getByTestId("load-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile(withAppVersion("1.0.0"));

    await screen.findByTestId("confirm-dialog-confirm");
    expect(screen.getByText(/1\.0\.0/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("confirm-dialog-confirm")).not.toBeInTheDocument(),
    );
    expect(stateSnapshot()).toBe(before);
  });

  it("an app-version mismatch's Continue commits the load", async () => {
    render(<LoadControls />);

    fireEvent.click(screen.getByTestId("load-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile(withAppVersion("1.0.0"));

    await screen.findByTestId("confirm-dialog-confirm");
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => expect(currentState().rangeStart).toBe("2026-05-14"));
    expect(useScenarioStore.temporal.getState().pastStates.length).toBe(0);
  });

  it("a missing app version also gates on the confirm modal", async () => {
    render(<LoadControls />);

    fireEvent.click(screen.getByTestId("load-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile(withAppVersion(undefined));

    const dialog = await screen.findByTestId("confirm-dialog-confirm");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/does not contain app version information/i)).toBeInTheDocument();
  });

  it("advanced-syntax survivors render the non-blocking import warnings banner; load still proceeds", async () => {
    render(<LoadControls />);

    fireEvent.click(screen.getByTestId("load-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile(advancedSyntaxYaml());

    await waitFor(() => expect(currentState().rangeStart).toBe("2026-05-14"));
    const banner = await screen.findByTestId("import-warnings-banner");
    expect(banner).toHaveTextContent(/advanced backend reference syntax/i);

    fireEvent.click(screen.getByTestId("import-warnings-dismiss"));
    expect(screen.queryByTestId("import-warnings-banner")).not.toBeInTheDocument();
  });

  it("the 'load a sample scenario' affordance loads the built-in sample", async () => {
    render(<LoadControls />);

    fireEvent.click(screen.getByTestId("load-upload-button"));
    await screen.findByTestId("upload-modal");
    fireEvent.click(screen.getByTestId("upload-load-sample-button"));

    await waitFor(() => expect(currentState().rangeStart).toBe("2026-05-01"));
    expect(currentState().staff.some((p) => p.id === "Kevin Ong")).toBe(true);
  });
});
