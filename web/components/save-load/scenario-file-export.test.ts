import { describe, expect, it, vi } from "vitest";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import type { ScenarioUiState } from "@/lib/scenario";
import { performCopy, performDownload, SCENARIO_DOWNLOAD_FILENAME } from "./scenario-file-export";

/** A producer-invalid draft (equal start/end shift — mirrors T05's own fixture trick). */
function makeInvalidUiState(): ScenarioUiState {
  const state = makeValidUiState();
  state.shifts[1] = { id: "E", startTime: "09:00", endTime: "09:00" };
  return state;
}

describe("performDownload", () => {
  it("writes the validated YAML to the injected file writer, then clears dirty", () => {
    const writeFile = vi.fn();
    const markSaved = vi.fn();

    const result = performDownload(makeValidUiState(), { writeFile, markSaved });

    expect(result.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), SCENARIO_DOWNLOAD_FILENAME);
    const [yaml] = writeFile.mock.calls[0] as [string, string];
    expect(yaml).toContain("apiVersion: alpha");
    expect(markSaved).toHaveBeenCalledTimes(1);
  });

  it("on an invalid draft, surfaces issues and writes nothing (dirty untouched)", () => {
    const writeFile = vi.fn();
    const markSaved = vi.fn();

    const result = performDownload(makeInvalidUiState(), { writeFile, markSaved });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
    expect(writeFile).not.toHaveBeenCalled();
    expect(markSaved).not.toHaveBeenCalled();
  });
});

describe("performCopy", () => {
  it("writes the validated YAML to the clipboard and never clears dirty", () => {
    const writeClipboard = vi.fn();

    const result = performCopy(makeValidUiState(), { writeClipboard });

    expect(result.ok).toBe(true);
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    expect(writeClipboard).toHaveBeenCalledWith(expect.any(String));
    // Structural guarantee: PerformCopyDeps has no markSaved field to call —
    // there is nothing here that could clear dirty even by mistake.
  });

  it("on an invalid draft, surfaces issues and writes nothing to the clipboard", () => {
    const writeClipboard = vi.fn();

    const result = performCopy(makeInvalidUiState(), { writeClipboard });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
    expect(writeClipboard).not.toHaveBeenCalled();
  });
});
