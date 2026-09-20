/**
 * Timezone layer built entirely around local wall-clock fields.
 *
 * The browser's `Date` is deliberately never used for recurrence math: the
 * server resolves every local timestamp to UTC via IANA tz data and returns
 * the local fields, the chosen offset and the UTC instant alongside each
 * occurrence. Clients only render those fields.
 *
 * A local timestamp has exactly three possible shapes:
 *   - unique: a single UTC instant carries those wall-clock fields
 *   - gap:    the wall time never happens (spring forward)
 *   - fold:   the wall time happens twice (fall back)
 *
 * For both ambiguous shapes the offsets are labelled EARLIER / LATER by the
 * moment in time at which that offset is in effect, independent of whether the
 * offset numerically grows or shrinks:
 *   gap:  EARLIER = offset before the jump,  LATER = offset after the jump
 *   fold: EARLIER = offset of the first pass, LATER = offset of the second pass
 */

export type OffsetSide = 'earlier' | 'later';

export type LocalShape = 'unique' | 'gap' | 'fold';

/** Resolver is injected so the pure recurrence engine can be unit tested with fakes. */
export interface TimezoneResolver {
  readonly zoneId: string;
  /** Offset in seconds, at the given UTC instant (milliseconds since epoch). */
  offsetAt(utcMs: number): number;
  /** Year/month(1-12)/day(1-31)/hour/minute/second as they read on the wall at utcMs. */
  wallAt(utcMs: number): WallFields;
  /**
   * Resolve a local wall-clock timestamp. `offset` (seconds) and `utcMs` are
   * always populated for the selected candidate; gap+skip leaves them null.
   */
  resolveLocal(y: number, mo: number, d: number, h: number, mi: number, s: number, side: OffsetSide): LocalResolution;
}

export type WallFields = {year:number;month:number;day:number;hour:number;minute:number;second:number};

export type LocalResolution = {
  shape: LocalShape;
  /** Offsets (seconds) that frame the wall time. One entry for unique, two for gap/fold. */
  offsets: [number] | [number, number];
  /** Chosen UTC instant; null only for shape 'gap' + side 'skip'. */
  utcMs: number | null;
  /** Offset (seconds) of the chosen instant; null only for gap + skip. */
  offset: number | null;
};

export function localStamp(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(y, 4)}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}`;
}

/** +HH:MM[:SS] seconds-offset rendering (never Z: callers need an explicit sign). */
export function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  const a = Math.abs(seconds);
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = a % 60;
  const base = `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return s === 0 ? base : `${base}:${String(s).padStart(2, '0')}`;
}

const DAY_MS = 86_400_000;
const MAX_SAFE_DAYS = 100_000_000; // clamp calendar arithmetic to Date range

/** Calendar arithmetic in local fields; never touch DST while stepping dates. */
export function addDaysLocal(f: WallFields, days: number): WallFields {
  if (Math.abs(days) > MAX_SAFE_DAYS) throw new Error('day_step_out_of_range');
  const utc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  const next = new Date(utc + days * DAY_MS);
  return {
    year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(),
    hour: f.hour, minute: f.minute, second: f.second,
  };
}

/**
 * IANA-backed resolver using Intl. Offset transitions are found by recursive
 * bisection of an instant window rather than guessing with a single probe —
 * a single probe is asymmetric and mislabels gap/fold candidates.
 */
export class IntlTimezone implements TimezoneResolver {
  readonly zoneId: string;
  private readonly dtf: Intl.DateTimeFormat;
  private readonly offsetCache = new Map<number, number>();
  /**
   * Transitions intersecting windows already scanned: tuples of
   * [boundary utcMs, offsetBefore seconds, offsetAfter seconds], sorted.
   */
  private transitions: Array<[number, number, number]> | null = null;

  constructor(zoneId: string) {
    try {
      // Throws for unknown zones (RangeError on supported engines).
      new Intl.DateTimeFormat('en-US', {timeZone: zoneId});
    } catch {
      throw new Error(`unknown_timezone:${zoneId}`);
    }
    this.zoneId = zoneId;
    this.dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zoneId, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  offsetAt(utcMs: number): number {
    const hit = this.offsetCache.get(utcMs);
    if (hit !== undefined) return hit;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: this.zoneId, timeZoneName: 'longOffset',
    }).formatToParts(new Date(utcMs));
    const raw = parts.find(p => p.type === 'timeZoneName')?.value ?? '';
    const m = raw.match(/GMT(?:([+-])(\d{2})(?::(\d{2})(?::(\d{2}))?)?)?/);
    let value = 0;
    if (m && m[1]) {
      value = (m[1] === '-' ? -1 : 1) *
        (Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0));
    }
    this.offsetCache.set(utcMs, value);
    return value;
  }

  wallAt(utcMs: number): WallFields {
    const map = new Map<string, string>();
    for (const part of this.dtf.formatToParts(new Date(utcMs))) {
      if (part.type !== 'literal') map.set(part.type, part.value);
    }
    return {
      year: Number(map.get('year')), month: Number(map.get('month')), day: Number(map.get('day')),
      hour: Number(map.get('hour')), minute: Number(map.get('minute')), second: Number(map.get('second')),
    };
  }

  /**
   * Ensure every transition inside [fromMs, toMs] is known. First call anchors
   * on a wide window and subsequent calls extend it (historical offsets often
   * change once and never repeat).
   */
  private scanTransitions(fromMs: number, toMs: number): Array<[number, number, number]> {
    if (this.transitions) {
      let [lo, hi] = [this.scanLo, this.scanHi];
      if (fromMs < lo || toMs > hi) {
        lo = Math.min(lo, fromMs);
        hi = Math.max(hi, toMs);
        this.transitions = this.bisectRange(lo, hi);
        this.scanLo = lo; this.scanHi = hi;
      }
      return this.transitions;
    }
    const margin = 2 * 365 * DAY_MS;
    this.scanLo = fromMs - margin;
    this.scanHi = toMs + margin;
    this.transitions = this.bisectRange(this.scanLo, this.scanHi);
    return this.transitions;
  }
  private scanLo = 0;
  private scanHi = 0;

  /**
   * Find every offset discontinuity in [lo, hi]. Bucketed pre-split keeps
   * deep history cheap (pre-1900 zones have many tiny changes); the second
   * granularity stop keeps sub-minute historical steps honest.
   */
  private bisectRange(lo: number, hi: number): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    const BUCKET = 30 * DAY_MS;
    for (let b = lo; b < hi; b += BUCKET) {
      this.bisect(b, Math.min(b + BUCKET, hi), out, 0);
    }
    out.sort((a, z) => a[0] - z[0]);
    return out;
  }

  private bisect(lo: number, hi: number, out: Array<[number, number, number]>, depth: number): void {
    const oLo = this.offsetAt(lo);
    const oHi = this.offsetAt(hi);
    if (oLo === oHi) return;
    if (hi - lo < 1000 || depth > 64) {
      // Snap the boundary to a whole second: it is the first second at which
      // the new offset is in effect (sub-ms bisection noise would otherwise
      // break exact wall-field matching for fold candidates).
      const prevSec = Math.floor(hi / 1000) * 1000;
      const boundary = this.offsetAt(prevSec) === oHi ? prevSec : prevSec + 1000;
      out.push([boundary, oLo, oHi]);
      return;
    }
    const mid = lo + Math.floor((hi - lo) / 2);
    this.bisect(lo, mid, out, depth + 1);
    this.bisect(mid, hi, out, depth + 1);
  }

  resolveLocal(y: number, mo: number, d: number, h: number, mi: number, s: number, side: OffsetSide): LocalResolution {
    const nominalUtc = Date.UTC(y, mo - 1, d, h, mi, s);
    if (Number.isNaN(nominalUtc)) throw new Error('invalid_local_fields');
    // The true instant is within the wider of the two framing offsets.
    const span = 24 * 3600_000;
    const transitions = this.scanTransitions(nominalUtc - span, nominalUtc + span);

    const matches: Array<{utcMs:number; offset:number}> = [];
    const seen = new Set<number>();
    for (const offset of this.candidateOffsets(nominalUtc, transitions)) {
      const utcMs = nominalUtc - offset * 1000;
      const wall = this.wallAt(utcMs);
      if (wall.year === y && wall.month === mo && wall.day === d &&
          wall.hour === h && wall.minute === mi && wall.second === s &&
          this.offsetAt(utcMs) === offset && !seen.has(utcMs)) {
        seen.add(utcMs);
        matches.push({utcMs, offset});
      }
    }

    if (matches.length >= 2) {
      matches.sort((a, b) => a.utcMs - b.utcMs);
      const [first, second] = matches;
      const pick = side === 'earlier' ? first : second;
      return {shape: 'fold', offsets: [first.offset, second.offset], utcMs: pick.utcMs, offset: pick.offset};
    }
    if (matches.length === 1) {
      return {shape: 'unique', offsets: [matches[0].offset], utcMs: matches[0].utcMs, offset: matches[0].offset};
    }

    // Gap: the wall time is skipped at exactly one transition framing nominalUtc.
    const framing = this.findGapTransition(nominalUtc, transitions);
    if (!framing) {
      // Defensive: zone data without an observed transition in the window.
      const offset = this.offsetAt(nominalUtc);
      return {shape: 'gap', offsets: [offset, offset], utcMs: null, offset: null};
    }
    const [, offBefore, offAfter] = framing;
    const offsets: [number, number] = [offBefore, offAfter];
    const pickOffset = side === 'earlier' ? offBefore : offAfter;
    return {shape: 'gap', offsets, utcMs: nominalUtc - pickOffset * 1000, offset: pickOffset};
  }

  /** Offsets worth testing for the wall time: the framing transition pair. */
  private candidateOffsets(nominalUtc: number, transitions: Array<[number, number, number]>): number[] {
    const offsets = new Set<number>([this.offsetAt(nominalUtc)]);
    for (const [boundary, before, after] of transitions) {
      if (Math.abs(boundary - nominalUtc) <= 26 * 3600_000) {
        offsets.add(before);
        offsets.add(after);
      }
    }
    return [...offsets];
  }

  private findGapTransition(nominalUtc: number, transitions: Array<[number, number, number]>): [number, number, number] | null {
    // A gap is a forward jump (offset strictly increases). Express boundary
    // wall readings in "wall key" space (boundary instant + offset, i.e. what
    // the clock would read if local = UTC + offset): the skipped interval is
    // (wall-before-boundary, wall-at-boundary-after).
    for (const t of transitions) {
      const [boundary, before, after] = t;
      if (after <= before) continue;
      const lastWallBefore = boundary - 1000 + before * 1000;
      const firstWallAfter = boundary + after * 1000;
      if (nominalUtc > lastWallBefore && nominalUtc < firstWallAfter) return t;
    }
    return null;
  }
}

/** Validate an IANA zone id without constructing a full resolver. */
export function isValidTimezone(zoneId: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: zoneId});
    return true;
  } catch {
    return false;
  }
}
