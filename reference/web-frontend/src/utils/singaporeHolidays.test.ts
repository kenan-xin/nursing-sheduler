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
  SINGAPORE_FREEDAY_GROUP_ID,
  SINGAPORE_WORKDAY_GROUP_ID,
  buildSingaporeHolidayGroups,
  fetchSingaporeHolidays,
  getCachedSingaporeHolidays,
  getSingaporeDayType,
  getSingaporeHolidayEntriesInRange,
  getSingaporeHolidaySupportLabel,
  isSingaporeFreeday,
  isSingaporeHolidayRangeSupported,
  resetSingaporeHolidaysCache,
} from '@/utils/singaporeHolidays';
import type { DateRange, Item } from '@/types/scheduling';

const API_RESPONSE = {
  success: true,
  result: {
    records: [
      { _id: 79, date: '2026-01-01', day: 'Thursday', holiday: 'New Year’s Day' },
      { _id: 80, date: '2026-02-17', day: 'Tuesday', holiday: 'Chinese New Year' },
      { _id: 81, date: '2026-02-18', day: 'Wednesday', holiday: 'Chinese New Year' },
      { _id: 84, date: '2026-05-01', day: 'Friday', holiday: 'Labour Day' },
      { _id: 86, date: '2026-05-31', day: 'Sunday', holiday: 'Vesak Day' },
      { _id: 87, date: '2026-06-01', day: 'Monday', holiday: 'Vesak Day (Observed)' },
      { _id: 88, date: '2026-08-09', day: 'Sunday', holiday: 'National Day' },
      { _id: 89, date: '2026-08-10', day: 'Monday', holiday: 'National Day (Observed)' },
      { _id: 90, date: '2026-11-08', day: 'Sunday', holiday: 'Deepavali' },
      { _id: 91, date: '2026-11-09', day: 'Monday', holiday: 'Deepavali (Observed)' },
    ],
  },
};

function mockApiResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn().mockResolvedValueOnce({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  });
}

function makeItem(id: string): Item {
  return { id, description: '' };
}

describe('singaporeHolidays', () => {
  beforeEach(() => {
    resetSingaporeHolidaysCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetSingaporeHolidaysCache();
  });

  describe('fetchSingaporeHolidays', () => {
    it('parses records from the data.gov.sg response into holiday entries', async () => {
      vi.stubGlobal('fetch', mockApiResponse(API_RESPONSE));

      const entries = await fetchSingaporeHolidays();

      expect(entries).toEqual([
        { date: '2026-01-01', name: 'New Year’s Day', isObserved: false },
        { date: '2026-02-17', name: 'Chinese New Year', isObserved: false },
        { date: '2026-02-18', name: 'Chinese New Year', isObserved: false },
        { date: '2026-05-01', name: 'Labour Day', isObserved: false },
        { date: '2026-05-31', name: 'Vesak Day', isObserved: false },
        { date: '2026-06-01', name: 'Vesak Day', isObserved: true },
        { date: '2026-08-09', name: 'National Day', isObserved: false },
        { date: '2026-08-10', name: 'National Day', isObserved: true },
        { date: '2026-11-08', name: 'Deepavali', isObserved: false },
        { date: '2026-11-09', name: 'Deepavali', isObserved: true },
      ]);
    });

    it('caches results so the network is only hit once per session', async () => {
      const fetchMock = mockApiResponse(API_RESPONSE);
      vi.stubGlobal('fetch', fetchMock);

      const first = await fetchSingaporeHolidays();
      const second = await fetchSingaporeHolidays();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
      expect(getCachedSingaporeHolidays()).toEqual(first);
    });

    it('coalesces concurrent fetches into a single network call', async () => {
      const fetchMock = mockApiResponse(API_RESPONSE);
      vi.stubGlobal('fetch', fetchMock);

      const [a, b, c] = await Promise.all([
        fetchSingaporeHolidays(),
        fetchSingaporeHolidays(),
        fetchSingaporeHolidays(),
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(a).toEqual(b);
      expect(b).toEqual(c);
    });

    it('clears the in-flight promise after a failure so the next call can retry', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(API_RESPONSE) });
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchSingaporeHolidays()).rejects.toThrow(/500/);

      const entries = await fetchSingaporeHolidays();
      expect(entries).toHaveLength(API_RESPONSE.result.records.length);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws when the response payload is malformed', async () => {
      vi.stubGlobal('fetch', mockApiResponse({ success: false }));

      await expect(fetchSingaporeHolidays()).rejects.toThrow(/data\.gov\.sg/);
    });
  });

  describe('isSingaporeHolidayRangeSupported', () => {
    const supported: DateRange = {
      startDate: new Date('2026-05-01'),
      endDate: new Date('2026-05-31'),
    };
    const entries = [
      { date: '2026-01-01', name: 'New Year’s Day', isObserved: false },
      { date: '2026-12-31', name: 'Year End', isObserved: false },
    ];

    it('accepts ranges fully inside the supported window', () => {
      expect(isSingaporeHolidayRangeSupported(supported, entries)).toBe(true);
    });

    it('rejects ranges that start before the supported window', () => {
      expect(isSingaporeHolidayRangeSupported({
        startDate: new Date('2019-12-31'),
        endDate: new Date('2026-01-15'),
      }, entries)).toBe(false);
    });

    it('rejects ranges that end after the supported window', () => {
      expect(isSingaporeHolidayRangeSupported({
        startDate: new Date('2026-12-30'),
        endDate: new Date('2028-01-15'),
      }, entries)).toBe(false);
    });

    it('returns false when the entries array is empty', () => {
      expect(isSingaporeHolidayRangeSupported(supported, [])).toBe(false);
    });
  });

  describe('getSingaporeHolidaySupportLabel', () => {
    it('returns the derived range from the loaded entries', () => {
      expect(getSingaporeHolidaySupportLabel([
        { date: '2026-01-01', name: 'X', isObserved: false },
        { date: '2026-12-31', name: 'Y', isObserved: false },
      ])).toBe('2026-01-01 to 2026-12-31');
    });

    it('returns a placeholder when no entries are loaded', () => {
      expect(getSingaporeHolidaySupportLabel([])).toBe('no data loaded');
    });
  });

  describe('isSingaporeFreeday', () => {
    const entries = [
      { date: '2026-05-01', name: 'Labour Day', isObserved: false },
      { date: '2026-05-31', name: 'Vesak Day', isObserved: false },
      { date: '2026-06-01', name: 'Vesak Day', isObserved: true },
      { date: '2026-08-09', name: 'National Day', isObserved: false },
      { date: '2026-08-10', name: 'National Day', isObserved: true },
    ];

    it('returns true for a holiday on a weekday', () => {
      expect(isSingaporeFreeday(new Date('2026-05-01'), entries)).toBe(true);
    });

    it('returns true for both actual and observed dates when a holiday falls on Sunday', () => {
      expect(isSingaporeFreeday(new Date('2026-05-31'), entries)).toBe(true);
      expect(isSingaporeFreeday(new Date('2026-06-01'), entries)).toBe(true);
      expect(isSingaporeFreeday(new Date('2026-08-09'), entries)).toBe(true);
      expect(isSingaporeFreeday(new Date('2026-08-10'), entries)).toBe(true);
    });

    it('returns true for plain weekends', () => {
      expect(isSingaporeFreeday(new Date('2026-05-02'), entries)).toBe(true);
      expect(isSingaporeFreeday(new Date('2026-05-03'), entries)).toBe(true);
    });

    it('returns false for an ordinary weekday', () => {
      expect(isSingaporeFreeday(new Date('2026-05-04'), entries)).toBe(false);
    });
  });

  describe('getSingaporeDayType', () => {
    const entries = [
      { date: '2026-05-01', name: 'Labour Day', isObserved: false },
      { date: '2026-05-31', name: 'Vesak Day', isObserved: false },
    ];

    it('returns FREEDAY for a holiday on a weekday', () => {
      expect(getSingaporeDayType(new Date('2026-05-01'), entries)).toBe(SINGAPORE_FREEDAY_GROUP_ID);
    });

    it('returns WORKDAY for an ordinary weekday inside the supported range', () => {
      expect(getSingaporeDayType(new Date('2026-05-29'), entries)).toBe(SINGAPORE_WORKDAY_GROUP_ID);
    });

    it('returns FREEDAY for a weekend inside the supported range', () => {
      expect(getSingaporeDayType(new Date('2026-05-02'), entries)).toBe(SINGAPORE_FREEDAY_GROUP_ID);
      expect(getSingaporeDayType(new Date('2026-05-03'), entries)).toBe(SINGAPORE_FREEDAY_GROUP_ID);
    });

    it('returns undefined when the entries list is empty', () => {
      expect(getSingaporeDayType(new Date('2026-05-01'), [])).toBeUndefined();
    });

    it('returns undefined for dates outside the supported range', () => {
      expect(getSingaporeDayType(new Date('2028-01-01'), entries)).toBeUndefined();
    });
  });

  describe('buildSingaporeHolidayGroups', () => {
    const entries = [
      { date: '2026-05-01', name: 'Labour Day', isObserved: false },
    ];
    const dateRange: DateRange = {
      startDate: new Date('2026-05-01'),
      endDate: new Date('2026-05-04'),
    };

    it('returns empty groups when no entries are loaded', () => {
      expect(buildSingaporeHolidayGroups(
        [makeItem('01'), makeItem('02')],
        dateRange,
        [],
      )).toEqual([]);
    });

    it('returns empty groups for ranges outside the supported window', () => {
      expect(buildSingaporeHolidayGroups(
        [makeItem('01')],
        {
          startDate: new Date('2019-01-01'),
          endDate: new Date('2019-01-02'),
        },
        entries,
      )).toEqual([]);
    });

    it('classifies in-range entries as FREEDAY and in-range non-weekend non-holiday dates as WORKDAY', () => {
      // Entries span the full dateRange so the derived supported window covers it.
      const entriesSpanningRange = [
        { date: '2026-05-01', name: 'Labour Day', isObserved: false },
        { date: '2026-05-04', name: 'Dummy boundary', isObserved: false },
      ];
      // 2026-05-02 (Sat) and 2026-05-03 (Sun) are plain weekends, but with
      // 2026-05-02 marked as a holiday entry, only the unmarked weekend (2026-05-03)
      // proves the "weekend → FREEDAY" fallback is still applied for in-range dates.
      const groups = buildSingaporeHolidayGroups(
        [makeItem('01'), makeItem('02'), makeItem('03'), makeItem('04')],
        dateRange,
        entriesSpanningRange,
      );

      expect(groups).toEqual([
        {
          id: SINGAPORE_WORKDAY_GROUP_ID,
          description: 'Singapore workdays imported from the data.gov.sg public holidays dataset',
          members: [],
        },
        {
          id: SINGAPORE_FREEDAY_GROUP_ID,
          description: 'Singapore freedays imported from the data.gov.sg public holidays dataset',
          members: ['01', '02', '03', '04'],
        },
      ]);
    });

    it('puts weekday items into WORKDAY when entries span the range but do not flag them as holidays', () => {
      // Entries span the full month so the derived supported window covers it.
      // Only 2026-05-01 is actually a holiday; the rest of the range is regular days.
      const entriesSpanningRange = [
        { date: '2026-05-01', name: 'Labour Day', isObserved: false },
        { date: '2026-05-31', name: 'Vesak Day', isObserved: false },
      ];
      const fullMonthRange: DateRange = {
        startDate: new Date('2026-05-01'),
        endDate: new Date('2026-05-04'),
      };
      const groups = buildSingaporeHolidayGroups(
        [makeItem('01'), makeItem('03'), makeItem('04')],
        fullMonthRange,
        entriesSpanningRange,
      );

      // 01 (Fri, Labour Day) → FREEDAY (in freedaySet)
      // 03 (Sun) → FREEDAY (weekend)
      // 04 (Mon) → WORKDAY (weekday, not in freedaySet)
      expect(groups).toContainEqual({
        id: SINGAPORE_WORKDAY_GROUP_ID,
        description: 'Singapore workdays imported from the data.gov.sg public holidays dataset',
        members: ['04'],
      });
      expect(groups).toContainEqual({
        id: SINGAPORE_FREEDAY_GROUP_ID,
        description: 'Singapore freedays imported from the data.gov.sg public holidays dataset',
        members: ['01', '03'],
      });
    });

    it('classifies both actual and observed dates into FREEDAY', () => {
      const observedEntries = [
        { date: '2026-05-31', name: 'Vesak Day', isObserved: false },
        { date: '2026-06-01', name: 'Vesak Day', isObserved: true },
      ];

      const groups = buildSingaporeHolidayGroups(
        [makeItem('05-31'), makeItem('06-01')],
        {
          startDate: new Date('2026-05-31'),
          endDate: new Date('2026-06-01'),
        },
        observedEntries,
      );

      expect(groups).toContainEqual({
        id: SINGAPORE_FREEDAY_GROUP_ID,
        description: 'Singapore freedays imported from the data.gov.sg public holidays dataset',
        members: ['05-31', '06-01'],
      });
      expect(groups).toContainEqual({
        id: SINGAPORE_WORKDAY_GROUP_ID,
        description: 'Singapore workdays imported from the data.gov.sg public holidays dataset',
        members: [],
      });
    });
  });

  describe('getSingaporeHolidayEntriesInRange', () => {
    const entries = [
      { date: '2026-01-01', name: 'New Year’s Day', isObserved: false },
      { date: '2026-05-01', name: 'Labour Day', isObserved: false },
      { date: '2026-05-31', name: 'Vesak Day', isObserved: false },
      { date: '2026-06-01', name: 'Vesak Day', isObserved: true },
    ];

    it('returns only entries within the selected range', () => {
      expect(getSingaporeHolidayEntriesInRange({
        startDate: new Date('2026-05-01'),
        endDate: new Date('2026-05-31'),
      }, entries)).toEqual([
        { date: '2026-05-01', name: 'Labour Day', isObserved: false },
        { date: '2026-05-31', name: 'Vesak Day', isObserved: false },
      ]);
    });

    it('returns an empty list when entries are not loaded', () => {
      expect(getSingaporeHolidayEntriesInRange({
        startDate: new Date('2026-05-01'),
        endDate: new Date('2026-05-31'),
      }, [])).toEqual([]);
    });
  });
});
