// Keyset pagination over an expanded window.
//
// Pages are slices of one globally-sorted occurrence list for a fixed
// (rule fingerprint, [windowFrom, windowTo)) triple. The cursor pins all four
// values, so changing the window or the gap/fold policy invalidates the cursor
// outright (409 cursor_stale) instead of silently repeating or dropping
// occurrences across a page boundary.

import {expand, ruleFingerprint, type ExpansionResult, type Occurrence, type RecurRule} from './rule';

export const CURSOR_VERSION = 'p1';
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export type Cursor = {
  v: typeof CURSOR_VERSION;
  fp: string;
  wf: number | null;
  wt: number | null;
  after: string | null; // uid of the last occurrence already returned
};

export type PageRequest = {
  windowFrom?: number;
  windowTo?: number;
  limit?: number;
  cursor?: string;
};

export type PageResult = {
  occurrences: Occurrence[];
  skipped: Array<{uid: string; nominalIndex: number; local: string; status: 'skipped'; reason: 'gap' | 'fold'}>;
  nextCursor: string | null;
  hasMore: boolean;
  fingerprint: string;
  windowFrom: number | null;
  windowTo: number | null;
  totalInWindow: number; // full occurrence count for this exact window
  exhausted: boolean; // rule reached COUNT/UNTIL/horizon within the search
};

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(text: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Cursor;
    if (parsed.v !== CURSOR_VERSION || typeof parsed.fp !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// Check a cursor against the current rule fingerprint and query window
// without expanding. Returns null when valid.
export function checkCursor(
  fingerprint: string,
  windowFrom: number | null,
  windowTo: number | null,
  cursor: string | undefined,
): {error: string; status: number} | null {
  if (!cursor) return null;
  const parsed = decodeCursor(cursor);
  if (!parsed) return {error: 'cursor_malformed', status: 400};
  if (parsed.fp !== fingerprint) return {error: 'cursor_stale', status: 409};
  if ((parsed.wf ?? null) !== (windowFrom ?? null) || (parsed.wt ?? null) !== (windowTo ?? null)) {
    return {error: 'cursor_stale', status: 409};
  }
  return null;
}

// Validate window/limit/cursor and slice a (possibly cached) expansion.
// Callers that cache expansions pass them in; otherwise the window is
// expanded here.
export function pageOccurrences(
  rule: RecurRule,
  request: PageRequest,
  precomputed?: ExpansionResult,
): PageResult | {error: string; status: number} {
  const fingerprint = ruleFingerprint(rule);
  let windowFrom = request.windowFrom === undefined ? null : request.windowFrom;
  let windowTo = request.windowTo === undefined ? null : request.windowTo;
  let afterUid: string | null = null;

  if (request.cursor) {
    const cursor = decodeCursor(request.cursor);
    if (!cursor) return {error: 'cursor_malformed', status: 400};
    if (cursor.fp !== fingerprint) return {error: 'cursor_stale', status: 409};
    if ((cursor.wf ?? null) !== (windowFrom ?? null) || (cursor.wt ?? null) !== (windowTo ?? null)) {
      return {error: 'cursor_stale', status: 409};
    }
    windowFrom = cursor.wf;
    windowTo = cursor.wt;
    afterUid = cursor.after;
  }

  if (windowFrom !== null && windowTo !== null && windowTo <= windowFrom) {
    return {error: 'windowTo must be greater than windowFrom', status: 400};
  }
  const limit = request.limit === undefined ? DEFAULT_LIMIT : Math.floor(request.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return {error: `limit must be between 1 and ${MAX_LIMIT}`, status: 400};
  }

  const expansion =
    precomputed ??
    expand(rule, {
      windowFrom: windowFrom ?? undefined,
      windowTo: windowTo ?? undefined,
      includeSkipped: true,
    });

  let startIndex = 0;
  if (afterUid !== null) {
    const found = expansion.occurrences.findIndex(item => item.uid === afterUid);
    if (found === -1) return {error: 'cursor_stale', status: 409};
    startIndex = found + 1;
  }

  const slice = expansion.occurrences.slice(startIndex, startIndex + limit);
  const last = slice[slice.length - 1];
  const hasMore = startIndex + slice.length < expansion.occurrences.length;
  const nextCursor =
    hasMore && last
      ? encodeCursor({v: CURSOR_VERSION, fp: fingerprint, wf: windowFrom, wt: windowTo, after: last.uid})
      : null;

  return {
    occurrences: slice,
    skipped: expansion.skipped,
    nextCursor,
    hasMore,
    fingerprint,
    windowFrom,
    windowTo,
    totalInWindow: expansion.occurrences.length,
    exhausted: expansion.exhausted,
  };
}

// Default preview window: [now - 30d, now + 365d) in UTC. Passed explicitly so
// the server clock, never the browser clock, decides it.
export function defaultWindow(now: number): {windowFrom: number; windowTo: number} {
  return {windowFrom: now - 30 * 86_400_000, windowTo: now + 365 * 86_400_000};
}
