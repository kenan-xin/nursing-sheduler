// A saved roster on the app's own path, as a successful Optimize run leaves it: the
// submission the Optimize screen builds is staged as the write-ahead snapshot, the app
// capture gate fetches the solver's `/roster` container and F3 assembles the document,
// and F1 commits it to the empty working slot. Only the solver is replaced: its
// container comes from the case's rows, and the workbook is stand-in bytes (the
// assistant never reads them).
import { INITIAL_OPTIMIZE_RUN_VIEW } from "@/lib/optimize/run-view";
import { getRosterCaptureGate, resetRosterCaptureGate } from "@/lib/optimize/roster-capture-app";
import { ROSTER_SUBMISSION_VERSION } from "@/lib/optimize/roster-candidate-builder";
import { buildStagedSubmission, stageSubmissionSnapshot } from "@/lib/optimize/submission-snapshot";
import { XLSX_MEDIA_TYPE } from "@/lib/roster/container";
import { deriveRosterContext } from "@/lib/roster/context";
import type { RosterDayState } from "@/lib/roster/types";
import { toCanonicalScenarioDocument } from "@/lib/scenario/canonical";
import { prepareOptimizeSubmission } from "@/lib/scenario/prepare-optimize-submission";
import { applyCovers } from "@/lib/scenario/temporary-cover";
import type { ScenarioUiState } from "@/lib/scenario/types";
import { rosterStorage, useHotStore } from "@/lib/store";

/** One row per person id: a code per roster day, space-separated. OFF is a day off, LV leave. */
export type SavedRosterRows = Record<string, string>;

let jobs = 0;

/** No saved roster and no finished run, as after the app's Clear. */
export async function clearSavedRoster(): Promise<void> {
  const cleared = await rosterStorage.clearRosterData();
  if (cleared.status !== "cleared") throw new Error("could not clear the saved roster");
  resetRosterCaptureGate();
  useHotStore.getState().resetRunView();
}

function day(code: string): RosterDayState {
  if (code === "OFF") return { kind: "off" };
  if (code === "LV") return { kind: "leave" };
  return { kind: "shift", shiftId: code };
}

/** Save `rows` as the roster a finished run made for `scenario`, replacing any saved one. */
export async function seedSavedRoster(
  scenario: ScenarioUiState,
  rows: SavedRosterRows,
): Promise<void> {
  // Built as the Optimize screen builds a plain (not anonymised) run.
  const applied = applyCovers(scenario);
  const prepared = prepareOptimizeSubmission(toCanonicalScenarioDocument(applied.state), {
    anonymize: false,
  });
  if (!prepared.ok) throw new Error(`scenario is not submittable: ${JSON.stringify(prepared)}`);
  const payload = buildStagedSubmission({
    canonicalYaml: prepared.prep.yaml,
    reverseMap: prepared.prep.reverseMap,
    schemaVersion: ROSTER_SUBMISSION_VERSION,
  });
  const derived = deriveRosterContext(payload);
  if (!derived.ok) throw new Error(`no roster context: ${derived.reason}`);
  const { people, calendar } = derived.context;

  const solvedDays = people.map((person) => {
    const id = String(person.id);
    const codes = rows[id]?.trim().split(/\s+/) ?? [];
    if (codes.length !== calendar.length)
      throw new Error(`row for ${id} has ${codes.length} days, the roster has ${calendar.length}`);
    return codes.map(day);
  });
  const container = {
    schemaVersion: "roster-container/1",
    people: people.map((person) => ({ id: person.id })),
    dates: calendar.map((d) => ({ iso: d.iso })),
    solvedDays,
    score: 0,
    solverStatus: "OPTIMAL",
    coordinateMap: {
      peopleRows: people.map((_, i) => 2 + i),
      dateColumns: calendar.map((_, i) => 2 + i),
      firstPeopleRow: 2,
      leadingCols: 1,
      historyCols: 0,
      prettify: false,
    },
    xlsx: { name: "roster.xlsx", mime: XLSX_MEDIA_TYPE },
  };

  await clearSavedRoster();

  const jobId = `eval_roster_${++jobs}`;
  const capture = await stageSubmissionSnapshot({
    ownerId: `${jobId}_owner`,
    payload,
    cover: { entries: [], decrements: applied.decrements },
  });
  const outcome = await getRosterCaptureGate({ fetchRoster: async () => container }).capture({
    jobId,
    capture,
    frozenXlsx: new Blob([new Uint8Array([80, 75, 3, 4])], { type: XLSX_MEDIA_TYPE }),
  });
  if (outcome.state.status !== "committed")
    throw new Error(`the app did not save the roster: ${JSON.stringify(outcome.state)}`);

  useHotStore.getState().setRunView({
    ...INITIAL_OPTIMIZE_RUN_VIEW,
    lifecycle: "completed",
    jobId,
    outcome: "optimal",
    result: { outcome: "optimal", score: 0, solverStatus: "OPTIMAL", terminationReason: null },
  });
}
