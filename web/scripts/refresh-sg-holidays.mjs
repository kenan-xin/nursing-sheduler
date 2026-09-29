// Regenerate the bundled Singapore holiday snapshot in lib/dates/holidays-sg.ts from the
// data.gov.sg MOM consolidated dataset (bead si4j). Deterministic: rows sorted by date
// then name, one line each, written between the GENERATED markers, so an unchanged
// dataset leaves the file byte-identical. Run from web/: `pnpm refresh:sg-holidays`.
// Mirrors `parseHolidayName` / `parseUpstreamHolidays` in lib/dates (a plain .mjs
// cannot import the TS modules).

import { readFileSync, writeFileSync } from "node:fs";

const URL_ =
  "https://data.gov.sg/api/action/datastore_search?resource_id=d_8ef23381f9417e4d4254ee8b4dcdb176&limit=1000";
const FILE = new URL("../lib/dates/holidays-sg.ts", import.meta.url);
const BEGIN = "  // BEGIN GENERATED (scripts/refresh-sg-holidays.mjs)\n";
const END = "  // END GENERATED\n";
const OBSERVED = " (Observed)";

const response = await fetch(URL_, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`data.gov.sg answered HTTP ${response.status}`);
const body = await response.json();
const records = body?.result?.records;
if (body?.success !== true || !Array.isArray(records) || records.length === 0) {
  throw new Error("data.gov.sg answered an unexpected body");
}
if (body.result.total !== records.length) {
  throw new Error(`incomplete page: ${records.length} of ${body.result.total} rows`);
}

const rows = records.map(({ date, holiday }) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof holiday !== "string" || !holiday.trim()) {
    throw new Error(`bad row: ${JSON.stringify({ date, holiday })}`);
  }
  const isObserved = holiday.endsWith(OBSERVED);
  const name = isObserved ? holiday.slice(0, -OBSERVED.length) : holiday;
  return { date, name, isObserved };
});
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0); // code-unit order, locale-free
rows.sort((a, b) => cmp(a.date, b.date) || cmp(a.name, b.name));

const generated = rows
  .map(
    (r) =>
      `  { date: ${JSON.stringify(r.date)}, name: ${JSON.stringify(r.name)}, isObserved: ${r.isObserved} },\n`,
  )
  .join("");

const source = readFileSync(FILE, "utf8");
const start = source.indexOf(BEGIN);
const end = source.indexOf(END);
if (start < 0 || end < start) throw new Error("GENERATED markers not found in holidays-sg.ts");
const next = source.slice(0, start + BEGIN.length) + generated + source.slice(end);
if (next === source) {
  console.log(`holidays-sg.ts unchanged (${rows.length} rows)`);
} else {
  writeFileSync(FILE, next);
  console.log(
    `holidays-sg.ts regenerated: ${rows.length} rows, ${rows[0].date} to ${rows.at(-1).date}`,
  );
}
