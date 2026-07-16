import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type ImportNormalizationTarget } from "@/lib/scenario";
import { createMemoryStorage, SCENARIO_PERSIST_KEY, SCENARIO_PERSIST_VERSION } from "./persistence";
import { selectIsDirty } from "./scenario-store";
import { createStateSpine } from "./spine";
import {
  drainScenarioPersist,
  flushScenarioPersist,
  hydrateScenarioStore,
  loadScenario,
  newScenario,
  resetToNewScenario,
} from "./lifecycle";
import { commitPaintGesture } from "./paint";

/** A serialized persist envelope, as zustand's `createJSONStorage` writes it. */
function envelope(state: unknown, version: number): Record<string, string> {
  return { [SCENARIO_PERSIST_KEY]: JSON.stringify({ state, version }) };
}

describe("hydration lifecycle", () => {
  it("reload restores the saved scenario, clears history, and is clean", async () => {
    const mem = createMemoryStorage();

    const first = createStateSpine({ createStorage: () => mem });
    await hydrateScenarioStore(first.scenario, first.hot);
    first.scenario.getState().mutateScenario({ rangeStart: "2026-02-01", rangeEnd: "2026-02-28" });
    first.scenario.getState().markSaved();
    await drainScenarioPersist(first.scenario);

    const reloaded = createStateSpine({ createStorage: () => mem });
    await hydrateScenarioStore(reloaded.scenario, reloaded.hot);

    expect(reloaded.scenario.getState().rangeStart).toBe("2026-02-01");
    expect(reloaded.hot.getState().hydrationStatus).toBe("ready");
    expect(reloaded.scenario.temporal.getState().pastStates.length).toBe(0);
    expect(selectIsDirty(reloaded.scenario.getState())).toBe(false);

    reloaded.scenario.getState().mutateScenario({ rangeStart: "2026-03-01" });
    expect(reloaded.scenario.temporal.getState().pastStates.length).toBe(1);
  });

  it("distinguishes restored-unsaved from clean via the persisted baseline", async () => {
    const mem = createMemoryStorage();

    const first = createStateSpine({ createStorage: () => mem });
    await hydrateScenarioStore(first.scenario, first.hot);
    first.scenario.getState().mutateScenario({ rangeStart: "2026-01-01" });
    first.scenario.getState().markSaved(); // baseline = fingerprint(S0)
    await drainScenarioPersist(first.scenario);
    first.scenario.getState().mutateScenario({ rangeStart: "2026-06-01" }); // edit to S1, NOT saved
    await drainScenarioPersist(first.scenario);

    const reloaded = createStateSpine({ createStorage: () => mem });
    await hydrateScenarioStore(reloaded.scenario, reloaded.hot);

    expect(reloaded.scenario.getState().rangeStart).toBe("2026-06-01");
    expect(selectIsDirty(reloaded.scenario.getState())).toBe(true);
  });

  it("a fresh store (no persisted record) hydrates ready and clean", async () => {
    const spine = createStateSpine({ createStorage: () => createMemoryStorage() });
    await hydrateScenarioStore(spine.scenario, spine.hot);

    expect(spine.hot.getState().hydrationStatus).toBe("ready");
    expect(spine.scenario.getState().baselineFingerprint).not.toBeNull();
    expect(selectIsDirty(spine.scenario.getState())).toBe(false);
  });

  it("runs the persistence migration on an older payload", async () => {
    const cell = { kind: "leave", person: "p1", date: "2026-01-01" };
    const mem = createMemoryStorage(envelope({ requests: [cell], rangeStart: "2026-01-01" }, 0));
    const spine = createStateSpine({ createStorage: () => mem });

    await hydrateScenarioStore(spine.scenario, spine.hot);

    expect(spine.hot.getState().hydrationStatus).toBe("ready");
    expect(spine.scenario.getState().reqData).toEqual([cell]);
    expect(spine.scenario.getState().rangeStart).toBe("2026-01-01");
    expect(spine.scenario.getState().exportLayout).toEqual({
      formatting: [],
      extraColumns: [],
      extraRows: [],
    });
  });

  it("recovers from a corrupt (unparseable) record, then user-resets", async () => {
    const mem = createMemoryStorage({ [SCENARIO_PERSIST_KEY]: "{{{ not valid json" });
    const spine = createStateSpine({ createStorage: () => mem });

    await hydrateScenarioStore(spine.scenario, spine.hot);
    expect(spine.hot.getState().hydrationStatus).toBe("recoverable-error");
    // zundo recovered (not stranded paused): tracking is on again.
    expect(spine.scenario.temporal.getState().isTracking).toBe(true);

    await resetToNewScenario(spine.scenario, spine.hot);
    await drainScenarioPersist(spine.scenario);
    expect(spine.hot.getState().hydrationStatus).toBe("ready");
    expect(spine.scenario.getState().staff).toEqual([]);
    expect(selectIsDirty(spine.scenario.getState())).toBe(false);

    const stored = mem.snapshot()[SCENARIO_PERSIST_KEY];
    expect(stored).toBeDefined();
    expect(() => JSON.parse(stored)).not.toThrow();
    expect(JSON.parse(stored).state.staff).toEqual([]);
  });

  it("recovers from a parseable-but-malformed payload without clobbering live state", async () => {
    const mem = createMemoryStorage(envelope({ reqData: "not an array" }, 1));
    const spine = createStateSpine({ createStorage: () => mem });

    await hydrateScenarioStore(spine.scenario, spine.hot);

    expect(spine.hot.getState().hydrationStatus).toBe("recoverable-error");
    // The malformed payload was NOT spread into live state; actions survive.
    expect(typeof spine.scenario.getState().mutateScenario).toBe("function");
    expect(spine.scenario.getState().reqData).toEqual([]);
  });

  it("nested malformed payloads leave no state applied and resume tracking", async () => {
    for (const payload of [
      { meta: {} },
      { cardsByKind: {} },
      { exportLayout: {} },
      { staff: [null] },
      { reqData: [{ kind: "leave" }] },
      { staffGroups: [{ id: "g1" }] },
      { meta: { apiVersion: "alpha" }, cardsByKind: { requirements: [{ weight: 1 }] } },
    ]) {
      const mem = createMemoryStorage(envelope(payload, 1));
      const spine = createStateSpine({ createStorage: () => mem });

      await hydrateScenarioStore(spine.scenario, spine.hot);

      expect(spine.hot.getState().hydrationStatus).toBe("recoverable-error");
      // Full pre-hydration live state unchanged: still the empty default.
      expect(spine.scenario.getState().staff).toEqual([]);
      expect(spine.scenario.getState().reqData).toEqual([]);
      expect(spine.scenario.getState().meta).toEqual({ apiVersion: "alpha" });
      expect(spine.scenario.getState().baselineFingerprint).toBeNull();
      // Actions survived.
      expect(typeof spine.scenario.getState().mutateScenario).toBe("function");
      // zundo resumed (not stranded paused).
      expect(spine.scenario.temporal.getState().isTracking).toBe(true);
    }
  });

  it("rejects an explicit null state as corrupt and resumes tracking", async () => {
    const mem = createMemoryStorage(envelope(null, 1));
    const spine = createStateSpine({ createStorage: () => mem });

    await hydrateScenarioStore(spine.scenario, spine.hot);

    expect(spine.hot.getState().hydrationStatus).toBe("recoverable-error");
    expect(spine.scenario.getState().reqData).toEqual([]);
    expect(spine.scenario.temporal.getState().isTracking).toBe(true);
  });

  it("a uid-only requirement card routes to recoverable-error with live state unchanged", async () => {
    const payload = {
      cardsByKind: {
        requirements: [{ uid: "r1" }],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    };
    const record = envelope(payload, 1);
    const mem = createMemoryStorage(record);
    const spine = createStateSpine({ createStorage: () => mem });

    await hydrateScenarioStore(spine.scenario, spine.hot);

    expect(spine.hot.getState().hydrationStatus).toBe("recoverable-error");
    expect(spine.scenario.getState().staff).toEqual([]);
    expect(spine.scenario.getState().reqData).toEqual([]);
    expect(spine.scenario.getState().meta).toEqual({ apiVersion: "alpha" });
    expect(spine.scenario.getState().baselineFingerprint).toBeNull();
    expect(typeof spine.scenario.getState().mutateScenario).toBe("function");
    expect(spine.scenario.temporal.getState().isTracking).toBe(true);
    expect(mem.snapshot()[SCENARIO_PERSIST_KEY]).toBe(record[SCENARIO_PERSIST_KEY]);
  });

  it("an empty formatting-rule object routes to recoverable-error with live state unchanged", async () => {
    const payload = {
      exportLayout: { formatting: [{}], extraColumns: [], extraRows: [] },
    };
    const record = envelope(payload, 1);
    const mem = createMemoryStorage(record);
    const spine = createStateSpine({ createStorage: () => mem });

    await hydrateScenarioStore(spine.scenario, spine.hot);

    expect(spine.hot.getState().hydrationStatus).toBe("recoverable-error");
    expect(spine.scenario.getState().staff).toEqual([]);
    expect(spine.scenario.getState().reqData).toEqual([]);
    expect(spine.scenario.getState().meta).toEqual({ apiVersion: "alpha" });
    expect(spine.scenario.getState().baselineFingerprint).toBeNull();
    expect(typeof spine.scenario.getState().mutateScenario).toBe("function");
    expect(spine.scenario.temporal.getState().isTracking).toBe(true);
    expect(mem.snapshot()[SCENARIO_PERSIST_KEY]).toBe(record[SCENARIO_PERSIST_KEY]);
  });

  it("deeply nested corrupt payloads (round-4 gaps) route to recoverable-error with live state + record preserved", async () => {
    const emptyCards = {
      requirements: [],
      successions: [],
      counts: [],
      affinities: [],
      coverings: [],
    };
    const emptyLayout = { formatting: [], extraColumns: [], extraRows: [] };
    const validCount = {
      uid: "x",
      person: "p1",
      countDates: [],
      countShiftTypes: [],
      expression: "",
      target: 1,
      weight: 1,
    };

    for (const [name, payload] of [
      [
        "coefficient entry[0] non-string",
        {
          exportLayout: {
            ...emptyLayout,
            extraColumns: [
              {
                type: "count",
                header: "C",
                countShiftTypes: [],
                countDates: [],
                countShiftTypeCoefficients: [[{}, 1]],
              },
            ],
          },
        },
      ],
      [
        "number in nested shift-type list",
        {
          cardsByKind: {
            ...emptyCards,
            successions: [{ uid: "s1", person: "p1", pattern: [1], weight: 1 }],
          },
        },
      ],
      [
        "numeric count-card countShiftTypes",
        {
          cardsByKind: { ...emptyCards, counts: [{ ...validCount, countShiftTypes: [1] }] },
        },
      ],
      [
        "export people array with {} element",
        {
          exportLayout: {
            ...emptyLayout,
            formatting: [{ type: "cell", people: [{}], dates: [], shiftTypes: [] }],
          },
        },
      ],
      [
        "ordinary count with policy",
        {
          cardsByKind: { ...emptyCards, counts: [{ ...validCount, policy: "exact" }] },
        },
      ],
      [
        "contracted-hours count with non-string unit",
        {
          cardsByKind: {
            ...emptyCards,
            counts: [{ ...validCount, tag: "contracted_hours", policy: "exact", unit: 42 }],
          },
        },
      ],
      ["staff entity with non-string _k", { staff: [{ id: "p1", _k: 42 }] }],
      [
        "export formatting rule with non-string description",
        {
          exportLayout: {
            ...emptyLayout,
            formatting: [{ type: "row", people: [], description: 7 }],
          },
        },
      ],
      [
        "reqData cell with non-string uid",
        {
          reqData: [{ kind: "off", person: "p1", date: "d1", weight: 1, uid: 5 }],
        },
      ],
    ] as const) {
      const record = envelope(payload, 1);
      const mem = createMemoryStorage(record);
      const spine = createStateSpine({ createStorage: () => mem });

      await hydrateScenarioStore(spine.scenario, spine.hot);

      expect(spine.hot.getState().hydrationStatus, name).toBe("recoverable-error");
      expect(spine.scenario.getState().staff, name).toEqual([]);
      expect(spine.scenario.getState().reqData, name).toEqual([]);
      expect(spine.scenario.getState().meta, name).toEqual({ apiVersion: "alpha" });
      expect(spine.scenario.getState().baselineFingerprint, name).toBeNull();
      expect(typeof spine.scenario.getState().mutateScenario, name).toBe("function");
      expect(spine.scenario.temporal.getState().isTracking, name).toBe(true);
      expect(mem.snapshot()[SCENARIO_PERSIST_KEY], name).toBe(record[SCENARIO_PERSIST_KEY]);
    }
  });

  it("refuses a future-version record and leaves it intact (no downgrade)", async () => {
    const record = envelope({ reqData: [] }, SCENARIO_PERSIST_VERSION + 1);
    const mem = createMemoryStorage(record);
    const spine = createStateSpine({ createStorage: () => mem });

    await hydrateScenarioStore(spine.scenario, spine.hot);

    expect(spine.hot.getState().hydrationStatus).toBe("recoverable-error");
    // The newer record is preserved byte-for-byte — not rewritten at v1.
    expect(mem.snapshot()[SCENARIO_PERSIST_KEY]).toBe(record[SCENARIO_PERSIST_KEY]);
  });

  it("a pre-hydration edit cannot clobber the saved record (ready gate)", async () => {
    const record = envelope({ rangeStart: "2026-05-05" }, SCENARIO_PERSIST_VERSION);
    const mem = createMemoryStorage(record);
    const spine = createStateSpine({ createStorage: () => mem });

    // Edit attempted before manual rehydrate — the gate must refuse it.
    spine.scenario.getState().mutateScenario({ rangeStart: "2099-01-01" });
    await drainScenarioPersist(spine.scenario);
    expect(mem.snapshot()[SCENARIO_PERSIST_KEY]).toBe(record[SCENARIO_PERSIST_KEY]);

    await hydrateScenarioStore(spine.scenario, spine.hot);
    expect(spine.scenario.getState().rangeStart).toBe("2026-05-05");
  });
});

describe("Load / New lifecycle", () => {
  it("New resets every slice, clears history, and resets the baseline", async () => {
    const spine = createStateSpine({ createStorage: () => createMemoryStorage() });
    await hydrateScenarioStore(spine.scenario, spine.hot);

    spine.scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    expect(spine.scenario.temporal.getState().pastStates.length).toBe(1);

    newScenario(spine.scenario, spine.hot);

    expect(spine.scenario.getState().rangeStart).toBe("");
    expect(spine.scenario.getState().staff).toEqual([]);
    expect(spine.scenario.temporal.getState().pastStates.length).toBe(0);
    expect(selectIsDirty(spine.scenario.getState())).toBe(false);
  });

  it("Load replaces state, assigns card identity, clears history, and is clean", async () => {
    const spine = createStateSpine({ createStorage: () => createMemoryStorage() });
    await hydrateScenarioStore(spine.scenario, spine.hot);
    spine.scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });

    const target: ImportNormalizationTarget = {
      ...createEmptyScenarioUiState(),
      rangeStart: "2026-09-01",
      cardsByKind: {
        requirements: [{ shiftType: "D", requiredNumPeople: 2, weight: Infinity }],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    };

    loadScenario(spine.scenario, spine.hot, target);

    expect(spine.scenario.getState().rangeStart).toBe("2026-09-01");
    expect(spine.scenario.getState().cardsByKind.requirements).toHaveLength(1);
    expect(typeof spine.scenario.getState().cardsByKind.requirements[0].uid).toBe("string");
    expect(spine.scenario.temporal.getState().pastStates.length).toBe(0);
    expect(selectIsDirty(spine.scenario.getState())).toBe(false);
  });

  it("Load/New reset the hot store so a staged paint from A cannot commit into B", async () => {
    const spine = createStateSpine({ createStorage: () => createMemoryStorage() });
    await hydrateScenarioStore(spine.scenario, spine.hot);

    // Scenario A: stage a paint gesture and some run progress.
    spine.hot.getState().pushProgress({ progress: 0.5 });
    spine.hot.getState().beginPaint();
    spine.hot
      .getState()
      .stagePaintCell("p1", "2026-01-01", { kind: "leave", person: "p1", date: "2026-01-01" });

    // Load scenario B.
    loadScenario(spine.scenario, spine.hot, {
      ...createEmptyScenarioUiState(),
      rangeStart: "2026-12-01",
    });

    expect(spine.hot.getState().paint).toBeNull();
    expect(spine.hot.getState().progress).toEqual([]);

    // The stale gesture cannot commit into B.
    commitPaintGesture(spine.scenario, spine.hot);
    await drainScenarioPersist(spine.scenario);
    expect(spine.scenario.getState().reqData).toEqual([]);
  });
});

describe("pagehide flush", () => {
  it("forces a persist write of the current state without a history entry", async () => {
    const mem = createMemoryStorage();
    const spine = createStateSpine({ createStorage: () => mem });
    await hydrateScenarioStore(spine.scenario, spine.hot);

    spine.scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    await drainScenarioPersist(spine.scenario);
    const entriesBefore = spine.scenario.temporal.getState().pastStates.length;

    flushScenarioPersist(spine.scenario);
    await drainScenarioPersist(spine.scenario);

    expect(mem.snapshot()[SCENARIO_PERSIST_KEY]).toContain("2026-02-01");
    expect(spine.scenario.temporal.getState().pastStates.length).toBe(entriesBefore);
  });

  it("a pre-hydration flush preserves the seeded saved record byte-for-byte", async () => {
    const seed = envelope({ rangeStart: "2026-05-05", meta: { apiVersion: "alpha" } }, 1);
    const mem = createMemoryStorage(seed);
    const spine = createStateSpine({ createStorage: () => mem });

    // Store is still unhydrated — flush must be a no-op.
    expect(spine.hot.getState().hydrationStatus).toBe("unhydrated");
    flushScenarioPersist(spine.scenario);
    await drainScenarioPersist(spine.scenario);

    // The seeded record is untouched.
    expect(mem.snapshot()[SCENARIO_PERSIST_KEY]).toBe(seed[SCENARIO_PERSIST_KEY]);

    // After hydration, the seed is still intact and readable.
    await hydrateScenarioStore(spine.scenario, spine.hot);
    expect(spine.scenario.getState().rangeStart).toBe("2026-05-05");
  });

  it("a post-future-version-rejection flush preserves the record byte-for-byte", async () => {
    const record = envelope({ reqData: [] }, SCENARIO_PERSIST_VERSION + 1);
    const mem = createMemoryStorage(record);
    const spine = createStateSpine({ createStorage: () => mem });

    await hydrateScenarioStore(spine.scenario, spine.hot);
    expect(spine.hot.getState().hydrationStatus).toBe("recoverable-error");

    // Flush in the recoverable-error state must be a no-op.
    flushScenarioPersist(spine.scenario);
    await drainScenarioPersist(spine.scenario);

    expect(mem.snapshot()[SCENARIO_PERSIST_KEY]).toBe(record[SCENARIO_PERSIST_KEY]);
  });
});
