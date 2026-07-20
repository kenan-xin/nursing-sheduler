// @vitest-environment jsdom
//
// T16c browser-execution gate: confirms the ExcelJS dynamic import and the full
// restorePeopleIdsInXlsx path actually execute in a browser-like environment
// (jsdom here; Playwright exercises the real browser route under T16f). The
// companion test file runs under Node so it can shell out to openpyxl for the
// independent semantic diff; this one only proves the module loads and runs
// where T16e will actually call it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RESTORED_XLSX_MIME_TYPE,
  applyPeopleIdRestoration,
  restorePeopleIdsInXlsx,
} from "./restore-people-ids-in-xlsx";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "c5");
const PLAIN = JSON.parse(readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf-8"))[
  "plain-3people"
] as { file: string; peopleCount: number; columnAIds: string[] };

function fixtureBlob(): Blob {
  // Node 18+'s global Blob is what jsdom also surfaces; the typed array is
  // copied so the restoration path's input stays immutable.
  const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, PLAIN.file)));
  return new Blob([bytes as BlobPart], { type: RESTORED_XLSX_MIME_TYPE });
}

describe("restorePeopleIdsInXlsx — runs in a browser-like environment", () => {
  it("dynamically imports ExcelJS, restores column A, and returns a Blob", async () => {
    const blob = fixtureBlob();
    const restored = await restorePeopleIdsInXlsx(
      blob,
      PLAIN.columnAIds.map((anon) => [anon, `orig-${anon}`]) as Array<[string, string]>,
      PLAIN.peopleCount,
    );
    expect(restored).toBeInstanceOf(Blob);
    expect(restored.type).toBe(RESTORED_XLSX_MIME_TYPE);
    expect(restored.size).toBeGreaterThan(0);
  });

  it("applyPeopleIdRestoration bypass returns the same blob reference when not anonymized", async () => {
    const blob = fixtureBlob();
    const result = await applyPeopleIdRestoration(blob, {
      anonymized: false,
      reverseMap: [],
      peopleCount: PLAIN.peopleCount,
    });
    expect(result).toBe(blob);
  });
});
