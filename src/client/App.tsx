import {useCallback, useEffect, useMemo, useState} from 'react';
import {CalendarClock, ChevronLeft, ChevronRight, FlaskConical, Save} from 'lucide-react';
import type {DocDTO, DocSummary, GapFoldPolicy, OccurrenceDTO, PageDTO, RecurRuleDTO, ZoneDTO} from '../shared/types';

// UTC epoch millis -> value for <input type="datetime-local">, using purely
// numeric UTC fields (never local browser fields).
function utcInputValue(ms: number): string {
  const s = new Date(ms).toISOString();
  return s.slice(0, 16);
}
function parseUtcInput(value: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value + ':00.000Z');
  return Number.isFinite(ms) ? ms : null;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const POLICIES: Array<{value: GapFoldPolicy; label: string; hint: string}> = [
  {value: 'earlier', label: 'Earlier offset', hint: 'gap: push forward · fold: first pass'},
  {value: 'later', label: 'Later offset', hint: 'gap: keep nominal time · fold: second pass'},
  {value: 'skip', label: 'Skip', hint: 'do not emit an occurrence'},
];

function toInputLocal(iso: string): string {
  return iso.slice(0, 16);
}

type FetchState = 'idle' | 'loading' | 'ready' | 'error';

export default function App() {
  const [items, setItems] = useState<DocSummary[]>([]);
  const [zones, setZones] = useState<ZoneDTO[]>([]);
  const [selected, setSelected] = useState('nyc-daily');
  const [doc, setDoc] = useState<DocDTO | null>(null);
  const [draft, setDraft] = useState<RecurRuleDTO | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [status, setStatus] = useState('Ready');
  const [error, setError] = useState<string | null>(null);

  // Window + page state. Cached pages are keyed by fingerprint: any rule edit
  // changes the fingerprint, which drops all held pages and cursors.
  const [windowFromMs, setWindowFromMs] = useState(() => Date.now() - 30 * 86400000);
  const [windowToMs, setWindowToMs] = useState(() => Date.now() + 365 * 86400000);
  const [limit, setLimit] = useState(25);
  const [page, setPage] = useState<PageDTO | null>(null);
  const [pageState, setPageState] = useState<FetchState>('idle');
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [activeCursor, setActiveCursor] = useState<string | undefined>(undefined);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/zones').then(r => r.json()).then(v => setZones(v.zones));
    fetch('/api/recurrences').then(r => r.json()).then(v => setItems(v.recurrences));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus('Loading');
    fetch('/api/recurrences/' + selected)
      .then(r => r.json())
      .then((value: DocDTO) => {
        if (cancelled) return;
        setDoc(value);
        setDraft(structuredClone(value.rule));
        setNameDraft(value.name);
        setStatus('Loaded');
        setError(null);
        setCursorStack([]);
        setActiveCursor(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const fingerprintMatches = doc && page && page.fingerprint === doc.fingerprint;

  const loadPage = useCallback(
    async (cursor: string | undefined, keepStack: string[]) => {
      const params = new URLSearchParams({
        from: String(windowFromMs),
        to: String(windowToMs),
        limit: String(limit),
      });
      if (cursor) params.set('cursor', cursor);
      setPageState('loading');
      const res = await fetch(`/api/recurrences/${selected}/occurrences?${params}`);
      const body = await res.json();
      if (!res.ok) {
        // A stale cursor means the rule/window changed: reset to first page.
        if (body.error === 'cursor_stale') {
          setCursorStack([]);
          setActiveCursor(undefined);
          setCacheNotice('Page expired after a rule or window change — restarted from the first page.');
          return loadPage(undefined, []);
        }
        setPageState('error');
        setError(body.error ?? 'failed to load page');
        return;
      }
      setPage(body);
      setActiveCursor(cursor);
      setCursorStack(keepStack);
      setPageState('ready');
      setCacheNotice(body.cache === 'hit' ? 'Served from server expansion cache.' : null);
    },
    [limit, selected, windowFromMs, windowToMs],
  );

  // Refetch when the selected doc, window or limit changes — but only for the
  // first page (the fingerprint guards stale cursors).
  useEffect(() => {
    if (!doc) return;
    loadPage(undefined, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id, doc?.fingerprint, windowFromMs, windowToMs, limit]);

  async function save() {
    if (!doc || !draft) return;
    setStatus('Saving');
    const res = await fetch('/api/recurrences/' + doc.id, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision: doc.revision, name: nameDraft, rule: draft}),
    });
    const body = await res.json();
    if (res.status === 409) {
      setError('Revision conflict — the document changed on the server. Reloading.');
      setDoc(body.current);
      setDraft(structuredClone(body.current.rule));
      setNameDraft(body.current.name);
      return;
    }
    if (!res.ok) {
      setError(body.error ?? 'save failed');
      setStatus('Error');
      return;
    }
    setDoc(body);
    setDraft(structuredClone(body.rule));
    setNameDraft(body.name);
    setError(null);
    setStatus(`Saved · ${body.cacheInvalidated} cached expansion(s) invalidated`);
  }

  const dirty = useMemo(() => {
    if (!doc || !draft) return false;
    return JSON.stringify({name: nameDraft, rule: draft}) !== JSON.stringify({name: doc.name, rule: doc.rule});
  }, [doc, draft, nameDraft]);

  function patchRule(patch: Partial<RecurRuleDTO>) {
    if (!draft) return;
    setDraft({...draft, ...patch});
  }
  function toggleWeekday(day: number) {
    if (!draft) return;
    const current = new Set(draft.weekdays ?? []);
    if (current.has(day)) current.delete(day);
    else current.add(day);
    patchRule({weekdays: [...current].sort((a, b) => a - b)});
  }

  const ruleChanged = doc && draft && JSON.stringify(draft) !== JSON.stringify(doc.rule);

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Recurrence Rule Studio</strong>
        <small>Local-field expansion · DST gap/fold aware</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>Rules</h2>
          <div className="list">
            {items.map(item => (
              <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>
                {item.name}
                <br />
                <small>rev {item.revision} · {item.fingerprint}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane editor">
          {draft && doc && (
            <>
              <input className="name-input" value={nameDraft} onChange={e => setNameDraft(e.target.value)} />
              <div className="grid">
                <label>
                  Zone
                  <select value={draft.zone} onChange={e => patchRule({zone: e.target.value})}>
                    {zones.map(z => <option key={z.id} value={z.id}>{z.id}</option>)}
                  </select>
                </label>
                <label>
                  First occurrence (local)
                  <input
                    type="datetime-local"
                    step={1}
                    value={toInputLocal(draft.startLocal)}
                    onChange={e => patchRule({startLocal: e.target.value.replace('T', 'T')})}
                  />
                </label>
                <label>
                  Frequency
                  <select value={draft.frequency} onChange={e => patchRule({frequency: e.target.value as RecurRuleDTO['frequency']})}>
                    <option value="daily">daily</option>
                    <option value="weekly">weekly</option>
                    <option value="monthly">monthly</option>
                  </select>
                </label>
                <label>
                  Interval
                  <input
                    type="number"
                    min={1}
                    value={draft.interval}
                    onChange={e => patchRule({interval: Math.max(1, Number(e.target.value) || 1)})}
                  />
                </label>
                <label>
                  COUNT (empty = none)
                  <input
                    type="number"
                    min={1}
                    value={draft.count ?? ''}
                    onChange={e => patchRule({count: e.target.value === '' ? undefined : Number(e.target.value)})}
                  />
                </label>
                <label>
                  UNTIL local (inclusive, empty = none)
                  <input
                    type="datetime-local"
                    value={draft.untilLocal ? toInputLocal(draft.untilLocal) : ''}
                    onChange={e => patchRule({untilLocal: e.target.value || undefined})}
                  />
                </label>
              </div>

              {draft.frequency === 'weekly' && (
                <div className="weekdays">
                  {WEEKDAYS.map((label, day) => (
                    <button
                      key={label}
                      className={(draft.weekdays ?? []).includes(day) ? 'chip on' : 'chip'}
                      onClick={() => toggleWeekday(day)}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}

              <div className="policies">
                <PolicyPicker
                  title="Spring gap (local time does not exist)"
                  value={draft.gapPolicy}
                  onChange={v => patchRule({gapPolicy: v})}
                />
                <PolicyPicker
                  title="Autumn fold (local time happens twice)"
                  value={draft.foldPolicy}
                  onChange={v => patchRule({foldPolicy: v})}
                />
              </div>

              <div className="toolbar">
                <button className="primary" onClick={save} disabled={!dirty}>
                  <Save size={15} /> Save
                </button>
                <span className={dirty ? 'dirty' : ''}>
                  {dirty ? 'Unsaved local fields' : `Saved · revision ${doc.revision}`}
                </span>
                {ruleChanged && <span className="warn">policy/rule change will invalidate old pages &amp; cache</span>}
              </div>
              {error && <div className="error">{error}</div>}
              <div className="status">{status}</div>
            </>
          )}
        </section>

        <aside className="pane preview">
          <h2><CalendarClock size={16} /> Occurrences</h2>
          {doc && (
            <>
              <div className="meta">
                <div>fingerprint <code>{doc.fingerprint}</code></div>
                <div>revision <code>{doc.revision}</code></div>
              </div>
              <div className="window">
                <label>
                  Window from (UTC)
                  <input type="datetime-local" value={utcInputValue(windowFromMs)}
                    onChange={e => {
                      const ms = parseUtcInput(e.target.value);
                      if (ms !== null) setWindowFromMs(ms);
                    }} />
                </label>
                <label>
                  Window to (UTC, exclusive)
                  <input type="datetime-local" value={utcInputValue(windowToMs)}
                    onChange={e => {
                      const ms = parseUtcInput(e.target.value);
                      if (ms !== null) setWindowToMs(ms);
                    }} />
                </label>
                <label>
                  Page size
                  <input type="number" min={1} max={500} value={limit}
                    onChange={e => setLimit(Math.min(500, Math.max(1, Number(e.target.value) || 25)))} />
                </label>
              </div>

              {page && (
                <>
                  <div className="counts">
                    <span><b>{page.totalInWindow}</b> in window</span>
                    <span><b>{page.skipped.length}</b> skipped</span>
                    <span>{page.exhausted ? 'rule ended' : 'extends beyond window'}</span>
                  </div>
                  {fingerprintMatches === false && (
                    <div className="warn">Showing the last saved expansion — save or wait for reload.</div>
                  )}
                  {cacheNotice && <div className="cache-note">{cacheNotice}</div>}
                  {page.skipped.length > 0 && (
                    <details className="skipped">
                      <summary>{page.skipped.length} nominal occurrence(s) skipped by policy</summary>
                      <ul>
                        {page.skipped.map(s => (
                          <li key={s.uid}><code>{s.local}</code> — {s.reason} (nominal #{s.nominalIndex})</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <OccurrenceTable occurrences={page.occurrences} />
                  <div className="pager">
                    <button disabled={cursorStack.length === 0 || pageState === 'loading'}
                      onClick={() => loadPage(cursorStack[cursorStack.length - 1], cursorStack.slice(0, -1))}>
                      <ChevronLeft size={15} /> Prev
                    </button>
                    <button disabled={!page.hasMore || pageState === 'loading'}
                      onClick={() => page.nextCursor && loadPage(page.nextCursor, [...cursorStack, activeCursor!])}>
                      Next <ChevronRight size={15} />
                    </button>
                    <span>{pageState === 'loading' ? 'Loading…' : page.hasMore ? 'more pages' : 'end'}</span>
                  </div>
                </>
              )}
            </>
          )}
        </aside>
      </section>
    </main>
  );
}

function PolicyPicker({title, value, onChange}: {title: string; value: GapFoldPolicy; onChange: (v: GapFoldPolicy) => void}) {
  return (
    <div className="policy">
      <div className="policy-title">{title}</div>
      <div className="policy-options">
        {POLICIES.map(p => (
          <label key={p.value} className={value === p.value ? 'option on' : 'option'}>
            <input type="radio" name={title} checked={value === p.value} onChange={() => onChange(p.value)} />
            <span>{p.label}</span>
            <small>{p.hint}</small>
          </label>
        ))}
      </div>
    </div>
  );
}

function OccurrenceTable({occurrences}: {occurrences: OccurrenceDTO[]}) {
  return (
    <table className="occurrences">
      <thead>
        <tr><th>#</th><th>nominal local</th><th>actual local</th><th>offset</th><th>UTC instant</th><th>state</th></tr>
      </thead>
      <tbody>
        {occurrences.map(o => (
          <tr key={o.uid} className={o.ambiguous ? 'ambiguous' : ''}>
            <td>{o.nominalIndex}</td>
            <td><code>{o.local}</code></td>
            <td><code>{o.actualLocal}</code></td>
            <td>{o.offset}</td>
            <td className="utc">{new Date(Number(o.instant)).toISOString().replace(/\.\d+Z$/, 'Z')}</td>
            <td><StatusBadge status={o.status} /></td>
          </tr>
        ))}
        {occurrences.length === 0 && (
          <tr><td colSpan={6} className="empty">no occurrences in this window</td></tr>
        )}
      </tbody>
    </table>
  );
}

function StatusBadge({status}: {status: OccurrenceDTO['status']}) {
  const label = {
    unique: 'unique',
    'gap-shifted': 'gap · shifted',
    'fold-earlier': 'fold · earlier',
    'fold-later': 'fold · later',
  }[status];
  return <span className={`badge ${status === 'unique' ? 'ok' : 'warn-badge'}`}>{label}</span>;
}
