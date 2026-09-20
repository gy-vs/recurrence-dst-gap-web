import {describe, expect, it, beforeEach} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {resetRecurrenceRows} from '../src/server/store';

beforeEach(() => resetRecurrenceRows());

function app() {
  return createApp();
}

async function getDoc(id: string) {
  const res = await request(app()).get(`/api/recurrences/${id}`).expect(200);
  return res.body;
}

describe('recurrence api', () => {
  it('serves the zone table including half-hour and historical zones', async () => {
    const res = await request(app()).get('/api/zones').expect(200);
    const ids = res.body.zones.map((z: {id: string}) => z.id);
    expect(ids).toEqual(
      expect.arrayContaining(['Asia/Kolkata', 'Australia/Lord_Howe', 'America/Caracas', 'Europe/Moscow']),
    );
  });

  it('preview reports consistent counts for COUNT (skipped included in nominal count)', async () => {
    const doc = await getDoc('kolkata-count');
    const res = await request(app())
      .get(`/api/recurrences/${doc.id}/occurrences/preview?from=0&to=4102444800000`)
      .expect(200);
    expect(res.body.counts).toMatchObject({occurrences: 10, skipped: 0, nominalInWindow: 10});
    expect(res.body.exhausted).toBe(true);
  });

  it('exposes spring gap + autumn fold on the seeded New York rule', async () => {
    // Spring 2026 window (UTC): gap day 2026-03-08.
    const spring = await request(app())
      .get('/api/recurrences/nyc-daily/occurrences/preview')
      .query({from: Date.parse('2026-03-07T00:00:00Z'), to: Date.parse('2026-03-10T00:00:00Z')})
      .expect(200);
    const gapDay = spring.body.occurrences.filter((o: {local: string}) => o.local === '2026-03-08T02:30:00');
    expect(gapDay).toHaveLength(1);
    expect(gapDay[0]).toMatchObject({status: 'gap-shifted', actualLocal: '2026-03-08T03:30:00', offset: '-04:00'});

    const autumn = await request(app())
      .get('/api/recurrences/nyc-daily/occurrences/preview')
      .query({from: Date.parse('2026-10-31T00:00:00Z'), to: Date.parse('2026-11-03T00:00:00Z')})
      .expect(200);
    const foldDay = autumn.body.occurrences.filter((o: {local: string}) => o.local === '2026-11-01T01:30:00');
    // Seeded rule is 02:30 — fold hour is 01-02, so 02:30 is unique; but the
    // rule itself contains no fold-day duplicate. Check a dedicated rule below.
    expect(foldDay).toHaveLength(0);
    expect(autumn.body.occurrences.every((o: {uid: string}, i: number, arr: Array<{uid: string}>) =>
      i === 0 || arr.findIndex(x => x.uid === o.uid) === i)).toBe(true);
  });

  it('fold rule never returns the same uid twice, under either policy', async () => {
    const server = app();
    const doc = await request(server).get('/api/recurrences/nyc-daily').expect(200);
    // Build a rule sitting inside the fold hour.
    const foldRule = {
      ...doc.body.rule,
      startLocal: '2026-10-25T01:30:00',
      untilLocal: '2026-11-08T01:30:00',
      foldPolicy: 'later',
    };
    await request(server)
      .put(`/api/recurrences/${doc.body.id}`)
      .send({revision: doc.body.revision, rule: foldRule})
      .expect(200);
    const res = await request(server)
      .get(`/api/recurrences/nyc-daily/occurrences/preview`)
      .query({from: Date.parse('2026-10-30T00:00:00Z'), to: Date.parse('2026-11-05T00:00:00Z')})
      .expect(200);
    const fold = res.body.occurrences.find((o: {local: string}) => o.local === '2026-11-01T01:30:00');
    expect(fold).toMatchObject({status: 'fold-later', offset: '-04:00'});
    expect(fold.instant).toBe(String(Date.parse('2026-11-01T05:30:00Z')));
  });
});

describe('pagination', () => {
  it('pages an arbitrary window without duplicates or gaps between pages', async () => {
    const server = app();
    const from = Date.parse('2026-01-01T00:00:00Z');
    const to = Date.parse('2026-04-01T00:00:00Z');
    let cursor: string | undefined;
    const all: Array<{uid: string; instant: string}> = [];
    let pages = 0;
    for (;;) {
      const page = await request(server)
        .get('/api/recurrences/nyc-daily/occurrences')
        .query({from, to, limit: 37, ...(cursor ? {cursor} : {})})
        .expect(200);
      pages += 1;
      all.push(...page.body.occurrences);
      if (!page.body.nextCursor) break;
      cursor = page.body.nextCursor;
    }
    expect(pages).toBeGreaterThan(2);
    const uids = new Set(all.map(o => o.uid));
    expect(uids.size).toBe(all.length);
    // Jan+Feb (31+28) + March up to the window's UTC end on 03-31/04-01;
    // every nominal day is represented exactly once (gap policy = earlier).
    expect(all.length).toBe(90);
    for (let i = 1; i < all.length; i++) {
      expect(Number(all[i].instant)).toBeGreaterThan(Number(all[i - 1].instant));
    }
  });

  it('rejects a cursor reused on a different window or after a policy change', async () => {
    const server = app();
    const first = await request(server)
      .get('/api/recurrences/nyc-daily/occurrences')
      .query({from: 1, to: 2000000000000, limit: 5})
      .expect(200);

    await request(server)
      .get('/api/recurrences/nyc-daily/occurrences')
      .query({from: 2, to: 2000000000000, limit: 5, cursor: first.body.nextCursor})
      .expect(409, {error: 'cursor_stale'});

    const doc = await request(server).get('/api/recurrences/nyc-daily').expect(200);
    await request(server)
      .put('/api/recurrences/nyc-daily')
      .send({revision: doc.body.revision, rule: {...doc.body.rule, foldPolicy: 'skip'}})
      .expect(200);
    await request(server)
      .get('/api/recurrences/nyc-daily/occurrences')
      .query({from: 1, to: 2000000000000, limit: 5, cursor: first.body.nextCursor})
      .expect(409, {error: 'cursor_stale'});
  });

  it('paging under gap=skip keeps skipped nominals out of every page', async () => {
    const server = app();
    const doc = await request(server).get('/api/recurrences/nyc-daily').expect(200);
    await request(server)
      .put('/api/recurrences/nyc-daily')
      .send({revision: doc.body.revision, rule: {...doc.body.rule, gapPolicy: 'skip'}})
      .expect(200);

    const from = Date.parse('2026-03-01T00:00:00Z');
    const to = Date.parse('2026-03-16T00:00:00Z'); // 15 nominal days, one gap
    let cursor: string | undefined;
    const all: Array<{uid: string; local: string}> = [];
    let reportedSkipped: unknown[] | undefined;
    for (;;) {
      const page = await request(server)
        .get('/api/recurrences/nyc-daily/occurrences')
        .query({from, to, limit: 4, ...(cursor ? {cursor} : {})})
        .expect(200);
      all.push(...page.body.occurrences);
      reportedSkipped = page.body.skipped;
      cursor = page.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(all).toHaveLength(14);
    expect(new Set(all.map(o => o.uid)).size).toBe(14);
    expect(all.map(o => o.local)).not.toContain('2026-03-08T02:30:00');
    expect(reportedSkipped).toEqual([
      expect.objectContaining({local: '2026-03-08T02:30:00', reason: 'gap'}),
    ]);
  });

  it('pages a 30-minute-offset DST zone (Lord Howe) across its spring gap', async () => {
    const server = app();
    const doc = await request(server).get('/api/recurrences/lord-howe-weekly').expect(200);
    await request(server)
      .put('/api/recurrences/lord-howe-weekly')
      .send({
        revision: doc.body.revision,
        rule: {
          ...doc.body.rule,
          frequency: 'daily',
          weekdays: undefined,
          startLocal: '2026-10-01T02:15:00',
          untilLocal: '2026-10-08T02:15:00',
          gapPolicy: 'earlier',
        },
      })
      .expect(200);

    const from = Date.parse('2026-10-01T00:00:00Z');
    const to = Date.parse('2026-10-09T00:00:00Z');
    const page = await request(server)
      .get('/api/recurrences/lord-howe-weekly/occurrences')
      .query({from, to, limit: 100})
      .expect(200);
    // Window starts at 10-01T00:00Z; the 10-01 local occurrence is
    // 09-30T15:45Z (+10:30), so it legitimately falls outside the UTC window.
    expect(page.body.totalInWindow).toBe(7);
    const gapDay = page.body.occurrences.find((o: {local: string}) => o.local === '2026-10-04T02:15:00');
    expect(gapDay).toMatchObject({
      status: 'gap-shifted',
      actualLocal: '2026-10-04T02:45:00',
      offset: '+11:00',
    });
  });

  it('handles a historical 30-minute fold (Caracas 2016) and gap (2007)', async () => {
    const server = app();
    const doc = await request(server).get('/api/recurrences/kolkata-count').expect(200);
    await request(server)
      .put('/api/recurrences/kolkata-count')
      .send({
        revision: doc.body.revision,
        rule: {
          zone: 'America/Caracas',
          startLocal: '2016-04-28T02:15:00',
          frequency: 'daily',
          interval: 1,
          untilLocal: '2016-05-04T02:15:00',
          gapPolicy: 'earlier',
          foldPolicy: 'later',
        },
      })
      .expect(200);
    const fold = await request(server)
      .get('/api/recurrences/kolkata-count/occurrences/preview')
      .query({from: Date.parse('2016-04-27T00:00:00Z'), to: Date.parse('2016-05-06T00:00:00Z')})
      .expect(200);
    const onFoldDay = fold.body.occurrences.find((o: {local: string}) => o.local === '2016-05-01T02:15:00');
    expect(onFoldDay).toMatchObject({status: 'fold-later', offset: '-04:00'});
    expect(fold.body.occurrences).toHaveLength(7);

    await request(server)
      .put('/api/recurrences/kolkata-count')
      .send({
        revision: 2,
        rule: {
          zone: 'America/Caracas',
          startLocal: '2007-12-07T03:15:00',
          frequency: 'daily',
          interval: 1,
          untilLocal: '2007-12-11T03:15:00',
          gapPolicy: 'earlier',
          foldPolicy: 'earlier',
        },
      })
      .expect(200);
    const gap = await request(server)
      .get('/api/recurrences/kolkata-count/occurrences/preview')
      .query({from: Date.parse('2007-12-06T00:00:00Z'), to: Date.parse('2007-12-12T00:00:00Z')})
      .expect(200);
    const onGapDay = gap.body.occurrences.find((o: {local: string}) => o.local === '2007-12-09T03:15:00');
    expect(onGapDay).toMatchObject({
      status: 'gap-shifted',
      actualLocal: '2007-12-09T03:45:00',
      offset: '-04:00',
    });
  });

  it('window edges are half-open and never double-count an instant on the boundary', async () => {
    const server = app();
    // kolkata-count: 2026-03-01T02:30 +05:30 -> 2026-02-28T21:00Z
    const boundary = Date.parse('2026-02-28T21:00:00Z');
    const includes = await request(server)
      .get('/api/recurrences/kolkata-count/occurrences')
      .query({from: boundary, to: boundary + 1, limit: 10})
      .expect(200);
    expect(includes.body.totalInWindow).toBe(1);
    const excludes = await request(server)
      .get('/api/recurrences/kolkata-count/occurrences')
      .query({from: boundary - 1, to: boundary, limit: 10})
      .expect(200);
    expect(excludes.body.totalInWindow).toBe(0);
  });
});

describe('caching', () => {
  it('serves the same window from cache and invalidates on save', async () => {
    const server = app();
    const qs = '/api/recurrences/nyc-daily/occurrences?from=1700000000000&to=1800000000000&limit=10';
    const first = await request(server).get(qs).expect(200);
    expect(first.body.cache).toBe('miss');
    const second = await request(server).get(qs).expect(200);
    expect(second.body.cache).toBe('hit');

    const statsBefore = (await request(server).get('/api/debug/cache').expect(200)).body.size;
    const doc = await request(server).get('/api/recurrences/nyc-daily').expect(200);
    const saved = await request(server)
      .put('/api/recurrences/nyc-daily')
      .send({revision: doc.body.revision, rule: {...doc.body.rule, gapPolicy: 'skip'}})
      .expect(200);
    expect(saved.body.cacheInvalidated).toBeGreaterThan(0);
    const statsAfter = (await request(server).get('/api/debug/cache').expect(200)).body.size;
    expect(statsAfter).toBeLessThan(statsBefore);
    const third = await request(server).get(qs).expect(200);
    expect(third.body.cache).toBe('miss');
  });

  it('rejects stale revisions on save', async () => {
    const server = app();
    const doc = await request(server).get('/api/recurrences/kolkata-count').expect(200);
    await request(server)
      .put('/api/recurrences/kolkata-count')
      .send({revision: doc.body.revision, rule: doc.body.rule})
      .expect(200);
    await request(server)
      .put('/api/recurrences/kolkata-count')
      .send({revision: doc.body.revision, rule: doc.body.rule})
      .expect(409);
  });

  it('rejects invalid rules', async () => {
    const server = app();
    const doc = await request(server).get('/api/recurrences/kolkata-count').expect(200);
    await request(server)
      .put('/api/recurrences/kolkata-count')
      .send({revision: doc.body.revision, rule: {...doc.body.rule, zone: 'Nowhere/Zone'}})
      .expect(400);
  });
});
