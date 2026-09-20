import {MS_PER_DAY, toWallMillis} from './civil';
import type {Transition, Zone} from './zones';

const H = 3_600_000;

// UTC millis of `y-m-d H:MM` *as if read in the given offset* — i.e. the
// transition's local clock time, converted to the actual instant.
function localAt(year: number, month: number, day: number, hour: number, minute: number, offsetMs: number): number {
  return toWallMillis({year, month, day}, {hour, minute, second: 0, millisecond: 0}) - offsetMs;
}

// nth weekday (n=1..; -1 = last) of a month, at a fixed local clock time.
function nthWeekdayLocal(
  year: number,
  month: number,
  weekday: number, // 0 Sun .. 6 Sat
  nth: number,
  hour: number,
  minute: number,
  offsetMs: number,
): number {
  const day = (() => {
    if (nth > 0) {
      const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
      return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
    }
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const last = new Date(Date.UTC(year, month - 1, daysInMonth)).getUTCDay();
    return daysInMonth - ((last - weekday + 7) % 7);
  })();
  return localAt(year, month, day, hour, minute, offsetMs);
}

function buildNewYork(): Transition[] {
  const transitions: Transition[] = [];
  for (let year = 2000; year < 2075; year++) {
    if (year < 2007) {
      // First Sunday of April 02:00 local standard (-05:00) -> -04:00;
      // last Sunday of October 02:00 local daylight (-04:00) -> -05:00.
      transitions.push({
        at: nthWeekdayLocal(year, 4, 0, 1, 2, 0, -5 * H),
        offsetBefore: -5 * H,
        offsetAfter: -4 * H,
      });
      transitions.push({
        at: nthWeekdayLocal(year, 10, 0, -1, 2, 0, -4 * H),
        offsetBefore: -4 * H,
        offsetAfter: -5 * H,
      });
    } else {
      // Second Sunday of March 02:00 (-05:00 -> -04:00);
      // first Sunday of November 02:00 (-04:00 -> -05:00).
      transitions.push({
        at: nthWeekdayLocal(year, 3, 0, 2, 2, 0, -5 * H),
        offsetBefore: -5 * H,
        offsetAfter: -4 * H,
      });
      transitions.push({
        at: nthWeekdayLocal(year, 11, 0, 1, 2, 0, -4 * H),
        offsetBefore: -4 * H,
        offsetAfter: -5 * H,
      });
    }
  }
  return transitions.sort((a, b) => a.at - b.at);
}

function buildLordHowe(): Transition[] {
  const transitions: Transition[] = [];
  // Standard +10:30; DST +11:00 (30-minute shifts). DST runs first Sunday of
  // October (02:00 standard) to first Sunday of April (02:00 daylight).
  for (let year = 2000; year < 2075; year++) {
    transitions.push({
      at: nthWeekdayLocal(year, 10, 0, 1, 2, 0, 630 * 60_000),
      offsetBefore: 630 * 60_000,
      offsetAfter: 660 * 60_000,
    });
    transitions.push({
      at: nthWeekdayLocal(year + 1, 4, 0, 1, 2, 0, 660 * 60_000),
      offsetBefore: 660 * 60_000,
      offsetAfter: 630 * 60_000,
    });
  }
  return transitions.sort((a, b) => a.at - b.at);
}

function buildMoscow(): Transition[] {
  const transitions: Transition[] = [];
  // Last Sunday of March 02:00 standard (+03:00) -> +04:00;
  // last Sunday of October 03:00 daylight (+04:00) -> +03:00,
  // through 2010.
  for (let year = 2000; year <= 2010; year++) {
    transitions.push({
      at: nthWeekdayLocal(year, 3, 0, -1, 2, 0, 3 * H),
      offsetBefore: 3 * H,
      offsetAfter: 4 * H,
    });
  }
  for (let year = 2000; year <= 2010; year++) {
    transitions.push({
      at: nthWeekdayLocal(year, 10, 0, -1, 3, 0, 4 * H),
      offsetBefore: 4 * H,
      offsetAfter: 3 * H,
    });
  }
  // 2011-03-27 02:00 +03:00 -> permanent +04:00.
  transitions.push({at: localAt(2011, 3, 27, 2, 0, 3 * H), offsetBefore: 3 * H, offsetAfter: 4 * H});
  // 2014-10-26 02:00 +04:00 -> permanent +03:00.
  transitions.push({at: localAt(2014, 10, 26, 2, 0, 4 * H), offsetBefore: 4 * H, offsetAfter: 3 * H});
  return transitions.sort((a, b) => a.at - b.at);
}

function buildCaracas(): Transition[] {
  // -04:30 -> -04:00 on 2007-12-09 at 03:00 local (clocks jump to 03:30):
  // a 30-minute gap at 03:00-03:30. Reverted on 2016-05-01 at 02:30 local
  // (-04:00, clocks go back to 02:00 in -04:30): a 30-minute fold 02:00-02:30.
  return [
    {at: localAt(2007, 12, 9, 3, 0, -270 * 60_000), offsetBefore: -270 * 60_000, offsetAfter: -4 * H},
    {at: localAt(2016, 5, 1, 2, 30, -4 * H), offsetBefore: -4 * H, offsetAfter: -270 * 60_000},
  ];
}

export const HORIZON_START = Date.UTC(1970, 0, 1);
export const HORIZON_END = Date.UTC(2100, 0, 1);

function fixedZone(id: string, offsetMs: number): Zone {
  return {id, initialOffset: offsetMs, transitions: [], horizonStart: HORIZON_START, horizonEnd: HORIZON_END};
}

export const ZONES: Record<string, Zone> = Object.fromEntries(
  [
    fixedZone('UTC', 0),
    fixedZone('Asia/Kolkata', 330 * 60_000),
    fixedZone('Asia/Kathmandu', 345 * 60_000),
    {
      id: 'America/Caracas',
      initialOffset: -270 * 60_000,
      transitions: buildCaracas(),
      horizonStart: HORIZON_START,
      horizonEnd: HORIZON_END,
    },
    {
      id: 'Europe/Moscow',
      initialOffset: 3 * H,
      transitions: buildMoscow(),
      horizonStart: HORIZON_START,
      horizonEnd: HORIZON_END,
    },
    {
      id: 'America/New_York',
      initialOffset: -5 * H,
      transitions: buildNewYork(),
      horizonStart: HORIZON_START,
      horizonEnd: HORIZON_END,
    },
    {
      id: 'Australia/Lord_Howe',
      initialOffset: 630 * 60_000,
      transitions: buildLordHowe(),
      horizonStart: HORIZON_START,
      horizonEnd: HORIZON_END,
    },
  ].map(zone => [zone.id, zone]),
);

export function getZone(id: string): Zone | undefined {
  return ZONES[id];
}

export {MS_PER_DAY};
