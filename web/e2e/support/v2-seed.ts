// F4 — deterministic seed strategies for the frozen surface matrix.
//
// Every builder below is a pure function of its name: fixed identifiers, fixed
// ISO dates, fixed weights. Nothing reads a clock, a random source, the
// filesystem or another row's state, so any row can run alone, in any order, in
// any worker, and produce the same DOM. That property is what lets the parallel
// route wave trust a screenshot taken in someone else's shard.
//
// The seam is the real one: `window.__nsStore.scenario.getState().mutateScenario`
// from `components/shell/test-bridge.tsx`, i.e. a genuine tracked T04 mutation
// through the durable store — not a fixture prop, not a mock, not a hand-written
// IndexedDB record.
//
// Playwright is imported for TYPES only, so the pure builders below stay
// importable from the node vitest environment.

import type { Page } from "@playwright/test";
import type { V2Row, V2SeedKey } from "./v2-surface-matrix";

/**
 * The two storage keys the reset has to know about, restated as literals rather
 * than imported from `@/lib/store` / `@/lib/mode/mode`.
 *
 * The reason is the runtime, not taste: this module is loaded by Playwright's
 * own transform, and pulling the durable store's module graph (Dexie, zustand,
 * zundo) into an e2e helper to read two strings would be a large amount of
 * browser-shaped code evaluated in node for no benefit. `v2-seed.test.ts`
 * imports both real modules and asserts these literals still equal them, so the
 * duplication is pinned rather than trusted.
 */
export const SCENARIO_DB_NAME = "nurse-scheduler";
export const MODE_STORAGE_KEY = "ns-app-mode";

// ---------------------------------------------------------------------------
// The fixed scenario vocabulary
// ---------------------------------------------------------------------------

/** The seven-day roster window every seeded row shares. Thursday → Wednesday. */
export const SEED_RANGE = { start: "2026-05-14", end: "2026-05-20" } as const;

/** Every date in `SEED_RANGE`, derived once so no builder writes a date twice. */
export const SEED_DATES: readonly string[] = Object.freeze([
  "2026-05-14",
  "2026-05-15",
  "2026-05-16",
  "2026-05-17",
  "2026-05-18",
  "2026-05-19",
  "2026-05-20",
]);

/**
 * Three people rather than two: an affinity or a covering needs a third party
 * before "keep these apart" means anything, and a table needs a third row before
 * zebra striping is observable at all.
 */
export const SEED_STAFF_IDS = ["Alice", "Bob", "Cara"] as const;

/** Day / Evening / Night — enough for a succession and a shift group. */
export const SEED_SHIFT_IDS = ["D", "E", "N"] as const;

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

/** A durable-store patch: the exact object handed to `mutateScenario`. */
export type SeedPatch = Record<string, unknown>;

/** Range + staff + staff group + shift types + shift group + date group. */
export function buildRosterWeek(): SeedPatch {
  return {
    rangeStart: SEED_RANGE.start,
    rangeEnd: SEED_RANGE.end,
    staff: [
      { id: "Alice", description: "Senior nurse", history: ["D"] },
      { id: "Bob", description: "Staff nurse" },
      { id: "Cara", description: "Preceptor" },
    ],
    staffGroups: [
      { id: "Seniors", members: ["Alice", "Cara"] },
      { id: "Juniors", members: ["Bob"] },
    ],
    shifts: [
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
    ],
    shiftGroups: [{ id: "DayOrEvening", members: ["D", "E"] }],
    dateGroups: [{ id: "FirstTwo", members: [SEED_DATES[0], SEED_DATES[1]] }],
  };
}

/**
 * The empty card set, spelled out so every builder that touches `cardsByKind`
 * writes the same five keys. A partial `cardsByKind` patch would leave a route
 * reading `undefined` where it expects an array, which is a seed bug that looks
 * like a route bug.
 */
function emptyCards(): Record<string, unknown[]> {
  return { requirements: [], successions: [], counts: [], affinities: [], coverings: [] };
}

/**
 * The guided Rules screen derives its rows from the SOURCE constraints, plus the
 * always-present structural rule, so "seed the rules screen" means seeding the
 * constraints it projects — there is no separate rules collection to write.
 */
export function buildRosterWeekRules(): SeedPatch {
  return {
    ...buildRosterWeek(),
    maxOneShiftPerDay: { description: "One shift per nurse per day" },
    cardsByKind: {
      ...emptyCards(),
      requirements: [
        {
          uid: "seed-req-1",
          description: "Two nurses on Day",
          shiftType: "D",
          requiredNumPeople: 2,
          qualifiedPeople: "ALL",
          date: "ALL",
          weight: -1,
        },
      ],
    },
  };
}

/** One card of every constraint kind, so all five Card Editor routes have content. */
export function buildRosterWeekConstraints(): SeedPatch {
  return {
    ...buildRosterWeekRules(),
    cardsByKind: {
      requirements: [
        {
          uid: "seed-req-1",
          description: "Two nurses on Day",
          shiftType: "D",
          requiredNumPeople: 2,
          qualifiedPeople: "ALL",
          date: "ALL",
          weight: -1,
        },
      ],
      // Card shapes follow `lib/scenario/types.ts` exactly — `person`/`pattern`
      // for a succession, `people1`/`people2` for an affinity, and
      // `preceptors`/`preceptees` for a covering. The nested single-element
      // arrays are the aggregate-group form those editors round-trip.
      successions: [
        {
          uid: "seed-succ-1",
          description: "No Day after Night",
          person: ["Alice"],
          pattern: ["N", "D"],
          weight: -1,
        },
      ],
      counts: [
        {
          uid: "seed-count-1",
          description: "At most four nights a week",
          person: "ALL",
          countDates: "ALL",
          countShiftTypes: "N",
          expression: "<=",
          target: 4,
          weight: -1,
        },
      ],
      affinities: [
        {
          uid: "seed-aff-1",
          description: "Keep Alice and Bob apart",
          people1: [["Alice"]],
          people2: [["Bob"]],
          shiftTypes: [["D"]],
          date: ["ALL"],
          weight: 2,
        },
      ],
      coverings: [
        {
          uid: "seed-cov-1",
          description: "Cara supervises Bob",
          preceptors: [["Cara"]],
          preceptees: [["Bob"]],
          shiftTypes: [["D"]],
          weight: -1,
        },
      ],
    },
  };
}

/** Leave, a weighted request and an off day — one of each `reqData` arm. */
export function buildRosterWeekRequests(): SeedPatch {
  return {
    ...buildRosterWeek(),
    reqData: [
      { uid: "seed-cell-1", kind: "leave", person: "Alice", date: SEED_DATES[0] },
      {
        uid: "seed-cell-2",
        kind: "request",
        person: "Bob",
        date: SEED_DATES[1],
        shiftType: "D",
        weight: 2,
      },
      { uid: "seed-cell-3", kind: "off", person: "Cara", date: SEED_DATES[2], weight: 1 },
    ],
  };
}

/**
 * The Optimize route's own readiness gate needs exactly the required data —
 * range, at least one person, at least one shift type — which `roster-week`
 * already carries. It is a distinct NAME rather than an alias because the two
 * mean different things: if the readiness gate's inputs ever change, this seed
 * follows it and `roster-week` does not.
 */
export function buildOptimizeReady(): SeedPatch {
  return buildRosterWeek();
}

/**
 * Every named strategy, resolved to its patch. `empty` and `harness-self-seeded`
 * intentionally return `null`: the row is reset and then left alone, because the
 * surface under test either needs no scenario (the design-system reference) or
 * seeds its own deterministic state in the page itself (the optimize harnesses).
 * Returning `null` rather than `{}` keeps "seed nothing" distinguishable from
 * "apply an empty mutation", which would still be a tracked undo entry.
 */
export function buildSeedPatch(key: V2SeedKey): SeedPatch | null {
  switch (key) {
    case "empty":
    case "harness-self-seeded":
      return null;
    case "roster-week":
      return buildRosterWeek();
    case "roster-week-rules":
      return buildRosterWeekRules();
    case "roster-week-constraints":
      return buildRosterWeekConstraints();
    case "roster-week-requests":
      return buildRosterWeekRequests();
    case "roster-week-backup":
      return buildRosterWeek();
    case "optimize-ready":
      return buildOptimizeReady();
  }
}

/**
 * Whether the strategy records a Workspace backup after seeding, so the row
 * lands on a genuine "backup current" state rather than the "no backup" default.
 */
export function seedRecordsBackup(key: V2SeedKey): boolean {
  return key === "roster-week-backup";
}

// ---------------------------------------------------------------------------
// Browser-side application
// ---------------------------------------------------------------------------

interface SeedWindow {
  __NS_ENABLE_TEST_BRIDGE?: boolean;
  __nsStore?: {
    scenario: {
      getState(): {
        mutateScenario(patch: Record<string, unknown>): void;
        recordBackup(): void;
      };
    };
  };
}

/**
 * Reset every persistence surface, then arm the seams the row needs — all as
 * init scripts, so they run before any application code on every navigation in
 * this page, including a reload.
 *
 * Playwright already gives each test a fresh browser context, so in the ordinary
 * case there is nothing to clear. The explicit reset is here for the case that
 * is not ordinary: a locally reused server/context, a spec that reloads mid-row,
 * or a future fixture that shares a context. `deleteDatabase` is requested
 * before the app's first script runs, so it cannot lose a race with the Dexie
 * adapter opening the same database.
 *
 * Must be called BEFORE `page.goto`.
 */
export async function prepareRow(page: Page, row: V2Row): Promise<void> {
  await page.addInitScript(
    ([dbName, modeKey, mode, wantsBridge]) => {
      const w = window as unknown as Record<string, unknown>;
      try {
        window.localStorage.clear();
      } catch {}
      try {
        window.sessionStorage.clear();
      } catch {}
      try {
        indexedDB.deleteDatabase(dbName as string);
      } catch {}

      // In-memory bridges from a previous navigation in this page.
      delete w.__nsStore;
      delete w.__NS_DURABLE_FIXTURE_YAML;
      delete w.__NS_DURABLE_FIXTURE_PEOPLE_COUNT;
      delete w.__NS_DURABLE_FIXTURE_REVERSE_MAP;

      // The Advanced-only routes are bounced to Home by the route-validity gate
      // unless the stored preference says otherwise, so the mode a row needs is
      // part of its readiness contract, not an incidental setup step.
      if (mode) {
        try {
          window.localStorage.setItem(modeKey as string, mode as string);
        } catch {}
      }

      // The e2e suite runs against a PRODUCTION build, where the store seam is
      // exposed only on explicit opt-in (test-bridge.tsx).
      if (wantsBridge) w.__NS_ENABLE_TEST_BRIDGE = true;
    },
    [SCENARIO_DB_NAME, MODE_STORAGE_KEY, row.readiness.mode, row.readiness.storeSeam] as const,
  );
}

/**
 * Apply the row's seed through the real tracked mutation. Call AFTER readiness:
 * `mutateScenario` no-ops until the durable store reports `ready`, so seeding a
 * still-hydrating store would silently write nothing.
 */
export async function seedRow(page: Page, row: V2Row): Promise<void> {
  const patch = buildSeedPatch(row.seed);
  if (patch === null) return;

  const store = await page.evaluate(() => Boolean((window as unknown as SeedWindow).__nsStore));
  if (!store) {
    throw new Error(
      `${row.route} (${row.owner}): seed "${row.seed}" needs the window.__nsStore seam, ` +
        `but it is absent. The row's readiness descriptor must set storeSeam: true.`,
    );
  }

  await page.evaluate((p) => {
    (window as unknown as SeedWindow).__nsStore!.scenario.getState().mutateScenario(p);
  }, patch);

  if (seedRecordsBackup(row.seed)) {
    await page.evaluate(() => {
      (window as unknown as SeedWindow).__nsStore!.scenario.getState().recordBackup();
    });
  }
}
