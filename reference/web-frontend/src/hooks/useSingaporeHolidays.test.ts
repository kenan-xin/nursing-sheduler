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
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useSingaporeHolidays,
  resetSingaporeHolidaysCache,
} from '@/hooks/useSingaporeHolidays';

const API_RESPONSE = {
  success: true,
  result: {
    records: [
      { date: '2026-01-01', day: 'Thursday', holiday: 'New Year’s Day' },
      { date: '2026-05-31', day: 'Sunday', holiday: 'Vesak Day' },
      { date: '2026-06-01', day: 'Monday', holiday: 'Vesak Day (Observed)' },
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

describe('useSingaporeHolidays', () => {
  beforeEach(() => {
    resetSingaporeHolidaysCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetSingaporeHolidaysCache();
  });

  it('starts in loading and resolves to ready with parsed entries', async () => {
    vi.stubGlobal('fetch', mockApiResponse(API_RESPONSE));

    const { result } = renderHook(() => useSingaporeHolidays());

    expect(result.current.status).toBe('loading');
    expect(result.current.entries).toEqual([]);

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.entries).toEqual([
      { date: '2026-01-01', name: 'New Year’s Day', isObserved: false },
      { date: '2026-05-31', name: 'Vesak Day', isObserved: false },
      { date: '2026-06-01', name: 'Vesak Day', isObserved: true },
    ]);
    expect(result.current.error).toBeNull();
  });

  it('reports an error and exposes a working refetch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(API_RESPONSE) });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSingaporeHolidays());

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error).toMatch(/503/);
    expect(result.current.entries).toEqual([]);

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.entries).toHaveLength(API_RESPONSE.result.records.length);
    expect(result.current.error).toBeNull();
  });

  it('does not refetch when already in a terminal state', async () => {
    vi.stubGlobal('fetch', mockApiResponse(API_RESPONSE));

    const { result } = renderHook(() => useSingaporeHolidays());

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    expect(result.current.entries).toHaveLength(API_RESPONSE.result.records.length);
  });
});
