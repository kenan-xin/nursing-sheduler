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

// Persistent cache for Singapore public holidays backed by IndexedDB.
import { del, get, set } from 'idb-keyval';
import type { SingaporeHolidayEntry } from '@/utils/singaporeHolidays';

export interface StoredSingaporeHolidays {
  entries: SingaporeHolidayEntry[];
  fetchedAt: number;
}

// Bump the suffix in SINGAPORE_HOLIDAYS_STORAGE_KEY whenever the StoredSingaporeHolidays
// shape changes in a backwards-incompatible way so stale entries are ignored on read.
export const SINGAPORE_HOLIDAYS_STORAGE_KEY = 'singapore-holidays:v1';

export async function readStoredSingaporeHolidays(): Promise<StoredSingaporeHolidays | null> {
  const stored = await get(SINGAPORE_HOLIDAYS_STORAGE_KEY);
  if (stored === undefined || stored === null) {
    return null;
  }
  return stored as StoredSingaporeHolidays;
}

export async function writeStoredSingaporeHolidays(data: StoredSingaporeHolidays): Promise<void> {
  await set(SINGAPORE_HOLIDAYS_STORAGE_KEY, data);
}

export async function clearStoredSingaporeHolidays(): Promise<void> {
  await del(SINGAPORE_HOLIDAYS_STORAGE_KEY);
}
