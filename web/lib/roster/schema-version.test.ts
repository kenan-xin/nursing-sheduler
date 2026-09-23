// The roster-file version matrix (F3).
//
// Compatibility is the file's business, not the app's. These tests cover all five
// verdicts and the whole migration chain — including migrate-older, which at v1 is
// only reachable through the injected policy the module exposes for exactly this
// reason. Shipping the chain machinery untested would mean writing the first real
// migration on top of unproven code.

import { describe, expect, it } from "vitest";
import {
  classifyRosterFileVersion,
  CURRENT_ROSTER_FILE_VERSION,
  describeVersionVerdict,
  migrateRosterFileDocument,
  ROSTER_FILE_MIGRATIONS,
  rosterFileVersionString,
  type RosterFileMigration,
} from "./schema-version";
import { ROSTER_DOCUMENT_SCHEMA_VERSION } from "./types";

/** A step that restamps and records that it ran. */
function step(from: number, mark = `v${from + 1}`): RosterFileMigration {
  return {
    from,
    migrate: (document) => ({
      ok: true,
      document: {
        ...document,
        schemaVersion: rosterFileVersionString(from + 1),
        trail: [...((document.trail as string[]) ?? []), mark],
      },
    }),
  };
}

describe("the shipped version", () => {
  it("agrees with the document schema constant", () => {
    expect(rosterFileVersionString(CURRENT_ROSTER_FILE_VERSION)).toBe(
      ROSTER_DOCUMENT_SCHEMA_VERSION,
    );
  });

  it("ships no migrations yet, because v1 is the first version", () => {
    expect(ROSTER_FILE_MIGRATIONS).toEqual([]);
    expect(CURRENT_ROSTER_FILE_VERSION).toBe(1);
  });
});

describe("classifyRosterFileVersion", () => {
  it("loads an exact match", () => {
    expect(classifyRosterFileVersion(ROSTER_DOCUMENT_SCHEMA_VERSION)).toEqual({
      status: "exact",
      version: 1,
    });
  });

  it("rejects a NEWER file rather than best-effort loading it", () => {
    expect(classifyRosterFileVersion("roster-file/2")).toEqual({ status: "newer", version: 2 });
    expect(classifyRosterFileVersion("roster-file/99")).toEqual({ status: "newer", version: 99 });
  });

  it("migrates an older version when the whole chain is registered", () => {
    const policy = { migrations: [step(1), step(2)], currentVersion: 3 };
    expect(classifyRosterFileVersion("roster-file/1", policy)).toEqual({
      status: "migrate",
      version: 1,
    });
    expect(classifyRosterFileVersion("roster-file/2", policy)).toEqual({
      status: "migrate",
      version: 2,
    });
    expect(classifyRosterFileVersion("roster-file/3", policy)).toEqual({
      status: "exact",
      version: 3,
    });
  });

  it("rejects an older version whose chain has a hole", () => {
    // 1 → 2 exists, 2 → 3 does not: version 1 cannot reach current.
    const policy = { migrations: [step(1)], currentVersion: 3 };
    expect(classifyRosterFileVersion("roster-file/1", policy)).toEqual({
      status: "unsupported",
      version: 1,
    });
    expect(classifyRosterFileVersion("roster-file/2", policy)).toEqual({
      status: "unsupported",
      version: 2,
    });
  });

  it.each([
    ["a missing version", undefined],
    ["a non-string version", 1],
    ["a foreign schema family", "roster-container/1"],
    ["a bare number", "1"],
    ["a leading zero", "roster-file/01"],
    ["a non-integer version", "roster-file/1.2"],
    ["a negative version", "roster-file/-1"],
    ["trailing content", "roster-file/1x"],
  ])("does not recognize %s", (_label, value) => {
    expect(classifyRosterFileVersion(value)).toEqual({ status: "unrecognized" });
  });
});

describe("describeVersionVerdict", () => {
  it("tells a user with a newer file which build wrote it and which reads it", () => {
    const message = describeVersionVerdict({ status: "newer", version: 4 });
    expect(message).toContain("newer version of the app");
    expect(message).toContain("roster-file/4");
    expect(message).toContain(ROSTER_DOCUMENT_SCHEMA_VERSION);
  });

  it("distinguishes too-old from unrecognized", () => {
    expect(describeVersionVerdict({ status: "unsupported", version: 1 })).toContain("too old");
    expect(describeVersionVerdict({ status: "unrecognized" })).toContain(
      "does not carry a roster file schema version",
    );
  });
});

describe("migrateRosterFileDocument", () => {
  it("runs every step in order and leaves the document stamped at current", () => {
    const policy = { migrations: [step(1), step(2)], currentVersion: 3 };
    const result = migrateRosterFileDocument({ schemaVersion: "roster-file/1" }, 1, policy);
    expect(result).toEqual({
      ok: true,
      document: { schemaVersion: "roster-file/3", trail: ["v2", "v3"] },
    });
  });

  it("is a no-op at the current version", () => {
    const document = { schemaVersion: ROSTER_DOCUMENT_SCHEMA_VERSION, keep: true };
    expect(migrateRosterFileDocument(document, CURRENT_ROSTER_FILE_VERSION)).toEqual({
      ok: true,
      document,
    });
  });

  it("fails closed when a step is missing", () => {
    const result = migrateRosterFileDocument({}, 1, { migrations: [step(1)], currentVersion: 3 });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok)
      expect(result.reason).toContain("no migration from roster file schema version 2");
  });

  it("propagates a step's own rejection instead of continuing", () => {
    const failing: RosterFileMigration = {
      from: 1,
      migrate: () => ({ ok: false, reason: "cannot upgrade a v1 overlay faithfully" }),
    };
    const result = migrateRosterFileDocument({}, 1, {
      migrations: [failing, step(2)],
      currentVersion: 3,
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("cannot upgrade a v1 overlay faithfully");
  });

  it("catches a step that forgets to restamp the version", () => {
    // Otherwise the miss would surface later as a confusing validation failure.
    const forgetful: RosterFileMigration = {
      from: 1,
      migrate: (document) => ({
        ok: true,
        document: { ...document, schemaVersion: "roster-file/1" },
      }),
    };
    const result = migrateRosterFileDocument({}, 1, {
      migrations: [forgetful],
      currentVersion: 2,
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("did not stamp roster-file/2");
  });
});
