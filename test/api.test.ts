import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

const alphaRule = {
  tzid:'America/New_York',
  dtstartLocal:'2024-01-01T02:30:00',
  interval:1,
  gapPolicy:'later',
  foldPolicy:'earlier',
};

async function saveAlpha(app: ReturnType<typeof createApp>, rule: unknown) {
  const before = await request(app).get('/api/schedules/alpha').expect(200);
  const res = await request(app).put('/api/schedules/alpha')
    .send({content:JSON.stringify(rule), revision:before.body.revision})
    .expect(200);
  return res.body.revision as number;
}

describe('schedule records', () => {
  it('loads and conditionally updates a record (optimistic revision)', async () => {
    const app = createApp();
    const before = await request(app).get('/api/schedules/alpha').expect(200);
    await request(app).put('/api/schedules/alpha')
      .send({content:JSON.stringify(alphaRule), revision:before.body.revision}).expect(200);
    await request(app).put('/api/schedules/alpha')
      .send({content:JSON.stringify(alphaRule), revision:before.body.revision}).expect(409);
  });

  it('rejects content that is not a valid rule document', async () => {
    const app = createApp();
    const before = await request(app).get('/api/schedules/alpha').expect(200);
    await request(app).put('/api/schedules/alpha')
      .send({content:'not json', revision:before.body.revision}).expect(400);
    await request(app).put('/api/schedules/alpha')
      .send({content:JSON.stringify({...alphaRule,tzid:'Moon/Sea'}), revision:before.body.revision})
      .expect(400);
  });
});

describe('occurrence API: server-authoritative fields', () => {
  it('returns local fields, resolved fields, offset, utc and stable id', async () => {
    const app = createApp();
    await saveAlpha(app, alphaRule);
    const res = await request(app).post('/api/schedules/alpha/occurrences')
      .send({window:{fromLocal:'2024-03-09T00:00:00', toLocal:'2024-03-11T00:00:00'}})
      .expect(200);
    const days = res.body.occurrences;
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({
      local:'2024-03-09T02:30:00',
      resolvedLocal:'2024-03-09T02:30:00',
      utc:'2024-03-09T07:30:00.000Z',
      offset:'-05:00',
      kind:'normal',
    });
    expect(days[0].id).toMatch(/^alpha:2024-03-09T02:30:00#\d+$/);
    expect(res.body.engine).toBeTruthy();
    expect(res.body.fingerprint).toBeTruthy();
  });

  it('preview gap policy as draft without persisting', async () => {
    const app = createApp();
    const win = {fromLocal:'2024-03-09T00:00:00', toLocal:'2024-03-11T00:00:00'};
    const earlier = await request(app).post('/api/schedules/alpha/occurrences')
      .send({rule:{...alphaRule,gapPolicy:'earlier'}, window:win}).expect(200);
    expect(earlier.body.occurrences.find((o:any)=>o.local==='2024-03-10T02:30:00'))
      .toMatchObject({resolvedLocal:'2024-03-10T03:30:00', offset:'-05:00'});

    const skip = await request(app).post('/api/schedules/alpha/occurrences')
      .send({rule:{...alphaRule,gapPolicy:'skip'}, window:win}).expect(200);
    expect(skip.body.occurrences.map((o:any)=>o.local)).not.toContain('2024-03-10T02:30:00');
    expect(skip.body.skipped.map((o:any)=>o.local)).toContain('2024-03-10T02:30:00');
    expect(skip.body.ruleSource).toBe('draft');
  });
});

describe('pagination', () => {
  async function allPages(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
    let cursor: string | null = null;
    const occurrences: any[] = [];
    for (;;) {
      const res: any = await request(app).post('/api/schedules/alpha/occurrences')
        .send({...body, cursor}).expect(200);
      occurrences.push(...res.body.occurrences);
      cursor = res.body.nextCursor;
      if (!cursor) return occurrences;
      if (occurrences.length > 5000) throw new Error('runaway paging');
    }
  }

  it('pages a fixed window without duplicates or omissions across a fold', async () => {
    const app = createApp();
    await saveAlpha(app, {
      tzid:'America/New_York', dtstartLocal:'2024-01-01T01:30:00',
      gapPolicy:'later', foldPolicy:'later',
    });
    const win = {fromLocal:'2024-11-01T00:00:00', toLocal:'2024-11-05T00:00:00'};
    const ids = await allPages(app, {window:win, pageSize:1});
    expect(ids.map((o:any)=>o.local)).toEqual([
      '2024-11-01T01:30:00','2024-11-02T01:30:00',
      '2024-11-03T01:30:00','2024-11-04T01:30:00',
    ]);
    // the fold day is a single occurrence at the later offset
    const fold = ids.find((o:any)=>o.local==='2024-11-03T01:30:00');
    expect(fold.offset).toBe('-05:00');
    expect(new Set(ids.map((o:any)=>o.id)).size).toBe(4);
  });

  it('starts from an arbitrary window far from DTSTART', async () => {
    const app = createApp();
    await saveAlpha(app, alphaRule);
    const res = await request(app).post('/api/schedules/alpha/occurrences')
      .send({window:{fromLocal:'2030-06-10T00:00:00', toLocal:'2030-06-12T00:00:00'}})
      .expect(200);
    expect(res.body.occurrences.map((o:any)=>o.local)).toEqual([
      '2030-06-10T02:30:00','2030-06-11T02:30:00',
    ]);
  });

  it('COUNT is honored across pages', async () => {
    const app = createApp();
    await saveAlpha(app, {...alphaRule, count:5});
    const all = await allPages(app, {
      window:{fromLocal:'2024-01-01T00:00:00', toLocal:'2025-01-01T00:00:00'}, pageSize:2,
    });
    expect(all).toHaveLength(5);
  });
});

describe('caching and invalidation', () => {
  it('serves identical saved queries from cache then invalidates on save', async () => {
    const app = createApp();
    await saveAlpha(app, alphaRule);
    const body = {window:{fromLocal:'2024-03-09T00:00:00', toLocal:'2024-03-11T00:00:00'}};
    const first = await request(app).post('/api/schedules/alpha/occurrences').send(body).expect(200);
    expect(first.body.cached).toBe(false);
    const second = await request(app).post('/api/schedules/alpha/occurrences').send(body).expect(200);
    expect(second.body.cached).toBe(true);

    // Changing the policy changes the fingerprint => different cache key.
    const changed = await request(app).post('/api/schedules/alpha/occurrences')
      .send({...body, rule:{...alphaRule,gapPolicy:'skip'}}).expect(200);
    expect(changed.body.fingerprint).not.toBe(second.body.fingerprint);
    expect(changed.body.cached).toBe(false);

    // Saving purges all of the schedule's cached pages: query the new saved
    // policy twice — the first repopulates, the second must be a cache hit;
    // and critically the first after save is not served by the pre-save key.
    await saveAlpha(app, {...alphaRule,gapPolicy:'skip'});
    const afterSave = await request(app).post('/api/schedules/alpha/occurrences').send(body).expect(200);
    expect(afterSave.body.fingerprint).toBe(changed.body.fingerprint);
    const afterSave2 = await request(app).post('/api/schedules/alpha/occurrences').send(body).expect(200);
    expect(afterSave2.body.cached).toBe(true);
    // The old-policy page must be gone: re-saving the old policy repopulates.
    await saveAlpha(app, alphaRule);
    const oldAgain = await request(app).post('/api/schedules/alpha/occurrences').send(body).expect(200);
    expect(oldAgain.body.cached).toBe(false);
    expect(oldAgain.body.fingerprint).toBe(second.body.fingerprint);
  });
});

describe('validation', () => {
  it('400s on bad windows, page size, and policy', async () => {
    const app = createApp();
    await request(app).post('/api/schedules/alpha/occurrences')
      .send({rule:alphaRule, window:{fromLocal:'nope',toLocal:'2024-03-11T00:00:00'}}).expect(400);
    await request(app).post('/api/schedules/alpha/occurrences')
      .send({rule:alphaRule, pageSize:0}).expect(400);
    await request(app).post('/api/schedules/alpha/occurrences')
      .send({rule:{...alphaRule,gapPolicy:'explode'}}).expect(400);
    await request(app).post('/api/schedules/missing/occurrences')
      .send({}).expect(404);
  });
});
