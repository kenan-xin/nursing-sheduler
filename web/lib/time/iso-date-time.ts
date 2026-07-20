const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function daysBeforeYear(year: number): number {
  const prior = year - 1;
  return 365 * prior + Math.floor(prior / 4) - Math.floor(prior / 100) + Math.floor(prior / 400);
}

function daysBeforeMonth(year: number, month: number): number {
  let days = 0;
  for (let candidate = 1; candidate < month; candidate += 1) {
    days += daysInMonth(year, candidate);
  }
  return days;
}

export interface IsoDateTimeInstant {
  seconds: number;
  nanoseconds: number;
}

/** Parse the backend's timezone-aware ISO domain without losing fractional precision. */
export function parseIsoDateTime(value: string): IsoDateTimeInstant | null {
  const match = ISO_DATE_TIME.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const timezone = match[8];

  if (year < 1 || year > 9999 || month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetSeconds = 0;
  if (timezone !== "Z") {
    const offsetHours = Number(timezone.slice(1, 3));
    const offsetMinutes = Number(timezone.slice(4, 6));
    if (offsetMinutes > 59 || offsetHours > 14 || (offsetHours === 14 && offsetMinutes !== 0)) {
      return null;
    }
    const sign = timezone[0] === "+" ? 1 : -1;
    offsetSeconds = sign * (offsetHours * 3600 + offsetMinutes * 60);
  }

  const days = daysBeforeYear(year) + daysBeforeMonth(year, month) + day - 1;
  const localSeconds = days * 86400 + hour * 3600 + minute * 60 + second;
  return {
    seconds: localSeconds - offsetSeconds,
    nanoseconds: Number(fraction.padEnd(9, "0")),
  };
}

export function isIsoDateTime(value: string): boolean {
  return parseIsoDateTime(value) !== null;
}

/** Compare two valid backend timestamps without truncating fractional precision. */
export function compareIsoDateTimes(left: string, right: string): -1 | 0 | 1 | null {
  const leftInstant = parseIsoDateTime(left);
  const rightInstant = parseIsoDateTime(right);
  if (leftInstant === null || rightInstant === null) return null;
  if (leftInstant.seconds !== rightInstant.seconds) {
    return leftInstant.seconds < rightInstant.seconds ? -1 : 1;
  }
  return leftInstant.nanoseconds < rightInstant.nanoseconds
    ? -1
    : leftInstant.nanoseconds > rightInstant.nanoseconds
      ? 1
      : 0;
}
