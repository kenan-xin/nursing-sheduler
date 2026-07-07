/*
 * This file is part of Nurse Scheduling Project, see <https://github.com/j3soon/nurse-scheduling>.
 *
 * Copyright (C) 2023-2026 Johnson Sun
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Singapore public holidays are sourced live from data.gov.sg (MOM consolidated dataset).
// Each entry corresponds to either an actual holiday or its "(Observed)" substitute day.
import { DateRange, Group, Item } from '@/types/scheduling';
import { dateStrToDate } from '@/utils/dateParsing';
import {
  readStoredSingaporeHolidays,
  writeStoredSingaporeHolidays,
} from '@/utils/singaporeHolidaysStorage';

export const SINGAPORE_WORKDAY_GROUP_ID = 'WORKDAY';
export const SINGAPORE_FREEDAY_GROUP_ID = 'FREEDAY';

export const SINGAPORE_HOLIDAYS_DATASET_ID = 'd_8ef23381f9417e4d4254ee8b4dcdb176';
const SINGAPORE_HOLIDAYS_API_URL =
  `https://data.gov.sg/api/action/datastore_search?resource_id=${SINGAPORE_HOLIDAYS_DATASET_ID}&limit=200`;
const OBSERVED_SUFFIX = ' (Observed)';

export interface SingaporeHolidayEntry {
  date: string;
  name: string;
  isObserved: boolean;
}

interface SingaporeHolidayApiRecord {
  date: string;
  holiday: string;
}

interface SingaporeHolidayApiResponse {
  success: boolean;
  result?: {
    records: SingaporeHolidayApiRecord[];
  };
}

interface CacheState {
  entries: SingaporeHolidayEntry[] | null;
  inflight: Promise<SingaporeHolidayEntry[]> | null;
}

const cache: CacheState = {
  entries: null,
  inflight: null,
};

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function parseApiResponse(payload: SingaporeHolidayApiResponse): SingaporeHolidayEntry[] {
  if (!payload.success || !payload.result) {
    throw new Error('Unexpected data.gov.sg response: missing success flag or result');
  }
  return payload.result.records.map(record => {
    const isObserved = record.holiday.endsWith(OBSERVED_SUFFIX);
    const name = isObserved ? record.holiday.slice(0, -OBSERVED_SUFFIX.length) : record.holiday;
    return { date: record.date, name, isObserved };
  });
}

export function resetSingaporeHolidaysCache(): void {
  cache.entries = null;
  cache.inflight = null;
}

export function getCachedSingaporeHolidays(): SingaporeHolidayEntry[] | null {
  return cache.entries;
}

export async function loadSingaporeHolidaysFromIdb(): Promise<SingaporeHolidayEntry[] | null> {
  try {
    const stored = await readStoredSingaporeHolidays();
    if (!stored || !Array.isArray(stored.entries) || stored.entries.length === 0) {
      return null;
    }
    cache.entries = stored.entries;
    return stored.entries;
  } catch {
    // IndexedDB may be unavailable (private mode, disabled, very old browser, test env).
    // Treat the absence of a persistent cache as a soft failure.
    return null;
  }
}

export async function fetchSingaporeHolidays(): Promise<SingaporeHolidayEntry[]> {
  if (cache.entries) {
    return cache.entries;
  }
  if (cache.inflight) {
    return cache.inflight;
  }

  const inflight = (async () => {
    const response = await fetch(SINGAPORE_HOLIDAYS_API_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch Singapore public holidays: HTTP ${response.status}`);
    }
    const payload = await response.json() as SingaporeHolidayApiResponse;
    const entries = parseApiResponse(payload);
    cache.entries = entries;
    cache.inflight = null;
    void writeStoredSingaporeHolidays({ entries, fetchedAt: Date.now() }).catch(() => {
      // Persisting the cache is best-effort; a failure here must not break the in-memory result.
    });
    return entries;
  })();

  cache.inflight = inflight;
  try {
    return await inflight;
  } catch (error) {
    cache.inflight = null;
    throw error;
  }
}

interface SupportedRange {
  start: string;
  end: string;
}

function getSupportedRange(entries: SingaporeHolidayEntry[]): SupportedRange | null {
  if (entries.length === 0) {
    return null;
  }
  let start = entries[0].date;
  let end = entries[0].date;
  for (const entry of entries) {
    if (entry.date < start) start = entry.date;
    if (entry.date > end) end = entry.date;
  }
  return { start, end };
}

export function getSingaporeHolidaySupportLabel(entries: SingaporeHolidayEntry[]): string {
  const range = getSupportedRange(entries);
  if (range === null) {
    return 'no data loaded';
  }
  return `${range.start} to ${range.end}`;
}

export function isSingaporeHolidayRangeSupported(
  dateRange: DateRange,
  entries: SingaporeHolidayEntry[],
): boolean {
  if (entries.length === 0) {
    return false;
  }
  if (!dateRange.startDate || !dateRange.endDate) {
    return false;
  }
  const range = getSupportedRange(entries);
  if (range === null) {
    return false;
  }
  const start = formatDate(dateRange.startDate);
  const end = formatDate(dateRange.endDate);
  return start >= range.start && end <= range.end;
}

function buildFreedaySet(entries: SingaporeHolidayEntry[]): Set<string> {
  return new Set(entries.map(entry => entry.date));
}

export function isSingaporeFreeday(date: Date, entries: SingaporeHolidayEntry[]): boolean {
  if (entries.length === 0) {
    return false;
  }
  const freedaySet = buildFreedaySet(entries);
  if (freedaySet.has(formatDate(date))) {
    return true;
  }
  const weekday = date.getUTCDay();
  return weekday === 0 || weekday === 6;
}

export function getSingaporeDayType(
  date: Date,
  entries: SingaporeHolidayEntry[],
): 'WORKDAY' | 'FREEDAY' | undefined {
  const range = getSupportedRange(entries);
  if (range === null) {
    return undefined;
  }
  const dateKey = formatDate(date);
  if (dateKey < range.start || dateKey > range.end) {
    return undefined;
  }
  return isSingaporeFreeday(date, entries) ? SINGAPORE_FREEDAY_GROUP_ID : SINGAPORE_WORKDAY_GROUP_ID;
}

function includesDate(dateRange: DateRange, dateKey: string): boolean {
  if (!dateRange.startDate || !dateRange.endDate) {
    return false;
  }
  const start = formatDate(dateRange.startDate);
  const end = formatDate(dateRange.endDate);
  return start <= dateKey && dateKey <= end;
}

export function getSingaporeHolidayEntriesInRange(
  dateRange: DateRange,
  entries: SingaporeHolidayEntry[],
): SingaporeHolidayEntry[] {
  if (!dateRange.startDate || !dateRange.endDate || entries.length === 0) {
    return [];
  }
  return entries.filter(entry => includesDate(dateRange, entry.date));
}

export function buildSingaporeHolidayGroups(
  items: Item[],
  dateRange: DateRange,
  entries: SingaporeHolidayEntry[],
): Group[] {
  if (!dateRange.startDate || !dateRange.endDate) {
    return [];
  }
  if (!isSingaporeHolidayRangeSupported(dateRange, entries)) {
    return [];
  }

  const freedaySet = buildFreedaySet(entries);
  const workdayMembers: string[] = [];
  const freedayMembers: string[] = [];

  for (const item of items) {
    const date = dateStrToDate(item.id, dateRange);
    const dateKey = formatDate(date);
    if (freedaySet.has(dateKey) || date.getUTCDay() === 0 || date.getUTCDay() === 6) {
      freedayMembers.push(item.id);
    } else {
      workdayMembers.push(item.id);
    }
  }

  return [
    {
      id: SINGAPORE_WORKDAY_GROUP_ID,
      description: 'Singapore workdays imported from the data.gov.sg public holidays dataset',
      members: workdayMembers,
    },
    {
      id: SINGAPORE_FREEDAY_GROUP_ID,
      description: 'Singapore freedays imported from the data.gov.sg public holidays dataset',
      members: freedayMembers,
    },
  ];
}
