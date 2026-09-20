# Recurrence Rule Studio

Daily recurrence editor with **server-authoritative timezone expansion**.

The server (Node + IANA tz data via `Intl`) resolves every local wall-clock
timestamp and returns each occurrence's nominal local fields, the resolved
local fields, the UTC instant, the effective offset and a stable id. The React
client only renders those fields — it never recomputes instants with the
browser `Date`, so preview and saved results cannot diverge.

## Gap / fold policy

Expansion is driven entirely by **local calendar fields** (cursors, COUNT and
UNTIL all advance in local days; UTC instants are attached afterwards). Both
ambiguous shapes are configurable independently:

| shape | example | `skip` | `earlier` | `later` |
| --- | --- | --- | --- | --- |
| spring **gap** (wall time missing) | NY 2024-03-10 02:30 | day omitted | keep pre-jump offset (-05:00), clock reads **03:30** | take post-jump offset (-04:00), clock reads **01:30** |
| autumn **fold** (wall time repeats) | NY 2024-11-03 01:30 | day omitted | first pass, -04:00 (05:30Z) | second pass, -05:00 (06:30Z) |

Offsets are labelled earlier/later by the moment in time at which they are in
effect, independent of whether the offset numerically grows or shrinks.

Half/quarter-hour zones (Asia/Kolkata +05:30, Asia/Kathmandu +05:45,
Pacific/Chatham +12:45, Australia/Adelaide/Lord_Howe) and historical offset
changes (e.g. Kathmandu 1986, Moscow 1880 LMT seconds) resolve the same way.

## Pagination & cache correctness

- The cursor records the processed candidate index `k` and the emitted count in
  the integer local-day sequence. "Before/after cursor" is therefore an exact
  partition — adjacent pages and adjacent windows never duplicate or omit an
  occurrence, regardless of the gap/fold policy.
- `COUNT` counts **emitted** occurrences (skipped gaps don't consume a slot).
- `UNTIL` is supported as a local-field bound (`untilLocal`) or a UTC-instant
  bound (`untilUtc`).
- Windows are inclusive local-stamp ranges; expansion can start at any window,
  far from DTSTART.
- The server cache key embeds an engine version and a fingerprint of every rule
  field including both policies. Changing a policy (or engine version) changes
  the key, so stale pages are never served; saving a schedule purges all of its
  cached pages.

## API

- `GET  /api/schedules` / `GET /api/schedules/:id` / `PUT /api/schedules/:id`
  (content is a JSON rule document; optimistic revision checks)
- `POST /api/schedules/:id/analyze` — validate a draft rule
- `POST /api/schedules/:id/occurrences`
  ```json
  {"rule": { "...optional draft preview..." },
   "window": {"fromLocal": "2024-03-01T00:00:00", "toLocal": "2024-03-31T23:59:59"},
   "cursor": null, "pageSize": 100}
  ```
  returns `{occurrences, skipped, nextCursor, exhausted, fingerprint, ...}`.
  Without `rule` the saved document is used; draft previews bypass the cache.

## Develop

```bash
npm install
npm test      # timezone layer + recurrence engine + API (vitest)
npm run dev   # tsx server :4174 + vite :4173 (proxied)
npm run build
```
