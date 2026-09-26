// roster-file/2: a borrowed (temporary) nurse's row on an existing roster (bead g1p).

import { describe, expect, it } from "vitest";
import { rosterAxisContext, rosterCurrentDays, withBorrowedRows } from "./borrowed";
import { decodeRosterFileBytes, encodeRosterFile } from "./file";
import {
  rosterFileVersionString,
  upgradeStoredRosterDocument,
  validateStoredRosterDocument,
} from "./schema-version";
import { fixtureRosterDocument, mutableDocument, withEdits } from "./test-fixtures";
import { validateRosterDocument } from "./validate";
import type { RosterBorrowedRow, RosterDayState, RosterDocument } from "./types";

const OFF: RosterDayState = { kind: "off" };
const N: RosterDayState = { kind: "shift", shiftId: "N" };

const MEI: RosterBorrowedRow = {
  id: "Mei",
  description: "relief pool",
  groups: ["RN"],
  days: [OFF, N, OFF, OFF],
};

async function withMei(): Promise<RosterDocument> {
  return withBorrowedRows(await fixtureRosterDocument(), [MEI]);
}

async function rawBytes(document: RosterDocument): Promise<Record<string, unknown>> {
  const encoded = await encodeRosterFile(document);
  if (!encoded.ok) throw new Error(encoded.reason);
  return JSON.parse(new TextDecoder().decode(encoded.file.bytes)) as Record<string, unknown>;
}

describe("roster-file/2 borrowed rows", () => {
  it("a new roster is roster-file/2 with no borrowed rows", async () => {
    const document = await fixtureRosterDocument();
    expect(document.schemaVersion).toBe("roster-file/2");
    expect(document.borrowed).toEqual([]);
  });

  it("loads an old roster-file/1 file as roster-file/2 with no borrowed rows", async () => {
    const raw = await rawBytes(await fixtureRosterDocument());
    const { borrowed: _dropped, ...v1 } = raw;
    v1.schemaVersion = rosterFileVersionString(1);
    const result = await decodeRosterFileBytes(new TextEncoder().encode(JSON.stringify(v1)));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.document.schemaVersion).toBe("roster-file/2");
    expect(result.document.borrowed).toEqual([]);
  });

  it("upgrades a roster stored by an older build (IndexedDB) and validates it", async () => {
    const { borrowed: _dropped, ...stored } = await fixtureRosterDocument();
    const v1 = { ...stored, schemaVersion: rosterFileVersionString(1) };
    expect(await validateRosterDocument(v1)).toMatchObject({ ok: false });
    expect(upgradeStoredRosterDocument(v1)).toMatchObject({
      schemaVersion: "roster-file/2",
      borrowed: [],
    });
    expect(await validateStoredRosterDocument(v1)).toMatchObject({ ok: true });
  });

  it("round-trips a borrowed row and its edits through the file", async () => {
    const document = withEdits(await withMei(), [{ personIdx: 2, dateIdx: 2, day: N }]);
    const encoded = await encodeRosterFile(document);
    expect(encoded).toMatchObject({ ok: true });
    if (!encoded.ok) return;
    const decoded = await decodeRosterFileBytes(encoded.file.bytes);
    expect(decoded).toMatchObject({ ok: true });
    if (!decoded.ok) return;
    expect(decoded.document.borrowed).toEqual([MEI]);
    expect(decoded.document.edits).toEqual([{ personIdx: 2, dateIdx: 2, day: N }]);
  });

  it("puts borrowed rows after the submitted people on the axis", async () => {
    const document = withEdits(await withMei(), [{ personIdx: 2, dateIdx: 0, day: N }]);
    expect(rosterAxisContext(document).people.map((p) => p.id)).toEqual(["Alice Ng", 7, "Mei"]);
    expect(rosterAxisContext(document).people[2]).toEqual({
      id: "Mei",
      description: "relief pool",
      temporary: true,
    });
    const days = rosterCurrentDays(document);
    expect(days).toHaveLength(3);
    expect(days[2]).toEqual([N, N, OFF, OFF]);
  });

  it.each<[string, (row: Record<string, unknown>) => void, string]>([
    ["a submitted person's id", (row) => (row.id = "Alice Ng"), "already on the roster"],
    ["a missing day", (row) => (row.days = [OFF, OFF, OFF]), "3 days for 4 dates"],
    [
      "an unknown shift",
      (row) => (row.days = [OFF, { kind: "shift", shiftId: "X" }, OFF, OFF]),
      "unknown shift type",
    ],
    ["an extra field", (row) => (row.role = "RN"), "unexpected field"],
    ["a non-string group", (row) => (row.groups = [1]), "groups"],
  ])("rejects a borrowed row with %s", async (_label, tamper, reason) => {
    const raw = mutableDocument(await withMei());
    tamper(raw.borrowed[0] as unknown as Record<string, unknown>);
    const result = await validateRosterDocument(raw);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it("rejects two borrowed rows with the same id", async () => {
    const document = withBorrowedRows(await fixtureRosterDocument(), [MEI, MEI]);
    const result = await validateRosterDocument(document);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("already on the roster");
  });

  it("rejects an edit equal to a borrowed row's own day", async () => {
    const document = withEdits(await withMei(), [{ personIdx: 2, dateIdx: 1, day: N }]);
    const result = await validateRosterDocument(document);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("equals its solved day-state");
  });
});
