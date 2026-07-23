// Pure core for the T17b-2 Load flow UI. Kept out of the UI components so the
// version-mismatch wording is unit-testable without mounting a component,
// mirroring the established `scenario-file-export.ts` pure-core / `-card.tsx` UI
// split. (The uncredited-leave guard now lives in the shared detector — see
// `lib/scenario/leave-guard` — and is wired into import in `use-scenario-import.ts`.)

import {
  createEmptyScenarioUiState,
  serializeScenario,
  type VersionConfirmStatus,
} from "@/lib/scenario";

// ---------------------------------------------------------------------------
// FR-SL-19/20 version-mismatch wording (spec 08, ported from the current
// codebase's `getVersionWarning`; the load-integrity check never parses
// version parts — FR-SL-20).
// ---------------------------------------------------------------------------

export interface VersionMismatchCopy {
  title: string;
  description: string;
}

/**
 * FR-SL-19's exactly-three warning cases, verbatim (spec 08). `description` is
 * reproduced byte-for-byte from the spec (including its embedded `\n\n`
 * paragraph breaks) — do not paraphrase or reflow it.
 */
export function versionMismatchCopy(
  status: VersionConfirmStatus,
  fileVersion: string | undefined,
  current: string,
): VersionMismatchCopy {
  switch (status) {
    case "missing":
      return {
        title: "Missing app version information",
        description:
          `The loaded file does not contain app version information. It may have been created ` +
          `with an older version of the application. Current app version: ${current}`,
      };
    case "dirty":
      return {
        title: "Development build detected",
        description:
          `Dirty app version detected.\n\n` +
          `File app version: ${fileVersion}\n` +
          `Current app version: ${current}\n\n` +
          `This YAML was created by a development build with uncommitted changes. It may not ` +
          `match a reproducible application version. If nothing breaks, you can continue.`,
      };
    case "incompatible":
      return {
        title: "App version mismatch detected",
        description:
          `App version mismatch detected.\n\n` +
          `File app version: ${fileVersion}\n` +
          `Current app version: ${current}\n\n` +
          `Older YAML may not work after breaking changes, though we try to preserve compatibility. ` +
          `If nothing breaks, you can continue.`,
      };
  }
}

// ---------------------------------------------------------------------------
// Combined replacement + version confirmation (T17r review P0). DL12 requires
// EVERY load into a non-empty workspace to confirm replacement — including a
// matching-version load — so the confirm may carry a replacement warning alone, a
// version warning alone, or both combined into one dialog.
// ---------------------------------------------------------------------------

/** Title/lead for the replacement half of the combined load confirmation. */
export const REPLACEMENT_CONFIRM_TITLE = "Replace your current workspace?";
export const REPLACEMENT_CONFIRM_BODY =
  "Loading this file replaces your current workspace — your current setup will be " +
  "overwritten. You can undo the load afterwards to restore it.";

export interface LoadConfirmCopy {
  title: string;
  description: string;
}

/**
 * Build the single combined confirmation copy for a staged load. `replacement` is
 * true when the current workspace is non-empty (its content would be overwritten);
 * `versionStatus` is `null` on a version match, or the FR-SL-19 case otherwise.
 * When both apply they are merged into one dialog (replacement lead + the exact
 * FR-SL-19 version wording, unaltered); either alone yields its own copy.
 */
export function loadConfirmCopy(
  versionStatus: VersionConfirmStatus | null,
  replacement: boolean,
  fileVersion: string | undefined,
  current: string,
): LoadConfirmCopy {
  const version =
    versionStatus !== null ? versionMismatchCopy(versionStatus, fileVersion, current) : null;
  if (replacement && version) {
    return {
      title: REPLACEMENT_CONFIRM_TITLE,
      description: `${REPLACEMENT_CONFIRM_BODY}\n\n${version.title}\n\n${version.description}`,
    };
  }
  if (version) return version;
  return { title: REPLACEMENT_CONFIRM_TITLE, description: REPLACEMENT_CONFIRM_BODY };
}

// ---------------------------------------------------------------------------
// "Load a sample scenario" affordance — built + serialized through the SAME
// `serializeScenario` producer-preflight path as Download/Copy, so the sample is
// guaranteed to round-trip through `prepareScenarioLoad` exactly like any other
// valid file (no hand-authored YAML that could silently drift from the schema).
// ---------------------------------------------------------------------------

export function buildSampleScenarioYaml(): string {
  const state = createEmptyScenarioUiState("alpha");
  state.meta.description = "Sample ward — General Medicine";
  state.rangeStart = "2026-05-01";
  state.rangeEnd = "2026-05-14";
  state.staff = [
    { id: "Aisha Rahman", description: "Senior" },
    { id: "Kevin Ong", description: "Junior" },
  ];
  state.staffGroups = [{ id: "Seniors", members: ["Aisha Rahman"] }];
  state.shifts = [
    {
      id: "AM",
      description: "Morning",
      startTime: "07:00",
      endTime: "15:00",
      durationMinutes: 480,
    },
    {
      id: "PM",
      description: "Evening",
      startTime: "14:00",
      endTime: "22:00",
      durationMinutes: 480,
    },
  ];
  state.cardsByKind.requirements = [
    {
      uid: "sample-r1",
      shiftType: "AM",
      requiredNumPeople: 1,
      qualifiedPeople: "ALL",
      date: "ALL",
      weight: -1,
    },
  ];
  state.reqData = [{ uid: "sample-c1", kind: "leave", person: "Kevin Ong", date: "2026-05-05" }];
  return serializeScenario(state);
}
