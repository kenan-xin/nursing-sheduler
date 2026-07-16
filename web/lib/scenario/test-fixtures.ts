// Test fixtures for the T05 contract layer. Not exported from `index.ts` — these
// build a small, backend-valid scenario the unit + differential tests share.

import { createEmptyScenarioUiState } from "./canonical";
import type { ScenarioUiState } from "./types";

/**
 * A minimal but non-trivial valid durable UI state: two people + a group, three
 * shift types (one with clock working-time) + a group, one date group, a shift
 * requirement, a leave + a request matrix cell, and an export rule. Projects to a
 * canonical document the vendored Python `load_data` accepts.
 */
export function makeValidUiState(): ScenarioUiState {
  const state = createEmptyScenarioUiState("alpha");
  state.meta.description = "T05 fixture";
  state.rangeStart = "2026-05-14";
  state.rangeEnd = "2026-05-20";
  state.staff = [{ id: "Alice", history: ["D"] }, { id: "Bob" }];
  state.staffGroups = [{ id: "Seniors", members: ["Alice", "Bob"] }];
  state.shifts = [
    {
      id: "D",
      description: "Day",
      startTime: "09:00",
      endTime: "17:00",
      restMinutes: 60,
      durationMinutes: 420,
    },
    { id: "E", description: "Evening" },
    { id: "N", description: "Night" },
  ];
  state.shiftGroups = [{ id: "DayOrEvening", members: ["D", "E"] }];
  state.dateGroups = [{ id: "FirstTwo", members: ["2026-05-14", "2026-05-15"] }];
  state.maxOneShiftPerDay = { description: "one per day" };
  state.cardsByKind.requirements = [
    {
      uid: "r1",
      shiftType: "D",
      requiredNumPeople: 1,
      qualifiedPeople: "ALL",
      date: "ALL",
      weight: -1,
    },
  ];
  state.reqData = [
    { uid: "c1", kind: "leave", person: "Alice", date: "2026-05-14" },
    { uid: "c2", kind: "request", person: "Bob", date: "2026-05-15", shiftType: "D", weight: 2 },
    { uid: "c3", kind: "off", person: "Bob", date: "2026-05-16", weight: 1 },
  ];
  state.exportLayout.formatting = [
    { uid: "f1", type: "row", people: ["Alice"], backgroundColor: "#ff0000" },
  ];
  return state;
}
