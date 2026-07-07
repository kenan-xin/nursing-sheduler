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

import { fireEvent, render, screen } from '@testing-library/react';
import { CalendarDayButton, getCalendarDayCategoryClassName } from '@/components/CalendarMonthView';

const SAMPLE_ENTRIES = [
  { date: '2026-05-01', name: 'Labour Day', isObserved: false },
  { date: '2026-05-31', name: 'Vesak Day', isObserved: false },
  { date: '2026-06-01', name: 'Vesak Day', isObserved: true },
];

describe('CalendarMonthView primitives', () => {
  it('responds only to left-mouse selection handlers', () => {
    const onMouseDown = vi.fn();
    const onMouseUp = vi.fn();

    render(
      <CalendarDayButton
        date={new Date('2026-05-01')}
        ariaLabel="May 1"
        stateClassName=""
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
      />,
    );

    const button = screen.getByRole('button', { name: 'May 1' });
    fireEvent.mouseDown(button, { button: 2 });
    fireEvent.mouseUp(button, { button: 2 });
    fireEvent.mouseDown(button, { button: 0 });
    fireEvent.mouseUp(button, { button: 0 });

    expect(onMouseDown).toHaveBeenCalledTimes(1);
    expect(onMouseUp).toHaveBeenCalledTimes(1);
  });

  it('prevents Enter and Space activation', () => {
    render(
      <CalendarDayButton
        date={new Date('2026-05-01')}
        ariaLabel="May 1"
        stateClassName=""
      />,
    );

    const button = screen.getByRole('button', { name: 'May 1' });
    expect(fireEvent.keyDown(button, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(button, { key: ' ' })).toBe(false);
  });

  it('uses quiet normal-day styling and text emphasis for Singapore holiday exceptions', () => {
    // 2026-05-01 (Fri) is Labour Day: weekday FREEDAY → amber background + medium text
    expect(getCalendarDayCategoryClassName(new Date('2026-05-01'), SAMPLE_ENTRIES))
      .toContain('font-medium text-amber-800');
    // 2026-05-02 (Sat) is a plain weekend FREEDAY → amber background, no medium text
    expect(getCalendarDayCategoryClassName(new Date('2026-05-02'), SAMPLE_ENTRIES))
      .toContain('bg-amber-50/70');
    // 2026-05-04 (Mon) is an ordinary workday → plain white background
    expect(getCalendarDayCategoryClassName(new Date('2026-05-04'), SAMPLE_ENTRIES))
      .toContain('text-slate-700');
    // Dates outside the supported range fall back to default weekend/workday styling.
    expect(getCalendarDayCategoryClassName(new Date('2029-01-01'), SAMPLE_ENTRIES))
      .toContain('text-slate-700');
  });

  it('returns plain styling when no Singapore entries are loaded', () => {
    // 2026-05-01 (Fri): no data → ordinary workday styling.
    expect(getCalendarDayCategoryClassName(new Date('2026-05-01'), []))
      .toContain('text-slate-700');
  });
});
