import { beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryStorage,
  SCENARIO_PERSIST_KEY,
  SCENARIO_PERSIST_VERSION,
  type MemoryStateStorage,
} from "./persistence";
import {
  createScenarioStore,
  decodeNonFiniteNumbers,
  encodeNonFiniteNumbers,
  NON_FINITE_PERSIST_TAG,
  selectBackupStatus,
} from "./scenario-store";
import { createStateSpine, type StateSpine } from "./spine";
import { drainScenarioPersist, hydrateScenarioStore } from "./lifecycle";

/** A spine hydrated to `ready` over fresh in-memory storage. */
async function readySpine(): Promise<StateSpine> {
  const spine = createStateSpine({ createStorage: () => createMemoryStorage() });
  await hydrateScenarioStore(spine.scenario, spine.hot);
  return spine;
}

function temporal(store: StateSpine["scenario"]) {
  return store.temporal.getState();
}

describe("durable scenario store — undo/redo", () => {
  let spine: StateSpine;
  beforeEach(async () => {
    spine = await readySpine();
  });

  it("restores the scenario slice on undo and reapplies on redo", () => {
    const { scenario } = spine;
    expect(scenario.getState().rangeStart).toBe("");

    scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    expect(scenario.getState().rangeStart).toBe("2026-02-01");
    expect(temporal(scenario).pastStates.length).toBe(1);

    temporal(scenario).undo();
    expect(scenario.getState().rangeStart).toBe("");

    temporal(scenario).redo();
    expect(scenario.getState().rangeStart).toBe("2026-02-01");
  });

  it("backup freshness reacts to a disabled-only change (normalized Workspace fingerprint)", () => {
    // T17r review P1 #139: the fingerprint hashes the Workspace projection, which
    // preserves authoring metadata the strict projection strips — so an enable/
    // disable edit makes the backup stale, unlike the old strict-projection hash.
    const { scenario } = spine;
    scenario.getState().mutateScenario({
      cardsByKind: {
        requirements: [{ uid: "r1", shiftType: "D", requiredNumPeople: 1, weight: -1 }],
        successions: [],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
    scenario.getState().recordBackup();
    expect(selectBackupStatus(scenario.getState())).toBe("current");

    scenario.getState().mutateScenario((state) => ({
      cardsByKind: {
        ...state.cardsByKind,
        requirements: state.cardsByKind.requirements.map((card) => ({ ...card, disabled: true })),
      },
    }));
    expect(selectBackupStatus(scenario.getState())).toBe("stale");
  });

  it("records only the scenario slice — never the backup fingerprint or action functions", () => {
    const { scenario } = spine;
    scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });

    const snapshot = temporal(scenario).pastStates[0] as Record<string, unknown>;
    expect("backupFingerprint" in snapshot).toBe(false);
    expect("mutateScenario" in snapshot).toBe(false);
    expect(typeof snapshot.reqData).toBe("object");
  });

  it("does not add a history entry for recording a backup (fingerprint-only change)", () => {
    const { scenario } = spine;
    scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    const before = temporal(scenario).pastStates.length;

    scenario.getState().recordBackup();

    expect(temporal(scenario).pastStates.length).toBe(before);
  });
});

describe("durable scenario store — backup currentness", () => {
  it("is current at the recorded backup and stale after an edit", async () => {
    const { scenario } = await readySpine();
    scenario.getState().recordBackup();
    expect(selectBackupStatus(scenario.getState())).toBe("current");

    scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    expect(selectBackupStatus(scenario.getState())).toBe("stale");

    scenario.getState().recordBackup();
    expect(selectBackupStatus(scenario.getState())).toBe("current");
  });

  it("backup → edit → undo-to-backup returns to current", async () => {
    const { scenario } = await readySpine();
    scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    scenario.getState().recordBackup();
    expect(selectBackupStatus(scenario.getState())).toBe("current");

    scenario.getState().mutateScenario({ rangeStart: "2026-03-01" });
    expect(selectBackupStatus(scenario.getState())).toBe("stale");

    temporal(scenario).undo();
    expect(scenario.getState().rangeStart).toBe("2026-02-01");
    expect(selectBackupStatus(scenario.getState())).toBe("current");
  });
});

// ---------------------------------------------------------------------------
// The non-finite weight codec at the JSON persistence boundary.
//
// `Weight` admits ±Infinity for a hard constraint and the product exposes both
// signs, but native `JSON.stringify` emits `null` for a non-finite number — so
// every hard weight used to reach IndexedDB as `null`, be rejected by the
// sanitizer on the next load, and take the whole app to the destructive
// "Stored data could not be loaded" state. These are the tests that discriminate
// that failure: the pre-existing hard-weight coverage stops at the in-memory
// store and never crosses the serialization seam.
// ---------------------------------------------------------------------------

/** Round-trip a value through the real codec, exactly as `createJSONStorage` does. */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, encodeNonFiniteNumbers), decodeNonFiniteNumbers);
}

/** Serialize with the codec only, to inspect the bytes that reach storage. */
function encoded(value: unknown): string {
  return JSON.stringify(value, encodeNonFiniteNumbers);
}

describe("non-finite weight codec — encode", () => {
  it("tags each infinity with its own sign instead of emitting null", () => {
    expect(encoded({ weight: Infinity })).toBe(
      `{"weight":{"${NON_FINITE_PERSIST_TAG}":"Infinity"}}`,
    );
    expect(encoded({ weight: -Infinity })).toBe(
      `{"weight":{"${NON_FINITE_PERSIST_TAG}":"-Infinity"}}`,
    );
    // The defect itself, named: plain stringify loses both signs to one null.
    expect(JSON.stringify({ weight: -Infinity })).toBe(`{"weight":null}`);
  });

  it("leaves every finite number exactly as it was", () => {
    for (const weight of [0, 1, -1, 25, -25, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(encoded({ weight }), String(weight)).toBe(JSON.stringify({ weight }));
      expect(roundTrip({ weight }), String(weight)).toEqual({ weight });
    }
    // `-0` is excluded above on purpose: JSON itself has no negative zero, so
    // plain stringify already flattens it. That is not the codec's doing, and a
    // signed zero is not a distinguishable Weight — recorded here rather than
    // hidden by omission.
    expect(JSON.stringify({ weight: -0 })).toBe(`{"weight":0}`);
    expect(encoded({ weight: -0 })).toBe(`{"weight":0}`);
  });

  it("deliberately does NOT encode NaN, so it keeps failing closed at the sanitizer", () => {
    // NaN is not a representable Weight. Encoding it would carry a corrupt value
    // PAST the gate that exists to catch it, so it still serializes to null.
    expect(encoded({ weight: Number.NaN })).toBe(`{"weight":null}`);
    expect(roundTrip({ weight: Number.NaN })).toEqual({ weight: null });
  });

  it("reaches infinities nested anywhere in the payload", () => {
    const state = {
      cardsByKind: {
        successions: [{ uid: "s1", weight: -Infinity }],
        coverings: [{ uid: "v1", weight: Infinity }],
      },
      reqData: [{ kind: "request", weight: Infinity }],
    };
    expect(roundTrip(state)).toEqual(state);
    expect(encoded(state)).not.toContain("null");
  });
});

describe("non-finite weight codec — decode", () => {
  it("restores each sign as an exact numeric infinity, not a string or a finite", () => {
    const positive = roundTrip({ weight: Infinity }) as { weight: number };
    const negative = roundTrip({ weight: -Infinity }) as { weight: number };

    expect(positive.weight).toBe(Number.POSITIVE_INFINITY);
    expect(negative.weight).toBe(Number.NEGATIVE_INFINITY);
    expect(typeof positive.weight).toBe("number");
    expect(Number.isFinite(negative.weight)).toBe(false);
    // The sign is the whole point: a hard "never" must not become a hard "always".
    expect(negative.weight).not.toBe(Number.POSITIVE_INFINITY);
  });

  it("preserves strings that merely resemble the markers", () => {
    // Encoding only ever wraps a NUMBER, so authored text is never a marker —
    // including the envelope's own JSON text stored as a description.
    const authored = {
      description: "Infinity",
      other: "-Infinity",
      literal: `{"${NON_FINITE_PERSIST_TAG}":"Infinity"}`,
      tagName: NON_FINITE_PERSIST_TAG,
    };
    expect(roundTrip(authored)).toEqual(authored);
  });

  it("passes through an ordinary persisted envelope untouched", () => {
    // Backward compatibility: a record written before the codec existed contains
    // no tag, so decoding is a no-op and no migration or version bump is needed.
    const legacy = {
      state: { rangeStart: "2026-02-01", cardsByKind: { successions: [{ weight: -1 }] } },
      version: SCENARIO_PERSIST_VERSION,
    };
    expect(JSON.parse(JSON.stringify(legacy), decodeNonFiniteNumbers)).toEqual(legacy);
  });

  it("never infers a sign for an already-corrupted null", () => {
    // A legacy record's null lost its sign irrecoverably. Guessing one would
    // silently invent a hard constraint in a ward's roster.
    expect(roundTrip({ weight: null })).toEqual({ weight: null });
  });

  it.each([
    ["an unknown tag payload", `{"weight":{"${NON_FINITE_PERSIST_TAG}":"inf"}}`],
    ["a numeric tag payload", `{"weight":{"${NON_FINITE_PERSIST_TAG}":1}}`],
    ["a null tag payload", `{"weight":{"${NON_FINITE_PERSIST_TAG}":null}}`],
    ["a tag carrying passengers", `{"weight":{"${NON_FINITE_PERSIST_TAG}":"Infinity","x":1}}`],
    [
      "a malformed tag inside the infinity-tolerant list",
      `{"weightRange":[{"${NON_FINITE_PERSIST_TAG}":"NaN"}]}`,
    ],
  ])("fails closed on %s rather than guessing", (_label, json) => {
    expect(() => JSON.parse(json, decodeNonFiniteNumbers)).toThrow(/malformed/i);
  });

  it("leaves ordinary objects and arrays alone", () => {
    const payload = { meta: { apiVersion: "alpha" }, list: [1, "two", null, { a: 1 }] };
    expect(roundTrip(payload)).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Field scope. "Non-finite" is a property of the DOMAIN a value sits in, not of
// the payload — so the codec is scoped to the positions the producer/import
// schemas actually allow a signed infinity in. A global codec revived a forged
// tag under `requiredNumPeople` into numeric Infinity, which the sanitizer's
// generic `typeof number` check then accepted, hydrating a state the schema
// forbids.
// ---------------------------------------------------------------------------

/** Every finite-only numeric field the durable slice actually carries. */
const FINITE_ONLY_FIELDS = [
  "requiredNumPeople",
  "preferredNumPeople",
  "target",
  "durationMinutes",
  "restMinutes",
  "id",
];

describe("non-finite weight codec — field scope", () => {
  it("decodes a tag only where the schema admits a signed infinity", () => {
    // The two approved positions, from the audit of the persisted slice.
    expect(roundTrip({ weight: -Infinity })).toEqual({ weight: -Infinity });
    expect(roundTrip({ weightRange: [-Infinity, 0, Infinity] })).toEqual({
      weightRange: [-Infinity, 0, Infinity],
    });
  });

  it.each(FINITE_ONLY_FIELDS)("refuses a tag at the finite-only field %s", (field) => {
    const json = `{"${field}":{"${NON_FINITE_PERSIST_TAG}":"Infinity"},"weight":-1}`;
    // Refused, not revived: the whole payload is rejected rather than hydrating a
    // domain-invalid value beside a perfectly valid weight.
    expect(() => JSON.parse(json, decodeNonFiniteNumbers)).toThrow(/finite-only/i);
  });

  it("never ENCODES an infinity outside an approved position", () => {
    // The app can therefore never author a tag into a finite-only slot. The value
    // still becomes `null` and is still refused by the sanitizer on the next load
    // — identical to the behaviour before the codec existed.
    expect(encoded({ requiredNumPeople: Infinity })).toBe(`{"requiredNumPeople":null}`);
    expect(encoded({ target: [Infinity, 2] })).toBe(`{"target":[null,2]}`);
    expect(encoded({ weight: Infinity })).toContain(NON_FINITE_PERSIST_TAG);
    expect(encoded({ weightRange: [Infinity] })).toContain(NON_FINITE_PERSIST_TAG);
  });

  it("leaves a tag inside a NON-approved numeric array for the sanitizer to refuse", () => {
    // `JSON.parse` walks bottom-up, so an array element is passed over and judged
    // by its parent. `target` is not an approved list, so the element stays an
    // object — which `sanitizePersistedScenario` rejects where it requires a
    // number (proven end-to-end in the lifecycle suite below). The codec does not
    // guess either way.
    const decoded = JSON.parse(
      `{"target":[{"${NON_FINITE_PERSIST_TAG}":"Infinity"}]}`,
      decodeNonFiniteNumbers,
    ) as { target: unknown[] };
    expect(typeof decoded.target[0]).toBe("object");
    expect(decoded.target[0]).not.toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps the approved-list decode working through the real array-holder walk", () => {
    // The element visit is skipped via `Array.isArray(this)` — `JSON.parse` binds
    // the reviver's `this` to the holder. Pinned here because if that binding ever
    // stopped working, a legitimate infinite bound would start failing closed.
    const json = `{"weightRange":[{"${NON_FINITE_PERSIST_TAG}":"-Infinity"},3]}`;
    expect(JSON.parse(json, decodeNonFiniteNumbers)).toEqual({
      weightRange: [Number.NEGATIVE_INFINITY, 3],
    });
  });

  it("mutation proof — the previous GLOBAL reviver revived the wrong-field tag", () => {
    // The exact reviver this fixup replaced, reproduced here so the delta is a
    // fact in the suite rather than a claim in a commit message.
    const priorGlobalReviver = (_key: string, value: unknown): unknown => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
      if (!Object.prototype.hasOwnProperty.call(value, NON_FINITE_PERSIST_TAG)) return value;
      const envelope = value as Record<string, unknown>;
      if (Object.keys(envelope).length === 1) {
        if (envelope[NON_FINITE_PERSIST_TAG] === "Infinity") return Number.POSITIVE_INFINITY;
        if (envelope[NON_FINITE_PERSIST_TAG] === "-Infinity") return Number.NEGATIVE_INFINITY;
      }
      throw new Error("malformed");
    };

    const forged = `{"requiredNumPeople":{"${NON_FINITE_PERSIST_TAG}":"Infinity"},"weight":-1}`;

    // Before: a finite-only field silently became numeric Infinity.
    expect(
      (JSON.parse(forged, priorGlobalReviver) as { requiredNumPeople: number }).requiredNumPeople,
    ).toBe(Number.POSITIVE_INFINITY);
    // After: refused.
    expect(() => JSON.parse(forged, decodeNonFiniteNumbers)).toThrow(/finite-only/i);
    // ...and the valid weight beside it is still decodable on its own.
    expect(roundTrip({ weight: -1 })).toEqual({ weight: -1 });
  });
});

describe("durable store — signed hard weights survive a real reload", () => {
  /** Seed one succession card carrying `weight`, through a tracked mutation. */
  function writeSuccession(spine: StateSpine, weight: number) {
    spine.scenario.getState().mutateScenario({
      rangeStart: "2026-02-01",
      cardsByKind: {
        requirements: [],
        successions: [{ uid: "s1", person: ["P1"], pattern: ["N", "D"], weight }],
        counts: [],
        affinities: [],
        coverings: [],
      },
    });
  }

  async function persistThenReload(mem: MemoryStateStorage, weight: number) {
    const first = createStateSpine({ createStorage: () => mem });
    await hydrateScenarioStore(first.scenario, first.hot);
    writeSuccession(first, weight);
    await drainScenarioPersist(first.scenario);

    const reloaded = createStateSpine({ createStorage: () => mem });
    await hydrateScenarioStore(reloaded.scenario, reloaded.hot);
    return reloaded;
  }

  it.each([
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["+Infinity", Number.POSITIVE_INFINITY],
  ])("round-trips a %s hard weight without corrupting the record", async (_label, weight) => {
    const mem = createMemoryStorage();
    const reloaded = await persistThenReload(mem, weight);

    // What actually reached storage: the tagged envelope, never `null`.
    const stored = mem.snapshot()[SCENARIO_PERSIST_KEY];
    expect(stored).toContain(NON_FINITE_PERSIST_TAG);
    expect(stored).not.toContain(`"weight":null`);

    // ...and what came back: the same numeric value, with its sign.
    expect(reloaded.scenario.getState().cardsByKind.successions[0].weight).toBe(weight);
    // The app is usable, not sitting on the destructive reset offer.
    expect(reloaded.hot.getState().hydrationStatus).toBe("ready");
    // The rest of the scenario came back with it.
    expect(reloaded.scenario.getState().rangeStart).toBe("2026-02-01");
  });

  it("keeps a hard weight across a second edit-and-reload cycle", async () => {
    const mem = createMemoryStorage();
    const reloaded = await persistThenReload(mem, Number.NEGATIVE_INFINITY);

    // A decoded infinity is a real number again, so the next write re-encodes it
    // rather than double-wrapping or degrading it.
    reloaded.scenario.getState().mutateScenario({ rangeEnd: "2026-02-28" });
    await drainScenarioPersist(reloaded.scenario);

    const third = createStateSpine({ createStorage: () => mem });
    await hydrateScenarioStore(third.scenario, third.hot);
    expect(third.scenario.getState().cardsByKind.successions[0].weight).toBe(
      Number.NEGATIVE_INFINITY,
    );
    expect(third.scenario.getState().rangeEnd).toBe("2026-02-28");
    expect(third.hot.getState().hydrationStatus).toBe("ready");
  });

  it("switches sign through the store and persists the NEW sign", async () => {
    const mem = createMemoryStorage();
    const spine = createStateSpine({ createStorage: () => mem });
    await hydrateScenarioStore(spine.scenario, spine.hot);

    writeSuccession(spine, Number.NEGATIVE_INFINITY);
    writeSuccession(spine, Number.POSITIVE_INFINITY);
    await drainScenarioPersist(spine.scenario);

    // Newest-wins through the guarded FIFO queue, unchanged by the codec.
    expect(mem.snapshot()[SCENARIO_PERSIST_KEY]).toContain(
      `"${NON_FINITE_PERSIST_TAG}":"Infinity"`,
    );

    const reloaded = createStateSpine({ createStorage: () => mem });
    await hydrateScenarioStore(reloaded.scenario, reloaded.hot);
    expect(reloaded.scenario.getState().cardsByKind.successions[0].weight).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("still fails closed on a legacy null weight, offering recovery rather than a guess", async () => {
    const mem = createMemoryStorage({
      [SCENARIO_PERSIST_KEY]: JSON.stringify({
        state: {
          cardsByKind: {
            requirements: [],
            successions: [{ uid: "s1", person: ["P1"], pattern: ["N", "D"], weight: null }],
            counts: [],
            affinities: [],
            coverings: [],
          },
        },
        version: SCENARIO_PERSIST_VERSION,
      }),
    });

    const spine = createStateSpine({ createStorage: () => mem });
    await hydrateScenarioStore(spine.scenario, spine.hot);

    expect(spine.hot.getState().hydrationStatus).toBe("recoverable-error");
    expect(spine.scenario.getState().cardsByKind.successions).toEqual([]);
  });

  it("routes a malformed tagged envelope to the same recoverable-error contract", async () => {
    const mem = createMemoryStorage({
      [SCENARIO_PERSIST_KEY]: JSON.stringify({
        state: {
          cardsByKind: {
            requirements: [],
            successions: [
              {
                uid: "s1",
                person: ["P1"],
                pattern: ["N", "D"],
                weight: { [NON_FINITE_PERSIST_TAG]: "probably-negative" },
              },
            ],
            counts: [],
            affinities: [],
            coverings: [],
          },
        },
        version: SCENARIO_PERSIST_VERSION,
      }),
    });

    const spine = createStateSpine({ createStorage: () => mem });
    await hydrateScenarioStore(spine.scenario, spine.hot);

    // The decode throws inside `getItem`, which persist's hydrate chain reports
    // through `onRehydrateStorage` — the same path a malformed field already uses.
    expect(spine.hot.getState().hydrationStatus).toBe("recoverable-error");
    // Crucially: the corrupt record is NOT rewritten, so recovery is still a choice.
    expect(mem.snapshot()[SCENARIO_PERSIST_KEY]).toContain("probably-negative");
  });
});

describe("durable store — a tag only revives where the schema allows one", () => {
  const TAGGED_POSITIVE = { [NON_FINITE_PERSIST_TAG]: "Infinity" };

  /** A CURRENT-version (v6) record, so nothing here depends on the migrator. */
  function currentRecord(state: Record<string, unknown>) {
    return createMemoryStorage({
      [SCENARIO_PERSIST_KEY]: JSON.stringify({ state, version: SCENARIO_PERSIST_VERSION }),
    });
  }

  function emptyCards(overrides: Record<string, unknown> = {}) {
    return {
      requirements: [],
      successions: [],
      counts: [],
      affinities: [],
      coverings: [],
      ...overrides,
    };
  }

  async function hydrateOver(mem: MemoryStateStorage) {
    const spine = createStateSpine({ createStorage: () => mem });
    await hydrateScenarioStore(spine.scenario, spine.hot);
    return spine;
  }

  it("hydrates a tagged card weight as a real signed infinity", async () => {
    const spine = await hydrateOver(
      currentRecord({
        cardsByKind: emptyCards({
          requirements: [
            {
              uid: "r1",
              shiftType: "D",
              requiredNumPeople: 2,
              weight: { [NON_FINITE_PERSIST_TAG]: "-Infinity" },
            },
          ],
        }),
      }),
    );

    expect(spine.hot.getState().hydrationStatus).toBe("ready");
    expect(spine.scenario.getState().cardsByKind.requirements[0].weight).toBe(
      Number.NEGATIVE_INFINITY,
    );
    // The finite field beside it is untouched.
    expect(spine.scenario.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(2);
  });

  it("hydrates a tagged matrix-cell weight, which is also a Weight", async () => {
    const spine = await hydrateOver(
      currentRecord({
        reqData: [{ uid: "c1", kind: "off", person: "P1", date: 1, weight: TAGGED_POSITIVE }],
      }),
    );

    expect(spine.hot.getState().hydrationStatus).toBe("ready");
    expect(spine.scenario.getState().reqData[0]).toMatchObject({
      kind: "off",
      weight: Number.POSITIVE_INFINITY,
    });
  });

  it("hydrates a tagged export weightRange bound, which the schema leaves unrestricted", async () => {
    // `zLooseNumber` — "unlike a preference weight, unrestricted" — and the
    // sanitizer accepts any number here. Reachable through a Workspace Load, so
    // scoping the codec to `weight` alone would have broken a valid record.
    const spine = await hydrateOver(
      currentRecord({
        exportLayout: {
          formatting: [
            {
              type: "cell",
              people: ["P1"],
              dates: [1],
              shiftTypes: ["D"],
              when: {
                preference: {
                  types: ["shift request"],
                  weightRange: [{ [NON_FINITE_PERSIST_TAG]: "-Infinity" }, 0],
                },
              },
            },
          ],
          extraColumns: [],
          extraRows: [],
        },
      }),
    );

    expect(spine.hot.getState().hydrationStatus).toBe("ready");
    const rule = spine.scenario.getState().exportLayout.formatting[0] as {
      when: { preference: { weightRange: number[] } };
    };
    expect(rule.when.preference.weightRange).toEqual([Number.NEGATIVE_INFINITY, 0]);
  });

  it("fails closed on a tag under requiredNumPeople instead of hydrating ready", async () => {
    // The exact case the combined review reproduced: a current-v6 envelope whose
    // tag sits in a finite-only field. It used to revive to numeric Infinity and
    // sail through the sanitizer's generic `typeof number` check.
    const mem = currentRecord({
      cardsByKind: emptyCards({
        requirements: [
          { uid: "r1", shiftType: "D", requiredNumPeople: TAGGED_POSITIVE, weight: -1 },
        ],
      }),
    });
    const spine = await hydrateOver(mem);

    expect(spine.hot.getState().hydrationStatus).toBe("recoverable-error");
    expect(spine.scenario.getState().cardsByKind.requirements).toEqual([]);
    // The corrupt record is preserved, so the reset offer is still a real choice.
    expect(mem.snapshot()[SCENARIO_PERSIST_KEY]).toContain(NON_FINITE_PERSIST_TAG);
  });

  it.each([
    [
      "preferredNumPeople",
      {
        requirements: [
          {
            uid: "r1",
            shiftType: "D",
            requiredNumPeople: 1,
            preferredNumPeople: TAGGED_POSITIVE,
            weight: -1,
          },
        ],
      },
    ],
    [
      "a count target",
      {
        counts: [
          {
            uid: "c1",
            person: "ALL",
            countDates: "ALL",
            countShiftTypes: "N",
            expression: "x >= T",
            target: TAGGED_POSITIVE,
            weight: 1,
          },
        ],
      },
    ],
    [
      "a count target INSIDE an array",
      {
        counts: [
          {
            uid: "c1",
            person: "ALL",
            countDates: "ALL",
            countShiftTypes: "N",
            expression: ["x >= T"],
            target: [TAGGED_POSITIVE],
            weight: 1,
          },
        ],
      },
    ],
  ])("fails closed on a tag at %s", async (_label, cards) => {
    // The array case is the one the codec deliberately does NOT judge (an element
    // is decided by its parent, and `target` is not an approved list) — so this
    // proves the sanitizer closes it, rather than assuming it does.
    const spine = await hydrateOver(currentRecord({ cardsByKind: emptyCards(cards) }));

    expect(spine.hot.getState().hydrationStatus).toBe("recoverable-error");
    expect(spine.scenario.getState().cardsByKind.requirements).toEqual([]);
    expect(spine.scenario.getState().cardsByKind.counts).toEqual([]);
  });

  it("still hydrates an ordinary finite record with no tag anywhere", async () => {
    const spine = await hydrateOver(
      currentRecord({
        rangeStart: "2026-02-01",
        cardsByKind: emptyCards({
          requirements: [{ uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1 }],
        }),
      }),
    );

    expect(spine.hot.getState().hydrationStatus).toBe("ready");
    expect(spine.scenario.getState().cardsByKind.requirements[0]).toMatchObject({
      requiredNumPeople: 2,
      weight: -1,
    });
    expect(spine.scenario.getState().rangeStart).toBe("2026-02-01");
  });
});

describe("ready gate", () => {
  it("has no backup recorded before any hydration", () => {
    const scenario = createScenarioStore({ createStorage: () => createMemoryStorage() });
    expect(scenario.getState().backupFingerprint).toBeNull();
    expect(selectBackupStatus(scenario.getState())).toBe("none");
  });

  it("mutating actions are no-ops until the spine reports ready", () => {
    // A spine whose hot store is never marked ready.
    const spine = createStateSpine({ createStorage: () => createMemoryStorage() });
    expect(spine.hot.getState().hydrationStatus).toBe("unhydrated");

    spine.scenario.getState().mutateScenario({ rangeStart: "2026-02-01" });
    spine.scenario.getState().setReqData([{ kind: "leave", person: "p1", date: "2026-01-01" }]);
    spine.scenario.getState().recordBackup();

    expect(spine.scenario.getState().rangeStart).toBe("");
    expect(spine.scenario.getState().reqData).toEqual([]);
    expect(spine.scenario.getState().backupFingerprint).toBeNull();
    expect(spine.scenario.temporal.getState().pastStates.length).toBe(0);
  });
});
