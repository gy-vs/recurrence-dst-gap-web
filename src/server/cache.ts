/**
 * Server-side expansion cache.
 *
 * The cache key contains the rule fingerprint (engine version + every rule
 * field incl. gap/fold policy), the schedule scope and the exact query
 * (window/cursor/pageSize). Therefore:
 *   - changing the gap/fold policy produces a different key => old cached
 *     pages are never served again (they naturally expire);
 *   - bumping ENGINE_VERSION invalidates every expansion after an upgrade;
 *   - a content save (PUT) purges all keys of that schedule scope.
 */

import {ruleFingerprint, NormalizedRule} from '../shared/recurrence';

interface CacheEntry<V> {value: V; expires: number}

export class ExpansionCache<V> {
  private readonly map = new Map<string, CacheEntry<V>>();

  constructor(private readonly ttlMs = 60_000, private readonly maxEntries = 2000) {}

  private static scopePrefix(scope: string): string {
    return `scope:${scope}|`;
  }

  key(rule: NormalizedRule, scope: string, query: Record<string, unknown>): string {
    return ExpansionCache.scopePrefix(scope) + ruleFingerprint(rule) + '|q=' +
      JSON.stringify(canonicalize(query));
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, {value, expires: Date.now() + this.ttlMs});
  }

  /** Drop every cached expansion of one schedule (called on every save). */
  purgeScope(scope: string): number {
    const prefix = ExpansionCache.scopePrefix(scope);
    let removed = 0;
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {return this.map.size;}
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        const v = (value as Record<string, unknown>)[k];
        if (v !== undefined && v !== null) acc[k] = canonicalize(v);
        return acc;
      }, {});
  }
  return value;
}
