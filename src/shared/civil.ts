// Civil (timezone-free) date arithmetic.
//
// A "wall" instant is the number of milliseconds that a *local* wall clock
// would show if it were interpreted against UTC. It is not a real instant:
// resolving it inside a zone is what turns it into one (see zones.ts).

export const MS_PER_DAY = 86_400_000;

export type CivilDate = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
};

export type CivilTime = {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

// Days from the proleptic Gregorian epoch (1970-01-01) to a civil date.
// Howard Hinnant's algorithm.
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const m = month + (month > 2 ? -3 : 9);
  const doy = Math.floor((153 * m + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(days: number): CivilDate {
  const z = days + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return {year: year + (month <= 2 ? 1 : 0), month, day};
}

export function toWallMillis(date: CivilDate, time: CivilTime = {hour: 0, minute: 0, second: 0, millisecond: 0}): number {
  return (
    daysFromCivil(date.year, date.month, date.day) * MS_PER_DAY +
    time.hour * 3_600_000 +
    time.minute * 60_000 +
    time.second * 1000 +
    time.millisecond
  );
}

export function civilDateOfWall(wall: number): CivilDate {
  return civilFromDays(Math.floor(wall / MS_PER_DAY));
}

export type WallParts = CivilDate & CivilTime;

export function wallParts(wall: number): WallParts {
  const days = Math.floor(wall / MS_PER_DAY);
  let within = wall - days * MS_PER_DAY;
  const date = civilFromDays(days);
  const hour = Math.floor(within / 3_600_000);
  within -= hour * 3_600_000;
  const minute = Math.floor(within / 60_000);
  within -= minute * 60_000;
  const second = Math.floor(within / 1000);
  return {...date, hour, minute, second, millisecond: within - second * 1000};
}

function pad(value: number, width = 2): string {
  const sign = value < 0 ? '-' : '';
  return sign + String(Math.abs(value)).padStart(width, '0');
}

// Local-field string, e.g. "2026-03-08T02:30:00". Never touched by Date.
export function formatWall(wall: number): string {
  const p = wallParts(wall);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

// Strict parser for "YYYY-MM-DDTHH:mm[:ss]" (no zone suffix by design).
export function parseWall(text: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!match) throw new Error(`invalid local datetime: ${text}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`invalid local datetime: ${text}`);
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) throw new Error(`invalid local datetime: ${text}`);
  return toWallMillis({year, month, day}, {hour, minute, second, millisecond: 0});
}

// ISO-8601 offset, e.g. "+05:30" / "-04:00" / "Z". Offsets are milliseconds
// east of UTC, so the sign renders directly.
export function formatOffset(offsetMs: number): string {
  if (offsetMs === 0) return 'Z';
  const totalMinutes = Math.round(offsetMs / 60_000);
  const sign = totalMinutes < 0 ? '-' : '+';
  const abs = Math.abs(totalMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function parseOffset(text: string): number {
  if (text === 'Z' || text === 'z' || text === '') return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(text.trim());
  if (!match) throw new Error(`invalid offset: ${text}`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === '-' ? -1 : 1) * minutes * 60_000;
}

export function addDays(wall: number, days: number): number {
  return wall + days * MS_PER_DAY;
}

export function addMonths(year: number, month: number, day: number, delta: number): CivilDate {
  const total = year * 12 + (month - 1) + delta;
  const targetYear = Math.floor(total / 12);
  const targetMonth = (total % 12) + 1;
  const daysInMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return {year: targetYear, month: targetMonth, day: Math.min(day, daysInMonth)};
}

// Weekday as used by weekly rules: 0 = Monday ... 6 = Sunday (ISO).
export function isoWeekday(wall: number): number {
  const p = civilDateOfWall(wall);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  return (date.getUTCDay() + 6) % 7;
}
