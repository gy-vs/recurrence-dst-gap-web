// Timezone model resolved entirely from local fields.
//
// A zone is an explicit, sorted table of offset transitions. No host TZ data,
// no browser Date: the same table runs on the server and (if ever needed) the
// client, so both sides agree exactly. The bundled zones are small but real:
//
//   UTC              fixed
//   Asia/Kolkata     fixed +05:30 (half-hour offset zone)
//   Asia/Kathmandu   fixed +05:45 (odd quarter-hour offset)
//   America/Caracas  -04:30 until 2007-12-09, -04:00 until 2016-05-01,
//                    -04:30 after — the 2007/2016 changes are 30-minute gap
//                    and fold jumps right around 02:30/03:00 local, exercising
//                    historical offset changes without yearly DST noise
//   Europe/Moscow    +03:00 with DST (+04:00) through 2010, permanent +04:00
//                    after 2011-03-27, permanent +03:00 after 2014-10-26
//   America/New_York yearly DST: -05:00 / -04:00, 1h gap (March) & fold (Nov)
//   Australia/Lord_Howe yearly DST: +10:30 / +11:00, 30-minute gap & fold
//
// Transitions are stored at the UTC instant they occur and describe the
// offset in effect *after* the instant.

export type Transition = {
  at: number; // UTC millis of the transition instant
  offsetBefore: number; // ms east of UTC, in effect before `at`
  offsetAfter: number; // ms east of UTC, in effect at/after `at`
};

export type Zone = {
  id: string;
  // Offset in effect before the first table entry.
  initialOffset: number;
  transitions: Transition[];
  // Table horizon; rules may only expand within [horizonStart, horizonEnd).
  horizonStart: number;
  horizonEnd: number;
};

export type ResolveKind = 'unique' | 'gap' | 'fold';

export type ResolveResult = {
  kind: ResolveKind;
  instant: number; // resolved UTC millis
  offset: number; // offset in effect at the resolved instant
  // Present for gap/fold: the two candidate offsets (signed, ms east of UTC).
  earlierOffset?: number;
  laterOffset?: number;
};

// Offset in effect at a UTC instant.
export function offsetAt(zone: Zone, instant: number): number {
  const list = zone.transitions;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].at <= instant) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? zone.initialOffset : list[lo - 1].offsetAfter;
}

export function offsetExtrema(zone: Zone): {min: number; max: number} {
  let min = zone.initialOffset;
  let max = zone.initialOffset;
  for (const t of zone.transitions) {
    min = Math.min(min, t.offsetBefore, t.offsetAfter);
    max = Math.max(max, t.offsetBefore, t.offsetAfter);
  }
  return {min, max};
}

// First transition index with `at` >= instant.
function lowerBoundAt(list: Transition[], instant: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].at < instant) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Does segment k render the given wall time?
// Segment k is the interval between transition k-1 and k; its rendered wall
// interval is [start + o_k, end + o_k) — start-inclusive, end-exclusive,
// which is what makes folds resolve to a unique segment count.
function segmentCovers(zone: Zone, k: number, wall: number): boolean {
  const list = zone.transitions;
  const start = k === 0 ? zone.horizonStart : list[k - 1].at;
  const end = k === list.length ? zone.horizonEnd : list[k].at;
  const offset = k === 0 ? zone.initialOffset : list[k - 1].offsetAfter;
  return wall >= start + offset && wall < end + offset;
}

export type Classification =
  | {kind: 'unique'; instant: number; offset: number}
  | {kind: 'gap'; earlierOffset: number; laterOffset: number}
  | {kind: 'fold'; earlierOffset: number; laterOffset: number};

// Classify a naive local wall time inside the zone.
//
// In wall coordinates a spring-forward transition leaves the interval
// [at+oBefore, at+oAfter) rendered by no segment (gap), while a fall-back
// transition lets the before/after segments overlap on
// [at+oAfter, at+oBefore) (fold). Every other wall time is rendered by
// exactly one segment.
export function classifyWall(zone: Zone, wall: number): Classification {
  const list = zone.transitions;
  const lastOffset = list.length === 0 ? zone.initialOffset : list[list.length - 1].offsetAfter;
  if (wall < zone.horizonStart + zone.initialOffset || wall >= zone.horizonEnd + lastOffset) {
    throw new Error(`local time ${wall} is outside the zone table horizon`);
  }

  const {min, max} = offsetExtrema(zone);
  // Any transition that could affect wall has its instant within one offset
  // of wall; candidate segments sit next to those transitions.
  const lo = lowerBoundAt(list, wall - max);
  const hi = lowerBoundAt(list, wall - min + 1);
  const firstSegment = Math.max(0, lo - 1);
  const lastSegment = Math.min(list.length, hi + 1);

  const covering: number[] = [];
  for (let k = firstSegment; k <= lastSegment; k++) {
    if (segmentCovers(zone, k, wall)) covering.push(k);
  }

  if (covering.length >= 2) {
    covering.sort((a, b) => a - b);
    const t = list[covering[1] - 1];
    if (t.offsetAfter < t.offsetBefore) {
      return {kind: 'fold', earlierOffset: t.offsetAfter, laterOffset: t.offsetBefore};
    }
    return {kind: 'gap', earlierOffset: t.offsetBefore, laterOffset: t.offsetAfter};
  }
  if (covering.length === 1) {
    const k = covering[0];
    const offset = k === 0 ? zone.initialOffset : list[k - 1].offsetAfter;
    return {kind: 'unique', instant: wall - offset, offset};
  }

  // Rendered by nothing: wall is inside a gap.
  for (let i = lo; i < hi; i++) {
    const t = list[i];
    if (t.offsetAfter > t.offsetBefore && wall >= t.at + t.offsetBefore && wall < t.at + t.offsetAfter) {
      return {kind: 'gap', earlierOffset: t.offsetBefore, laterOffset: t.offsetAfter};
    }
  }
  throw new Error(`local time ${wall} is not representable in ${zone.id}`);
}

// Resolve a local wall time under a skip / earlier / later policy.
// `null` means the occurrence is skipped.
//
// Semantics (matching Temporal's disambiguation options):
//   fold, earlier -> wall - earlierOffset (the -05:00 EDT-end... earlier
//                    instant of the overlap; clocks show the nominal time)
//   fold, later   -> wall - laterOffset   (the -04:00 EDT instant)
//   gap,  later   -> wall - laterOffset   (first valid instant, nominal 02:30)
//   gap,  earlier -> wall - earlierOffset (instant just *before* the jump,
//                    which renders in the new offset as e.g. 03:30 — the
//                    server "pushes" the nonexistent wall time forward)
export function resolveWall(
  zone: Zone,
  wall: number,
  policy: 'skip' | 'earlier' | 'later',
): ResolveResult | null {
  const found = classifyWall(zone, wall);
  if (found.kind === 'unique') {
    return {kind: 'unique', instant: found.instant, offset: found.offset};
  }
  if (policy === 'skip') return null;
  // `offset` is the offset that names the chosen instant; for a gap resolved
  // to the earlier side the instant is actually just past the transition, so
  // the offset in effect is laterOffset.
  const chosenOffset = policy === 'earlier' ? found.earlierOffset : found.laterOffset;
  const instant = wall - chosenOffset;
  const effectiveOffset = found.kind === 'gap' && policy === 'earlier' ? found.laterOffset : chosenOffset;
  return {
    kind: found.kind,
    instant,
    offset: effectiveOffset,
    earlierOffset: found.earlierOffset,
    laterOffset: found.laterOffset,
  };
}
