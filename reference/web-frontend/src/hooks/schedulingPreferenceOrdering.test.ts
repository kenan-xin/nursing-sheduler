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

import {
  Preference,
  SHIFT_AFFINITY,
  SHIFT_COUNT,
  SHIFT_REQUEST,
  SHIFT_TYPE_COVERING,
  SHIFT_TYPE_REQUIREMENT,
  SHIFT_TYPE_SUCCESSIONS,
  AT_MOST_ONE_SHIFT_PER_DAY,
} from '@/types/scheduling';
import { SchedulingState } from './schedulingState';
import {
  normalizePreferenceOrder,
  normalizePreferencesOrder,
  sortPreferencesByType,
} from './schedulingPreferenceOrdering';

// Use the runtime constants to avoid hardcoding string-literal orderings.
const SHIFT_AT_MOST_ONE_RUNTIME = AT_MOST_ONE_SHIFT_PER_DAY;

function emptyState(): SchedulingState {
  return {
    apiVersion: 'alpha',
    description: '',
    dates: { range: {}, items: [], groups: [] },
    people: { items: [], groups: [] },
    shiftTypes: { items: [], groups: [] },
    preferences: [],
  };
}

describe('sortPreferencesByType', () => {
  it('places SHIFT_TYPE_COVERING after SHIFT_AFFINITY in the type order', () => {
    // Reverse-sorted input: every type appears once, in reverse canonical order.
    const preferences: Preference[] = [
      { type: SHIFT_AFFINITY, date: [], people1: [], people2: [], shiftTypes: [], weight: 1 },
      { type: SHIFT_TYPE_SUCCESSIONS, person: [], pattern: [], date: [], weight: 1 },
      { type: SHIFT_TYPE_COVERING, preceptors: [], preceptees: [], shiftTypes: [], weight: 1 },
      { type: SHIFT_COUNT, person: [], countDates: [], countShiftTypes: [], expression: 'x = T', target: 0, weight: 1 },
      { type: SHIFT_REQUEST, person: [], date: [], shiftType: [], weight: 1 },
      { type: SHIFT_TYPE_REQUIREMENT, shiftType: [], requiredNumPeople: 0, qualifiedPeople: [], date: [], weight: 1 },
      { type: SHIFT_AT_MOST_ONE_RUNTIME },
    ];

    const sorted = sortPreferencesByType(preferences);

    expect(sorted.map(pref => pref.type)).toEqual([
      SHIFT_AT_MOST_ONE_RUNTIME,
      SHIFT_TYPE_REQUIREMENT,
      SHIFT_REQUEST,
      SHIFT_TYPE_SUCCESSIONS,
      SHIFT_COUNT,
      SHIFT_AFFINITY,
      SHIFT_TYPE_COVERING,
    ]);
  });

  it('keeps SHIFT_TYPE_COVERING grouped with other preferences when types match (stable within type)', () => {
    const a: Preference = {
      type: SHIFT_TYPE_COVERING,
      description: 'A',
      preceptors: [['A']],
      preceptees: [['B']],
      shiftTypes: [['D']],
      weight: 1,
    };
    const b: Preference = {
      type: SHIFT_TYPE_COVERING,
      description: 'B',
      preceptors: [['C']],
      preceptees: [['D']],
      shiftTypes: [['E']],
      weight: 2,
    };
    const sorted = sortPreferencesByType([b, a]);
    expect(sorted.map(pref => pref.description)).toEqual(['B', 'A']);
  });
});

describe('normalizePreferenceOrder — shift type covering', () => {
  it('sorts the flat date array by entity order and preserves the nested preceptors/preceptees/shiftTypes trees', () => {
    const state: SchedulingState = {
      ...emptyState(),
      people: {
        items: [
          { id: 'Anna', description: '' },
          { id: 'Bob', description: '' },
          { id: 'Carla', description: '' },
        ],
        groups: [],
      },
      shiftTypes: {
        items: [
          { id: 'Day', description: '' },
          { id: 'Evening', description: '' },
          { id: 'Night', description: '' },
        ],
        groups: [],
      },
      dates: {
        range: { startDate: new Date('2026-01-02'), endDate: new Date('2026-01-04') },
        items: [
          { id: '02', description: 'Fri' },
          { id: '03', description: 'Sat' },
          { id: '04', description: 'Sun' },
        ],
        groups: [],
      },
    };

    const pref: Preference = {
      type: SHIFT_TYPE_COVERING,
      description: '',
      date: ['04', '02', '03'],
      preceptors: [['Bob', 'Anna'], ['Carla']],
      preceptees: [['Carla'], ['Anna', 'Bob']],
      shiftTypes: [['Night', 'Day'], ['Evening']],
      weight: 1,
    };

    const normalized = normalizePreferenceOrder(pref, state) as Extract<Preference, { type: typeof SHIFT_TYPE_COVERING }>;

    // Nested reference trees (top-level element = equation; inner list = OR
    // alternative) preserve their nesting and inner ordering — matching the
    // existing shift-affinity convention. The flat `date` array is sorted.
    expect(normalized.preceptors).toEqual([['Bob', 'Anna'], ['Carla']]);
    expect(normalized.preceptees).toEqual([['Carla'], ['Anna', 'Bob']]);
    expect(normalized.shiftTypes).toEqual([['Night', 'Day'], ['Evening']]);
    expect(normalized.date).toEqual(['02', '03', '04']);
  });

  it('preserves an undefined `date` as undefined', () => {
    const pref: Preference = {
      type: SHIFT_TYPE_COVERING,
      description: 'no date',
      preceptors: [],
      preceptees: [],
      shiftTypes: [],
      weight: 1,
    };
    const normalized = normalizePreferenceOrder(pref, emptyState());
    expect(normalized).toEqual(pref);
  });
});

describe('normalizePreferencesOrder — shift type covering is grouped with other preferences', () => {
  it('places SHIFT_TYPE_COVERING after SHIFT_AFFINITY in the normalized order', () => {
    const state = emptyState();
    const preferences: Preference[] = [
      { type: SHIFT_TYPE_COVERING, preceptors: [], preceptees: [], shiftTypes: [], weight: 1 },
      { type: SHIFT_AFFINITY, date: [], people1: [], people2: [], shiftTypes: [], weight: 1 },
      { type: SHIFT_REQUEST, person: [], date: [], shiftType: [], weight: 1 },
      { type: SHIFT_TYPE_REQUIREMENT, shiftType: [], requiredNumPeople: 0, qualifiedPeople: [], date: [], weight: 1 },
    ];

    const normalized = normalizePreferencesOrder(preferences, state);
    expect(normalized.map(pref => pref.type)).toEqual([
      SHIFT_TYPE_REQUIREMENT,
      SHIFT_REQUEST,
      SHIFT_AFFINITY,
      SHIFT_TYPE_COVERING,
    ]);
  });
});
