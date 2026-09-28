import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, toCanonicalScenarioDocument } from "@/lib/scenario/canonical";
import { serializeWorkspace } from "@/lib/scenario/workspace";
import type { CanonicalShiftCountPreference, ScenarioUiState } from "@/lib/scenario/types";
import { expandPersonRefs } from "./expansion";
import {
  REST_DAYS_RULE_DESCRIPTION,
  REST_DAYS_WEIGHT,
  buildRestDaysRuleCard,
  expandRestDaysRule,
  isRestDaysRuleCard,
} from "./rest-days";

/** October 2026 ward; `history` is the days before Oct 1, newest last. */
function ward(history: Record<string, string[]> = {}): ScenarioUiState {
  const state = createEmptyScenarioUiState("alpha");
  state.rangeStart = "2026-10-01";
  state.rangeEnd = "2026-10-31";
  state.shifts = [{ id: "D" }, { id: "N" }];
  state.staff = ["ana", "ben"].map((id) => ({ id, history: history[id] }));
  state.cardsByKind.counts = [buildRestDaysRuleCard("t")];
  return state;
}

/** The window rules a roster breaks for one nurse: worked days in the window above T. */
function broken(state: ScenarioUiState, person: string, worked: string[]) {
  const card = state.cardsByKind.counts[0];
  return expandRestDaysRule(card, state).filter((pref: CanonicalShiftCountPreference) => {
    if (!expandPersonRefs(pref.person, state).has(person)) return false;
    const x = (pref.countDates as string[]).filter((d) => worked.includes(d)).length;
    return x > (pref.target as number);
  });
}

describe("2 rest days in any 7 days in a row", () => {
  it("is one count card, recognised by its id, a strong preference", () => {
    const card = buildRestDaysRuleCard("t");
    expect(isRestDaysRuleCard(card)).toBe(true);
    expect(isRestDaysRuleCard({ ...card, uid: "cnt-1" })).toBe(false);
    expect(card.description).toBe(REST_DAYS_RULE_DESCRIPTION);
    expect(card.person).toEqual(["ALL"]);
    expect(REST_DAYS_WEIGHT).toBe(-1000);
    expect(card.weight).toBe(REST_DAYS_WEIGHT);
  });

  it("penalises more than 5 worked shifts in every 7-day window of the roster", () => {
    const state = ward();
    const windows = expandRestDaysRule(state.cardsByKind.counts[0], state);
    // 31 days hold 25 windows; no history means no look-back windows.
    expect(windows).toHaveLength(25);
    for (const pref of windows) {
      expect(pref.countShiftTypes).toEqual(["ALL"]);
      expect(pref.expression).toBe("x > T");
      expect(pref.target).toBe(5);
      expect(pref.weight).toBe(REST_DAYS_WEIGHT);
      expect(pref.countDates).toHaveLength(7);
    }
    expect(windows[0].countDates).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
    ]);
    const oct = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
    expect(broken(state, "ana", [1, 2, 3, 4, 5].map(oct))).toEqual([]);
    expect(broken(state, "ana", [1, 2, 3, 4, 5, 7].map(oct))).toHaveLength(1);
  });

  it("looks back across the period start through each nurse's history", () => {
    // Worked Sep 28, 29, 30 (history, newest last); rest Oct 1, 2; work Oct 3, 4.
    const state = ward({ ana: ["OFF", "OFF", "OFF", "D", "N", "D"] });
    expect(broken(state, "ana", ["2026-10-03", "2026-10-04"])).toEqual([]);
    // Also working Oct 1 makes Sep 28 - Oct 4 six worked days.
    const six = broken(state, "ana", ["2026-10-01", "2026-10-03", "2026-10-04"]);
    expect(six).toHaveLength(1);
    expect(six[0]).toMatchObject({
      person: ["ana"],
      countDates: ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"],
      target: 2,
    });
    // Ben has no history, so nothing before Oct 1 counts for him.
    expect(broken(state, "ben", ["2026-10-01", "2026-10-03", "2026-10-04"])).toEqual([]);
  });

  it("does not count OFF or LEAVE in history as worked", () => {
    const state = ward({ ana: ["LEAVE", "LEAVE", "OFF", "LEAVE", "LEAVE", "LEAVE"] });
    const oct = (d: number) => `2026-10-0${d}`;
    expect(broken(state, "ana", [1, 2, 3, 4, 5].map(oct))).toEqual([]);
  });

  it("expands at submit, but stays one rule in the saved workspace", () => {
    const state = ward({ ana: ["D", "D", "D"] });
    const counts = toCanonicalScenarioDocument(state).preferences.filter(
      (pref) => pref.type === "shift count",
    );
    // 25 in-period windows + ana's look-back windows starting Sep 27-30 (allowance
    // 2-4 over 3-6 October days); Sep 25-26 leave 2 for 1-2 days, so cannot break.
    expect(counts).toHaveLength(29);
    expect(
      counts.some((pref) => (pref as CanonicalShiftCountPreference).countDates === "ALL"),
    ).toBe(false);

    const saved = serializeWorkspace(state);
    expect(saved.match(/type: shift count/g)).toHaveLength(1);
    expect(saved).toContain(`workspaceId: ${state.cardsByKind.counts[0].uid}`);
  });

  it("emits nothing when turned off", () => {
    const state = ward();
    state.cardsByKind.counts[0].disabled = true;
    expect(
      toCanonicalScenarioDocument(state).preferences.filter((p) => p.type === "shift count"),
    ).toEqual([]);
  });
});
