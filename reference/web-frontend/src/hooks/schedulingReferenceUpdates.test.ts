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
  DataType,
  SHIFT_AFFINITY,
  SHIFT_COUNT,
  SHIFT_REQUEST,
  SHIFT_TYPE_COVERING,
  SHIFT_TYPE_REQUIREMENT,
  SHIFT_TYPE_SUCCESSIONS,
  ShiftAffinityPreference,
  ShiftCountPreference,
  ShiftRequestPreference,
  ShiftTypeCoveringPreference,
  ShiftTypeRequirementsPreference,
  ShiftTypeSuccessionsPreference,
} from '@/types/scheduling';
import { SchedulingState } from './schedulingState';
import { applyReferencesForIdChange, applyReferencesForIdDeletion } from './schedulingReferenceUpdates';

function createState(): SchedulingState {
  return {
    apiVersion: 'test',
    description: '',
    dates: {
      range: {},
      items: [{ id: '2026-01-01', description: 'Jan 1' }, { id: '2026-01-02', description: 'Jan 2' }],
      groups: [{ id: 'Workday', members: ['2026-01-01'], description: '' }],
    },
    people: {
      items: [
        { id: 'P1', description: '', history: ['N', 'D'] },
        { id: 'P2', description: '', history: ['D'] },
      ],
      groups: [{ id: 'Team', members: ['P1', 'P2'], description: '' }],
    },
    shiftTypes: {
      items: [{ id: 'D', description: 'Day' }, { id: 'N', description: 'Night' }],
      groups: [{ id: 'Clinical', members: ['D', 'N'], description: '' }],
    },
    preferences: [
      {
        type: SHIFT_TYPE_REQUIREMENT,
        description: 'requirement',
        shiftType: ['D'],
        shiftTypeCoefficients: [['D', 2]],
        requiredNumPeople: 1,
        qualifiedPeople: ['P1', 'Team'],
        date: ['2026-01-01'],
        weight: 10,
      },
      {
        type: SHIFT_REQUEST,
        description: 'request',
        person: ['P1'],
        date: ['2026-01-01'],
        shiftType: ['D'],
        weight: 1,
      },
      {
        type: SHIFT_TYPE_SUCCESSIONS,
        description: 'succession',
        person: ['P1'],
        pattern: ['N', 'D'],
        date: ['2026-01-01'],
        weight: 1,
      },
      {
        type: SHIFT_COUNT,
        description: 'count',
        person: ['P1'],
        countDates: ['2026-01-01'],
        countShiftTypes: ['D', 'N'],
        countShiftTypeCoefficients: [['D', 1], ['N', 2]],
        expression: 'x = T',
        target: 1,
        weight: 1,
      },
      {
        type: SHIFT_AFFINITY,
        description: 'affinity',
        date: ['2026-01-01'],
        people1: ['P1'],
        people2: ['P2'],
        shiftTypes: ['D'],
        weight: 1,
      },
    ],
    export: {
      formatting: [
        { type: 'cell', people: ['P1'], dates: ['2026-01-01'], shiftTypes: ['D'] },
        { type: 'row', people: ['P1'] },
        { type: 'column', dates: ['2026-01-01'] },
      ],
      extraColumns: [
        {
          type: 'count',
          header: 'D Count',
          countShiftTypes: ['D', 'N'],
          countShiftTypeCoefficients: [['D', 1], ['N', 2]],
          countDates: ['2026-01-01'],
        },
      ],
      extraRows: [
        {
          type: 'count',
          header: 'D Count',
          countShiftTypes: ['D'],
          countPeople: ['P1'],
        },
      ],
    },
  };
}

describe('applyReferencesForIdChange', () => {
  it('renames people, dates, and shift types across related state', () => {
    let state = createState();

    state = applyReferencesForIdChange(state, DataType.PEOPLE, 'P1', 'Alice');
    state = applyReferencesForIdChange(state, DataType.DATES, '2026-01-01', 'Jan1');
    state = applyReferencesForIdChange(state, DataType.SHIFT_TYPES, 'D', 'Day');

    expect(state.people.items.map(person => person.history)).toEqual([['N', 'Day'], ['Day']]);

    expect(state.preferences[0] as ShiftTypeRequirementsPreference).toMatchObject({
      shiftType: ['Day'],
      shiftTypeCoefficients: [['Day', 2]],
      qualifiedPeople: ['Alice', 'Team'],
      date: ['Jan1'],
    });
    expect(state.preferences[1] as ShiftRequestPreference).toMatchObject({
      person: ['Alice'],
      date: ['Jan1'],
      shiftType: ['Day'],
    });
    expect(state.preferences[2] as ShiftTypeSuccessionsPreference).toMatchObject({
      person: ['Alice'],
      pattern: ['N', 'Day'],
      date: ['Jan1'],
    });
    expect(state.preferences[3] as ShiftCountPreference).toMatchObject({
      person: ['Alice'],
      countDates: ['Jan1'],
      countShiftTypes: ['Day', 'N'],
      countShiftTypeCoefficients: [['Day', 1], ['N', 2]],
    });
    expect(state.preferences[4] as ShiftAffinityPreference).toMatchObject({
      date: ['Jan1'],
      people1: ['Alice'],
      people2: ['P2'],
      shiftTypes: ['Day'],
    });

    expect(state.export?.formatting).toEqual([
      { type: 'cell', people: ['Alice'], dates: ['Jan1'], shiftTypes: ['Day'] },
      { type: 'row', people: ['Alice'] },
      { type: 'column', dates: ['Jan1'] },
    ]);
    expect(state.export?.extraColumns?.[0]).toMatchObject({
      countShiftTypes: ['Day', 'N'],
      countShiftTypeCoefficients: [['Day', 1], ['N', 2]],
      countDates: ['Jan1'],
    });
    expect(state.export?.extraRows?.[0]).toMatchObject({
      countShiftTypes: ['Day'],
      countPeople: ['Alice'],
    });
  });

  it('renames IDs inside nested preference reference groups', () => {
    let state = createState();
    (state.preferences[0] as ShiftTypeRequirementsPreference).shiftType = [['D', 'N']] as unknown as string[];
    (state.preferences[4] as ShiftAffinityPreference).people1 = [['P1', 'Team']] as unknown as string[];
    (state.preferences[4] as ShiftAffinityPreference).shiftTypes = [['D', 'N']] as unknown as string[];

    state = applyReferencesForIdChange(state, DataType.SHIFT_TYPES, 'D', 'Day');
    state = applyReferencesForIdChange(state, DataType.PEOPLE, 'P1', 'Alice');

    expect((state.preferences[0] as ShiftTypeRequirementsPreference).shiftType).toEqual([['Day', 'N']]);
    expect((state.preferences[4] as ShiftAffinityPreference).people1).toEqual([['Alice', 'Team']]);
    expect((state.preferences[4] as ShiftAffinityPreference).shiftTypes).toEqual([['Day', 'N']]);
  });

  it('renames scalar preference reference fields from YAML-compatible state', () => {
    let state = createState();
    (state.preferences[0] as ShiftTypeRequirementsPreference).shiftType = 'D' as unknown as string[];
    (state.preferences[1] as ShiftRequestPreference).shiftType = 'D' as unknown as string[];
    (state.preferences[3] as ShiftCountPreference).countShiftTypes = 'D' as unknown as string[];

    state = applyReferencesForIdChange(state, DataType.SHIFT_TYPES, 'D', 'Day');

    expect((state.preferences[0] as ShiftTypeRequirementsPreference).shiftType).toBe('Day');
    expect((state.preferences[1] as ShiftRequestPreference).shiftType).toBe('Day');
    expect((state.preferences[3] as ShiftCountPreference).countShiftTypes).toBe('Day');
  });
});

describe('applyReferencesForIdDeletion', () => {
  it('removes deleted people references and drops rules with empty required fields', () => {
    const state = applyReferencesForIdDeletion(createState(), DataType.PEOPLE, ['P1']);

    expect(state.preferences).toHaveLength(1);
    expect(state.preferences[0] as ShiftTypeRequirementsPreference).toMatchObject({
      qualifiedPeople: ['Team'],
    });
    expect(state.export?.formatting).toEqual([
      { type: 'column', dates: ['2026-01-01'] },
    ]);
    expect(state.export?.extraRows).toEqual([]);
  });

  it('removes deleted date references and drops empty export columns', () => {
    const state = applyReferencesForIdDeletion(createState(), DataType.DATES, ['2026-01-01']);

    expect(state.preferences).toEqual([]);
    expect(state.export?.formatting).toEqual([
      { type: 'row', people: ['P1'] },
    ]);
    expect(state.export?.extraColumns).toEqual([]);
    expect(state.export?.extraRows).toEqual([
      {
        type: 'count',
        header: 'D Count',
        countShiftTypes: ['D'],
        countPeople: ['P1'],
      },
    ]);
  });

  it('blanks deleted shift type history slots and removes shift type export references', () => {
    const state = applyReferencesForIdDeletion(createState(), DataType.SHIFT_TYPES, ['N']);

    expect(state.people.items.map(person => person.history)).toEqual([['', 'D'], ['D']]);
    expect(state.preferences[2] as ShiftTypeSuccessionsPreference).toMatchObject({
      pattern: ['D'],
    });
    expect(state.preferences[3] as ShiftCountPreference).toMatchObject({
      countShiftTypes: ['D'],
      countShiftTypeCoefficients: [['D', 1]],
    });
    expect(state.export?.extraColumns?.[0]).toMatchObject({
      countShiftTypes: ['D'],
      countShiftTypeCoefficients: [['D', 1]],
    });
  });

  it('removes deleted shift type requirement coefficients', () => {
    const initialState = createState();
    (initialState.preferences[0] as ShiftTypeRequirementsPreference).shiftType = ['D', 'N'];
    (initialState.preferences[0] as ShiftTypeRequirementsPreference).shiftTypeCoefficients = [['D', 2], ['N', 3]];

    const state = applyReferencesForIdDeletion(initialState, DataType.SHIFT_TYPES, ['D']);

    expect(state.preferences[0] as ShiftTypeRequirementsPreference).toMatchObject({
      shiftType: ['N'],
      shiftTypeCoefficients: [['N', 3]],
    });
  });

  it('removes IDs inside nested preference reference groups', () => {
    const initialState = createState();
    (initialState.preferences[0] as ShiftTypeRequirementsPreference).shiftType = [['D', 'N']] as unknown as string[];
    (initialState.preferences[4] as ShiftAffinityPreference).shiftTypes = [['D', 'N']] as unknown as string[];

    const state = applyReferencesForIdDeletion(initialState, DataType.SHIFT_TYPES, ['D']);
    const requirement = state.preferences.find(pref => pref.type === SHIFT_TYPE_REQUIREMENT) as ShiftTypeRequirementsPreference | undefined;
    const count = state.preferences.find(pref => pref.type === SHIFT_COUNT) as ShiftCountPreference | undefined;
    const affinity = state.preferences.find(pref => pref.type === SHIFT_AFFINITY) as ShiftAffinityPreference | undefined;

    expect(requirement).toMatchObject({
      shiftType: [['N']],
    });
    expect(count).toMatchObject({
      countShiftTypes: ['N'],
    });
    expect(affinity).toMatchObject({
      shiftTypes: [['N']],
    });
  });

  it('removes nested affinity people references without dropping populated groups', () => {
    const initialState = createState();
    (initialState.preferences[4] as ShiftAffinityPreference).people1 = [['P1', 'Team']] as unknown as string[];

    const state = applyReferencesForIdDeletion(initialState, DataType.PEOPLE, ['P1']);
    const affinity = state.preferences.find(pref => pref.type === SHIFT_AFFINITY) as ShiftAffinityPreference | undefined;

    expect(affinity).toMatchObject({
      people1: [['Team']],
      people2: ['P2'],
    });
  });

  it('removes scalar preference reference fields from YAML-compatible state', () => {
    const initialState = createState();
    (initialState.preferences[0] as ShiftTypeRequirementsPreference).shiftType = 'D' as unknown as string[];
    (initialState.preferences[1] as ShiftRequestPreference).shiftType = 'D' as unknown as string[];
    (initialState.preferences[3] as ShiftCountPreference).countShiftTypes = 'N' as unknown as string[];

    const state = applyReferencesForIdDeletion(initialState, DataType.SHIFT_TYPES, ['D']);
    const count = state.preferences.find(pref => pref.type === SHIFT_COUNT) as ShiftCountPreference | undefined;

    expect(state.preferences.some(pref => pref.type === SHIFT_TYPE_REQUIREMENT)).toBe(false);
    expect(state.preferences.some(pref => pref.type === SHIFT_REQUEST)).toBe(false);
    expect(count?.countShiftTypes).toBe('N');
  });
});

describe('shift type covering cascade', () => {
  const makeCoveringState = (overrides: Partial<ShiftTypeCoveringPreference> = {}): SchedulingState => {
    const base = createState();
    base.preferences = base.preferences.concat({
      type: SHIFT_TYPE_COVERING,
      description: 'cover',
      date: ['2026-01-01'],
      preceptors: [['P1']],
      preceptees: [['P2']],
      shiftTypes: [['D']],
      weight: 1,
      ...overrides,
    });
    return base;
  };

  const findCovering = (state: SchedulingState): ShiftTypeCoveringPreference | undefined =>
    state.preferences.find((pref): pref is ShiftTypeCoveringPreference => pref.type === SHIFT_TYPE_COVERING);

  describe('applyReferencesForIdChange', () => {
    it('renames person IDs inside the nested preceptors/preceptees arrays', () => {
      let state = makeCoveringState();
      state = applyReferencesForIdChange(state, DataType.PEOPLE, 'P1', 'Alice');
      state = applyReferencesForIdChange(state, DataType.PEOPLE, 'P2', 'Bob');

      const covering = findCovering(state);
      expect(covering).toBeDefined();
      expect(covering!.preceptors).toEqual([['Alice']]);
      expect(covering!.preceptees).toEqual([['Bob']]);
    });

    it('renames shift-type IDs inside the nested shiftTypes array', () => {
      let state = makeCoveringState();
      state = applyReferencesForIdChange(state, DataType.SHIFT_TYPES, 'D', 'Day');

      const covering = findCovering(state);
      expect(covering!.shiftTypes).toEqual([['Day']]);
    });

    it('renames date IDs inside the covering date field', () => {
      let state = makeCoveringState();
      state = applyReferencesForIdChange(state, DataType.DATES, '2026-01-01', 'Jan1');

      const covering = findCovering(state);
      expect(covering!.date).toEqual(['Jan1']);
    });

    it('leaves other covering preferences unchanged when their references do not match', () => {
      const state = applyReferencesForIdChange(makeCoveringState(), DataType.PEOPLE, 'X', 'Y');
      const covering = findCovering(state);
      expect(covering!.preceptors).toEqual([['P1']]);
      expect(covering!.preceptees).toEqual([['P2']]);
    });
  });

  describe('applyReferencesForIdDeletion', () => {
    it('removes a deleted preceptor from nested preceptors (keeps rule when others remain)', () => {
      const state = makeCoveringState({ preceptors: [['P1', 'P2']] });
      const after = applyReferencesForIdDeletion(state, DataType.PEOPLE, ['P1']);
      const covering = findCovering(after);
      expect(covering).toBeDefined();
      expect(covering!.preceptors).toEqual([['P2']]);
    });

    it('drops the covering rule when preceptors becomes empty', () => {
      const state = applyReferencesForIdDeletion(makeCoveringState(), DataType.PEOPLE, ['P1']);
      expect(state.preferences.some(pref => pref.type === SHIFT_TYPE_COVERING)).toBe(false);
    });

    it('drops the covering rule when preceptees becomes empty', () => {
      const state = applyReferencesForIdDeletion(makeCoveringState(), DataType.PEOPLE, ['P2']);
      expect(state.preferences.some(pref => pref.type === SHIFT_TYPE_COVERING)).toBe(false);
    });

    it('drops the covering rule when shiftTypes becomes empty', () => {
      const state = applyReferencesForIdDeletion(makeCoveringState(), DataType.SHIFT_TYPES, ['D']);
      expect(state.preferences.some(pref => pref.type === SHIFT_TYPE_COVERING)).toBe(false);
    });

    it('keeps the covering rule when only the optional date field is emptied', () => {
      const state = applyReferencesForIdDeletion(makeCoveringState(), DataType.DATES, ['2026-01-01']);
      const covering = findCovering(state);
      expect(covering).toBeDefined();
      expect(covering!.preceptors).toEqual([['P1']]);
      expect(covering!.preceptees).toEqual([['P2']]);
      expect(covering!.shiftTypes).toEqual([['D']]);
      expect(covering!.date).toEqual([]);
    });

    it('leaves other covering preferences alone when their references do not match', () => {
      const state = applyReferencesForIdDeletion(makeCoveringState(), DataType.PEOPLE, ['X']);
      const covering = findCovering(state);
      expect(covering!.preceptors).toEqual([['P1']]);
      expect(covering!.preceptees).toEqual([['P2']]);
    });
  });

  describe('flat reference fields (YAML-compatible shape)', () => {
    // The (string | string[])[] typing permits a flat top-level array as well
    // as nested trees. The cascade helpers must handle both: a flat array is
    // a single-element reference tree that recurses into the leaf strings.
    const makeFlatCoveringState = (): SchedulingState => {
      const base = createState();
      base.preferences = base.preferences.concat({
        type: SHIFT_TYPE_COVERING,
        description: 'flat',
        date: ['2026-01-01'],
        preceptors: ['P1', 'P2'],
        preceptees: ['P2', 'P1'],
        shiftTypes: ['D', 'N'],
        weight: 1,
      });
      return base;
    };

    it('renames person IDs inside flat preceptors / preceptees arrays', () => {
      let state = makeFlatCoveringState();
      state = applyReferencesForIdChange(state, DataType.PEOPLE, 'P1', 'Alice');
      state = applyReferencesForIdChange(state, DataType.PEOPLE, 'P2', 'Bob');

      const covering = findCovering(state);
      expect(covering!.preceptors).toEqual(['Alice', 'Bob']);
      expect(covering!.preceptees).toEqual(['Bob', 'Alice']);
    });

    it('renames shift-type IDs inside a flat shiftTypes array', () => {
      const state = applyReferencesForIdChange(makeFlatCoveringState(), DataType.SHIFT_TYPES, 'D', 'Day');
      const covering = findCovering(state);
      expect(covering!.shiftTypes).toEqual(['Day', 'N']);
    });

    it('removes a deleted ID from a flat preceptors array and drops the rule when empty', () => {
      // Deleting both preceptors empties the flat array, which should drop the rule.
      const state = applyReferencesForIdDeletion(makeFlatCoveringState(), DataType.PEOPLE, ['P1', 'P2']);
      expect(state.preferences.some(pref => pref.type === SHIFT_TYPE_COVERING)).toBe(false);
    });

    it('removes a deleted ID from a flat preceptors array and keeps the rule when others remain', () => {
      const reAdd = makeFlatCoveringState();
      // makeFlatCoveringState's covering has preceptors ['P1', 'P2']; mutate to
      // ['P2', 'P1'] so we can verify that deleting P1 (a non-leading entry)
      // leaves ['P2'] and the rule survives.
      const covering = reAdd.preferences.find(p => p.type === SHIFT_TYPE_COVERING) as ShiftTypeCoveringPreference;
      covering.preceptors = ['P2', 'P1'];
      const after = applyReferencesForIdDeletion(reAdd, DataType.PEOPLE, ['P1']);
      const kept = after.preferences.find(p => p.type === SHIFT_TYPE_COVERING) as ShiftTypeCoveringPreference | undefined;
      expect(kept).toBeDefined();
      expect(kept!.preceptors).toEqual(['P2']);
    });
  });
});
