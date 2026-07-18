import { describe, expect, it, vi } from "vitest";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import type { ScenarioUiState } from "@/lib/scenario";
import {
  ANONYMISE_DOWNLOAD_FILENAME,
  ANONYMISE_TOGGLES,
  defaultAnonymiseToggleState,
  isAnonymiseDownloadEnabled,
  performAnonymisedDownload,
  type AnonymiseToggleState,
} from "./anonymise-export";

/** A producer-invalid draft (equal start/end shift -- mirrors T05's own fixture trick). */
function makeInvalidUiState(): ScenarioUiState {
  const state = makeValidUiState();
  state.shifts[1] = { id: "E", startTime: "09:00", endTime: "09:00" };
  return state;
}

const allOff: AnonymiseToggleState = { people: false, groups: false, scatter: false };

describe("ANONYMISE_TOGGLES", () => {
  it("has exactly 3 toggles (DL10 D2 -- no 4th 'descriptions' toggle)", () => {
    expect(ANONYMISE_TOGGLES).toHaveLength(3);
    expect(ANONYMISE_TOGGLES.map((t) => t.key).sort()).toEqual(["groups", "people", "scatter"]);
    for (const toggle of ANONYMISE_TOGGLES) {
      expect(toggle.label.toLowerCase()).not.toContain("description");
    }
  });

  it("defaults: Replace item IDs ON, Replace group IDs OFF, Scatter OFF", () => {
    expect(defaultAnonymiseToggleState()).toEqual({
      people: true,
      groups: false,
      scatter: false,
    });
  });
});

describe("isAnonymiseDownloadEnabled", () => {
  it("is disabled when all toggles are off", () => {
    expect(isAnonymiseDownloadEnabled(allOff)).toBe(false);
  });

  it("is enabled when at least one toggle is on", () => {
    expect(isAnonymiseDownloadEnabled({ ...allOff, people: true })).toBe(true);
    expect(isAnonymiseDownloadEnabled({ ...allOff, groups: true })).toBe(true);
    expect(isAnonymiseDownloadEnabled({ ...allOff, scatter: true })).toBe(true);
  });
});

describe("performAnonymisedDownload", () => {
  it("writes the anonymised YAML to the injected file writer under the anonymised filename", () => {
    const writeFile = vi.fn();

    const result = performAnonymisedDownload(
      makeValidUiState(),
      { ...allOff, people: true },
      {
        writeFile,
      },
    );

    expect(result.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), ANONYMISE_DOWNLOAD_FILENAME);
  });

  it("passes the toggle-derived opts through to prepareAnonymizedExport (people rewritten, groups untouched)", () => {
    const writeFile = vi.fn();

    const result = performAnonymisedDownload(
      makeValidUiState(),
      { ...allOff, people: true },
      {
        writeFile,
      },
    );

    expect(result.ok).toBe(true);
    const [yaml] = writeFile.mock.calls[0] as [string, string];
    expect(yaml).not.toContain("Alice");
    expect(yaml).toContain("Seniors");
  });

  it("on an invalid draft, surfaces issues and writes nothing", () => {
    const writeFile = vi.fn();

    const result = performAnonymisedDownload(
      makeInvalidUiState(),
      { ...allOff, people: true },
      {
        writeFile,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("has no markSaved dependency to call -- an anonymised download cannot clear dirty", () => {
    // Structural guarantee: `PerformAnonymisedDownloadDeps` has only
    // `writeFile` (+ optional `rng`) -- no `markSaved` field exists to call,
    // mirroring why `PerformCopyDeps` has none either. A successful download
    // still resolves ok and never reaches for a save-baseline side effect.
    const writeFile = vi.fn();

    const result = performAnonymisedDownload(
      makeValidUiState(),
      { ...allOff, people: true },
      {
        writeFile,
      },
    );

    expect(result.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });
});
