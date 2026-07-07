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

// This test is mostly AI generated.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearStoredSingaporeHolidays,
  readStoredSingaporeHolidays,
  SINGAPORE_HOLIDAYS_STORAGE_KEY,
  writeStoredSingaporeHolidays,
  type StoredSingaporeHolidays,
} from '@/utils/singaporeHolidaysStorage';
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

vi.mock('idb-keyval', () => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}));

const sample: StoredSingaporeHolidays = {
  entries: [{ date: '2026-05-01', name: 'Labour Day', isObserved: false }],
  fetchedAt: 1700000000000,
};

describe('singaporeHolidaysStorage', () => {
  beforeEach(() => {
    vi.mocked(idbGet).mockReset();
    vi.mocked(idbSet).mockReset();
    vi.mocked(idbDel).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when no record exists in IndexedDB', async () => {
    vi.mocked(idbGet).mockResolvedValue(undefined);

    await expect(readStoredSingaporeHolidays()).resolves.toBeNull();
    expect(idbGet).toHaveBeenCalledWith(SINGAPORE_HOLIDAYS_STORAGE_KEY);
  });

  it('returns the stored value when one is found', async () => {
    vi.mocked(idbGet).mockResolvedValue(sample);

    await expect(readStoredSingaporeHolidays()).resolves.toEqual(sample);
  });

  it('writes the stored value to IndexedDB', async () => {
    vi.mocked(idbSet).mockResolvedValue(undefined);

    await expect(writeStoredSingaporeHolidays(sample)).resolves.toBeUndefined();
    expect(idbSet).toHaveBeenCalledWith(SINGAPORE_HOLIDAYS_STORAGE_KEY, sample);
  });

  it('deletes the stored entry by key', async () => {
    vi.mocked(idbDel).mockResolvedValue(undefined);

    await expect(clearStoredSingaporeHolidays()).resolves.toBeUndefined();
    expect(idbDel).toHaveBeenCalledWith(SINGAPORE_HOLIDAYS_STORAGE_KEY);
  });
});
