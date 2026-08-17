// SSR safety for the roster storage foundation. This file runs in an environment
// with no IndexedDB at all — exactly what a server render sees. Importing the
// modules and building the repositories must be free of side effects; only an
// actual operation may reach IndexedDB, and there it must fail loudly.
//
// INTEGRATION — the absence is now ENFORCED here rather than inherited. It used to
// rest on this file not importing `fake-indexeddb/auto`. The T02/T03 repository made
// IndexedDB a GLOBAL test fixture (`vitest.setup.ts` registers it for the whole
// suite), so every assertion below silently inverted: the environment had a working
// IndexedDB, `getRosterDb` constructed instead of throwing, and each operation
// RESOLVED where a server render must reject. Deleting the globals restores the real
// condition, and the first test is the guard that proves the deletion took effect —
// if a future setup reinstalls them some other way, that test fails first and says so.

import { describe, expect, it } from "vitest";

// Before any module below is exercised: unwind the global registration for THIS file.
// `indexedDB` is what `isIndexedDbAvailable()` reads; `IDBKeyRange` is removed with it
// so nothing here can reach a half-present API that a real server does not have.
Reflect.deleteProperty(globalThis, "indexedDB");
Reflect.deleteProperty(globalThis, "IDBKeyRange");

import { getRosterDb, isIndexedDbAvailable, IndexedDbUnavailableError } from "./dexie-storage";
import { createRosterStorage, rosterStorage } from "./roster-storage";

describe("client-lazy / SSR-safe construction", () => {
  it("has no IndexedDB in this environment (guards the test itself)", () => {
    expect(isIndexedDbAvailable()).toBe(false);
    expect(globalThis.indexedDB).toBeUndefined();
  });

  it("importing the modules and constructing repositories opens no database", () => {
    // Reaching this line at all means the module-level `rosterStorage` singleton
    // was constructed during import without touching IndexedDB.
    expect(typeof rosterStorage.readWorking).toBe("function");
    expect(() => createRosterStorage("ssr-test")).not.toThrow();
  });

  it("resolving the database throws a named error instead of constructing one", () => {
    expect(() => getRosterDb("ssr-test")).toThrow(IndexedDbUnavailableError);
  });

  it.each([
    ["readWorking", () => rosterStorage.readWorking()],
    ["readCurrentCandidate", () => rosterStorage.readCurrentCandidate()],
    ["getClearEpoch", () => rosterStorage.getClearEpoch()],
    [
      "writeWorkingEdit",
      () =>
        rosterStorage.writeWorkingEdit({
          document: {},
          expectedRevision: null,
          expectedClearEpoch: 0,
        }),
    ],
    [
      "allocateSubmissionSnapshot",
      () =>
        rosterStorage.allocateSubmissionSnapshot({
          ownerId: "owner",
          payload: {},
          expectedClearEpoch: 0,
        }),
    ],
  ])("%s rejects with IndexedDbUnavailableError on the server", async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(IndexedDbUnavailableError);
  });
});
