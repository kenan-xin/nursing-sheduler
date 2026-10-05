// d582 Task 20 — temporary cover against the REAL solver.
//
// Follows `roster-real-ward-assembled.spec.ts`: production routes only, the live
// direct Compose stack (`make verify-stream`), no `page.route`, no fixture page, no
// seeded storage. The ward is small on purpose — four nurses, Night needs 3 every
// day, and two of them are on leave on 14 Oct — so the real solver proves the
// night INFEASIBLE, and one temporary cover on N 14 Oct makes it solvable.
//
// The four tests are one journey (serial, one page): each builds on the state the
// previous one left.
//
// Run via: ASSEMBLED_BASE_URL=http://localhost:<port> pnpm exec playwright test
//          --config playwright.assembled.config.ts --grep "temporary cover"

import ExcelJS from "exceljs";
import { expect, test, type Download, type Page } from "@playwright/test";

const COVER = "Haseena (Ward 3)";
const CALENDAR = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
const COVER_DATE_IDX = CALENDAR.indexOf("2026-10-14");
const STAFF = ["ana", "ben", "cara", "dan"];

/** One short on N 14 Oct: ana and ben are on leave, and Night needs 3 of 4. */
const WARD_YAML = `apiVersion: alpha
dates:
  range:
    startDate: ${CALENDAR[0]}
    endDate: ${CALENDAR[CALENDAR.length - 1]}
people:
  items:
${STAFF.map((id) => `    - id: ${id}`).join("\n")}
shiftTypes:
  items:
    - id: AM
    - id: N
preferences:
  - type: at most one shift per day
  - type: shift type requirement
    description: night
    shiftType:
      - N
    requiredNumPeople: 3
    date:
      - ALL
    weight: -1
  - type: shift request
    person: ana
    date: 2026-10-14
    shiftType: LEAVE
    weight: .inf
  - type: shift request
    person: ben
    date: 2026-10-14
    shiftType: LEAVE
    weight: .inf
`;

const BOUND = 60_000;
const SOLVE_SECONDS = 30;

interface Captured {
  filename: string;
  bytes: Buffer;
}

async function consume(download: Download): Promise<Captured> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  const captured = { filename: download.suggestedFilename(), bytes: Buffer.concat(chunks) };
  await download.delete();
  return captured;
}

function text(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "richText" in value) {
    return value.richText.map((run) => run.text).join("");
  }
  return String(value).trim();
}

/**
 * Her row sits directly under the four staff rows, holds N in the 14 Oct column
 * only, and the provenance sheet lists her in its "Temporary cover" table.
 */
async function expectCoverWorkbook(label: string, bytes: Buffer): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<ExcelJS.Xlsx["load"]>[0]);
  const sheet = workbook.worksheets[0];
  const column = (row: number) =>
    Array.from({ length: sheet.columnCount }, (_, idx) => text(sheet.getCell(row, idx + 1).value));

  const names = Array.from({ length: sheet.rowCount }, (_, idx) =>
    text(sheet.getCell(idx + 1, 1).value),
  );
  const coverRow = names.indexOf(COVER) + 1;
  expect(coverRow, `${label}: her row`).toBeGreaterThan(0);
  expect(names.slice(coverRow - 1 - STAFF.length, coverRow - 1), `${label}: staff above`).toEqual(
    STAFF,
  );

  // Day-number row 1 locates the 14 Oct column; every other cell of her row is blank.
  const dayColumn = column(1).indexOf("14") + 1;
  expect(dayColumn, `${label}: the 14 Oct column`).toBeGreaterThan(1);
  const cells = column(coverRow);
  expect(cells[dayColumn - 1], `${label}: N on 14 Oct`).toBe("N");
  expect(
    cells.filter((value, idx) => idx > 0 && idx !== dayColumn - 1 && value !== ""),
    `${label}: nothing else on her row`,
  ).toEqual([]);

  const provenance = workbook.getWorksheet("Roster provenance");
  expect(provenance, `${label}: provenance sheet`).toBeDefined();
  // `getSheetValues` is sparse; `Array.from` turns its holes into empty rows.
  const rows = Array.from(provenance!.getSheetValues(), (row) =>
    Array.isArray(row) ? Array.from(row.slice(1), (value) => text(value ?? null)) : [],
  );
  const heading = rows.findIndex((row) => row[0] === "Temporary cover");
  expect(heading, `${label}: provenance cover table`).toBeGreaterThanOrEqual(0);
  expect(rows[heading + 1]).toEqual(["Name", "Date", "Shift type", "Groups"]);
  expect(rows[heading + 2]).toEqual([COVER, "2026-10-14", "N", "[]"]);
}

/** Her band row: N on 14 Oct, and no chip or rest glyph anywhere else. */
async function expectBandRow(page: Page, status: string): Promise<void> {
  const row = page.getByTestId("roster-cover-band-row");
  await expect(row).toHaveCount(1, { timeout: BOUND });
  await expect(row).toHaveAttribute("data-cover-name", COVER);
  await expect(row).toHaveAttribute("data-cover-status", status);
  const cells = row.getByTestId("roster-cover-band-cell");
  await expect(cells).toHaveCount(CALENDAR.length);
  for (let idx = 0; idx < CALENDAR.length; idx++) {
    if (idx === COVER_DATE_IDX) await expect(cells.nth(idx)).toHaveText("N");
    else await expect(cells.nth(idx)).toBeEmpty();
  }
}

async function optimize(page: Page): Promise<void> {
  await page.goto("/optimize-and-export", { timeout: BOUND });
  const submit = page.getByTestId("optimize-submit");
  await expect(submit).toBeEnabled({ timeout: BOUND });
  await page.locator("#optimize-timeout").fill(String(SOLVE_SECONDS));
  await submit.click();
}

test.describe("temporary cover on a real ward", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(4 * BOUND);

  let page: Page;
  const downloads: Download[] = [];
  let cursor = 0;
  const nextDownload = async (): Promise<Captured> => {
    await expect.poll(() => downloads.length, { timeout: BOUND }).toBeGreaterThan(cursor);
    cursor += 1;
    return consume(downloads[cursor - 1]);
  };

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ acceptDownloads: true })).newPage();
    page.on("download", (download) => downloads.push(download));
  });

  test.afterAll(async () => {
    await page.context().close();
  });

  test("a ward one short on N 14 Oct is INFEASIBLE", async () => {
    await page.goto("/save-and-load", { timeout: BOUND });
    await expect(page.getByTestId("scenario-file-card")).toBeVisible({ timeout: BOUND });
    await page.getByTestId("scenario-upload-button").click();
    await page.getByTestId("upload-file-input").setInputFiles({
      name: "one-short-night.yaml",
      mimeType: "application/x-yaml",
      buffer: Buffer.from(WARD_YAML),
    });
    await page.getByTestId("confirm-dialog-confirm").click({ timeout: BOUND });
    await expect(page.getByText(/Scenario loaded/)).toBeVisible({ timeout: BOUND });

    await optimize(page);
    const infeasible = page.getByTestId("optimize-infeasible");
    await expect(infeasible).toBeVisible({ timeout: 2 * BOUND });
    await expect(infeasible).toContainText("verdict: infeasibility_proven");
    await expect(page.getByTestId("optimize-open-roster")).toHaveCount(0);
  });

  test("with one cover it solves, and her band row shows N on 14 Oct only", async () => {
    await page.goto("/people", { timeout: BOUND });
    await page.getByTestId("temporary-cover-add").click({ timeout: BOUND });
    await page.getByTestId("temporary-cover-name").fill(COVER);
    await page.getByTestId("temporary-cover-date").fill("2026-10-14");
    await page.getByTestId("temporary-cover-shift").selectOption("N");
    await page.getByTestId("temporary-cover-save").click();
    await expect(page.getByTestId("temporary-cover-effect-0")).toContainText("3 → 2");

    await optimize(page);
    await expect(page.getByTestId("optimize-completed-artifact")).toContainText(
      "downloaded successfully",
      { timeout: 2 * BOUND },
    );
    await expect(page.getByTestId("optimize-summary-solver-status")).toHaveText(
      /^(OPTIMAL|FEASIBLE)$/,
    );
    const raw = await nextDownload();
    expect(raw.filename).toMatch(/\.xlsx$/);
    await expectCoverWorkbook("the raw Optimize download", raw.bytes);

    await page.getByTestId("optimize-open-roster").click({ timeout: BOUND });
    await expect(page.getByTestId("roster-viewer")).toBeVisible({ timeout: BOUND });
    await expect(page.getByTestId("roster-cover-band-heading")).toHaveText("Temporary cover");
    await expectBandRow(page, "solved");
  });

  test("the Excel download has her row under the staff rows and a provenance cover table", async () => {
    await page.getByTestId("roster-export-xlsx").click({ timeout: BOUND });
    const edited = await nextDownload();
    // A cover is not an edit (C-33): no grid edits, so no "-edited" suffix.
    expect(edited.filename).toMatch(/^roster-\d{4}-\d{2}-\d{2}\.xlsx$/);
    await expectCoverWorkbook("the edited roster export", edited.bytes);
    await expect(page.getByTestId("roster-action-error")).toHaveCount(0);
  });

  test("the roster file round-trips cover", async () => {
    await page.getByTestId("roster-export-file").click({ timeout: BOUND });
    const file = await nextDownload();
    const decoded = JSON.parse(file.bytes.toString("utf-8")) as {
      schemaVersion: string;
      cover: { entries: unknown[]; decrements: unknown[] };
    };
    expect(decoded.schemaVersion).toBe("roster-file/2");
    expect(decoded.cover.entries).toEqual([
      { name: COVER, iso: "2026-10-14", shiftId: "N", groups: [] },
    ]);
    expect(decoded.cover.decrements).toHaveLength(1);

    await page.getByTestId("roster-clear").click();
    await page.getByTestId("confirm-dialog-confirm").click({ timeout: BOUND });
    await expect(page.getByTestId("roster-viewer")).toHaveCount(0, { timeout: BOUND });

    // Had the file dropped `cover`, the live scenario cover would read NOT OPTIMIZED YET.
    await page.locator('input[type="file"]').setInputFiles({
      name: file.filename,
      mimeType: "application/json",
      buffer: file.bytes,
    });
    await expect(page.getByTestId("roster-viewer")).toBeVisible({ timeout: BOUND });
    await expect(page.getByTestId("roster-action-error")).toHaveCount(0);
    await expectBandRow(page, "solved");
  });
});
