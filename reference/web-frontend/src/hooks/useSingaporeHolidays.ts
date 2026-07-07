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

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchSingaporeHolidays,
  getCachedSingaporeHolidays,
  loadSingaporeHolidaysFromIdb,
  resetSingaporeHolidaysCache,
  SingaporeHolidayEntry,
} from '@/utils/singaporeHolidays';

export type SingaporeHolidaysStatus = 'loading' | 'ready' | 'error';

export interface SingaporeHolidaysState {
  status: SingaporeHolidaysStatus;
  entries: SingaporeHolidayEntry[];
  error: string | null;
  refetch: () => Promise<void>;
}

function getInitialEntries(): SingaporeHolidayEntry[] {
  return getCachedSingaporeHolidays() ?? [];
}

function getInitialStatus(): SingaporeHolidaysStatus {
  return getCachedSingaporeHolidays() ? 'ready' : 'loading';
}

export function useSingaporeHolidays(): SingaporeHolidaysState {
  const [status, setStatus] = useState<SingaporeHolidaysStatus>(getInitialStatus);
  const [entries, setEntries] = useState<SingaporeHolidayEntry[]>(getInitialEntries);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await fetchSingaporeHolidays();
      if (mountedRef.current) {
        setEntries(result);
        setStatus('ready');
      }
    } catch (caught) {
      if (mountedRef.current) {
        // Keep the (possibly stale) IndexedDB-backed entries in state when a refresh fails;
        // only flip to error if we never had data.
        setError(caught instanceof Error ? caught.message : String(caught));
        if (!getCachedSingaporeHolidays()) {
          setStatus('error');
        }
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // 1. Try to seed state from IndexedDB so the first paint shows cached data immediately.
    void (async () => {
      const fromIdb = await loadSingaporeHolidaysFromIdb();
      if (mountedRef.current && fromIdb) {
        setEntries(fromIdb);
        setStatus('ready');
      }
    })();
    // 2. Always verify on session start by hitting the network (stale-while-revalidate).
    // `load()` performs an async fetch and only setState inside its await/catch handlers,
    // so no synchronous setState happens in this effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  return {
    status,
    entries,
    error,
    refetch: load,
  };
}

export { resetSingaporeHolidaysCache };
