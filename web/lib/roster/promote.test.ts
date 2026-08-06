// The F3 → F1 promotion seam, against a real IndexedDB (fake-indexeddb globals).
//
// The claim under test is Core Flows' atomicity guarantee: "the incoming document
// is staged, validated, and durably committed BEFORE the current roster is
// replaced; on any failure the current roster is untouched." Every rejection case
// therefore asserts the surviving working roster, not just the returned status — a
// status alone would not prove nothing was overwritten.

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ScenarioPersistenceDb } from "@/lib/store/dexie-storage";
import { createRosterStorageForDb, type RosterStorage } from "@/lib/store/roster-storage";
import { encodeRosterFile } from "./file";
import {
  importRosterBytesToWorking,
  promoteCandidateRosterToWorking,
  promoteRosterDocumentToWorking,
  type PromotionFence,
} from "./promote";
import {
  fixtureFrozenXlsx,
  fixtureRosterDocument,
  withEdits,
  withProvenance,
} from "./test-fixtures";
import type { RosterDocument } from "./types";

let dbCounter = 0;
function openStorage(): RosterStorage {
  const db = new ScenarioPersistenceDb(`roster-promote-test-${dbCounter++}`);
  return createRosterStorageForDb(() => db);
}

async function fenceFor(storage: RosterStorage): Promise<PromotionFence> {
  const working = await storage.readWorking();
  return {
    storage,
    expectedWorkingRevision: working?.revision ?? null,
    expectedClearEpoch: await storage.getClearEpoch(),
  };
}

async function encodedBytes(document: RosterDocument): Promise<Uint8Array> {
  const result = await encodeRosterFile(document);
  if (!result.ok) throw new Error(result.reason);
  return result.file.bytes;
}

/** The working roster as F1 durably holds it, read back through the repository. */
async function readWorkingDocument(storage: RosterStorage): Promise<RosterDocument | null> {
  return (await storage.readWorking<RosterDocument>())?.document ?? null;
}

describe("importing a roster file into the working roster", () => {
  it("promotes a valid file and stores the validated document", async () => {
    const storage = openStorage();
    const document = await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(41) });
    const outcome = await importRosterBytesToWorking(
      await encodedBytes(document),
      await fenceFor(storage),
    );
    expect(outcome).toEqual({ status: "promoted", revision: 1 });

    const stored = await readWorkingDocument(storage);
    expect(stored?.provenance.solvedBaselineId).toBe(document.provenance.solvedBaselineId);
    expect(stored?.solvedDays).toEqual(document.solvedDays);
    // The Blob survived the IndexedDB round trip — the reason F1 stores structured
    // values rather than the string `StateStorage` facade.
    expect(stored?.frozenXlsx).toBeInstanceOf(Blob);
    expect(stored?.frozenXlsx.size).toBe(41);
  });

  it("replaces an existing working roster and bumps its revision", async () => {
    const storage = openStorage();
    const first = await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(11) });
    await importRosterBytesToWorking(await encodedBytes(first), await fenceFor(storage));

    const second = await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(22) });
    const outcome = await importRosterBytesToWorking(
      await encodedBytes(second),
      await fenceFor(storage),
    );
    expect(outcome).toEqual({ status: "promoted", revision: 2 });
    expect((await readWorkingDocument(storage))?.frozenXlsx.size).toBe(22);
  });

  it("keeps the current roster intact when the incoming file is malformed", async () => {
    const storage = openStorage();
    const current = await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(11) });
    await importRosterBytesToWorking(await encodedBytes(current), await fenceFor(storage));
    const fence = await fenceFor(storage);

    const malformed = [
      new TextEncoder().encode("{ not json"),
      new TextEncoder().encode("[]"),
      new Uint8Array(0),
    ];
    for (const bytes of malformed) {
      const outcome = await importRosterBytesToWorking(bytes, fence);
      expect(outcome.status).toBe("import-rejected");
    }

    const stored = await readWorkingDocument(storage);
    expect(stored?.frozenXlsx.size).toBe(11);
    expect((await storage.readWorking())?.revision).toBe(1);
  });

  it("keeps the current roster intact when the file is a NEWER schema version", async () => {
    const storage = openStorage();
    const current = await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(11) });
    await importRosterBytesToWorking(await encodedBytes(current), await fenceFor(storage));

    const incoming = await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(22) });
    const raw = JSON.parse(new TextDecoder().decode(await encodedBytes(incoming))) as Record<
      string,
      unknown
    >;
    raw.schemaVersion = "roster-file/2";

    const outcome = await importRosterBytesToWorking(
      new TextEncoder().encode(JSON.stringify(raw)),
      await fenceFor(storage),
    );
    expect(outcome.status).toBe("import-rejected");
    if (outcome.status === "import-rejected") {
      expect(outcome.reason).toContain("newer version of the app");
    }
    expect((await readWorkingDocument(storage))?.frozenXlsx.size).toBe(11);
  });

  it("keeps the current roster intact when the file's baseline hash was tampered with", async () => {
    const storage = openStorage();
    const current = await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(11) });
    await importRosterBytesToWorking(await encodedBytes(current), await fenceFor(storage));

    const incoming = await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(22) });
    const raw = JSON.parse(new TextDecoder().decode(await encodedBytes(incoming))) as Record<
      string,
      unknown
    >;
    // Structurally perfect, semantically a lie about what was solved.
    (raw.solvedDays as { kind: string }[][])[0][0] = { kind: "off" };

    const outcome = await importRosterBytesToWorking(
      new TextEncoder().encode(JSON.stringify(raw)),
      await fenceFor(storage),
    );
    expect(outcome.status).toBe("import-rejected");
    expect((await readWorkingDocument(storage))?.frozenXlsx.size).toBe(11);
  });
});

describe("promotion runs through F1's real gate, not around it", () => {
  it("is rejected by F1 when the in-memory document does not validate", async () => {
    const storage = openStorage();
    // A document that never validated in the first place: assembly now runs the same
    // gate, so this is constructed by patching a valid one rather than assembled.
    const document = withProvenance(await fixtureRosterDocument(), { appBuild: "" });
    const outcome = await promoteRosterDocumentToWorking(document, await fenceFor(storage));
    expect(outcome.status).toBe("rejected");
    expect(await readWorkingDocument(storage)).toBeNull();
  });

  it("reports a working-roster conflict rather than overwriting a newer autosave", async () => {
    const storage = openStorage();
    const document = await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(11) });
    const fence = await fenceFor(storage);
    // An autosave lands between reading the revision and promoting.
    await storage.writeWorking({
      document: await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(99) }),
      expectedRevision: null,
      expectedClearEpoch: fence.expectedClearEpoch,
    });

    const outcome = await promoteRosterDocumentToWorking(document, fence);
    expect(outcome).toEqual({ status: "working-conflict", currentRevision: 1 });
    expect((await readWorkingDocument(storage))?.frozenXlsx.size).toBe(99);
  });

  it("is rejected when Clear invalidated the epoch the import started under", async () => {
    const storage = openStorage();
    const document = await fixtureRosterDocument();
    const fence = await fenceFor(storage);
    await storage.clearRosterData();

    const outcome = await importRosterBytesToWorking(await encodedBytes(document), fence);
    expect(outcome.status).toBe("stale-epoch");
    expect(await readWorkingDocument(storage)).toBeNull();
  });
});

describe("promoting a captured candidate", () => {
  it("validates the stored candidate and promotes it, keeping the candidate", async () => {
    const storage = openStorage();
    const document = await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(31) });
    const epoch = await storage.getClearEpoch();
    const committed = await storage.commitCandidate({
      jobId: "job-1",
      submissionOrdinal: 1,
      document,
      expectedClearEpoch: epoch,
    });
    expect(committed.status).toBe("committed");

    const outcome = await promoteCandidateRosterToWorking("job-1", await fenceFor(storage));
    expect(outcome).toEqual({ status: "promoted", revision: 1 });
    expect((await readWorkingDocument(storage))?.frozenXlsx.size).toBe(31);
    // Promotion is a copy, not a move: Load can be repeated after an edit.
    expect(await storage.readCandidate("job-1")).not.toBeNull();
  });

  it("reports a missing candidate instead of clearing the working roster", async () => {
    const storage = openStorage();
    const current = await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(11) });
    await importRosterBytesToWorking(await encodedBytes(current), await fenceFor(storage));

    const outcome = await promoteCandidateRosterToWorking("job-absent", await fenceFor(storage));
    expect(outcome).toEqual({ status: "source-missing" });
    expect((await readWorkingDocument(storage))?.frozenXlsx.size).toBe(11);
  });

  it("rejects a candidate that no longer validates, leaving the working roster alone", async () => {
    const storage = openStorage();
    const current = await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(11) });
    await importRosterBytesToWorking(await encodedBytes(current), await fenceFor(storage));

    // A candidate stored by some other path with an un-normalized overlay: the
    // promotion gate is where that is caught, not the viewer.
    const broken = withEdits(await fixtureRosterDocument({ frozenXlsx: fixtureFrozenXlsx(22) }), [
      { personIdx: 0, dateIdx: 1, day: { kind: "off" } },
      { personIdx: 0, dateIdx: 1, day: { kind: "leave" } },
    ]);
    await storage.commitCandidate({
      jobId: "job-2",
      submissionOrdinal: 2,
      document: broken,
      expectedClearEpoch: await storage.getClearEpoch(),
    });

    const outcome = await promoteCandidateRosterToWorking("job-2", await fenceFor(storage));
    expect(outcome.status).toBe("rejected");
    expect((await readWorkingDocument(storage))?.frozenXlsx.size).toBe(11);
  });
});
