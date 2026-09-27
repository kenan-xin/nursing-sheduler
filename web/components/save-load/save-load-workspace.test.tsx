// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { stringify } from "yaml";
import {
  currentAppVersion,
  prepareWorkspaceExport,
  prepareScenarioLoad,
  serializeScenario,
  toCanonicalScenarioDocument,
  type CanonicalScenarioDocument,
} from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  loadScenario,
  pickScenario,
  selectBackupStatus,
  useAuthorityStore,
  useScenarioStore,
} from "@/lib/store";
import { SaveLoadWorkspace } from "./save-load-workspace";
import { resetScenarioForTest, drainScenarioCommands, undoDepth } from "@/lib/store/test-authority";

const YAML_OPTIONS = { version: "1.2" as const };

// Post-T1, `git describe` always yields a real `vX.Y.Z-…` stamp in dev/prod;
// only a source tarball with no `.git` falls back to "unknown". The version gate
// now consumes the shared major.minor classifier (T2/T4), which folds the
// "unknown" sentinel to "absent" → the `missing` tier. So drive this suite from a
// real stamp: an unstamped-vs-unstamped pair would otherwise resolve `missing`
// (a confirm), not the `identical` silent load these matching-version cases mean
// to exercise. `serializeScenario` re-stamps files with this same value.
const ENV_KEY = "NEXT_PUBLIC_APP_VERSION";
const ORIGINAL_APP_VERSION = process.env[ENV_KEY];
const TEST_APP_VERSION = "v0.1.1-5-gabc1234";

beforeAll(() => {
  process.env[ENV_KEY] = TEST_APP_VERSION;
});

afterAll(() => {
  if (ORIGINAL_APP_VERSION === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = ORIGINAL_APP_VERSION;
  }
});

async function currentState() {
  await drainScenarioCommands();
  return useScenarioStore.getState();
}

async function stateSnapshot(): Promise<string> {
  return JSON.stringify(pickScenario(await currentState()));
}

/** A backend-valid YAML string whose stamped `appVersion` equals the test env's
 *  `currentAppVersion()` (the real `TEST_APP_VERSION` stamp set above) — so the
 *  version gate resolves `identical` and Load proceeds without the confirm modal. */
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

function editYaml(text: string) {
  const textarea = screen.getByTestId("scenario-yaml-textarea") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
}

beforeEach(async () => {
  await resetScenarioForTest();
  await drainScenarioCommands();
});

afterEach(async () => {
  cleanup();
});

describe("SaveLoadWorkspace — composition", () => {
  // Renders the whole workspace against the real store. The container subscribes
  // via `useScenarioStore(useShallow(pickScenario))`; without `useShallow` this
  // loops ("Maximum update depth exceeded"), which throws and fails this render.
  it("mounts without a render loop", async () => {
    render(<SaveLoadWorkspace />);
    expect(screen.getByTestId("scenario-file-card")).toBeInTheDocument();
    expect(screen.getByTestId("scenario-yaml-preview")).toBeInTheDocument();
  });

  it("co-locates all four prototype file actions in the Scenario file card; no separate Load card remains", async () => {
    render(<SaveLoadWorkspace />);
    const card = screen.getByTestId("scenario-file-card");
    const buttons = within(card).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("data-testid"))).toEqual([
      "scenario-download-button",
      "scenario-upload-button",
      "scenario-copy-button",
      "scenario-edit-yaml-button",
    ]);
    expect(screen.queryByTestId("load-controls")).not.toBeInTheDocument();
  });
});

describe("SaveLoadWorkspace — Upload flow", () => {
  it("a valid file with a matching app version loads directly into an empty workspace: fresh scenario identity, unknown baseline", async () => {
    render(<SaveLoadWorkspace />);

    fireEvent.click(screen.getByTestId("scenario-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile(validYaml());

    await waitFor(async () => expect((await currentState()).rangeStart).toBe("2026-05-14"));
    expect((await currentState()).staff.map((p) => p.id)).toEqual(["Alice", "Bob"]);
    // The empty workspace + matching version commits directly (no confirm).
    //
    // T03: a Load is an atomic scenario SWITCH to a fresh `scenarioId` (tech plan,
    // "Load/replace always mints a new identity"), so the loaded document starts on
    // its own empty Undo history rather than being one reversible entry on the
    // previous document's. Undo therefore does not reach back across a Load.
    expect(await undoDepth()).toBe(0);
    expect(useAuthorityStore.getState().canUndo).toBe(false);
    // An imported file is not a fresh local backup: backup stays unknown (null).
    expect(selectBackupStatus(await currentState())).toBe("none");
    expect((await currentState()).backupFingerprint).toBeNull();
    expect(screen.queryByTestId("confirm-dialog-confirm")).not.toBeInTheDocument();
  });

  it("a matching-version load into a NON-EMPTY workspace stages the replacement confirmation (P0)", async () => {
    render(<SaveLoadWorkspace />);

    // First load fills the (empty) workspace, committing directly.
    fireEvent.click(screen.getByTestId("scenario-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile(validYaml());
    await waitFor(async () => expect((await currentState()).rangeStart).toBe("2026-05-14"));

    // A second load — same matching version — must now confirm replacement rather
    // than commit directly, because the current workspace is non-empty (DL12 P0-1).
    fireEvent.click(screen.getByTestId("scenario-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile(validYaml());

    await screen.findByTestId("confirm-dialog-confirm");
    expect(screen.getByText(/replace your current workspace/i)).toBeInTheDocument();

    // Continue commits the replacement, as another atomic switch.
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-dialog-confirm")).not.toBeInTheDocument(),
    );
    expect((await currentState()).staff.map((p) => p.id)).toEqual(["Alice", "Bob"]);
    expect(await undoDepth()).toBe(0);
  });

  it("invalid YAML blocks the load: V-issues shown in the Scenario file card, loadScenario not called, store untouched", async () => {
    render(<SaveLoadWorkspace />);
    const before = await stateSnapshot();

    fireEvent.click(screen.getByTestId("scenario-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile("preferences: [unterminated, flow");

    // Awaited on the QUERY, not on `within` — the misplaced await left this
    // assertion unobserved (a floating rejection Vitest reported as an unhandled
    // error), so the V-issues banner was never actually proven to appear.
    await within(screen.getByTestId("scenario-file-card")).findByTestId("scenario-export-issues");
    expect(await stateSnapshot()).toBe(before);
  });

  it("an import-schema-invalid document also blocks with no state change", async () => {
    render(<SaveLoadWorkspace />);
    const before = await stateSnapshot();

    fireEvent.click(screen.getByTestId("scenario-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile("apiVersion: alpha\n");

    await within(screen.getByTestId("scenario-file-card")).findByTestId("scenario-export-issues");
    expect(await stateSnapshot()).toBe(before);
  });

  it("an app-version mismatch shows the confirm modal; Cancel is a no-op (state intact)", async () => {
    render(<SaveLoadWorkspace />);
    const before = await stateSnapshot();

    fireEvent.click(screen.getByTestId("scenario-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile(withAppVersion("1.0.0"));

    await screen.findByTestId("confirm-dialog-confirm");
    expect(screen.getByText(/1\.0\.0/)).toBeInTheDocument();
    // The version pair renders in the shared confirm's mono detail box, not as
    // run-on prose (prototype ScreenSaveLoad.dc.html:150).
    const detail = screen.getByTestId("confirm-dialog-detail");
    expect(detail).toHaveTextContent("File app version: 1.0.0");
    expect(detail).toHaveTextContent(`Current app version: ${currentAppVersion()}`);

    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("confirm-dialog-confirm")).not.toBeInTheDocument(),
    );
    expect(await stateSnapshot()).toBe(before);
  });

  it("an app-version mismatch's Continue commits the load", async () => {
    render(<SaveLoadWorkspace />);

    fireEvent.click(screen.getByTestId("scenario-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile(withAppVersion("1.0.0"));

    await screen.findByTestId("confirm-dialog-confirm");
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(async () => expect((await currentState()).rangeStart).toBe("2026-05-14"));
    // A confirmed Load is the same atomic scenario switch as an unconfirmed one:
    // same content outcome, and the new identity's own empty Undo history.
    expect(await undoDepth()).toBe(0);
  });

  it("a missing app version also gates on the confirm modal", async () => {
    render(<SaveLoadWorkspace />);

    fireEvent.click(screen.getByTestId("scenario-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile(withAppVersion(undefined));

    const dialog = await screen.findByTestId("confirm-dialog-confirm");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/does not contain app version information/i)).toBeInTheDocument();
  });

  it("advanced-syntax survivors render the non-blocking import warnings banner; load still proceeds", async () => {
    render(<SaveLoadWorkspace />);

    fireEvent.click(screen.getByTestId("scenario-upload-button"));
    await screen.findByTestId("upload-modal");
    uploadTextFile(advancedSyntaxYaml());

    await waitFor(async () => expect((await currentState()).rangeStart).toBe("2026-05-14"));
    const banner = await screen.findByTestId("import-warnings-banner");
    expect(banner).toHaveTextContent(/advanced backend reference syntax/i);

    fireEvent.click(screen.getByTestId("import-warnings-dismiss"));
    expect(screen.queryByTestId("import-warnings-banner")).not.toBeInTheDocument();
  });

  it("the 'load a sample scenario' affordance loads the built-in sample", async () => {
    render(<SaveLoadWorkspace />);

    fireEvent.click(screen.getByTestId("scenario-upload-button"));
    await screen.findByTestId("upload-modal");
    fireEvent.click(screen.getByTestId("upload-load-sample-button"));

    await waitFor(async () => expect((await currentState()).rangeStart).toBe("2026-05-01"));
    expect((await currentState()).staff.some((p) => p.id === "Kevin Ong")).toBe(true);
  });
});

describe("SaveLoadWorkspace — Edit YAML flow", async () => {
  /** Seeds a valid baseline scenario through the real import pipeline, so the
   *  preview starts from an exportable draft (and Edit YAML is enabled) rather
   *  than the blank new-scenario state, which fails `prepareExport`. */
  async function seedValidScenario() {
    const prepared = prepareScenarioLoad(serializeScenario(makeValidUiState()));
    if (!prepared.target) throw new Error("fixture must normalize cleanly");
    // Awaited: the switch is a repository transaction, so an unawaited seed can be
    // outrun by the render and the route would open on the blank workspace.
    await loadScenario(prepared.target);
  }

  beforeEach(async () => {
    await seedValidScenario();
  });

  async function currentYaml(): Promise<string> {
    const result = prepareWorkspaceExport(pickScenario(await currentState()));
    if (!result.ok) throw new Error("expected a valid draft");
    return result.yaml;
  }

  it("Edit seeds a textarea with the current Workspace YAML", async () => {
    render(<SaveLoadWorkspace />);
    const yaml = await currentYaml();

    fireEvent.click(screen.getByTestId("scenario-edit-yaml-button"));

    const textarea = screen.getByTestId("scenario-yaml-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe(yaml);
    expect(screen.queryByTestId("scenario-yaml-content")).not.toBeInTheDocument();
  });

  it("Apply on a valid edit replaces state through the same staged load pipeline as Upload", async () => {
    render(<SaveLoadWorkspace />);

    fireEvent.click(screen.getByTestId("scenario-edit-yaml-button"));
    editYaml(serializeScenario(makeValidUiState()));
    fireEvent.click(screen.getByTestId("yaml-apply-button"));

    // Apply into the seeded (non-empty) workspace stages the same combined
    // replacement confirmation as Upload rather than committing directly (T17r P0).
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    await waitFor(async () => expect((await currentState()).rangeStart).toBe("2026-05-14"));
    expect((await currentState()).staff.map((p) => p.id)).toEqual(["Alice", "Bob"]);
    // An applied edit goes through the same atomic switch as Upload: a fresh
    // identity with its own empty history, and no fresh local backup (T17r P0).
    expect(await undoDepth()).toBe(0);
    expect((await currentState()).backupFingerprint).toBeNull();

    // Editing mode closes back to the read-only preview once the replace commits.
    await waitFor(() =>
      expect(screen.queryByTestId("scenario-yaml-textarea")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("scenario-yaml-content")).toBeInTheDocument();
  });

  it("Apply on invalid YAML (`::bad::`) surfaces an inline parse error and leaves state untouched", async () => {
    render(<SaveLoadWorkspace />);
    const before = await stateSnapshot();

    fireEvent.click(screen.getByTestId("scenario-edit-yaml-button"));
    editYaml("::bad::");
    fireEvent.click(screen.getByTestId("yaml-apply-button"));

    (await within(screen.getByTestId("scenario-yaml-preview"))).findByTestId(
      "scenario-export-issues",
    );
    expect(await stateSnapshot()).toBe(before);
    // Still editing — Apply failed, the draft is not discarded.
    expect(screen.getByTestId("scenario-yaml-textarea")).toBeInTheDocument();
  });

  it("Start over closes editing and clears a staged import", async () => {
    render(<SaveLoadWorkspace />);

    fireEvent.click(screen.getByTestId("scenario-edit-yaml-button"));
    editYaml(withAppVersion("1.0.0"));
    fireEvent.click(screen.getByTestId("yaml-apply-button"));

    await screen.findByRole("button", { name: "Continue" });
    fireEvent.click(screen.getByTestId("new-schedule-button"));
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));

    await waitFor(async () => expect((await currentState()).rangeStart).toBe(""));
    // The editor closes one render *after* the store commit: StartOverCard awaits
    // resetToNewScenario (which sets rangeStart="") and only then fires
    // onResetComplete → setEditing(false). Wait for the DOM to catch up rather
    // than asserting it synchronously against the store state (mirrors the Apply
    // test above) — a synchronous check races the re-render under parallel-file load.
    await waitFor(() =>
      expect(screen.queryByTestId("scenario-yaml-textarea")).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("yaml-apply-button")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });

  it("Cancel restores the read-only preview with no state change", async () => {
    render(<SaveLoadWorkspace />);
    const before = await stateSnapshot();
    const yaml = await currentYaml();

    fireEvent.click(screen.getByTestId("scenario-edit-yaml-button"));
    editYaml("::bad::");
    fireEvent.click(screen.getByTestId("yaml-cancel-button"));

    expect(screen.queryByTestId("scenario-yaml-textarea")).not.toBeInTheDocument();
    expect(screen.getByTestId("scenario-yaml-content").textContent).toBe(yaml);
    expect(await stateSnapshot()).toBe(before);
  });
});
