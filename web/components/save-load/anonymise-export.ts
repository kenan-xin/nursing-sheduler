// Anonymise decision core (T17a-5). Mirrors scenario-file-export.ts's shape:
// the toggle config is the single source of truth the card renders from (so
// "exactly 3 toggles, no 4th" is a data assertion, not a DOM one -- this repo
// has no jsdom/testing-library yet), and the download itself is a pure,
// injectable-deps function so it's unit-testable without a browser.
//
// DL10 D2 overrides the prototype's 4th "Remove free-text descriptions"
// toggle: descriptions are preserved, not stripped. Deliberately has no
// `markSaved` dependency to call -- an anonymised/redacted copy is not a save
// of the working scenario (mirrors why Copy doesn't clear dirty either).

import {
  prepareAnonymizedWorkspaceExport,
  type PrepareAnonymizedExportOptions,
  type PrepareExportResult,
  type ScenarioUiState,
} from "@/lib/scenario";

/** The filename stamped on every anonymised scenario download. */
export const ANONYMISE_DOWNLOAD_FILENAME = "scenario-anonymised.yaml";

export type AnonymiseToggleKey = "people" | "groups" | "scatter";

export interface AnonymiseToggleConfig {
  key: AnonymiseToggleKey;
  label: string;
  defaultOn: boolean;
}

/**
 * The exactly-3 toggles (DL10 D2) -- independent of each other, matching
 * `PrepareAnonymizedExportOptions`. NO 4th "Remove free-text descriptions"
 * toggle; the card shows a preservation note instead.
 */
export const ANONYMISE_TOGGLES: readonly AnonymiseToggleConfig[] = [
  { key: "people", label: "Replace item IDs", defaultOn: true },
  { key: "groups", label: "Replace group IDs", defaultOn: false },
  { key: "scatter", label: "Scatter shift requests (developer only)", defaultOn: false },
];

export type AnonymiseToggleState = Record<AnonymiseToggleKey, boolean>;

/** The card's initial toggle state -- `people` ON, `groups`/`scatter` OFF. */
export function defaultAnonymiseToggleState(): AnonymiseToggleState {
  const state = {} as AnonymiseToggleState;
  for (const toggle of ANONYMISE_TOGGLES) state[toggle.key] = toggle.defaultOn;
  return state;
}

/** Download-anonymised is enabled only when at least one toggle is on. */
export function isAnonymiseDownloadEnabled(toggles: AnonymiseToggleState): boolean {
  return ANONYMISE_TOGGLES.some((toggle) => toggles[toggle.key]);
}

export interface PerformAnonymisedDownloadDeps {
  /** Write the validated anonymised YAML to a file download. Never called on an invalid draft. */
  writeFile: (yaml: string, filename: string) => void;
  /** Injected RNG for scatter (defaults to `Math.random` inside `prepareAnonymizedExport`). */
  rng?: PrepareAnonymizedExportOptions["rng"];
}

/**
 * Download-anonymised: routes through `prepareAnonymizedExport` (T17a-2),
 * never the plain `prepareExport` path, so the transform always runs on a
 * clone and the live scenario is never mutated. Deliberately has NO
 * `markSaved` field in its deps -- there is no wiring mistake to make here,
 * unlike `performDownload`'s deps which require it.
 */
export function performAnonymisedDownload(
  state: ScenarioUiState,
  toggles: AnonymiseToggleState,
  deps: PerformAnonymisedDownloadDeps,
): PrepareExportResult {
  const result = prepareAnonymizedWorkspaceExport(state, {
    people: toggles.people,
    groups: toggles.groups,
    scatter: toggles.scatter,
    rng: deps.rng,
  });
  if (!result.ok) return result;
  deps.writeFile(result.yaml, ANONYMISE_DOWNLOAD_FILENAME);
  return result;
}
