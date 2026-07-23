// Anonymise decision core (T17a-5). Mirrors scenario-file-export.ts's shape:
// the toggle config is the single source of truth the card renders from (so
// "exactly 3 toggles, no 4th" is a data assertion, not a DOM one -- this repo
// has no jsdom/testing-library yet), and the download itself is a pure,
// injectable-deps function so it's unit-testable without a browser.
//
// DL10 D2 overrides the prototype's 4th "Remove free-text descriptions"
// toggle: descriptions are preserved, not stripped. Deliberately has no
// `recordBackup` dependency to call -- an anonymised/redacted copy is not a
// Workspace backup (mirrors why Copy doesn't record a backup either).

import {
  prepareAnonymizedWorkspaceExport,
  type PrepareAnonymizedExportOptions,
  type PrepareExportResult,
  type ScenarioUiState,
} from "@/lib/scenario";

/**
 * The filename for a download that actually anonymises identities (people
 * and/or groups replaced). Only honest when at least one identity toggle is on.
 */
export const ANONYMISE_DOWNLOAD_FILENAME = "scenario-anonymised.yaml";

/**
 * The filename for a Scatter-only download: dates are shuffled but identities
 * (names, groups, history, descriptions) are left verbatim. The `-anonymised`
 * name would assert a protection that didn't happen, so this reflects what the
 * transform actually did instead.
 */
export const ANONYMISE_SCATTER_ONLY_FILENAME = "scenario-dates-scattered.yaml";

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
  { key: "people", label: "Replace people item IDs", defaultOn: true },
  { key: "groups", label: "Replace people group IDs", defaultOn: false },
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

/**
 * The download filename honestly derived from the toggle state. The
 * `-anonymised` name is reserved for downloads that actually anonymise
 * identities (`people` and/or `groups`). A Scatter-only download leaves names,
 * groups, history and descriptions verbatim, so it gets a `-dates-scattered`
 * name instead of asserting a protection that didn't happen. (The all-off case
 * is unreachable via the CTA, which is gated by `isAnonymiseDownloadEnabled`.)
 */
export function filenameForToggles(toggles: AnonymiseToggleState): string {
  if (toggles.people || toggles.groups) return ANONYMISE_DOWNLOAD_FILENAME;
  return ANONYMISE_SCATTER_ONLY_FILENAME;
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
 * `recordBackup` field in its deps -- there is no wiring mistake to make here,
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
  deps.writeFile(result.yaml, filenameForToggles(toggles));
  return result;
}
