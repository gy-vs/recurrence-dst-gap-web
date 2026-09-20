import express from 'express';
import {fileURLToPath} from 'node:url';
import {ZONES} from '../shared/zoneData';
import {expand, ruleFingerprint} from '../shared/rule';
import {defaultWindow, checkCursor, pageOccurrences} from '../shared/pagination';
import {ExpansionCache} from './cache';
import {recurrenceRows, validateBody, type RecurrenceDoc} from './store';

type RecordRow = {id: string; name: string; revision: number; content: string; updatedAt: string};
const rows: RecordRow[] = [
  {id: 'alpha', name: 'Primary occurrence sets', revision: 3, content: 'occurrence sets: alpha\nstate: active', updatedAt: new Date(0).toISOString()},
  {id: 'beta', name: 'Secondary occurrence sets', revision: 5, content: 'occurrence sets: beta\nstate: review', updatedAt: new Date(1000).toISOString()},
];

const expansionCache = new ExpansionCache();

function summary(doc: RecurrenceDoc) {
  return {
    id: doc.id,
    name: doc.name,
    revision: doc.revision,
    fingerprint: ruleFingerprint(doc.rule),
    updatedAt: doc.updatedAt,
  };
}

// Parse the window query params. Empty/absent means "unbounded on this side".
function readWindow(query: express.Request['query']): {windowFrom?: number; windowTo?: number; error?: string} {
  const read = (name: string): number | undefined | 'bad' => {
    const raw = query[name];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') return 'bad';
    if (raw === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 'bad';
  };
  const windowFrom = read('from');
  const windowTo = read('to');
  if (windowFrom === 'bad' || windowTo === 'bad') return {error: 'from/to must be integer UTC milliseconds'};
  if (windowFrom !== undefined && windowTo !== undefined && windowTo <= windowFrom) {
    return {error: 'to must be greater than from'};
  }
  return {windowFrom, windowTo};
}

function getCachedExpansion(
  doc: RecurrenceDoc,
  windowFrom: number | undefined,
  windowTo: number | undefined,
) {
  const fingerprint = ruleFingerprint(doc.rule);
  const key = {
    id: doc.id,
    revision: doc.revision,
    fingerprint,
    windowFrom: windowFrom ?? null,
    windowTo: windowTo ?? null,
  };
  const cached = expansionCache.get(key);
  if (cached) return {value: cached, fingerprint, cached: true as const};
  const value = expand(doc.rule, {windowFrom, windowTo, includeSkipped: true});
  expansionCache.set(key, value);
  return {value, fingerprint, cached: false as const};
}

export function createApp() {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  // --- legacy workbench records ------------------------------------------------
  app.get('/api/bootstrap', (_req, res) => res.json({family: 'recurrence-rule', count: rows.length}));
  app.get('/api/schedules', (_req, res) => res.json(rows.map(({content, ...row}) => row)));
  app.get('/api/schedules/:id', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(row);
  });
  app.put('/api/schedules/:id', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body.revision !== row.revision) return res.status(409).json({error: 'revision_conflict', current: row});
    row.content = String(req.body.content ?? '');
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json(row);
  });
  app.post('/api/schedules/:id/analyze', async (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    await new Promise(resolve => setTimeout(resolve, req.params.id === 'alpha' ? 100 : 20));
    res.json({id: row.id, revision: row.revision, lines: String(req.body.content ?? row.content).split(/\r?\n/).length, diagnostics: []});
  });

  // --- recurrence rules --------------------------------------------------------
  app.get('/api/zones', (_req, res) => {
    res.json({
      version: 'local-table-1',
      zones: Object.values(ZONES).map(zone => ({
        id: zone.id,
        initialOffsetMinutes: Math.round(zone.initialOffset / 60_000),
        transitions: zone.transitions.map(t => ({
          at: String(t.at),
          offsetBeforeMinutes: Math.round(t.offsetBefore / 60_000),
          offsetAfterMinutes: Math.round(t.offsetAfter / 60_000),
        })),
      })),
    });
  });

  app.get('/api/recurrences', (_req, res) => {
    res.json({recurrences: recurrenceRows.map(summary)});
  });

  app.get('/api/recurrences/:id', (req, res) => {
    const doc = recurrenceRows.find(value => value.id === req.params.id);
    if (!doc) return res.status(404).json({error: 'not_found'});
    res.set('ETag', `"${doc.revision}"`).json({...summary(doc), rule: doc.rule});
  });

  app.put('/api/recurrences/:id', (req, res) => {
    const doc = recurrenceRows.find(value => value.id === req.params.id);
    if (!doc) return res.status(404).json({error: 'not_found'});
    if (req.body.revision !== doc.revision) {
      return res.status(409).json({error: 'revision_conflict', current: {...summary(doc), rule: doc.rule}});
    }
    const checked = validateBody(req.body);
    if (checked.error || !checked.rule) return res.status(400).json({error: checked.error ?? 'invalid rule'});

    const invalidated = expansionCache.invalidate(doc.id);
    doc.rule = checked.rule;
    if (checked.name !== undefined) doc.name = checked.name;
    doc.revision += 1;
    doc.updatedAt = new Date().toISOString();
    res.json({...summary(doc), rule: doc.rule, cacheInvalidated: invalidated});
  });

  // Preview: full occurrence set for a window (bounded for transport), with
  // counts and skip information. The client never computes anything beyond
  // rendering these fields.
  app.get('/api/recurrences/:id/occurrences/preview', (req, res) => {
    const doc = recurrenceRows.find(value => value.id === req.params.id);
    if (!doc) return res.status(404).json({error: 'not_found'});
    const win = readWindow(req.query);
    if (win.error) return res.status(400).json({error: win.error});
    const windowFrom = win.windowFrom ?? defaultWindow(Date.now()).windowFrom;
    const windowTo = win.windowTo ?? defaultWindow(Date.now()).windowTo;
    const {value, fingerprint, cached} = getCachedExpansion(doc, windowFrom, windowTo);
    const cap = 2000;
    res.set('Cache-Tag', `${doc.id}:${doc.revision}:${fingerprint}`);
    res.json({
      id: doc.id,
      revision: doc.revision,
      fingerprint,
      zone: doc.rule.zone,
      windowFrom,
      windowTo,
      counts: {
        nominalInWindow: value.occurrences.length + value.skipped.length,
        occurrences: value.occurrences.length,
        skipped: value.skipped.length,
        truncated: value.occurrences.length >= cap,
      },
      skipped: value.skipped,
      occurrences: value.occurrences.slice(0, cap),
      exhausted: value.exhausted,
      cache: cached ? 'hit' : 'miss',
    });
  });

  // Keyset pages over any arbitrary window.
  app.get('/api/recurrences/:id/occurrences', (req, res) => {
    const doc = recurrenceRows.find(value => value.id === req.params.id);
    if (!doc) return res.status(404).json({error: 'not_found'});
    const win = readWindow(req.query);
    if (win.error) return res.status(400).json({error: win.error});
    const limitRaw = req.query.limit === undefined ? undefined : Number(req.query.limit);
    if (limitRaw !== undefined && (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 500)) {
      return res.status(400).json({error: 'limit must be an integer between 1 and 500'});
    }
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const fingerprint = ruleFingerprint(doc.rule);
    const windowFrom = win.windowFrom ?? null;
    const windowTo = win.windowTo ?? null;
    const cursorError = checkCursor(fingerprint, windowFrom, windowTo, cursor);
    if (cursorError) return res.status(cursorError.status).json({error: cursorError.error});

    const {value: expansion, cached} = getCachedExpansion(
      doc,
      windowFrom ?? undefined,
      windowTo ?? undefined,
    );
    const page = pageOccurrences(
      doc.rule,
      {windowFrom: win.windowFrom, windowTo: win.windowTo, limit: limitRaw, cursor},
      expansion,
    );
    if ('error' in page) return res.status(page.status).json({error: page.error});
    res.set('Cache-Tag', `${doc.id}:${doc.revision}:${page.fingerprint}`);
    res.json({
      id: doc.id,
      revision: doc.revision,
      fingerprint: page.fingerprint,
      windowFrom: page.windowFrom,
      windowTo: page.windowTo,
      limit: limitRaw,
      totalInWindow: page.totalInWindow,
      skipped: page.skipped,
      exhausted: page.exhausted,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      occurrences: page.occurrences,
      cache: cached ? 'hit' : 'miss',
    });
  });

  app.get('/api/debug/cache', (_req, res) => res.json(expansionCache.stats()));

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
