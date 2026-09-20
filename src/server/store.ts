// In-memory recurrence documents (workbench persistence).
//
// A document stores the editable rule plus the revision used for optimistic
// concurrency. The rule's local fields are the only source of truth; nothing
// here ever converts through a host timezone.

import {validateRule, type RecurRule} from '../shared/rule';

export type RecurrenceDoc = {
  id: string;
  name: string;
  revision: number;
  rule: RecurRule;
  updatedAt: string;
};

export const recurrenceRows: RecurrenceDoc[] = [
  {
    id: 'nyc-daily',
    name: 'New York 02:30 daily (gap/fold showcase)',
    revision: 1,
    updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    rule: {
      zone: 'America/New_York',
      startLocal: '2026-01-01T02:30:00',
      frequency: 'daily',
      interval: 1,
      untilLocal: '2026-12-31T02:30:00',
      gapPolicy: 'earlier',
      foldPolicy: 'earlier',
    },
  },
  {
    id: 'lord-howe-weekly',
    name: 'Lord Howe weekly 02:15 (30-minute DST)',
    revision: 1,
    updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    rule: {
      zone: 'Australia/Lord_Howe',
      startLocal: '2026-01-04T02:15:00',
      frequency: 'weekly',
      interval: 1,
      weekdays: [0, 3, 6], // Mon/Thu/Sun
      gapPolicy: 'earlier',
      foldPolicy: 'earlier',
    },
  },
  {
    id: 'kolkata-count',
    name: 'Kolkata daily COUNT=10 (half-hour fixed offset)',
    revision: 1,
    updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    rule: {
      zone: 'Asia/Kolkata',
      startLocal: '2026-03-01T02:30:00',
      frequency: 'daily',
      interval: 1,
      count: 10,
      gapPolicy: 'earlier',
      foldPolicy: 'earlier',
    },
  },
];

export function validateBody(body: unknown): {rule?: RecurRule; name?: string; error?: string} {
  if (typeof body !== 'object' || body === null) return {error: 'body must be an object'};
  const record = body as Record<string, unknown>;
  const name = record.name === undefined ? undefined : String(record.name);
  if (name !== undefined && name.trim().length === 0) return {error: 'name must not be empty'};
  const checked = validateRule(record.rule);
  if (checked.error) return {error: checked.error};
  return {rule: checked.rule, name: name === undefined ? undefined : name.trim()};
}

// Deep snapshot for test isolation: rows are module-global so createApp()
// instances share them.
const snapshot = JSON.stringify(recurrenceRows);
export function resetRecurrenceRows() {
  const restored = JSON.parse(snapshot) as RecurrenceDoc[];
  recurrenceRows.splice(0, recurrenceRows.length, ...restored);
}
