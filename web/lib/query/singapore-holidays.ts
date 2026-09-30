"use client";

// Client loader for the Singapore holiday list (bead si4j). Order: the LIVE list from
// `/api/public-holidays` -> the browser's LAST GOOD live list (IndexedDB keyval) ->
// the BUNDLED snapshot. The chosen list is installed into `lib/dates/holidays-sg`, whose
// synchronous helpers every screen and the assistant already call.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  getSingaporeHolidays,
  mergeSingaporeHolidays,
  setSingaporeHolidays,
  SINGAPORE_HOLIDAYS,
  singaporeHolidayListSchema,
  singaporeHolidaysResponseSchema,
  subscribeSingaporeHolidays,
  type SingaporeHolidayEntry,
} from "@/lib/dates/holidays-sg";
import { getRosterDb } from "@/lib/store/dexie-storage";
import { singaporeHolidaysKey } from "@/lib/query/keys";

export const LAST_GOOD_HOLIDAYS_KEY = "sg-public-holidays:v1";

// The live answer carries bundled rows for years data.gov.sg lacks, so the saved copy
// is tied to the bundle it was merged with: a newer bundle (a refresh deploy) wins.
const BUNDLE_VERSION = JSON.stringify(SINGAPORE_HOLIDAYS);
const lastGoodSchema = z.strictObject({
  bundle: z.string(),
  entries: singaporeHolidayListSchema,
});

async function readLastGood(): Promise<SingaporeHolidayEntry[] | null> {
  try {
    const row = await getRosterDb().keyval.get(LAST_GOOD_HOLIDAYS_KEY);
    if (!row) return null;
    const saved = lastGoodSchema.parse(JSON.parse(row.value));
    return saved.bundle === BUNDLE_VERSION ? saved.entries : null;
  } catch {
    return null; // no IndexedDB, or a corrupt or pre-version row: the bundle still stands
  }
}

async function writeLastGood(entries: readonly SingaporeHolidayEntry[]): Promise<void> {
  try {
    await getRosterDb().keyval.put({
      key: LAST_GOOD_HOLIDAYS_KEY,
      value: JSON.stringify({ bundle: BUNDLE_VERSION, entries }),
    });
  } catch {
    // Best effort: losing the last-good copy only means the bundle is the next fallback.
  }
}

/** The best list available right now. Never throws. */
export async function fetchSingaporeHolidayList(
  signal?: AbortSignal,
): Promise<readonly SingaporeHolidayEntry[]> {
  try {
    const response = await fetch("/api/public-holidays", { cache: "no-store", signal });
    const body = singaporeHolidaysResponseSchema.parse(await response.json());
    if (body.source === "live") {
      await writeLastGood(body.entries);
      return body.entries;
    }
  } catch {
    // fall through to the last-good copy
  }
  const lastGood = await readLastGood();
  return lastGood ? mergeSingaporeHolidays(lastGood, SINGAPORE_HOLIDAYS) : SINGAPORE_HOLIDAYS;
}

/** Mounted once (app Providers): loads the list and installs it for the helpers. */
export function useLoadSingaporeHolidays(): void {
  const { data } = useQuery({
    queryKey: singaporeHolidaysKey,
    queryFn: ({ signal }) => fetchSingaporeHolidayList(signal),
    staleTime: Infinity,
  });
  useEffect(() => {
    if (data) setSingaporeHolidays(data);
  }, [data]);
}

/** The active list; a component that marks holidays calls this to re-render on swap. */
export function useSingaporeHolidayList(): readonly SingaporeHolidayEntry[] {
  return useSyncExternalStore(
    subscribeSingaporeHolidays,
    getSingaporeHolidays,
    () => SINGAPORE_HOLIDAYS,
  );
}
