// Pure core for the T17b-2 Load flow UI. Kept out of `load-controls.tsx` so the
// version-mismatch wording and the non-blocking uncredited-LEAVE detector are
// unit-testable without mounting a component, mirroring the established
// `scenario-file-export.ts` pure-core / `-card.tsx` UI split.

import {
  buildShiftTypeIndexMap,
  createEmptyScenarioUiState,
  expandShiftTypeSelector,
  LEAVE_SID,
  serializeScenario,
  type ImportNormalizationTarget,
  type ImportVersionStatus,
} from "@/lib/scenario";

// ---------------------------------------------------------------------------
// FR-SL-19/20 version-mismatch wording (spec 08, ported from the current
// codebase's `getVersionWarning`; the load-integrity check never parses
// version parts — FR-SL-20).
// ---------------------------------------------------------------------------

export type VersionConfirmStatus = Exclude<ImportVersionStatus, "match">;

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
    case "mismatch":
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
// Non-blocking uncredited-LEAVE warn-fence (qq0.17 blocks qq0.23; the real
// editor-time guard is deferred — this ticket ships only the import-time fence).
// ---------------------------------------------------------------------------

export const UNCREDITED_LEAVE_WARNING =
  "This scenario has a paid-leave request, but its contracted-hours count does not include " +
  "LEAVE in countShiftTypes — those hours will not be credited toward the contract. (The full " +
  "uncredited-leave guard is tracked separately; this file will still load.)";

/**
 * Non-blocking detector: a MARKED (`tag === "contracted_hours"`) count whose
 * expanded `countShiftTypes` selectors never reach the reserved LEAVE day-state,
 * while the imported scenario has at least one leave-pin (`reqData` cell with
 * `kind: "leave"`). An unresolved selector suppresses that card's check entirely
 * (no false positive) — the concrete per-person naming + one-click fix is
 * qq0.23's scope, not this fence's.
 */
export function hasUncreditedLeave(target: ImportNormalizationTarget): boolean {
  const hasLeavePin = target.reqData.some((cell) => cell.kind === "leave");
  if (!hasLeavePin) return false;

  const map = buildShiftTypeIndexMap(target.shifts, target.shiftGroups);
  for (const count of target.cardsByKind.counts) {
    if (count.tag !== "contracted_hours") continue;
    const selectors = Array.isArray(count.countShiftTypes)
      ? count.countShiftTypes
      : [count.countShiftTypes];

    let unresolved = false;
    let coversLeave = false;
    for (const selector of selectors) {
      const indices = expandShiftTypeSelector(selector, map);
      if (indices === null) {
        unresolved = true;
        break;
      }
      if (indices.includes(LEAVE_SID)) coversLeave = true;
    }
    if (unresolved) continue;
    if (!coversLeave) return true;
  }
  return false;
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
