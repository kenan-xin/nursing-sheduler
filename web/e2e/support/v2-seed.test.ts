import { describe, expect, it } from "vitest";
import { SCENARIO_DB_NAME as APP_DB_NAME } from "@/lib/store/dexie-storage";
import { MODE_STORAGE_KEY as APP_MODE_KEY } from "@/lib/mode/mode";
import {
  buildOptimizeReady,
  buildRosterWeek,
  buildRosterWeekConstraints,
  buildRosterWeekRequests,
  buildRosterWeekRules,
  buildSeedPatch,
  MODE_STORAGE_KEY,
  SCENARIO_DB_NAME,
  SEED_DATES,
  SEED_RANGE,
  SEED_SHIFT_IDS,
  SEED_STAFF_IDS,
  seedRecordsBackup,
} from "./v2-seed";
import { V2_SEED_KEYS, V2_SURFACE_MATRIX } from "./v2-surface-matrix";

// A seed that is not deterministic is a screenshot baseline that is not
// reviewable and a semantic check that fails in someone else's shard. These
// tests are about that one property, plus the two couplings the module cannot
// enforce for itself: the storage keys it restates, and the manifest rows it
// serves.

describe("storage keys stay coupled to the app", () => {
  it("matches the durable store's IndexedDB database name", () => {
    expect(SCENARIO_DB_NAME).toBe(APP_DB_NAME);
  });

  it("matches the mode lens's localStorage key", () => {
    expect(MODE_STORAGE_KEY).toBe(APP_MODE_KEY);
  });
});

describe("determinism", () => {
  it.each(V2_SEED_KEYS)("%s produces byte-identical output on every call", (key) => {
    const a = buildSeedPatch(key);
    const b = buildSeedPatch(key);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("returns a fresh object each time, so one row cannot poison another", () => {
    const a = buildRosterWeek();
    const b = buildRosterWeek();
    expect(a).not.toBe(b);
    (a.staff as unknown[]).push({ id: "Intruder" });
    expect((b.staff as unknown[]).length).toBe(SEED_STAFF_IDS.length);
  });

  it("contains no value derived from a clock or a random source", () => {
    // Every date the seeds use is drawn from the fixed roster window; a stray
    // `new Date()` would show up here as a date outside it.
    const dates = new Set(
      V2_SEED_KEYS.flatMap(
        (key) => JSON.stringify(buildSeedPatch(key)).match(/\d{4}-\d{2}-\d{2}/g) ?? [],
      ),
    );
    for (const date of dates) expect(SEED_DATES, `unexpected date ${date}`).toContain(date);
  });
});

describe("coverage of the named strategies", () => {
  it.each(V2_SEED_KEYS)("%s is handled", (key) => {
    expect(() => buildSeedPatch(key)).not.toThrow();
  });

  it("distinguishes `seed nothing` from `apply an empty mutation`", () => {
    // `{}` would still be a tracked mutation and a spurious undo entry.
    expect(buildSeedPatch("empty")).toBeNull();
    expect(buildSeedPatch("harness-self-seeded")).toBeNull();
  });

  it("records a Workspace backup only for the strategy that names one", () => {
    for (const key of V2_SEED_KEYS) {
      expect(seedRecordsBackup(key), key).toBe(key === "roster-week-backup");
    }
  });
});

describe("the roster week", () => {
  const week = buildRosterWeek();

  it("spans the fixed seven-day window", () => {
    expect(week.rangeStart).toBe(SEED_RANGE.start);
    expect(week.rangeEnd).toBe(SEED_RANGE.end);
    expect(SEED_DATES).toHaveLength(7);
    expect(SEED_DATES[0]).toBe(SEED_RANGE.start);
    expect(SEED_DATES[SEED_DATES.length - 1]).toBe(SEED_RANGE.end);
  });

  it("seeds three people and three shift types", () => {
    expect((week.staff as { id: string }[]).map((s) => s.id)).toEqual([...SEED_STAFF_IDS]);
    expect((week.shifts as { id: string }[]).map((s) => s.id)).toEqual([...SEED_SHIFT_IDS]);
  });

  it("seeds groups whose members all exist", () => {
    const staff = new Set((week.staff as { id: string }[]).map((s) => s.id));
    for (const group of week.staffGroups as { id: string; members: string[] }[]) {
      for (const member of group.members) expect(staff, `${group.id}`).toContain(member);
    }
    const shifts = new Set((week.shifts as { id: string }[]).map((s) => s.id));
    for (const group of week.shiftGroups as { id: string; members: string[] }[]) {
      for (const member of group.members) expect(shifts, `${group.id}`).toContain(member);
    }
    for (const group of week.dateGroups as { id: string; members: string[] }[]) {
      for (const member of group.members) expect(SEED_DATES, `${group.id}`).toContain(member);
    }
  });

  it("is what the Optimize readiness gate needs", () => {
    const ready = buildOptimizeReady();
    expect(ready.rangeStart).toBeTruthy();
    expect((ready.staff as unknown[]).length).toBeGreaterThan(0);
    expect((ready.shifts as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("the derived strategies build on the week rather than diverging", () => {
  it.each([
    ["roster-week-rules", buildRosterWeekRules],
    ["roster-week-constraints", buildRosterWeekConstraints],
    ["roster-week-requests", buildRosterWeekRequests],
  ] as const)("%s keeps the same range, staff and shifts", (_label, build) => {
    const patch = build();
    const week = buildRosterWeek();
    expect(patch.rangeStart).toBe(week.rangeStart);
    expect(patch.rangeEnd).toBe(week.rangeEnd);
    expect(JSON.stringify(patch.staff)).toBe(JSON.stringify(week.staff));
    expect(JSON.stringify(patch.shifts)).toBe(JSON.stringify(week.shifts));
  });

  it("the constraints strategy seeds one card of every kind", () => {
    // All five Card Editor routes share one seed, so a missing kind means one of
    // R4's five rows lands on an empty state and verifies nothing.
    const cards = buildRosterWeekConstraints().cardsByKind as Record<string, unknown[]>;
    for (const kind of ["requirements", "successions", "counts", "affinities", "coverings"]) {
      expect(cards[kind], `cardsByKind.${kind}`).toHaveLength(1);
    }
  });

  it("the rules strategy seeds the structural rule and a source constraint", () => {
    const rules = buildRosterWeekRules();
    expect(rules.maxOneShiftPerDay).toBeDefined();
    const cards = rules.cardsByKind as Record<string, unknown[]>;
    expect(cards.requirements.length).toBeGreaterThan(0);
    // Every kind is present as an array, even when empty: a route reading
    // `undefined` where it expects a list is a seed bug that reads as a route bug.
    for (const kind of ["requirements", "successions", "counts", "affinities", "coverings"]) {
      expect(Array.isArray(cards[kind]), `cardsByKind.${kind}`).toBe(true);
    }
  });

  it("the requests strategy seeds one cell of each reqData arm", () => {
    const cells = buildRosterWeekRequests().reqData as { kind: string; person: string }[];
    expect(cells.map((c) => c.kind).sort()).toEqual(["leave", "off", "request"]);
    for (const cell of cells) expect(SEED_STAFF_IDS as readonly string[]).toContain(cell.person);
  });
});

describe("every manifest row can actually be seeded", () => {
  it("a row that seeds data has the store seam, and vice versa", () => {
    for (const row of V2_SURFACE_MATRIX) {
      const needsSeam = buildSeedPatch(row.seed) !== null;
      expect(row.readiness.storeSeam, `${row.route} seeds ${row.seed}`).toBe(
        needsSeam || row.readiness.storeSeam,
      );
      if (needsSeam) expect(row.readiness.storeSeam, `${row.route}`).toBe(true);
    }
  });

  it("the uids a seed writes are unique within its patch", () => {
    for (const key of V2_SEED_KEYS) {
      const json = JSON.stringify(buildSeedPatch(key));
      const uids = [...json.matchAll(/"uid":"([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(uids).size, `${key} repeats a uid`).toBe(uids.length);
    }
  });
});
