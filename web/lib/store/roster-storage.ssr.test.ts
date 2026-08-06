// SSR safety for the roster storage foundation. This file deliberately does NOT
// import `fake-indexeddb/auto`, so it runs in an environment with no IndexedDB
// at all — exactly what a server render sees. Importing the modules and building
// the repositories must be free of side effects; only an actual operation may
// reach IndexedDB, and there it must fail loudly.

import { describe, expect, it } from "vitest";
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
      "writeWorking",
      () =>
        rosterStorage.writeWorking({
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
