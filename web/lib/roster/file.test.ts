// The roster-file wire format (F3): round trips, byte fidelity, and the four
// fail-closed layers.
//
// The round trips are the load-bearing product claim — "a recipient can view, edit,
// warn, and re-export with nothing else loaded" — so they assert the whole document
// survives, workbook bytes included, not merely that import succeeds.

import { describe, expect, it } from "vitest";
import { XLSX_MEDIA_TYPE } from "./container";
import {
  checkRosterFileCarrier,
  decodeRosterFile,
  decodeRosterFileBytes,
  encodeRosterFile,
  MAX_ROSTER_FILE_BYTES,
  ROSTER_FILE_EXTENSION,
  ROSTER_FILE_MIME,
  rosterFileName,
  toRosterFileDocument,
} from "./file";
import { deriveCurrentDays, deriveEditedSinceSolve, withRosterCellEdit } from "./overlay";
import { rosterFileVersionString, type RosterFileMigration } from "./schema-version";
import { MAX_FROZEN_XLSX_BYTES } from "./validate";
import {
  FIXTURE_DATES,
  fixtureFrozenXlsx,
  fixtureRosterDocument,
  fixtureSolvedDays,
  withEdits,
  withProvenance,
} from "./test-fixtures";
import type { RosterDocument } from "./types";

async function encode(document: RosterDocument): Promise<Uint8Array> {
  const result = await encodeRosterFile(document);
  if (!result.ok) throw new Error(`expected an encoded file, got: ${result.reason}`);
  return result.file.bytes;
}

async function decode(bytes: Uint8Array): Promise<RosterDocument> {
  const result = await decodeRosterFileBytes(bytes);
  if (!result.ok) throw new Error(`expected a decoded document, got: ${result.reason}`);
  return result.document;
}

/** Parse encoded bytes back to raw JSON so a single field can be tampered with. */
function reencode(json: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

async function rawOf(document: RosterDocument): Promise<Record<string, unknown>> {
  return JSON.parse(new TextDecoder().decode(await encode(document))) as Record<string, unknown>;
}

async function bytesOf(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

describe("the file's identity", () => {
  it("declares the roster media type and compound extension", async () => {
    const document = await fixtureRosterDocument();
    const result = await encodeRosterFile(document);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.file.blob.type).toBe(ROSTER_FILE_MIME);
    expect(result.file.filename.endsWith(ROSTER_FILE_EXTENSION)).toBe(true);
    expect(result.file.filename).toBe(rosterFileName(document));
    // Derived from the document, so it carries no clock and is stable.
    expect(result.file.filename).toContain(FIXTURE_DATES[0]);
  });

  it("writes deterministic bytes for the same document", async () => {
    const document = await fixtureRosterDocument();
    const first = await encode(document);
    const second = await encode(document);
    expect([...second]).toEqual([...first]);

    // ...and re-encoding an imported copy reproduces the original bytes exactly,
    // so a shared file has one canonical spelling rather than a per-peer one.
    expect([...(await encode(await decode(first)))]).toEqual([...first]);
  });

  it("embeds the workbook as strict base64 with the XLSX media type", async () => {
    const document = await fixtureRosterDocument();
    const wire = await toRosterFileDocument(document);
    expect(wire.frozenXlsx.mime).toBe(XLSX_MEDIA_TYPE);
    expect(wire.frozenXlsx.base64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});

describe("round trips", () => {
  it("preserves a solved-only roster, workbook bytes included", async () => {
    const document = await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(97) });
    const imported = await decode(await encode(document));

    expect(imported.schemaVersion).toBe(document.schemaVersion);
    expect(imported.provenance).toEqual(document.provenance);
    expect(imported.submission).toEqual(document.submission);
    expect(imported.context).toEqual(document.context);
    expect(imported.solvedDays).toEqual(fixtureSolvedDays());
    expect(imported.edits).toEqual([]);
    expect(imported.coordinateMap).toEqual(document.coordinateMap);
    expect(await bytesOf(imported.frozenXlsx)).toEqual(await bytesOf(document.frozenXlsx));
    expect(imported.frozenXlsx.type).toBe(XLSX_MEDIA_TYPE);
  });

  it("preserves the immutable baseline AND the overlay of an edited roster", async () => {
    const document = await fixtureRosterDocument();
    const bounds = {
      solvedDays: document.solvedDays,
      shiftTypeIds: document.context.shiftTypes.map((shiftType) => shiftType.id),
    };
    const edited = withRosterCellEdit(
      document.edits,
      { personIdx: 0, dateIdx: 1 },
      { kind: "shift", shiftId: "N" },
      bounds,
    );
    if (!edited.ok) throw new Error(edited.reason);

    const imported = await decode(await encode(withEdits(document, edited.edits)));
    // The baseline is untouched by the edit — that is what makes it a baseline.
    expect(imported.solvedDays).toEqual(fixtureSolvedDays());
    expect(imported.edits).toEqual([
      { personIdx: 0, dateIdx: 1, day: { kind: "shift", shiftId: "N" } },
    ]);
    expect(deriveEditedSinceSolve(imported.edits)).toBe(true);
    expect(deriveCurrentDays(imported.solvedDays, imported.edits)[0][1]).toEqual({
      kind: "shift",
      shiftId: "N",
    });
  });

  it("clears the overlay and the derived edited state when a cell returns to solved", async () => {
    const document = await fixtureRosterDocument();
    const bounds = {
      solvedDays: document.solvedDays,
      shiftTypeIds: document.context.shiftTypes.map((shiftType) => shiftType.id),
    };
    const edited = withRosterCellEdit(
      document.edits,
      { personIdx: 1, dateIdx: 2 },
      { kind: "leave" },
      bounds,
    );
    if (!edited.ok) throw new Error(edited.reason);

    // Export → import → the recipient chooses the cell's ORIGINAL solved value.
    const received = await decode(await encode(withEdits(document, edited.edits)));
    expect(received.edits).toHaveLength(1);
    const reverted = withRosterCellEdit(
      received.edits,
      { personIdx: 1, dateIdx: 2 },
      fixtureSolvedDays()[1][2],
      { solvedDays: received.solvedDays, shiftTypeIds: bounds.shiftTypeIds },
    );
    if (!reverted.ok) throw new Error(reverted.reason);
    expect(reverted.edits).toEqual([]);
    expect(deriveEditedSinceSolve(reverted.edits)).toBe(false);

    // And the resulting document still exports/imports cleanly.
    const cleared = withEdits(received, reverted.edits);
    expect((await decode(await encode(cleared))).edits).toEqual([]);
  });

  it("accepts the file through the carrier-checked File path", async () => {
    const document = await fixtureRosterDocument();
    const encoded = await encodeRosterFile(document);
    if (!encoded.ok) throw new Error(encoded.reason);
    const file = Object.assign(encoded.file.blob, { name: encoded.file.filename });
    expect(await decodeRosterFile(file)).toMatchObject({ ok: true });
  });
});

describe("the carrier guard", () => {
  it("accepts the roster type, a plain JSON type, and an unclassified file", () => {
    for (const type of [ROSTER_FILE_MIME, "application/json", ""]) {
      expect(checkRosterFileCarrier({ filename: `r${ROSTER_FILE_EXTENSION}`, type }, 10)).toEqual({
        ok: true,
      });
    }
  });

  it("rejects a wrong extension, a contradicting type, and an empty file", () => {
    expect(checkRosterFileCarrier({ filename: "roster.json" }, 10)).toMatchObject({ ok: false });
    expect(checkRosterFileCarrier({ filename: "roster.xlsx" }, 10)).toMatchObject({ ok: false });
    expect(
      checkRosterFileCarrier({ filename: `r${ROSTER_FILE_EXTENSION}`, type: XLSX_MEDIA_TYPE }, 10),
    ).toMatchObject({ ok: false });
    expect(checkRosterFileCarrier({}, 0)).toMatchObject({ ok: false });
  });

  it("accepts a file at the size cap and rejects one byte more", () => {
    expect(checkRosterFileCarrier({}, MAX_ROSTER_FILE_BYTES)).toEqual({ ok: true });
    expect(checkRosterFileCarrier({}, MAX_ROSTER_FILE_BYTES + 1)).toMatchObject({ ok: false });
  });

  it("guards the size before parsing, so an oversized file is never decoded", async () => {
    // A byte array over the cap that is not even JSON: the size guard must be what
    // rejects it, which the message proves.
    const oversized = new Uint8Array(MAX_ROSTER_FILE_BYTES + 1);
    const result = await decodeRosterFileBytes(oversized);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("above the");
  });
});

describe("structural and version rejection", () => {
  it("rejects non-UTF-8, non-JSON, and non-object payloads", async () => {
    expect(await decodeRosterFileBytes(new Uint8Array([0xff, 0xfe, 0xfd]))).toMatchObject({
      ok: false,
    });
    expect(await decodeRosterFileBytes(new TextEncoder().encode("{"))).toMatchObject({ ok: false });
    expect(await decodeRosterFileBytes(new TextEncoder().encode("[]"))).toMatchObject({
      ok: false,
    });
  });

  it("rejects a NEWER file with a message naming both versions", async () => {
    const raw = await rawOf(await fixtureRosterDocument());
    raw.schemaVersion = "roster-file/2";
    const result = await decodeRosterFileBytes(reencode(raw));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain("newer version of the app");
      expect(result.reason).toContain("roster-file/2");
    }
  });

  it("rejects a file with no recognizable schema version", async () => {
    const raw = await rawOf(await fixtureRosterDocument());
    delete raw.schemaVersion;
    const result = await decodeRosterFileBytes(reencode(raw));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("roster file schema version");
  });

  it("migrates an OLDER file end to end and IMPORTS it successfully", async () => {
    // The real contract: a supported older file migrates, passes FULL validation at
    // the version it was migrated TO, and decodes. Exercised through an injected
    // policy because v1 is the first version, so migrate-older is otherwise
    // unreachable — and the policy's `currentVersion` and validator advance together,
    // which is precisely what makes this success path reachable at all.
    const document = await fixtureRosterDocument();
    const raw = await rawOf(document);
    const legacy = { ...raw, schemaVersion: rosterFileVersionString(1), legacyNote: "retired" };
    const migration: RosterFileMigration = {
      from: 1,
      migrate: (stored) => {
        // A realistic step: drop a retired field and restamp the version.
        const { legacyNote: _retired, ...rest } = stored;
        return { ok: true, document: { ...rest, schemaVersion: rosterFileVersionString(2) } };
      },
    };

    const migrated = await decodeRosterFileBytes(reencode(legacy), {
      migrations: [migration],
      currentVersion: 2,
    });
    expect(migrated).toMatchObject({ ok: true });
    if (!migrated.ok) return;
    expect(migrated.document.schemaVersion).toBe(rosterFileVersionString(2));
    expect(migrated.document.solvedDays).toEqual(fixtureSolvedDays());
    expect(migrated.document.provenance.solvedBaselineId).toBe(
      document.provenance.solvedBaselineId,
    );
    expect(await bytesOf(migrated.document.frozenXlsx)).toEqual(await bytesOf(document.frozenXlsx));
  });

  it("still enforces the whole-document contract on a MIGRATED document", async () => {
    // Migration is not a bypass: a step that emits a structurally invalid document is
    // rejected by the post-migration validator rather than waved through.
    const raw = await rawOf(await fixtureRosterDocument());
    const legacy = { ...raw, schemaVersion: rosterFileVersionString(1) };
    const corrupting: RosterFileMigration = {
      from: 1,
      migrate: (stored) => ({
        ok: true,
        document: {
          ...stored,
          schemaVersion: rosterFileVersionString(2),
          // An overlay entry equal to its solved day-state — never storable.
          edits: [{ personIdx: 0, dateIdx: 0, day: { kind: "shift", shiftId: "D" } }],
        },
      }),
    };
    const result = await decodeRosterFileBytes(reencode(legacy), {
      migrations: [corrupting],
      currentVersion: 2,
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("equals its solved day-state");
  });

  it("reports a failing migration as a migration failure, not a structural one", async () => {
    const raw = await rawOf(await fixtureRosterDocument());
    const legacy = { ...raw, schemaVersion: rosterFileVersionString(1) };
    const failing = await decodeRosterFileBytes(reencode(legacy), {
      migrations: [
        { from: 1, migrate: () => ({ ok: false, reason: "legacy overlay is ambiguous" }) },
      ],
      currentVersion: 2,
    });
    expect(failing).toMatchObject({ ok: false });
    if (!failing.ok) expect(failing.reason).toContain("legacy overlay is ambiguous");
  });

  it("rejects an older file when the policy registers no chain to current", async () => {
    const raw = await rawOf(await fixtureRosterDocument());
    const legacy = { ...raw, schemaVersion: rosterFileVersionString(1) };
    const result = await decodeRosterFileBytes(reencode(legacy), {
      migrations: [],
      currentVersion: 2,
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("too old");
  });

  it("rejects a file missing a top-level field", async () => {
    const raw = await rawOf(await fixtureRosterDocument());
    delete raw.solvedDays;
    const result = await decodeRosterFileBytes(reencode(raw));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("solvedDays");
  });
});

describe("the embedded workbook", () => {
  async function withWorkbook(patch: Record<string, unknown>): Promise<Uint8Array> {
    const raw = await rawOf(await fixtureRosterDocument());
    raw.frozenXlsx = { ...(raw.frozenXlsx as Record<string, unknown>), ...patch };
    return reencode(raw);
  }

  it("rejects a workbook that is not exactly {base64, mime}", async () => {
    expect(await decodeRosterFileBytes(await withWorkbook({ name: "x.xlsx" }))).toMatchObject({
      ok: false,
    });
    const raw = await rawOf(await fixtureRosterDocument());
    raw.frozenXlsx = "AAAA";
    expect(await decodeRosterFileBytes(reencode(raw))).toMatchObject({ ok: false });
  });

  it("rejects a workbook media type that is not the XLSX type", async () => {
    const result = await decodeRosterFileBytes(await withWorkbook({ mime: "application/zip" }));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("workbook media type");
  });

  it.each([
    ["an empty payload", ""],
    ["a URL-safe alphabet", "a-b_cd"],
    ["embedded whitespace", "AAAA AAAA"],
    ["a length that is not a multiple of four", "AAAAA"],
    ["misplaced padding", "AA=AAAAA"],
    ["a non-base64 character", "AAA$"],
  ])("rejects base64 with %s", async (_label, base64) => {
    expect(await decodeRosterFileBytes(await withWorkbook({ base64 }))).toMatchObject({
      ok: false,
    });
  });

  it("rejects a non-canonically encoded final group", async () => {
    // `atob` would accept "QQ==" and "QR==" alike and normalize the unused bits
    // away, so two different strings would decode to the same workbook. Canonical
    // re-encoding is what closes that.
    const result = await decodeRosterFileBytes(await withWorkbook({ base64: "QR==" }));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("canonically encoded");
    // Control: the canonical spelling of the same byte decodes.
    const control = await decodeRosterFileBytes(await withWorkbook({ base64: "QQ==" }));
    // It decodes to one byte, so it fails LATER (the baseline hash still matches,
    // but a one-byte workbook is a valid Blob) — the point is the base64 layer
    // itself accepted it.
    expect(control).toMatchObject({ ok: true });
  });

  it("rejects a workbook whose DECLARED base64 length exceeds the cap, before decoding", async () => {
    // Pre-decode guard: a base64 string this long must be refused on its length
    // alone rather than allocating the decoded buffer first.
    const oversizedGroups = Math.ceil((MAX_FROZEN_XLSX_BYTES + 3) / 3);
    const base64 = "AAAA".repeat(oversizedGroups);
    const raw = await rawOf(await fixtureRosterDocument());
    raw.frozenXlsx = { base64, mime: XLSX_MEDIA_TYPE };
    const bytes = reencode(raw);
    // The file itself stays under the file cap, so the workbook cap is what fires.
    expect(bytes.length).toBeLessThanOrEqual(MAX_ROSTER_FILE_BYTES);
    const result = await decodeRosterFileBytes(bytes);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("declares");
  });
});

describe("export refuses an invalid document", () => {
  it("will not write a roster file from a tampered document", async () => {
    const document = withProvenance(await fixtureRosterDocument(), { score: Number.NaN });
    expect(await encodeRosterFile(document)).toMatchObject({ ok: false });
  });

  it("will not write a roster file with an un-normalized overlay", async () => {
    const document = withEdits(await fixtureRosterDocument(), [
      { personIdx: 1, dateIdx: 0, day: { kind: "off" } },
      { personIdx: 0, dateIdx: 1, day: { kind: "off" } },
    ]);
    expect(await encodeRosterFile(document)).toMatchObject({ ok: false });
  });
});
