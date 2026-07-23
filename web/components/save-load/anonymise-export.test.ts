import { describe, expect, it, vi } from "vitest";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import type { ScenarioUiState } from "@/lib/scenario";
import {
  ANONYMISE_DOWNLOAD_FILENAME,
  ANONYMISE_SCATTER_ONLY_FILENAME,
  ANONYMISE_TOGGLES,
  defaultAnonymiseToggleState,
  filenameForToggles,
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

describe("filenameForToggles", () => {
  // The `-anonymised` name asserts identity protection, so it must be gated on
  // an identity toggle actually being on. A Scatter-only export shuffles dates
  // but ships names/groups/history verbatim, so it gets an honest name instead.
  it("uses the -anonymised name when an identity toggle (people/groups) is on", () => {
    expect(filenameForToggles({ ...allOff, people: true })).toBe(ANONYMISE_DOWNLOAD_FILENAME);
    expect(filenameForToggles({ ...allOff, groups: true })).toBe(ANONYMISE_DOWNLOAD_FILENAME);
    // Scatter alongside an identity toggle still anonymises identities.
    expect(filenameForToggles({ people: true, groups: false, scatter: true })).toBe(
      ANONYMISE_DOWNLOAD_FILENAME,
    );
  });

  it("uses the honest -dates-scattered name when ONLY scatter is on", () => {
    expect(filenameForToggles({ ...allOff, scatter: true })).toBe(ANONYMISE_SCATTER_ONLY_FILENAME);
    // Guard the naming intent: the scatter-only artifact must not claim to be anonymised.
    expect(ANONYMISE_SCATTER_ONLY_FILENAME).not.toContain("anonymised");
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

  it("writes under the honest -dates-scattered name when ONLY scatter is on (identities untouched)", () => {
    const writeFile = vi.fn();

    const result = performAnonymisedDownload(
      makeValidUiState(),
      { ...allOff, scatter: true },
      {
        writeFile,
      },
    );

    expect(result.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
    // The -anonymised name must NOT be used: names/groups ship verbatim here.
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), ANONYMISE_SCATTER_ONLY_FILENAME);
    const [yaml] = writeFile.mock.calls[0] as [string, string];
    expect(yaml).toContain("Alice");
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

  it("anonymises an imperfect draft — backup preserves incomplete work (DL12 §2)", () => {
    const writeFile = vi.fn();

    const result = performAnonymisedDownload(
      makeInvalidUiState(),
      { ...allOff, people: true },
      {
        writeFile,
      },
    );

    expect(result.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("has no recordBackup dependency to call -- an anonymised download cannot record a backup", () => {
    // Structural guarantee: `PerformAnonymisedDownloadDeps` has only
    // `writeFile` (+ optional `rng`) -- no `recordBackup` field exists to call,
    // mirroring why `PerformCopyDeps` has none either. A successful download
    // still resolves ok and never reaches for a backup-fingerprint side effect.
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

  // Scatter needs a concrete, valid calendar to move requests within. A null,
  // partial, or reversed range would silently move nothing yet still report a
  // successful scattered download, so it must be a structured blocking issue that
  // fires BEFORE any transform and mutates nothing (T17r review P2).
  it.each([
    ["a null (unset) range", { rangeStart: "", rangeEnd: "" }],
    ["a partially-specified range (start only)", { rangeStart: "2026-05-14", rangeEnd: "" }],
    ["a partially-specified range (end only)", { rangeStart: "", rangeEnd: "2026-05-20" }],
    ["a reversed range (end before start)", { rangeStart: "2026-05-20", rangeEnd: "2026-05-14" }],
  ])("blocks Scatter on %s with no mutation and no download", (_label, range) => {
    const writeFile = vi.fn();
    const state = { ...makeValidUiState(), ...range };
    const before = structuredClone(state);

    const result = performAnonymisedDownload(state, { ...allOff, scatter: true }, { writeFile });

    // A structured blocking issue on the range — never a successful download.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(expect.objectContaining({ path: "dates.range" }));
    // No file was written, and the source state is byte-for-byte unchanged.
    expect(writeFile).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });
});
