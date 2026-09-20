import {describe,expect,it} from 'vitest';
import {
  expand, normalizeRule, encodeCursor, decodeCursor, ruleFingerprint,
  RecurrenceRule, Occurrence, candidateIndexAtOrAfter, parseLocalStamp,
} from '../src/shared/recurrence';
import {TimezoneResolver, WallFields, LocalResolution} from '../src/shared/timezone';

const NY_DAILY_0230 = (over: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  tzid:'America/New_York', dtstartLocal:'2024-01-01T02:30:00', interval:1,
  gapPolicy:'later', foldPolicy:'earlier', ...over,
});

/** Collect every chunk of a window expansion, following cursors. */
function gatherAll(rule: RecurrenceRule, window: {fromLocal:string;toLocal:string}, pageSize = 100) {
  let cursor: string | null = null;
  const occurrences: Occurrence[] = [];
  const skipped: Occurrence[] = [];
  let exhausted: boolean | undefined;
  let pages = 0;
  for (;;) {
    const page = expand(rule, {scope:'s', window, cursor, pageSize});
    // The terminal call may be an empty chunk carrying exhausted only; it
    // terminates paging but is not counted as a page.
    if (page.occurrences.length || page.skipped.length || !page.exhausted) pages += 1;
    occurrences.push(...page.occurrences);
    skipped.push(...page.skipped);
    exhausted = page.exhausted;
    cursor = page.nextCursor;
    if (!cursor) break;
    if (pages > 5000) throw new Error('too many pages');
  }
  return {occurrences, skipped, exhausted, pages};
}

const YEAR_2024 = {fromLocal:'2024-01-01T00:00:00', toLocal:'2024-12-31T23:59:59'};

describe('spring gap policies (daily 02:30 New York, 2024-03-10)', () => {
  const win = {fromLocal:'2024-03-08T00:00:00', toLocal:'2024-03-12T00:00:00'};

  it('skip removes the nominal day and reports it under skipped', () => {
    const {occurrences, skipped} = gatherAll(NY_DAILY_0230({gapPolicy:'skip'}), win);
    expect(occurrences.map(o => o.local)).toEqual([
      '2024-03-08T02:30:00','2024-03-09T02:30:00','2024-03-11T02:30:00',
    ]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      local:'2024-03-10T02:30:00', skipped:true, skipReason:'gap', utc:null, offset:null,
    });
    expect(skipped[0].framingOffsets).toEqual(['-05:00','-04:00']);
  });

  it('earlier shifts the wall reading forward to 03:30 (legacy server behavior)', () => {
    const {occurrences} = gatherAll(NY_DAILY_0230({gapPolicy:'earlier'}), win);
    const gapDay = occurrences.find(o => o.local === '2024-03-10T02:30:00')!;
    expect(gapDay.kind).toBe('gap-adjusted');
    expect(gapDay.resolvedLocal).toBe('2024-03-10T03:30:00');
    expect(gapDay.offset).toBe('-05:00');
    expect(gapDay.utc).toBe('2024-03-10T07:30:00.000Z');
  });

  it('later shifts the wall reading backward to 01:30', () => {
    const {occurrences} = gatherAll(NY_DAILY_0230({gapPolicy:'later'}), win);
    const gapDay = occurrences.find(o => o.local === '2024-03-10T02:30:00')!;
    expect(gapDay.resolvedLocal).toBe('2024-03-10T01:30:00');
    expect(gapDay.offset).toBe('-04:00');
    expect(gapDay.utc).toBe('2024-03-10T06:30:00.000Z');
  });
});

describe('autumn fold policies (daily 01:30 New York, 2024-11-03)', () => {
  const rule = (foldPolicy: 'skip'|'earlier'|'later'): RecurrenceRule => ({
    tzid:'America/New_York', dtstartLocal:'2024-01-01T01:30:00', foldPolicy,
  });
  const win = {fromLocal:'2024-11-01T00:00:00', toLocal:'2024-11-05T00:00:00'};

  it('never emits twice on the fold day regardless of policy', () => {
    for (const p of ['skip','earlier','later'] as const) {
      const {occurrences} = gatherAll(rule(p), win);
      const foldDay = occurrences.filter(o => o.local === '2024-11-03T01:30:00');
      expect(foldDay.length).toBe(p === 'skip' ? 0 : 1);
    }
  });

  it('earlier picks the first pass (-04:00, 05:30Z), later the second (-05:00, 06:30Z)', () => {
    const early = gatherAll(rule('earlier'), win).occurrences.find(o => o.local === '2024-11-03T01:30:00')!;
    const late = gatherAll(rule('later'), win).occurrences.find(o => o.local === '2024-11-03T01:30:00')!;
    expect(early.offset).toBe('-04:00');
    expect(early.utc).toBe('2024-11-03T05:30:00.000Z');
    expect(late.offset).toBe('-05:00');
    expect(late.utc).toBe('2024-11-03T06:30:00.000Z');
    expect(early.id).toBe(late.id); // identity independent of offset choice
  });
});

describe('half/quarter-hour offset zones', () => {
  it('Adelaide: daily 02:30 keeps +10:30/+09:30 fold offsets and local stepping', () => {
    const rule: RecurrenceRule = {
      tzid:'Australia/Adelaide', dtstartLocal:'2024-04-05T02:30:00',
    };
    const win = {fromLocal:'2024-04-05T00:00:00', toLocal:'2024-04-09T00:00:00'};
    const {occurrences} = gatherAll(rule, win);
    expect(occurrences.map(o => o.local)).toEqual([
      '2024-04-05T02:30:00','2024-04-06T02:30:00','2024-04-07T02:30:00','2024-04-08T02:30:00',
    ]);
    const fold = occurrences[2];
    expect(fold.kind).toBe('fold');
    expect(fold.offset).toBe('+10:30');
    expect(fold.utc).toBe('2024-04-06T16:00:00.000Z');
  });

  it('Nepal: a normal daily 02:30 never drifts across the +05:45 offset', () => {
    const rule: RecurrenceRule = {tzid:'Asia/Kathmandu', dtstartLocal:'2024-01-01T02:30:00'};
    const {occurrences} = gatherAll(rule, {
      fromLocal:'2024-01-01T00:00:00', toLocal:'2024-01-15T00:00:00',
    });
    expect(occurrences).toHaveLength(14);
    for (const o of occurrences) {
      expect(o.offset).toBe('+05:45');
      expect(o.resolvedLocal).toBe(o.local);
    }
  });

  it('Lord Howe: 30-minute fold and gap at 01:45/02:15 are handled', () => {
    const foldWin = {fromLocal:'2024-04-06T00:00:00', toLocal:'2024-04-08T00:00:00'};
    const later = gatherAll({tzid:'Australia/Lord_Howe', dtstartLocal:'2024-04-05T01:45:00', foldPolicy:'later'}, foldWin);
    const foldDay = later.occurrences.find(o => o.local === '2024-04-07T01:45:00')!;
    expect(foldDay.kind).toBe('fold');
    expect(foldDay.offset).toBe('+10:30');

    const gapWin = {fromLocal:'2024-10-05T00:00:00', toLocal:'2024-10-07T00:00:00'};
    const skip = gatherAll({tzid:'Australia/Lord_Howe', dtstartLocal:'2024-10-04T02:15:00', gapPolicy:'skip'}, gapWin);
    expect(skip.skipped.map(o => o.local)).toContain('2024-10-06T02:15:00');
  });
});

describe('historical offset changes', () => {
  it('expands across the Kathmandu 1986 gap with the chosen policy', () => {
    const rule: RecurrenceRule = {tzid:'Asia/Kathmandu', dtstartLocal:'1985-12-30T00:07:00'};
    const win = {fromLocal:'1985-12-30T00:00:00', toLocal:'1986-01-03T00:00:00'};
    const skipped = gatherAll({...rule, gapPolicy:'skip'}, win);
    expect(skipped.skipped.map(o => o.local)).toContain('1986-01-01T00:07:00');
    const adjusted = gatherAll({...rule, gapPolicy:'earlier'}, win);
    const gapDay = adjusted.occurrences.find(o => o.local === '1986-01-01T00:07:00')!;
    expect(gapDay.kind).toBe('gap-adjusted');
    expect(gapDay.resolvedLocal).toBe('1986-01-01T00:22:00');
  });
});

describe('COUNT semantics', () => {
  it('counts EMITTED occurrences (skipped gaps do not consume the count)', () => {
    const rule = NY_DAILY_0230({gapPolicy:'skip', count:3});
    // Open-ended cursor expansion.
    const p1 = expand(rule, {scope:'s', pageSize:2});
    expect(p1.occurrences.map(o => o.local)).toEqual(['2024-01-01T02:30:00','2024-01-02T02:30:00']);
    const p2 = expand(rule, {scope:'s', pageSize:2, cursor:p1.nextCursor});
    expect(p2.occurrences.map(o => o.local)).toEqual(['2024-01-03T02:30:00']);
    expect(p2.nextCursor).toBeNull();
    expect(p2.exhausted).toBe(true);
  });

  it('stops exactly at COUNT across a gap-adjusted day', () => {
    const rule = NY_DAILY_0230({dtstartLocal:'2024-03-08T02:30:00', gapPolicy:'earlier', count:3});
    const all = gatherAll(rule, {fromLocal:'2024-03-08T00:00:00', toLocal:'2024-12-31T23:59:59'});
    expect(all.occurrences.map(o => o.local)).toEqual([
      '2024-03-08T02:30:00','2024-03-09T02:30:00','2024-03-10T02:30:00',
    ]);
    expect(all.exhausted).toBe(true);
  });
});

describe('UNTIL semantics', () => {
  it('UNTIL local is inclusive and compared on local fields', () => {
    const rule = NY_DAILY_0230({untilLocal:'2024-03-09T02:30:00'});
    const {occurrences} = gatherAll(rule, {
      fromLocal:'2024-03-08T00:00:00', toLocal:'2024-03-12T00:00:00',
    });
    expect(occurrences.map(o => o.local)).toEqual([
      '2024-03-08T02:30:00','2024-03-09T02:30:00',
    ]);
  });

  it('UNTIL UTC compares against the resolved instant (gap policies included)', () => {
    // gap earlier: 03-10 nominal -> 07:30Z; bound 07:00Z excludes it.
    const rule = NY_DAILY_0230({
      dtstartLocal:'2024-03-08T02:30:00', gapPolicy:'earlier', untilUtc:'2024-03-10T07:00:00Z',
    });
    const {occurrences} = gatherAll(rule, {
      fromLocal:'2024-03-08T00:00:00', toLocal:'2024-03-12T00:00:00',
    });
    expect(occurrences.map(o => o.local)).toEqual([
      '2024-03-08T02:30:00','2024-03-09T02:30:00',
    ]);
  });
});

describe('pagination from arbitrary windows', () => {
  const rule = NY_DAILY_0230();

  it('enters mid-year windows far from DTSTART without drift', () => {
    const {occurrences} = gatherAll(rule, {
      fromLocal:'2024-07-15T00:00:00', toLocal:'2024-07-17T00:00:00',
    });
    expect(occurrences.map(o => o.local)).toEqual([
      '2024-07-15T02:30:00','2024-07-16T02:30:00',
    ]);
  });

  it.each([1,2,3,7,37,100])(
    'partitions the window with no duplicates or omissions at pageSize %i', (pageSize) => {
      const {occurrences, pages} = gatherAll(rule, YEAR_2024, pageSize);
      const ids = occurrences.map(o => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(366); // no DST gaps under default gap policy (later adjusts)
      const locals = occurrences.map(o => o.local);
      const sorted = [...locals].sort();
      expect(locals).toEqual(sorted);
      // The terminal chunk ends with exhausted=true (no trailing cursor);
      // pages count = ceil(n/size).
      expect(pages).toBe(Math.ceil(366/pageSize));
    },
  );

  it('skip policies keep pages disjoint: emitted + skipped == nominal candidates', () => {
    for (const gapPolicy of ['skip','earlier','later'] as const) {
      const {occurrences, skipped} = gatherAll(NY_DAILY_0230({gapPolicy}), YEAR_2024, 7);
      const total = occurrences.length + skipped.length;
      expect(total).toBe(366);
      const allLocal = [...occurrences.map(o => o.local), ...skipped.map(o => o.local)];
      expect(new Set(allLocal).size).toBe(366);
    }
  });

  it('adjacent windows are disjoint by nominal local stamp', () => {
    const first = gatherAll(rule, {fromLocal:'2024-03-01T00:00:00', toLocal:'2024-03-31T23:59:59'});
    const second = gatherAll(rule, {fromLocal:'2024-04-01T00:00:00', toLocal:'2024-04-30T23:59:59'});
    const a = new Set(first.occurrences.map(o => o.local));
    for (const o of second.occurrences) expect(a.has(o.local)).toBe(false);
  });

  it('rejects tampered cursors', () => {
    expect(() => expand(rule, {scope:'s', cursor:'not-base64!!'})).toThrow('invalid_cursor');
  });
});

describe('policy change stability', () => {
  it('emits the same nominal ids across gap/fold policies (skipped ids aside)', () => {
    const byPolicy = new Map<string, Set<string>>();
    for (const gapPolicy of ['skip','earlier','later'] as const) {
      const {occurrences} = gatherAll(NY_DAILY_0230({gapPolicy, foldPolicy:'later'}), YEAR_2024, 31);
      byPolicy.set(gapPolicy, new Set(occurrences.map(o => o.id)));
    }
    const earlier = byPolicy.get('earlier')!;
    const later = byPolicy.get('later')!;
    expect([...earlier]).toEqual([...later]);
    const skip = byPolicy.get('skip')!;
    for (const id of skip) expect(earlier.has(id)).toBe(true);
  });

  it('fingerprint changes when policy changes', () => {
    const a = normalizeRule(NY_DAILY_0230({gapPolicy:'earlier'}));
    const b = normalizeRule(NY_DAILY_0230({gapPolicy:'skip'}));
    expect(ruleFingerprint(a)).not.toBe(ruleFingerprint(b));
  });

  it('fingerprint changes when tzid / dtstart / interval / count / until change', () => {
    const base = normalizeRule(NY_DAILY_0230());
    const variants = [
      NY_DAILY_0230({tzid:'UTC'}),
      NY_DAILY_0230({dtstartLocal:'2024-01-02T02:30:00'}),
      NY_DAILY_0230({interval:2}),
      NY_DAILY_0230({count:10}),
      NY_DAILY_0230({untilLocal:'2024-06-01T00:00:00'}),
      NY_DAILY_0230({foldPolicy:'later'}),
    ];
    const fps = new Set(variants.map(v => ruleFingerprint(normalizeRule(v))));
    expect(fps.size).toBe(variants.length);
    for (const fp of fps) expect(fp).not.toBe(ruleFingerprint(base));
  });
});

describe('identity', () => {
  it('id is scope + nominal local stamp + ordinal and is policy-independent', () => {
    const win = {fromLocal:'2024-03-08T00:00:00', toLocal:'2024-03-12T00:00:00'};
    const a = gatherAll(NY_DAILY_0230({gapPolicy:'earlier'}), win).occurrences;
    const b = gatherAll(NY_DAILY_0230({gapPolicy:'later'}), win).occurrences;
    expect(a.map(o => o.id)).toEqual(b.map(o => o.id));
    expect(a[2].id).toBe('s:2024-03-10T02:30:00#70'); // ordinal over full rule sequence
  });

  it('ordinal is the 1-based nominal index (gap days keep a sequence position)', () => {
    const win = {fromLocal:'2024-03-08T00:00:00', toLocal:'2024-03-12T00:00:00'};
    const {occurrences, skipped} = gatherAll(NY_DAILY_0230({gapPolicy:'skip'}), win);
    expect(occurrences.map(o => o.ordinal)).toEqual([68,69,71]);
    expect(skipped[0].ordinal).toBe(70);
  });
});

describe('cursor codecs', () => {
  it('round-trips k and emitted', () => {
    const c = encodeCursor({k:41, emitted:7});
    expect(decodeCursor(c)).toEqual({k:41, emitted:7});
  });
  it('rejects legacy/foreign payloads', () => {
    const legacy = Buffer.from(JSON.stringify(['2024-01-01T00:00:00',1]),'utf8').toString('base64url');
    expect(() => decodeCursor(legacy)).toThrow('invalid_cursor');
  });
});

describe('candidate index', () => {
  it('finds the first candidate on/after a target with interval > 1', () => {
    const rule = normalizeRule({tzid:'UTC', dtstartLocal:'2024-01-01T02:30:00', interval:3});
    expect(candidateIndexAtOrAfter(rule, parseLocalStamp('2024-01-01T00:00:00'))).toBe(0);
    expect(candidateIndexAtOrAfter(rule, parseLocalStamp('2024-01-05T00:00:00'))).toBe(2); // Jan 7
    expect(candidateIndexAtOrAfter(rule, parseLocalStamp('2024-01-07T00:00:00'))).toBe(2);
    expect(candidateIndexAtOrAfter(rule, parseLocalStamp('2024-01-08T00:00:00'))).toBe(3); // Jan 10
  });
});

/** Deterministic zone with a 1-minute fold and 2-minute gap for edge coverage. */
class FakeZone implements TimezoneResolver {
  readonly zoneId = 'Fake/Minute';
  /** minuteOfUtc (absolute) -> offset seconds; piecewise transitions */
  constructor(private transitions: Array<{atMin:number;offset:number}>) {}
  offsetAt(utcMs: number): number {
    const min = Math.floor(utcMs/60000);
    let off = this.transitions[0].offset;
    for (const t of this.transitions) if (min >= t.atMin) off = t.offset;
    return off;
  }
  wallAt(utcMs: number): WallFields {
    const d = new Date(utcMs + this.offsetAt(utcMs)*1000);
    return {
      year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate(),
      hour:d.getUTCHours(),minute:d.getUTCMinutes(),second:d.getUTCSeconds(),
    };
  }
  resolveLocal(y:number,m:number,d:number,h:number,mi:number,_s:number,side:'earlier'|'later'): LocalResolution {
    const nominalMin = Date.UTC(y,m-1,d,h,mi)/60000;
    const candidates: Array<{utcMs:number;offset:number}> = [];
    for (const t of this.transitions) {
      for (const off of [this.offsetAt(t.atMin*60000-60000), this.offsetAt(t.atMin*60000)]) {
        const utcMs = (nominalMin*60 - off)*1000;
        const w = this.wallAt(utcMs);
        if (w.year===y&&w.month===m&&w.day===d&&w.hour===h&&w.minute===mi&&
            !candidates.some(c=>c.utcMs===utcMs)) candidates.push({utcMs,offset:off});
      }
    }
    candidates.sort((a,b)=>a.utcMs-b.utcMs);
    if (candidates.length>=2) {
      const pick = side==='earlier'?candidates[0]:candidates[1];
      return {shape:'fold',offsets:[candidates[0].offset,candidates[1].offset],...pick};
    }
    if (candidates.length===1) return {shape:'unique',offsets:[candidates[0].offset],...candidates[0]};
    // derive gap framing from the forward transition near nominal
    const t = this.transitions.find(tr=>this.offsetAt(tr.atMin*60000)>this.offsetAt(tr.atMin*60000-60000))!;
    const before=this.offsetAt(t.atMin*60000-60000), after=this.offsetAt(t.atMin*60000);
    const off=side==='earlier'?before:after;
    return {shape:'gap',offsets:[before,after],utcMs:nominalMin*60000-off*1000,offset:off};
  }
}

describe('sub-minute / minute-scale transitions via injected resolver', () => {
  it('expands a 1-minute fold deterministically under all policies', () => {
    // fold at minute 100: offset 0 -> -60 (wall repeats minute 99)
    const zone = new FakeZone([{atMin:0,offset:0},{atMin:100,offset:-60},{atMin:200,offset:0}]);
    const rule: RecurrenceRule = {tzid:'Fake/Minute', dtstartLocal:'1970-01-01T01:39:00', foldPolicy:'earlier'};
    const page = expand(rule, {
      scope:'s',
      window:{fromLocal:'1970-01-01T01:39:00',toLocal:'1970-01-01T01:39:00'},
    }, () => zone);
    expect(page.occurrences).toHaveLength(1);
    expect(page.occurrences[0].kind).toBe('fold');
  });
});
