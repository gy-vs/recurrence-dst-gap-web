// Wire types shared by client and server. The client treats these as opaque
// display values: it never converts `local`/`actualLocal` through Date and
// never derives offsets itself.

export type GapFoldPolicy = 'skip' | 'earlier' | 'later';
export type Frequency = 'daily' | 'weekly' | 'monthly';

export type RecurRuleDTO = {
  zone: string;
  startLocal: string;
  frequency: Frequency;
  interval: number;
  weekdays?: number[];
  count?: number;
  untilLocal?: string;
  gapPolicy: GapFoldPolicy;
  foldPolicy: GapFoldPolicy;
};

export type DocSummary = {
  id: string;
  name: string;
  revision: number;
  fingerprint: string;
  updatedAt: string;
};

export type DocDTO = DocSummary & {rule: RecurRuleDTO};

export type OccurrenceDTO = {
  uid: string;
  nominalIndex: number;
  local: string;
  actualLocal: string;
  offset: string;
  offsetMinutes: number;
  instant: string;
  status: 'unique' | 'gap-shifted' | 'fold-earlier' | 'fold-later';
  ambiguous: boolean;
};

export type SkippedDTO = {
  uid: string;
  nominalIndex: number;
  local: string;
  status: 'skipped';
  reason: 'gap' | 'fold';
};

export type PageDTO = {
  id: string;
  revision: number;
  fingerprint: string;
  windowFrom: number | null;
  windowTo: number | null;
  totalInWindow: number;
  skipped: SkippedDTO[];
  exhausted: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  occurrences: OccurrenceDTO[];
  cache?: 'hit' | 'miss';
};

export type ZoneDTO = {
  id: string;
  initialOffsetMinutes: number;
  transitions: Array<{at: string; offsetBeforeMinutes: number; offsetAfterMinutes: number}>;
};
