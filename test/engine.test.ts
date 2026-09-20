import {describe, expect, it} from 'vitest';
import {parseWall, formatWall, addMonths, daysFromCivil, civilFromDays} from '../src/shared/civil';
import {getZone} from '../src/shared/zoneData';
import {classifyWall, resolveWall} from '../src/shared/zones';
import {expand, ruleFingerprint, validateRule, type RecurRule} from '../src/shared/rule';

describe('civil arithmetic', () => {
  it('round-trips civil dates', () => {
    for (const [y, m, d] of [
      [1970, 1, 1],
      [2026, 3, 8],
      [2024, 2, 29],
      [1900, 3, 1],
      [2100, 12, 31],
    ] as const) {
      expect(civilFromDays(daysFromCivil(y, m, d))).toEqual({year: y, month: m, day: d});
    }
  });

  it('clamps monthly arithmetic to month length', () => {
    expect(addMonths(2026, 1, 31, 1)).toEqual({year: 2026, month: 2, day: 28});
    expect(addMonths(2024, 1, 31, 1)).toEqual({year: 2024, month: 2, day: 29});
    expect(addMonths(2026, 12, 15, 1)).toEqual({year: 2027, month: 1, day: 15});
  });

  it('parses and formats local fields without any host TZ involvement', () => {
    expect(formatWall(parseWall('2026-03-08T02:30'))).toBe('2026-03-08T02:30:00');
    expect(() => parseWall('2026-02-29T00:00')).toThrow();
  });
});

describe('zone classification', () => {
  const nyc = getZone('America/New_York')!;
  const lord = getZone('Australia/Lord_Howe')!;
  const caracas = getZone('America/Caracas')!;
  const moscow = getZone('Europe/Moscow')!;

  it('resolves unique wall times to the documented instant', () => {
    // 2026-03-07T02:30 in New York is standard time: 07:30Z, offset -05:00.
    const r = resolveWall(nyc, parseWall('2026-03-07T02:30'), 'earlier')!;
    expect(r.kind).toBe('unique');
    expect(r.offset).toBe(-5 * 3_600_000);
    expect(new Date(r.instant).toISOString()).toBe('2026-03-07T07:30:00.000Z');
  });

  it('classifies the New York spring gap (2026-03-08 02:00-03:00)', () => {
    const c = classifyWall(nyc, parseWall('2026-03-08T02:30'));
    expect(c.kind).toBe('gap');
    expect(c).toMatchObject({earlierOffset: -5 * 3_600_000, laterOffset: -4 * 3_600_000});
  });

  it('classifies the New York autumn fold (2026-11-01 01:00-02:00)', () => {
    const c = classifyWall(nyc, parseWall('2026-11-01T01:30'));
    expect(c.kind).toBe('fold');
    expect(c).toMatchObject({earlierOffset: -5 * 3_600_000, laterOffset: -4 * 3_600_000});
  });

  it('gap policy: earlier jumps forward on the wall clock; later keeps 02:30', () => {
    const wall = parseWall('2026-03-08T02:30');
    // earlier: instant the nominal time would have had under -05:00 (07:30Z);
    // at that instant the new -04:00 offset already applies, so local clocks
    // render 03:30 — the classic server "push forward".
    const early = resolveWall(nyc, wall, 'earlier')!;
    expect(early.instant).toBe(Date.parse('2026-03-08T07:30:00Z'));
    expect(early.offset).toBe(-4 * 3_600_000);
    // later (-04:00): 06:30Z, local clocks still show the nominal 02:30.
    const late = resolveWall(nyc, wall, 'later')!;
    expect(late.instant).toBe(Date.parse('2026-03-08T06:30:00Z'));
    expect(late.offset).toBe(-4 * 3_600_000);
    expect(resolveWall(nyc, wall, 'skip')).toBeNull();
  });

  it('fold policy chooses 06:30Z (earlier/-05) or 05:30Z (later/-04)', () => {
    const wall = parseWall('2026-11-01T01:30');
    const early = resolveWall(nyc, wall, 'earlier')!;
    expect(early.instant).toBe(Date.parse('2026-11-01T06:30:00Z'));
    const late = resolveWall(nyc, wall, 'later')!;
    expect(late.instant).toBe(Date.parse('2026-11-01T05:30:00Z'));
    expect(resolveWall(nyc, wall, 'skip')).toBeNull();
  });

  it('handles a 30-minute gap and fold on Lord Howe', () => {
    // 2026-10-04: clocks 02:00 +10:30 -> 02:30 +11:00 (gap 02:00-02:30).
    const gap = classifyWall(lord, parseWall('2026-10-04T02:15'));
    expect(gap.kind).toBe('gap');
    expect(gap).toMatchObject({earlierOffset: 630 * 60_000, laterOffset: 660 * 60_000});
    // 2027-04-04: clocks 02:00 +11:00 -> 01:30 +10:30 (fold 01:30-02:00).
    const fold = classifyWall(lord, parseWall('2027-04-04T01:45'));
    expect(fold.kind).toBe('fold');
    expect(fold).toMatchObject({earlierOffset: 630 * 60_000, laterOffset: 660 * 60_000});
  });

  it('handles the historical 30-minute Caracas gap (2007) and fold (2016)', () => {
    const gap = classifyWall(caracas, parseWall('2007-12-09T03:15'));
    expect(gap.kind).toBe('gap');
    expect(gap).toMatchObject({earlierOffset: -270 * 60_000, laterOffset: -240 * 60_000});
    const fold = classifyWall(caracas, parseWall('2016-05-01T02:15'));
    expect(fold.kind).toBe('fold');
    expect(fold).toMatchObject({earlierOffset: -270 * 60_000, laterOffset: -240 * 60_000});
  });

  it('covers the Moscow 2014 permanent-time fold', () => {
    // 2014-10-26 02:00 +04 -> 01:00 +03; fold 01:00-02:00.
    const fold = classifyWall(moscow, parseWall('2014-10-26T01:30'));
    expect(fold.kind).toBe('fold');
    expect(fold).toMatchObject({earlierOffset: 3 * 3_600_000, laterOffset: 4 * 3_600_000});
  });
});

function dailyRule(overrides: Partial<RecurRule> = {}): RecurRule {
  return {
    zone: 'America/New_York',
    startLocal: '2026-03-01T02:30:00',
    frequency: 'daily',
    interval: 1,
    gapPolicy: 'earlier',
    foldPolicy: 'earlier',
    ...overrides,
  };
}

describe('expansion', () => {
  it('COUNT counts nominal positions including a skipped gap', () => {
    const rule = dailyRule({count: 10, gapPolicy: 'skip'});
    const result = expand(rule, {includeSkipped: true});
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({local: '2026-03-08T02:30:00', reason: 'gap'});
    expect(result.occurrences).toHaveLength(9);
    expect(result.occurrences[result.occurrences.length - 1].nominalIndex).toBe(9);
  });

  it('UNTIL bounds nominal local fields inclusively', () => {
    const rule = dailyRule({startLocal: '2026-03-05T00:00:00', untilLocal: '2026-03-10T00:00:00'});
    const result = expand(rule);
    expect(result.occurrences.map(o => o.local)).toEqual([
      '2026-03-05T00:00:00',
      '2026-03-06T00:00:00',
      '2026-03-07T00:00:00',
      '2026-03-08T00:00:00',
      '2026-03-09T00:00:00',
      '2026-03-10T00:00:00',
    ]);
    expect(result.exhausted).toBe(true);
  });

  it('marks spring gap occurrences and reports resolved fields', () => {
    const result = expand(dailyRule(), {
      windowFrom: Date.parse('2026-03-07T00:00:00Z'),
      windowTo: Date.parse('2026-03-10T00:00:00Z'),
    });
    expect(result.occurrences).toHaveLength(3);
    const gap = result.occurrences[1];
    // earlier offset (-05:00) anchors the nominal instant at 07:30Z; after
    // the jump that instant renders as 03:30 in the new -04:00 offset.
    expect(gap).toMatchObject({
      local: '2026-03-08T02:30:00',
      actualLocal: '2026-03-08T03:30:00',
      status: 'gap-shifted',
      offset: '-04:00',
    });
    expect(gap.instant).toBe(String(Date.parse('2026-03-08T07:30:00Z')));
  });

  it('policies change the fingerprint', () => {
    const a = ruleFingerprint(dailyRule({gapPolicy: 'earlier'}));
    const b = ruleFingerprint(dailyRule({gapPolicy: 'later'}));
    const c = ruleFingerprint(dailyRule({foldPolicy: 'skip'}));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('validates incoming rules', () => {
    expect(validateRule(dailyRule()).error).toBeUndefined();
    expect(validateRule({...dailyRule(), zone: 'Mars/Olympus'}).error).toBeTruthy();
    expect(validateRule({...dailyRule(), interval: 0}).error).toBeTruthy();
    expect(validateRule({...dailyRule(), frequency: 'weekly'} as RecurRule).error).toBeTruthy();
  });

  it('expands fixed +05:30 half-hour offsets unchanged', () => {
    const result = expand(dailyRule({zone: 'Asia/Kolkata', count: 3}), {includeSkipped: true});
    expect(result.skipped).toEqual([]);
    expect(result.occurrences.map(o => [o.local, o.offset])).toEqual([
      ['2026-03-01T02:30:00', '+05:30'],
      ['2026-03-02T02:30:00', '+05:30'],
      ['2026-03-03T02:30:00', '+05:30'],
    ]);
  });
});
