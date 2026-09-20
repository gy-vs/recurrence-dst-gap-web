/**
 * Recurrence expansion engine.
 *
 * Everything is driven by LOCAL WALL-CLOCK FIELDS: the cursor, COUNT and
 * UNTIL all advance in the zone's local calendar, and UTC instants are only
 * attached after gap/fold resolution. This guarantees:
 *   - half/quarter-hour zones advance by exactly one local day (no 30/45min
 *     drift that iterating UTC instants would introduce);
 *   - pagination keyed on the nominal local timestamp is stable regardless of
 *     the chosen gap/fold policy, so adjacent pages never overlap or lose an
 *     occurrence when the policy changes;
 *   - the identity of an occurrence never depends on offset resolution.
 */

import {
  IntlTimezone, TimezoneResolver, WallFields, localStamp, formatOffset, addDaysLocal,
} from './timezone';

export type GapPolicy = 'skip' | 'earlier' | 'later';
export type FoldPolicy = 'skip' | 'earlier' | 'later';

export const GAP_POLICIES: GapPolicy[] = ['skip', 'earlier', 'later'];
export const FOLD_POLICIES: FoldPolicy[] = ['skip', 'earlier', 'later'];

/**
 * Daily recurrence rule. The local time-of-day (hour/minute/second) is taken
 * from dtstartLocal; stepping happens in local calendar days.
 */
export interface RecurrenceRule {
  /** IANA zone id, e.g. "America/New_York". */
  tzid: string;
  /** First occurrence as a local timestamp, e.g. "2024-01-01T02:30:00". */
  dtstartLocal: string;
  interval?: number; // default 1
  /** Stop after this many EMITTED occurrences (skipped gaps are not emitted). */
  count?: number;
  /** Inclusive bound; compared in local fields (RFC 5545 UNTIL with TZID). */
  untilLocal?: string;
  /** Inclusive bound; compared against the resolved UTC instant (DATE-TIME UTC). */
  untilUtc?: string;
  gapPolicy?: GapPolicy; // default 'later'
  foldPolicy?: FoldPolicy; // default 'earlier'
}

export type OccurrenceKind = 'normal' | 'gap-adjusted' | 'fold';

/**
 * One server-resolved occurrence. `local` is the nominal (rule) wall time the
 * user scheduled; `resolvedLocal` is what the clock reads at the picked instant
 * (identical for fold/normal, shifted for gap-adjusted).
 */
export interface Occurrence {
  /** Stable identity, independent of policy: "<scope>:<nominal local stamp>#<ordinal>". */
  id: string;
  /** 1-based position of the NOMINAL candidate in the local-day sequence. */
  ordinal: number;
  /** Nominal rule timestamp, e.g. "2024-03-10T02:30:00". */
  local: string;
  /** Wall fields actually read at the selected instant. */
  resolvedLocal: string;
  /** UTC instant, e.g. "2024-03-10T07:30:00.000Z"; null only when gap+skip. */
  utc: string | null;
  /** Effective offset "+HH:MM[:SS]"; null only when gap+skip. */
  offset: string | null;
  kind: OccurrenceKind;
  /** Framing offsets for gap/fold diagnostics; length 1 when normal. */
  framingOffsets: string[];
  skipped: boolean;
  skipReason?: 'gap';
}

/** Version bump invalidates every derived server cache keyed on ENGINE_VERSION. */
export const ENGINE_VERSION = 'tz-local-v1';

export interface NormalizedRule {
  tzid: string;
  dtstart: WallFields;
  interval: number;
  count?: number;
  untilLocal?: WallFields;
  untilUtcMs?: number;
  gapPolicy: GapPolicy;
  foldPolicy: FoldPolicy;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?[Zz]$/;

export function stampOf(f: WallFields): string {
  return localStamp(f.year, f.month, f.day, f.hour, f.minute, f.second);
}

export function parseLocalStamp(stamp: string): WallFields {
  const m = LOCAL_RE.exec(stamp.trim());
  if (!m) throw new Error(`invalid_local_stamp:${stamp}`);
  const f = {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0),
  };
  validateFields(f, stamp);
  return f;
}

function validateFields(f: WallFields, stamp: string): void {
  if (f.month < 1 || f.month > 12 || f.hour > 23 || f.minute > 59 || f.second > 59) {
    throw new Error(`invalid_local_stamp:${stamp}`);
  }
  const probe = Date.UTC(f.year, f.month - 1, f.day);
  const d = new Date(probe);
  if (d.getUTCMonth() !== f.month - 1 || d.getUTCDate() !== f.day) {
    throw new Error(`invalid_local_stamp:${stamp}`);
  }
}

export function normalizeRule(input: RecurrenceRule): NormalizedRule {
  if (!input || typeof input !== 'object') throw new Error('rule_required');
  const {tzid, dtstartLocal} = input;
  if (typeof tzid !== 'string' || !tzid) throw new Error('tzid_required');
  if (typeof dtstartLocal !== 'string' || !dtstartLocal) throw new Error('dtstart_required');
  const dtstart = parseLocalStamp(dtstartLocal);

  const interval = input.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) throw new Error('interval_must_be_positive_integer');

  const count = input.count;
  if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
    throw new Error('count_must_be_positive_integer');
  }
  if (input.untilLocal !== undefined && input.untilUtc !== undefined) {
    throw new Error('until_local_and_utc_conflict');
  }
  let untilLocal: WallFields | undefined;
  let untilUtcMs: number | undefined;
  if (input.untilLocal !== undefined) untilLocal = parseLocalStamp(input.untilLocal);
  if (input.untilUtc !== undefined) {
    const raw = input.untilUtc.trim();
    if (!UTC_RE.test(raw)) throw new Error(`invalid_utc_stamp:${input.untilUtc}`);
    const ms = Date.parse(raw.replace(' ', 'T'));
    if (Number.isNaN(ms)) throw new Error(`invalid_utc_stamp:${input.untilUtc}`);
    untilUtcMs = ms;
  }
  if (untilLocal && compareDayAware(untilLocal, dtstart) < 0) throw new Error('until_before_dtstart');

  const gapPolicy = input.gapPolicy ?? 'later';
  const foldPolicy = input.foldPolicy ?? 'earlier';
  if (!GAP_POLICIES.includes(gapPolicy)) throw new Error(`invalid_gap_policy:${gapPolicy}`);
  if (!FOLD_POLICIES.includes(foldPolicy)) throw new Error(`invalid_fold_policy:${foldPolicy}`);

  return {tzid, dtstart, interval, count, untilLocal, untilUtcMs, gapPolicy, foldPolicy};
}

export function compareLocal(a: WallFields, b: WallFields): number {
  return compareDayAware(a, b);
}

/** Compare on date first then wall time (all daily candidates share wall time). */
function compareDayAware(a: WallFields, b: WallFields): number {
  const da = Date.UTC(a.year, a.month - 1, a.day, a.hour, a.minute, a.second);
  const db = Date.UTC(b.year, b.month - 1, b.day, b.hour, b.minute, b.second);
  return Math.sign(da - db);
}

/**
 * Compact fingerprint of everything that changes an expansion. It is part of
 * every cache key: changing the policy (or engine version) silently invalidates
 * all old cached pages.
 */
export function ruleFingerprint(rule: NormalizedRule): string {
  return [
    ENGINE_VERSION,
    rule.tzid,
    stampOf(rule.dtstart),
    rule.interval,
    rule.count ?? '',
    rule.untilLocal ? stampOf(rule.untilLocal) : '',
    rule.untilUtcMs ?? '',
    rule.gapPolicy,
    rule.foldPolicy,
  ].join('|');
}

export interface OccurrencePage {
  /** Emitted occurrences inside the window, sorted by nominal local stamp. */
  occurrences: Occurrence[];
  /** Nominal candidates skipped inside the window (gap+skip), sorted. */
  skipped: Occurrence[];
  /** Opaque cursor for the next chunk; null when the rule/window has ended. */
  nextCursor: string | null;
  /** True once COUNT emitted / UNTIL bound / window end / horizon is reached. */
  exhausted: boolean;
}

export interface ExpandWindow {
  /** Inclusive local stamps, e.g. "2024-03-01T00:00:00". */
  fromLocal: string;
  toLocal: string;
}

export interface ExpandOptions {
  /** Schedule id used as the occurrence id scope. */
  scope: string;
  /** Window in local time; absent => cursor-driven chunk starting at DTSTART. */
  window?: ExpandWindow;
  /** Resume point returned by a previous call. */
  cursor?: string | null;
  /** Chunk size (default 100, hard cap 10_000). */
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 10_000;
/**
 * Hard ceiling on nominal candidates scanned per call. Open-ended window scans
 * without COUNT/UNTIL are bounded here; callers continue via cursor.
 */
const MAX_SCAN_PER_CALL = 200_000;

/**
 * Decoded cursor. `k` is the nominal candidate index last fully processed
 * (0-based local-day multiple of interval); `emitted` counts emitted
 * occurrences so COUNT resumes correctly. Storing k — rather than a timestamp
 * re-derived via day arithmetic — is what makes "resume after" an exact
 * partition of the integer candidate sequence.
 */
export interface CursorState {k: number; emitted: number}

export function encodeCursor(state: CursorState): string {
  const json = JSON.stringify([ENGINE_CURSOR_TAG, state.k, state.emitted]);
  return Buffer.from(json, 'utf8').toString('base64url');
}

const ENGINE_CURSOR_TAG = 1;

export function decodeCursor(cursor: string): CursorState {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed[0] !== ENGINE_CURSOR_TAG) throw new Error('bad_tag');
    const k = parsed[1];
    const emitted = parsed[2];
    if (!Number.isInteger(k) || k < 0 || !Number.isInteger(emitted) || emitted < 0) {
      throw new Error('bad_values');
    }
    return {k, emitted};
  } catch {
    throw new Error('invalid_cursor');
  }
}

/**
 * Smallest k such that dtstart + k*interval local days >= target.
 *
 * The index space is the integer LOCAL DAY sequence (UTC-anchored arithmetic
 * on wall fields only): the zone offset cancels because both endpoints share
 * the same wall time, so 30/45-minute zones land on exactly the right day and
 * gap/fold policy cannot move candidates between pages.
 */
export function candidateIndexAtOrAfter(rule: NormalizedRule, target: WallFields): number {
  const t0 = Date.UTC(rule.dtstart.year, rule.dtstart.month - 1, rule.dtstart.day);
  const t1 = Date.UTC(target.year, target.month - 1, target.day);
  const dayDiff = Math.round((t1 - t0) / 86_400_000);
  let k = Math.max(0, Math.floor(dayDiff / rule.interval));
  // Adjust floor (and any DST-rounded edges) by direct local comparison.
  for (let guard = 0; guard < 3; guard += 1) {
    const cand = addDaysLocal(rule.dtstart, k * rule.interval);
    const dayCmp = Date.UTC(cand.year, cand.month - 1, cand.day) - t1;
    if (dayCmp >= 0) return k;
    k += 1;
  }
  return k;
}

/**
 * Expand one chunk. The partition of the candidate sequence is
 * "... <= cursor.after | cursor.after < ..." in nominal-local space, an exact
 * split of an arithmetic day sequence — adjacent pages can never repeat or
 * omit a candidate, regardless of gap/fold policy.
 */
export function expand(
  ruleInput: RecurrenceRule | NormalizedRule,
  options: ExpandOptions,
  resolverFactory?: (tzid: string) => TimezoneResolver,
): OccurrencePage {
  const rule = 'dtstart' in ruleInput ? ruleInput : normalizeRule(ruleInput);
  const factory = resolverFactory ?? ((tzid: string) => new IntlTimezone(tzid));
  const tz = factory(rule.tzid);

  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('page_size_must_be_positive_integer');
  if (pageSize > MAX_PAGE_SIZE) throw new Error('page_size_too_large');

  let windowFrom: WallFields | null = null;
  let windowTo: WallFields | null = null;
  if (options.window) {
    windowFrom = parseLocalStamp(options.window.fromLocal);
    windowTo = parseLocalStamp(options.window.toLocal);
    if (compareLocal(windowTo, windowFrom) < 0) throw new Error('window_inverted');
  }

  const cursorState = options.cursor ? decodeCursor(options.cursor) : null;
  let kStart: number;
  if (cursorState) {
    kStart = cursorState.k + 1;
  } else if (options.window) {
    kStart = candidateIndexAtOrAfter(rule, windowFrom as WallFields);
  } else {
    kStart = 0;
  }

  const occurrences: Occurrence[] = [];
  const skipped: Occurrence[] = [];
  let emitted = cursorState?.emitted ?? 0;
  let exhausted = false;
  let lastK: number | null = cursorState?.k ?? null;

  let k = kStart;
  let stopReason: 'count' | 'until-local' | 'until-utc' | 'window-end' | 'horizon' | null = null;
  for (let scanned = 0; scanned < MAX_SCAN_PER_CALL; scanned += 1, k += 1) {
    const nominal = addDaysLocal(rule.dtstart, k * rule.interval);
    const ordinal = k + 1;
    const nominalStamp = stampOf(nominal);

    if (windowTo && compareLocal(nominal, windowTo) > 0) { stopReason = 'window-end'; break; }
    if (rule.untilLocal && compareLocal(nominal, rule.untilLocal) > 0) { stopReason = 'until-local'; break; }
    if (rule.count !== undefined && emitted >= rule.count) { stopReason = 'count'; break; }

    // Resolve with 'earlier' framing first; re-resolve only when policy picks
    // the later side. For unique instants side is irrelevant.
    const first = tz.resolveLocal(nominal.year, nominal.month, nominal.day,
      nominal.hour, nominal.minute, nominal.second, 'earlier');
    const policy = first.shape === 'fold' ? rule.foldPolicy : rule.gapPolicy;
    const isSkipped = first.shape !== 'unique' && policy === 'skip';
    const chosen = !isSkipped && policy === 'later'
      ? tz.resolveLocal(nominal.year, nominal.month, nominal.day,
        nominal.hour, nominal.minute, nominal.second, 'later')
      : first;

    // UNTIL-UTC binds the resolved instant (counting only candidates in range).
    if (!isSkipped && rule.untilUtcMs !== undefined && chosen.utcMs !== null &&
        chosen.utcMs > rule.untilUtcMs) {
      stopReason = 'until-utc'; break;
    }

    const id = `${options.scope}:${nominalStamp}#${ordinal}`;
    const inWindow = !windowFrom || compareLocal(nominal, windowFrom) >= 0;

    if (isSkipped) {
      if (inWindow) {
        skipped.push({
          id, ordinal, local: nominalStamp, resolvedLocal: nominalStamp,
          utc: null, offset: null,
          kind: first.shape === 'gap' ? 'gap-adjusted' : 'fold',
          framingOffsets: first.offsets.map(formatOffset),
          skipped: true, skipReason: first.shape === 'gap' ? 'gap' : undefined,
        });
      }
    } else {
      const wall = tz.wallAt(chosen.utcMs as number);
      occurrences.push({
        id, ordinal, local: nominalStamp, resolvedLocal: stampOf(wall),
        utc: new Date(chosen.utcMs as number).toISOString(),
        offset: formatOffset(chosen.offset as number),
        kind: chosen.shape === 'gap' ? 'gap-adjusted' : chosen.shape === 'fold' ? 'fold' : 'normal',
        framingOffsets: chosen.offsets.map(formatOffset),
        skipped: false,
      });
      emitted += 1;
    }
    lastK = k;

    if (occurrences.length + skipped.length >= pageSize) {
      return {
        occurrences, skipped,
        nextCursor: encodeCursor({k, emitted}),
        exhausted: false,
      };
    }
  }

  if (stopReason === null) stopReason = 'horizon';
  // Bounded rules are finished as soon as the bound itself is reached. The
  // scan horizon only applies to open-ended rules, which continue by cursor.
  const ruleBounded = rule.count !== undefined || rule.untilLocal !== undefined ||
    rule.untilUtcMs !== undefined;
  exhausted = stopReason === 'window-end' ||
    (ruleBounded && stopReason !== 'horizon');

  if (!exhausted && lastK !== null) {
    return {
      occurrences, skipped,
      nextCursor: encodeCursor({k: lastK, emitted}),
      exhausted: false,
    };
  }

  return {occurrences, skipped, nextCursor: null, exhausted};
}
