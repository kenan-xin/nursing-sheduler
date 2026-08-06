// Test harness for the repository-backed scenario authority (T03). Not a test
// file (vitest collects `*.test.ts` only), so it may be imported freely.
//
// WHY A HARNESS AT ALL. Before T03 a test could reset the app by calling
// `resetToNewScenario` against the singleton stores, because durable state was a
// single serialized record behind an injectable storage double. Durable state is
// now a per-scenario envelope, a lease, a commit log, and a history session in
// IndexedDB — and leaking any of that between tests would make ownership and
// history assertions order-dependent.
//
// So each test binds the APP singletons (which the components under test import
// directly) to a FRESH database and a fresh tab identity. That keeps the
// components exercising the real repository transaction — the only way a test can
// actually prove "one mutation, one durable commit" — while staying isolated.

import { NurseSchedulerDb } from "@/lib/repository";
import { createAuthorityStore, ScenarioAuthority, useAuthorityStore } from "./authority";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import { createHotStore, type HotStore } from "./hot-store";
import { createScenarioStore, type ScenarioStore } from "./scenario-store";
import { setScenarioAuthority, stateSpine } from "./spine";

let counter = 0;

/** The harness the app singletons are currently bound to (for the read helpers). */
let current: TestAuthority | null = null;

export interface TestAuthorityOptions {
  /** Share a database between two harnesses to simulate a second tab. */
  databaseName?: string;
  /** Distinct per simulated tab; defaults to a fresh id. */
  tabId?: string;
  /** Injected clock, so lease expiry is testable without sleeping 20 seconds. */
  now?: () => Date;
  leaseTtlMs?: number;
  /** Bind the app singletons to this authority (default `true`). */
  install?: boolean;
}

export interface TestAuthority {
  authority: ScenarioAuthority;
  db: NurseSchedulerDb;
  databaseName: string;
  tabId: string;
  /** The projection this authority publishes into (the app one when installed). */
  scenario: ScenarioStore;
  hot: HotStore;
  /** The session-authority projection (the app one when installed). */
  authorityStore: typeof useAuthorityStore;
}

/** A fresh IndexedDB database name so no durable state bleeds between tests. */
export function freshAuthorityDbName(): string {
  counter += 1;
  return `nurse-scheduler-t03-${counter}`;
}

/**
 * Build an authority bound to the app singletons and bring it up. Resets the
 * projection, the hot store, and the session-authority state first, so a test
 * never inherits the previous one's in-memory view either.
 */
export async function installTestAuthority(
  options: TestAuthorityOptions = {},
): Promise<TestAuthority> {
  const databaseName = options.databaseName ?? freshAuthorityDbName();
  const tabId = options.tabId ?? `tab-${(counter += 1)}`;
  const db = new NurseSchedulerDb(databaseName);

  // A SECOND simulated tab gets its own projections. Sharing the app singletons
  // would let the peer's publishes overwrite the tab under test, which would make
  // an ownership assertion pass or fail for reasons that have nothing to do with
  // the lease.
  const installed = options.install !== false;
  const scenario = installed ? stateSpine.scenario : createScenarioStore();
  const hot = installed ? stateSpine.hot : createHotStore();
  const authorityStore = installed ? useAuthorityStore : createAuthorityStore();

  const authority = new ScenarioAuthority({
    db,
    scenario,
    hot,
    authority: authorityStore,
    tabId,
    ...(options.now ? { now: options.now } : {}),
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
  });

  if (installed) {
    setScenarioAuthority(authority);
    resetProjection();
    await authority.initialize();
    hot.getState().setHydrationStatus("ready");
  }

  const harness = { authority, db, databaseName, tabId, scenario, hot, authorityStore };
  if (installed) current = harness;
  return harness;
}

/**
 * How many reversals are currently available — the replacement for reading
 * zundo's `pastStates.length`.
 *
 * Read from the DURABLE envelope rather than from the session-authority
 * projection, because "how deep is the history" and "is the top entry reversible"
 * are different questions: the projection answers the second (which is what a
 * button needs), and a test asserting "this operation added exactly one Undo
 * step" needs the first.
 */
export async function undoDepth(): Promise<number> {
  const scenarioId = current?.authorityStore.getState().scenarioId;
  if (!current || !scenarioId) return 0;
  const envelope = await current.db.scenarioEnvelopes.get(scenarioId);
  return envelope?.historyCursor ?? 0;
}

/** How many reapplications are currently available (zundo's `futureStates`). */
export async function redoDepth(): Promise<number> {
  const scenarioId = current?.authorityStore.getState().scenarioId;
  if (!current || !scenarioId) return 0;
  const envelope = await current.db.scenarioEnvelopes.get(scenarioId);
  if (!envelope) return 0;
  const commits = await current.db.scenarioCommits.where("scenarioId").equals(scenarioId).toArray();
  const content = commits.filter(
    (commit) =>
      commit.isContent &&
      commit.supersededAt === null &&
      commit.historySessionId === envelope.historySessionId,
  );
  return content.length - envelope.historyCursor;
}

/** Reset the in-memory projections without touching any durable state. */
export function resetProjection(): void {
  stateSpine.scenario.setState({ ...createEmptyScenarioUiState(), backupFingerprint: null }, true);
  stateSpine.hot.getState().resetEphemeral();
  useAuthorityStore.setState({
    scenarioId: null,
    documentRevision: 0,
    recordRevision: 0,
    ownership: "unknown",
    heldByTabId: null,
    canUndo: false,
    canRedo: false,
    writeStatus: "idle",
    lastErrorCode: null,
    reloadRequired: false,
  });
}

/**
 * The common `beforeEach`: a brand-new empty scenario on a brand-new database,
 * owned by this tab. Replaces the pre-T03 `resetToNewScenario(...)` +
 * `drainScenarioPersist(...)` pair.
 */
export async function resetScenarioForTest(): Promise<TestAuthority> {
  return installTestAuthority();
}

/** Drop the singleton binding so the next `getScenarioAuthority()` rebuilds it. */
export function clearTestAuthority(): void {
  current = null;
  setScenarioAuthority(null);
}

/** Re-exported so a migrated test needs one import line, not three. */
export { drainScenarioCommands, scenarioCommands } from "./commands";
