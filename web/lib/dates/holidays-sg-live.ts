// Server side of the live Singapore holiday list (bead si4j). The route
// `app/api/public-holidays` calls `loadSingaporeHolidays`; it lives here because a
// Next route file may export only its handlers.
//
// One GET to data.gov.sg's datastore_search API (no key required), validated with
// zod, merged over the bundled snapshot BY YEAR (live wins), cached in server memory
// for a day. Any failure answers the bundled list with `source: "bundled"`, and is
// not cached, so the next request retries.

import { z } from "zod";
import { isValidIso } from "./date-id";
import {
  mergeSingaporeHolidays,
  parseHolidayName,
  SINGAPORE_HOLIDAYS,
  type SingaporeHolidayEntry,
  type SingaporeHolidaysResponse,
} from "./holidays-sg";

export const SG_HOLIDAYS_DATASET_ID = "d_8ef23381f9417e4d4254ee8b4dcdb176";
// ponytail: one page of 1000 rows (~13 a year, so ~75 years); a `total` above the page
// fails validation, and pagination can come when that day arrives.
export const SG_HOLIDAYS_URL = `https://data.gov.sg/api/action/datastore_search?resource_id=${SG_HOLIDAYS_DATASET_ID}&limit=1000`;
export const SG_HOLIDAYS_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

const upstreamSchema = z
  .object({
    success: z.literal(true),
    result: z.object({
      total: z.number().int(),
      records: z
        .array(
          z.object({
            date: z.string().refine(isValidIso, "not a calendar date"),
            holiday: z.string().trim().min(1),
          }),
        )
        .min(1),
    }),
  })
  .refine((body) => body.result.total === body.result.records.length, "incomplete page");

/** The upstream body as entries, sorted by date. Throws on anything off-contract. */
export function parseUpstreamHolidays(body: unknown): SingaporeHolidayEntry[] {
  return upstreamSchema
    .parse(body)
    .result.records.map((r) => ({ date: r.date, ...parseHolidayName(r.holiday) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

let cache: { entries: SingaporeHolidayEntry[]; expiresAt: number } | null = null;

/** Tests only: forget the cached live list. */
export function resetSingaporeHolidayCache(): void {
  cache = null;
}

const BUNDLED: SingaporeHolidaysResponse = { source: "bundled", entries: [...SINGAPORE_HOLIDAYS] };

export async function loadSingaporeHolidays(
  now: number = Date.now(),
): Promise<SingaporeHolidaysResponse> {
  if (cache && now < cache.expiresAt) return { source: "live", entries: cache.entries };
  // E2E and offline deployments: deterministic, no network.
  if (process.env.SG_HOLIDAYS_OFFLINE === "1") return BUNDLED;
  try {
    const response = await fetch(SG_HOLIDAYS_URL, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const entries = mergeSingaporeHolidays(
      parseUpstreamHolidays(await response.json()),
      SINGAPORE_HOLIDAYS,
    );
    cache = { entries, expiresAt: now + SG_HOLIDAYS_TTL_MS };
    return { source: "live", entries };
  } catch (error) {
    console.error("[api/public-holidays] live fetch failed, answering the bundled list", error);
    return BUNDLED;
  }
}
