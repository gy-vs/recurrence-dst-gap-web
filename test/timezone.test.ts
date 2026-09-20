import {describe,expect,it} from 'vitest';
import {
  IntlTimezone, formatOffset, addDaysLocal, isValidTimezone, WallFields,
} from '../src/shared/timezone';

const H = 3600;

function resolveAll(zone:string, y:number,m:number,d:number,h:number,mi:number,s=0) {
  const tz = new IntlTimezone(zone);
  return {
    earlier: tz.resolveLocal(y,m,d,h,mi,s,'earlier'),
    later: tz.resolveLocal(y,m,d,h,mi,s,'later'),
  };
}

describe('fixed and half-hour offsets', () => {
  it('resolves UTC and fixed-offset zones uniquely', () => {
    const tz = new IntlTimezone('UTC');
    const r = tz.resolveLocal(2024,3,10,2,30,0,'earlier');
    expect(r.shape).toBe('unique');
    expect(r.offset).toBe(0);
    expect(new Date(r.utcMs as number).toISOString()).toBe('2024-03-10T02:30:00.000Z');
  });

  it('supports +05:30 daily half-hour zones with no drift over a week', () => {
    const tz = new IntlTimezone('Asia/Kolkata');
    const start: WallFields = {year:2024,month:3,day:8,hour:2,minute:30,second:0};
    for (let k = 0; k < 7; k += 1) {
      const f = addDaysLocal(start,k);
      const r = tz.resolveLocal(f.year,f.month,f.day,f.hour,f.minute,f.second,'earlier');
      expect(r.shape).toBe('unique');
      expect(r.offset).toBe(5.5*H);
      expect(tz.wallAt(r.utcMs as number)).toMatchObject({hour:2,minute:30});
    }
  });

  it('supports +05:45 (quarter hour) and +12:45 zones', () => {
    const nepal = new IntlTimezone('Asia/Kathmandu').resolveLocal(2024,6,1,2,30,0,'earlier');
    expect(nepal.shape).toBe('unique');
    expect(nepal.offset).toBe(5*H+45*60);
    const chatham = new IntlTimezone('Pacific/Chatham').resolveLocal(2024,6,1,2,30,0,'earlier');
    expect(chatham.offset).toBe(12*H+45*60);
  });

  it('formats offsets including seconds for historical data', () => {
    expect(formatOffset(-5*H)).toBe('-05:00');
    expect(formatOffset(12*H+45*60)).toBe('+12:45');
    expect(formatOffset(2*H+30*60+17)).toBe('+02:30:17');
  });

  it('validates IANA zones', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });
});

describe('spring gap', () => {
  it('finds the US 2024 gap and frames it with -05:00/-04:00', () => {
    const {earlier} = resolveAll('America/New_York',2024,3,10,2,30);
    expect(earlier.shape).toBe('gap');
    expect(earlier.offsets).toEqual([-5*H,-4*H]);
  });

  it('earlier side maps 02:30 -> wall 03:30 at -05:00 (the observed server behavior)', () => {
    const tz = new IntlTimezone('America/New_York');
    const r = tz.resolveLocal(2024,3,10,2,30,0,'earlier');
    expect(new Date(r.utcMs as number).toISOString()).toBe('2024-03-10T07:30:00.000Z');
    expect(tz.wallAt(r.utcMs as number)).toMatchObject({hour:3,minute:30});
    expect(r.offset).toBe(-5*H);
  });

  it('later side maps 02:30 -> wall 01:30 at -04:00', () => {
    const tz = new IntlTimezone('America/New_York');
    const r = tz.resolveLocal(2024,3,10,2,30,0,'later');
    expect(new Date(r.utcMs as number).toISOString()).toBe('2024-03-10T06:30:00.000Z');
    expect(tz.wallAt(r.utcMs as number)).toMatchObject({hour:1,minute:30});
    expect(r.offset).toBe(-4*H);
  });

  it('treats the first post-gap instant (03:00) uniquely', () => {
    const r = resolveAll('America/New_York',2024,3,10,3,0);
    expect(r.earlier.shape).toBe('unique');
    expect(new Date(r.earlier.utcMs as number).toISOString()).toBe('2024-03-10T07:00:00.000Z');
  });

  it('handles a 30-minute gap in a half-hour offset zone (Adelaide)', () => {
    // 2024-10-06: +09:30 -> +10:30, wall 02:00-02:30 removed.
    const tz = new IntlTimezone('Australia/Adelaide');
    const gap = tz.resolveLocal(2024,10,6,2,15,0,'earlier');
    expect(gap.shape).toBe('gap');
    expect(gap.offsets).toEqual([9.5*H,10.5*H]);
    const boundary = tz.resolveLocal(2024,10,6,2,30,0,'later');
    expect(boundary.shape).toBe('gap'); // 02:30 nominal did not exist either
  });

  it('handles a 30-minute gap on Lord Howe Island (+10:30 -> +11:00)', () => {
    const tz = new IntlTimezone('Australia/Lord_Howe');
    const r = tz.resolveLocal(2024,10,6,2,15,0,'earlier');
    expect(r.shape).toBe('gap');
    expect(r.offsets).toEqual([10.5*H,11*H]);
  });
});

describe('autumn fold', () => {
  it('finds the US 2024 fold with two valid instants for 01:30', () => {
    const tz = new IntlTimezone('America/New_York');
    const earlier = tz.resolveLocal(2024,11,3,1,30,0,'earlier');
    const later = tz.resolveLocal(2024,11,3,1,30,0,'later');
    expect(earlier.shape).toBe('fold');
    expect(later.shape).toBe('fold');
    expect(new Date(earlier.utcMs as number).toISOString()).toBe('2024-11-03T05:30:00.000Z');
    expect(new Date(later.utcMs as number).toISOString()).toBe('2024-11-03T06:30:00.000Z');
    expect(earlier.offset).toBe(-4*H);
    expect(later.offset).toBe(-5*H);
  });

  it('never emits two instants from a single resolve call (fall "twice" bug guard)', () => {
    const {earlier,later} = resolveAll('America/New_York',2024,11,3,1,30);
    expect(earlier.utcMs).not.toBe(later.utcMs);
    // both sides must reproduce the exact same wall fields
    const tz = new IntlTimezone('America/New_York');
    for (const ms of [earlier.utcMs,later.utcMs] as number[]) {
      expect(tz.wallAt(ms)).toMatchObject({month:11,day:3,hour:1,minute:30});
    }
  });

  it('resolves a half-hour-zone fold (Adelaide +10:30 -> +09:30)', () => {
    const tz = new IntlTimezone('Australia/Adelaide');
    const earlier = tz.resolveLocal(2024,4,7,2,30,0,'earlier');
    const later = tz.resolveLocal(2024,4,7,2,30,0,'later');
    expect(earlier.shape).toBe('fold');
    expect(earlier.offset).toBe(10.5*H);
    expect(later.offset).toBe(9.5*H);
    expect(new Date(earlier.utcMs as number).toISOString()).toBe('2024-04-06T16:00:00.000Z');
    expect(new Date(later.utcMs as number).toISOString()).toBe('2024-04-06T17:00:00.000Z');
  });

  it('resolves the 30-minute Lord Howe fold and 45-minute Chatham fold', () => {
    const lh = resolveAll('Australia/Lord_Howe',2024,4,7,1,45);
    expect(lh.earlier.shape).toBe('fold');
    expect(lh.earlier.offsets).toEqual([11*H,10.5*H]);
    expect(lh.later.utcMs! - lh.earlier.utcMs!).toBe(30*60*1000);
    const ch = resolveAll('Pacific/Chatham',2024,4,7,2,45);
    expect(ch.earlier.shape).toBe('fold');
    expect(ch.earlier.offsets).toEqual([13.75*H,12.75*H]);
    // same wall time at differing offsets => instants are 1h apart in UTC.
    expect(ch.later.utcMs! - ch.earlier.utcMs!).toBe(H*1000);
  });
});

describe('historical offset changes', () => {
  it('detects the Kathmandu 1985/86 +5:30 -> +5:45 change as a 15-minute gap', () => {
    const tz = new IntlTimezone('Asia/Kathmandu');
    // transition at 1985-12-31 18:30Z: local wall jumps 23:59:59 -> 00:15,
    // so 1986-01-01 00:00..00:14 never happened.
    const gone = tz.resolveLocal(1986,1,1,0,7,0,'earlier');
    expect(gone.shape).toBe('gap');
    expect(gone.offsets).toEqual([5.5*H,5.75*H]);
    const validAfter = tz.resolveLocal(1986,1,1,0,15,0,'earlier');
    expect(validAfter.shape).toBe('unique');
    expect(validAfter.offset).toBe(5.75*H);
  });

  it('exposes second-precision historical offsets (Moscow 1880 LMT)', () => {
    const tz = new IntlTimezone('Europe/Moscow');
    expect(tz.offsetAt(Date.UTC(1880,0,1))).toBe(2*H+30*60+17);
  });

  it('treats Moscow 2014 permanent +04 -> +03 as a fold', () => {
    const r = resolveAll('Europe/Moscow',2014,10,26,1,30);
    expect(r.earlier.shape).toBe('fold');
    expect(r.earlier.offset).toBe(4*H);
    expect(r.later.offset).toBe(3*H);
  });

  it('resolves a 30-minute gap in 1981 Lord Howe data (+10:00 -> +10:30)', () => {
    const tz = new IntlTimezone('Australia/Lord_Howe');
    const r = tz.resolveLocal(1981,3,1,0,15,0,'earlier');
    expect(r.shape).toBe('gap');
    expect(r.offsets).toEqual([10*H,10.5*H]);
  });
});

describe('wide-window stability', () => {
  it('classifies a fold identically after scanning a multi-year window first', () => {
    const tz = new IntlTimezone('America/New_York');
    // Force a broad scan first (regression: bisection boundary noise used to
    // make later fold matches fail).
    (tz as unknown as {scanTransitions(a:number,b:number):unknown})
      .scanTransitions(Date.UTC(1900,0,1),Date.UTC(2100,0,1));
    const r = tz.resolveLocal(2024,11,3,1,30,0,'earlier');
    expect(r.shape).toBe('fold');
    expect(r.offset).toBe(-4*H);
    const g = tz.resolveLocal(2024,3,10,2,30,0,'earlier');
    expect(g.shape).toBe('gap');
  });
});
