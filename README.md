# Recurrence Rule Studio

DST-correct recurring rules expanded from **timezone local fields**.

Run `npm install`, then `npm run dev` (API on :4174, Vite on :4173). Tests: `npm test`.

## Why

A naive "02:30 every day" rule breaks twice a year:

- **Spring gap** — `02:30` does not exist on the jump-forward night.
- **Autumn fold** — `01:30` (or `02:30` depending on the rule) happens twice.

If the server and browser resolve those independently, the preview and the
stored occurrence set disagree. Here the **server is the only place that
computes occurrences**; the browser renders exactly what it receives.

## Model

- `src/shared/civil.ts` — pure civil-date arithmetic (no host TZ). A "wall
  millisecond" is a local clock reading interpreted as if it were UTC.
- `src/shared/zones.ts` — zones as explicit offset-transition tables.
  `classifyWall` returns `unique | gap | fold`; `resolveWall` applies the
  configured policy.
- `src/shared/zoneData.ts` — bundled zones:
  - `UTC`, `Asia/Kolkata` (+05:30), `Asia/Kathmandu` (+05:45) — fixed half/quarter-hour
  - `America/Caracas` — historical 30-minute **gap** (2007-12-09) and **fold** (2016-05-01)
  - `Europe/Moscow` — DST until 2010, permanent +04:00, permanent +03:00 from 2014
  - `America/New_York` — yearly 1-hour gap/fold
  - `Australia/Lord_Howe` — yearly **30-minute** gap/fold (+10:30/+11:00)
- `src/shared/rule.ts` — `daily | weekly | monthly`, `COUNT`/`UNTIL` on the
  **nominal local sequence**, fingerprints, `expand()`.
- `src/shared/pagination.ts` — keyset pages over a fixed
  `(fingerprint, window)` pair.
- `src/server/*` — Express API, optimistic revisions, invalidating cache.

## Gap/fold policies

Configurable independently for gaps and folds: `skip`, `earlier`, `later`.

| | spring gap (`02:30` missing) | autumn fold (`01:30` twice) |
|---|---|---|
| `earlier` | instant as under the old offset; renders as `03:30` after the jump | first pass (earlier offset) |
| `later` | first valid instant; local clocks still show `02:30` | second pass (later offset) |
| `skip` | no occurrence that day | no occurrence that day |

Skipped nominals still consume a `COUNT` position and are reported in a
separate `skipped` list so nominal and materialized counts reconcile.

## Occurrence payload

```json
{
  "uid": "r1-02957227:304",
  "nominalIndex": 304,
  "local": "2026-11-01T01:30:00",
  "actualLocal": "2026-11-01T01:30:00",
  "offset": "-04:00",
  "offsetMinutes": -240,
  "instant": "1793511000000",
  "status": "fold-later",
  "ambiguous": true
}
```

`uid` is `ruleFingerprint:nominalIndex`, stable across pages and windows.
The client never parses `local`/`actualLocal` with `Date`; it only formats
the UTC `instant` for display.

## Pagination & cache

- Windows are half-open UTC intervals `[from, to)`; any arbitrary window is
  allowed. Adjacent pages are slices of one globally-sorted list, so no
  occurrence can repeat or vanish at a page edge.
- The cursor pins `fingerprint + window + last uid`. Changing the window or
  the rule (including a policy change) returns `409 cursor_stale`.
- The expansion cache key contains document revision, fingerprint and
  window; every save drops the document's entries and reports how many were
  invalidated (`cacheInvalidated`). A policy change therefore cannot serve a
  stale expansion.

## API

- `GET  /api/zones`
- `GET  /api/recurrences` / `GET /api/recurrences/:id`
- `PUT  /api/recurrences/:id` — body `{revision, name?, rule}`; 409 on stale revision
- `GET  /api/recurrences/:id/occurrences/preview?from&to` — bounded set + counts + skipped
- `GET  /api/recurrences/:id/occurrences?from&to&limit&cursor` — keyset pages
