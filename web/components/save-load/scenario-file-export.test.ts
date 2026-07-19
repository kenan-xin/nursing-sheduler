import { describe, expect, it, vi } from "vitest";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import type { ScenarioUiState } from "@/lib/scenario";
import { performCopy, performDownload, SCENARIO_DOWNLOAD_FILENAME } from "./scenario-file-export";

/** An imperfect draft (equal start/end shift) — producer-invalid, but a Workspace
 *  backup preserves it (DL12 §2: readiness gates Optimize, not backup). */
function makeImperfectUiState(): ScenarioUiState {
  const state = makeValidUiState();
  state.shifts[1] = { id: "E", startTime: "09:00", endTime: "09:00" };
  return state;
}

/** A structurally corrupt draft: two cards share a `uid`, so the emitted Workspace
 *  would carry a duplicate `workspaceId` — the one thing backup still blocks. */
function makeDuplicateIdUiState(): ScenarioUiState {
  const state = makeValidUiState();
  state.cardsByKind.requirements = [
    { uid: "dup", shiftType: "D", requiredNumPeople: 1, weight: -1 },
    { uid: "dup", shiftType: "E", requiredNumPeople: 1, weight: -1 },
  ];
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

  it("backs up an imperfect draft — backup preserves incomplete work (DL12 §2)", () => {
    const writeFile = vi.fn();
    const markSaved = vi.fn();

    const result = performDownload(makeImperfectUiState(), { writeFile, markSaved });

    expect(result.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(markSaved).toHaveBeenCalledTimes(1);
  });

  it("blocks a structurally corrupt draft (duplicate workspace identity), writing nothing", () => {
    const writeFile = vi.fn();
    const markSaved = vi.fn();

    const result = performDownload(makeDuplicateIdUiState(), { writeFile, markSaved });

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

  it("copies an imperfect draft — backup preserves incomplete work (DL12 §2)", () => {
    const writeClipboard = vi.fn();

    const result = performCopy(makeImperfectUiState(), { writeClipboard });

    expect(result.ok).toBe(true);
    expect(writeClipboard).toHaveBeenCalledTimes(1);
  });

  it("blocks a structurally corrupt draft (duplicate workspace identity)", () => {
    const writeClipboard = vi.fn();

    const result = performCopy(makeDuplicateIdUiState(), { writeClipboard });

    expect(result.ok).toBe(false);
    expect(writeClipboard).not.toHaveBeenCalled();
  });
});
