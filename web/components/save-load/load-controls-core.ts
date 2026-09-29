// Pure core for the T17b-2 Load flow UI. Kept out of the UI components so the
// version-mismatch wording is unit-testable without mounting a component,
// mirroring the established `scenario-file-export.ts` pure-core / `-card.tsx` UI
// split. (The uncredited-leave guard now lives in the shared detector — see
// `lib/scenario/leave-guard` — and is wired into import in `use-scenario-import.ts`.)

import {
  createEmptyScenarioUiState,
  serializeScenario,
  type V1LeaveShiftPlan,
  type VersionConfirmStatus,
} from "@/lib/scenario";

// ---------------------------------------------------------------------------
// v1 "Leave" shift conversion offer (nursing-sheduler-objg). v1 let a file define
// its own "Leave" shift; v2 reserves LEAVE as the paid-leave pin.
// ---------------------------------------------------------------------------

/** Copy for the confirm that offers converting a v1 "Leave" shift to paid leave. */
export function v1LeaveShiftOfferCopy(plan: V1LeaveShiftPlan): {
  title: string;
  description: string;
  detail: string;
} {
  const lines = [
    `Requests that become paid leave: ${plan.convertedRequests}`,
    `History entries that become LEAVE: ${plan.historyEntries}`,
  ];
  if (plan.droppedRequests > 0)
    lines.push(`Requests dropped (zero or negative weight): ${plan.droppedRequests}`);
  if (plan.allShiftRules > 0)
    lines.push(
      plan.allShiftRules === 1
        ? "1 rule that counts ALL shifts will no longer count leave days after conversion."
        : `${plan.allShiftRules} rules that count ALL shifts will no longer count leave days after conversion.`,
    );
  return {
    title: `Convert "${plan.shiftId}" to paid leave?`,
    description:
      `This file has its own shift type "${plan.shiftId}". This app has a built-in LEAVE for ` +
      `paid leave, so the two clash. Convert it: the shift type is removed and its requests ` +
      `become fixed paid-leave days, which the schedule always keeps. ` +
      `To keep it as a worked shift instead, choose Don't convert.`,
    detail: lines.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// FR-SL-19/20 version-mismatch wording (spec 08, ported from the current
// codebase's `getVersionWarning`; the load-integrity check never parses
// version parts — FR-SL-20).
// ---------------------------------------------------------------------------

export interface VersionMismatchCopy {
  title: string;
  description: string;
  /**
   * The file/current app-version pair for the confirm's mono bordered detail box
   * (prototype ScreenSaveLoad.dc.html:150), as `\n`-separated lines. Present only
   * in the two cases that compare a FILE version against the current one; the
   * `missing` case has no file version and states the current one inline.
   */
  detail?: string;
}

/**
 * FR-SL-19's exactly-three warning cases, verbatim (spec 08). The wording is
 * reproduced byte-for-byte from the spec (including its embedded `\n\n`
 * paragraph breaks) — do not paraphrase or reflow it. The two version lines are
 * lifted out of `description` into `detail` (CW-4 follow-up) so the confirm can
 * box them; the words themselves are unchanged.
 */
export function versionMismatchCopy(
  status: VersionConfirmStatus,
  fileVersion: string | undefined,
  current: string,
): VersionMismatchCopy {
  const versionDetail = `File app version: ${fileVersion}\nCurrent app version: ${current}`;
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
          `This YAML was created by a development build with uncommitted changes. It may not ` +
          `match a reproducible application version. If nothing breaks, you can continue.`,
        detail: versionDetail,
      };
    case "incompatible":
      return {
        title: "App version mismatch detected",
        description:
          `App version mismatch detected.\n\n` +
          `Older YAML may not work after breaking changes, though we try to preserve compatibility. ` +
          `If nothing breaks, you can continue.`,
        detail: versionDetail,
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
// A Load mints a new scenario identity, so Undo cannot reach back across it
// (`lib/store/lifecycle.ts`). The copy must not promise otherwise (C-05).
export const REPLACEMENT_CONFIRM_BODY =
  "This replaces your current schedule and cannot be undone. Download a copy first. " +
  "The current roster will also be cleared.";

export interface LoadConfirmCopy {
  title: string;
  description: string;
  /** True when the load overwrites a non-empty workspace — render the destructive style. */
  destructive?: boolean;
  /** The FR-SL-19 mono version box lines, when the version case applies (see `VersionMismatchCopy.detail`). */
  detail?: string;
}

/**
 * Build the single combined confirmation copy for a staged load. `replacement` is
 * true when the current workspace is non-empty (its content would be overwritten);
 * `versionStatus` is `null` on a version match, or the FR-SL-19 case otherwise.
 * When both apply they are merged into one dialog (replacement lead + the exact
 * FR-SL-19 version wording, unaltered); either alone yields its own copy. A
 * replacement-only confirm carries no version box.
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
      detail: version.detail,
      destructive: true,
    };
  }
  if (version) return version;
  return {
    title: REPLACEMENT_CONFIRM_TITLE,
    description: REPLACEMENT_CONFIRM_BODY,
    destructive: true,
  };
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
