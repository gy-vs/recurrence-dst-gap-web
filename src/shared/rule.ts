// Recurring rule model + expansion engine.
//
// Everything is driven by *local fields* in a named zone. The engine produces
// occurrences carrying:
//   - local  : the nominal local fields (always the rule's wall time)
//   - actual : the local fields of the resolved instant (may differ across a
//              gap when the policy shifts the instant)
//   - offset : UTC offset in effect at the resolved instant
//   - instant: UTC millis (identity tie-breaker only)
//   - uid    : stable per-(rule, nominal index) identity
// See expand() for the pagination contract.

import {
  addDays,
  addMonths,
  formatOffset,
  formatWall,
  isoWeekday,
  parseWall,
  toWallMillis,
  wallParts,
} from './civil';
import {HORIZON_END, HORIZON_START, getZone} from './zoneData';
import {offsetExtrema, resolveWall, type Zone} from './zones';

export type Frequency = 'daily' | 'weekly' | 'monthly';
export type GapFoldPolicy = 'skip' | 'earlier' | 'later';

export type RecurRule = {
  zone: string;
  startLocal: string; // first nominal occurrence, "YYYY-MM-DDTHH:mm[:ss]"
  frequency: Frequency;
  interval: number; // >= 1
  weekdays?: number[]; // ISO weekdays 0(Mon)-6(Sun), weekly only
  count?: number; // COUNT: number of *nominal* candidates (incl. skipped)
  untilLocal?: string; // UNTIL: inclusive bound on nominal local fields
  gapPolicy: GapFoldPolicy;
  foldPolicy: GapFoldPolicy;
};

export type OccurrenceStatus = 'unique' | 'gap-shifted' | 'fold-earlier' | 'fold-later';

export type Occurrence = {
  uid: string;
  nominalIndex: number; // position in the rule's nominal local sequence
  local: string; // nominal local fields, e.g. "2026-03-08T02:30:00"
  actualLocal: string; // local fields of the resolved instant
  offset: string; // ISO-8601, e.g. "-04:00"
  offsetMinutes: number;
  instant: string; // UTC millis as string
  status: OccurrenceStatus;
  ambiguous: boolean; // true when the nominal local time was a gap/fold
};

export type SkippedOccurrence = {
  uid: string;
  nominalIndex: number;
  local: string;
  status: 'skipped';
  reason: 'gap' | 'fold';
};

export type ExpansionOptions = {
  // UTC-instant window, half-open [from, to).
  windowFrom?: number;
  windowTo?: number;
  // Include nominal candidates that a skip policy removed (they never occupy
  // an instant, so they are reported separately and never paginate).
  includeSkipped?: boolean;
  maxCandidates?: number;
};

export type ExpansionResult = {
  occurrences: Occurrence[]; // sorted by (instant, uid)
  skipped: SkippedOccurrence[]; // sorted by nominalIndex
  exhausted: boolean; // rule ended (COUNT/UNTIL/horizon) inside the search range
};

export const RULE_FINGERPRINT_VERSION = 'r1';

// FNV-1a 32-bit hex over a canonical JSON serialization. Policies are part of
// the fingerprint: changing the gap/fold decision invalidates every cursor
// and cache derived from the rule.
export function ruleFingerprint(rule: RecurRule): string {
  const canonical: unknown = {
    v: RULE_FINGERPRINT_VERSION,
    zone: rule.zone,
    startLocal: normalizeLocal(rule.startLocal),
    frequency: rule.frequency,
    interval: rule.interval,
    weekdays: rule.frequency === 'weekly' ? [...(rule.weekdays ?? [])].sort((a, b) => a - b) : [],
    count: rule.count ?? null,
    untilLocal: rule.untilLocal ? normalizeLocal(rule.untilLocal) : null,
    gapPolicy: rule.gapPolicy,
    foldPolicy: rule.foldPolicy,
  };
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  for (const b of bytes) {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${RULE_FINGERPRINT_VERSION}-${hash.toString(16).padStart(8, '0')}`;
}

export function normalizeLocal(text: string): string {
  return formatWall(parseWall(text));
}

export function validateRule(rule: unknown): {rule?: RecurRule; error?: string} {
  if (typeof rule !== 'object' || rule === null) return {error: 'rule must be an object'};
  const r = rule as Record<string, unknown>;
  if (typeof r.zone !== 'string' || !getZone(r.zone)) return {error: 'unknown zone'};
  let startWall: number;
  try {
    startWall = parseWall(String(r.startLocal));
  } catch (err) {
    return {error: (err as Error).message};
  }
  const frequency = r.frequency;
  if (frequency !== 'daily' && frequency !== 'weekly' && frequency !== 'monthly') {
    return {error: 'frequency must be daily, weekly or monthly'};
  }
  const interval = Number(r.interval);
  if (!Number.isInteger(interval) || interval < 1) return {error: 'interval must be an integer >= 1'};

  let weekdays: number[] | undefined;
  if (frequency === 'weekly') {
    if (!Array.isArray(r.weekdays) || r.weekdays.length === 0) return {error: 'weekly rule needs weekdays'};
    weekdays = [];
    for (const value of r.weekdays as unknown[]) {
      const day = Number(value);
      if (!Number.isInteger(day) || day < 0 || day > 6) return {error: 'weekday must be 0..6'};
      if (!weekdays.includes(day)) weekdays.push(day);
    }
    weekdays.sort((a, b) => a - b);
  }

  let count: number | undefined;
  if (r.count !== undefined && r.count !== null) {
    count = Number(r.count);
    if (!Number.isInteger(count) || count < 1) return {error: 'count must be a positive integer'};
  }
  let untilWall: number | undefined;
  if (r.untilLocal !== undefined && r.untilLocal !== null && r.untilLocal !== '') {
    try {
      untilWall = parseWall(String(r.untilLocal));
    } catch (err) {
      return {error: (err as Error).message};
    }
    if (untilWall < startWall) return {error: 'untilLocal must not precede startLocal'};
  }
  const gapPolicy = policyOf(r.gapPolicy, 'gapPolicy');
  const foldPolicy = policyOf(r.foldPolicy, 'foldPolicy');
  if (gapPolicy === null) return {error: 'gapPolicy must be skip, earlier or later'};
  if (foldPolicy === null) return {error: 'foldPolicy must be skip, earlier or later'};

  return {
    rule: {
      zone: r.zone as string,
      startLocal: formatWall(startWall),
      frequency,
      interval,
      weekdays,
      count,
      untilLocal: untilWall === undefined ? undefined : formatWall(untilWall),
      gapPolicy,
      foldPolicy,
    },
  };
}

function policyOf(value: unknown, _field: string): GapFoldPolicy | null {
  if (value === undefined || value === null) return 'earlier';
  if (value !== 'skip' && value !== 'earlier' && value !== 'later') return null;
  return value;
}

function* nominalCandidates(rule: RecurRule, zone: Zone, budget: number): Generator<{index: number; wall: number}> {
  const startWall = parseWall(rule.startLocal);
  const untilWall = rule.untilLocal ? parseWall(rule.untilLocal) : undefined;
  let remaining = budget;
  const take = (index: number, wall: number) => {
    if (remaining <= 0) return null;
    remaining -= 1;
    return {index, wall} as const;
  };

  if (rule.frequency === 'monthly') {
    const start = wallParts(startWall);
    let period = 0;
    let index = 0;
    while (true) {
      if (rule.count && index >= rule.count) return;
      const date = addMonths(start.year, start.month, start.day, period * rule.interval);
      const wall = toWallMillis(date, {
        hour: start.hour,
        minute: start.minute,
        second: start.second,
        millisecond: 0,
      });
      period += 1;
      if (wall < startWall) continue;
      if (untilWall !== undefined && wall > untilWall) return;
      if (wall >= HORIZON_END + offsetExtrema(zone).max) return;
      const next = take(index, wall);
      if (!next) return;
      yield next;
      index += 1;
    }
  }

  // daily / weekly walk day by day, skipping non-matching weekdays.
  const weekdaySet = rule.frequency === 'weekly' ? new Set(rule.weekdays) : undefined;
  let wall = startWall;
  let index = 0;
  while (true) {
    if (rule.count && index >= rule.count) return;
    if (untilWall !== undefined && wall > untilWall) return;
    if (wall >= HORIZON_END + offsetExtrema(zone).max) return;
    if (!weekdaySet || weekdaySet.has(isoWeekday(wall))) {
      const next = take(index, wall);
      if (!next) return;
      yield next;
    }
    index += 1;
    wall = addDays(wall, 1);
  }
}

function makeOccurrence(
  rule: RecurRule,
  index: number,
  nominalWall: number,
  zone: Zone,
): Occurrence | SkippedOccurrence {
  const policy = (res: {kind: 'unique' | 'gap' | 'fold'}) =>
    res.kind === 'gap' ? rule.gapPolicy : res.kind === 'fold' ? rule.foldPolicy : 'earlier';
  const resolved = resolveWall(zone, nominalWall, 'earlier');
  if (!resolved) throw new Error('unreachable');
  const chosenPolicy = policy(resolved);
  if (chosenPolicy === 'skip') {
    return {
      uid: `${ruleFingerprint(rule)}:${index}`,
      nominalIndex: index,
      local: formatWall(nominalWall),
      status: 'skipped',
      reason: resolved.kind === 'gap' ? 'gap' : 'fold',
    };
  }
  const finalResolved = chosenPolicy === 'earlier' ? resolved : resolveWall(zone, nominalWall, chosenPolicy)!;
  const status: OccurrenceStatus =
    finalResolved.kind === 'unique'
      ? 'unique'
      : finalResolved.kind === 'gap'
        ? 'gap-shifted'
        : chosenPolicy === 'earlier'
          ? 'fold-earlier'
          : 'fold-later';
  return {
    uid: `${ruleFingerprint(rule)}:${index}`,
    nominalIndex: index,
    local: formatWall(nominalWall),
    actualLocal: formatWall(finalResolved.instant + finalResolved.offset),
    offset: formatOffset(finalResolved.offset),
    offsetMinutes: Math.round(finalResolved.offset / 60_000),
    instant: String(finalResolved.instant),
    status,
    ambiguous: finalResolved.kind !== 'unique',
  };
}

export function expand(rule: RecurRule, options: ExpansionOptions = {}): ExpansionResult {
  const zone = getZone(rule.zone);
  if (!zone) throw new Error(`unknown zone: ${rule.zone}`);
  const startWall = parseWall(rule.startLocal);
  if (startWall < HORIZON_START || startWall >= HORIZON_END) {
    throw new Error('startLocal is outside the supported table horizon');
  }

  const extrema = offsetExtrema(zone);
  const windowFrom = options.windowFrom;
  const windowTo = options.windowTo;
  // Local-field bounds that could possibly render into the window.
  const localFrom = windowFrom === undefined ? undefined : windowFrom + extrema.min;
  const localTo = windowTo === undefined ? undefined : windowTo + extrema.max;

  const occurrences: Occurrence[] = [];
  const skipped: SkippedOccurrence[] = [];
  const budget = options.maxCandidates ?? 20_000;
  let produced = 0;
  let exhausted = true;

  for (const candidate of nominalCandidates(rule, zone, budget)) {
    produced += 1;
    if (localTo !== undefined && candidate.wall >= localTo) {
      exhausted = false;
      break;
    }
    if (localFrom !== undefined && candidate.wall < localFrom) continue;

    const item = makeOccurrence(rule, candidate.index, candidate.wall, zone);
    if (item.status === 'skipped') {
      if (options.includeSkipped) skipped.push(item);
      continue;
    }
    const instant = Number(item.instant);
    if (windowFrom !== undefined && instant < windowFrom) continue;
    if (windowTo !== undefined && instant >= windowTo) continue;
    occurrences.push(item);
  }
  // Hitting the hard candidate cap means the rule itself is not exhausted.
  if (produced >= budget) exhausted = false;

  occurrences.sort((a, b) => Number(a.instant) - Number(b.instant) || compareUid(a.uid, b.uid));
  return {occurrences, skipped, exhausted};
}

function compareUid(a: string, b: string): number {
  const ai = Number(a.slice(a.lastIndexOf(':') + 1));
  const bi = Number(b.slice(b.lastIndexOf(':') + 1));
  return ai - bi;
}
