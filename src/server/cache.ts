// Expansion cache.
//
// Keys bind the document revision, the rule fingerprint (which includes the
// gap/fold policies) and the exact window. Any rule edit bumps the revision
// and changes the fingerprint, so stale entries can never match; saves also
// proactively drop every entry for the document.

import type {ExpansionResult} from '../shared/rule';

export type CacheKey = {
  id: string;
  revision: number;
  fingerprint: string;
  windowFrom: number | null;
  windowTo: number | null;
};

type Entry = {key: string; value: ExpansionResult; at: number};

const EXPAND_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 200;

export class ExpansionCache {
  private entries = new Map<string, Entry>();
  hits = 0;
  misses = 0;

  private static serialize(key: CacheKey): string {
    return `${key.id}|${key.revision}|${key.fingerprint}|${key.windowFrom ?? ''}|${key.windowTo ?? ''}`;
  }

  get(key: CacheKey): ExpansionResult | undefined {
    const serialized = ExpansionCache.serialize(key);
    const entry = this.entries.get(serialized);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (Date.now() - entry.at > EXPAND_TTL_MS) {
      this.entries.delete(serialized);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.value;
  }

  set(key: CacheKey, value: ExpansionResult): 'stored' {
    const serialized = ExpansionCache.serialize(key);
    this.entries.set(serialized, {key: serialized, value, at: Date.now()});
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return 'stored';
  }

  // Drop all entries for a document. Returns how many were removed so callers
  // can prove that a policy/rule edit invalidated the old cache.
  invalidate(id: string): number {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${id}|`)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  stats(): {hits: number; misses: number; size: number} {
    return {hits: this.hits, misses: this.misses, size: this.entries.size};
  }
}
