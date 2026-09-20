import {useEffect,useMemo,useRef,useState} from 'react';
import {CalendarClock,ChevronLeft,ChevronRight,FlaskConical,Play,Save,ShieldAlert} from 'lucide-react';

/**
 * The client renders only local strings/offsets/ids produced by the server.
 * No browser `Date` math anywhere: DST gap/fold decisions live server-side,
 * so preview and saved results can never diverge.
 */

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};

type GapPolicy='skip'|'earlier'|'later';
type FoldPolicy='skip'|'earlier'|'later';
interface RuleDraft {
  tzid:string;
  dtstartLocal:string; // yyyy-MM-ddTHH:mm
  interval:number;
  count?:number;
  untilLocal?:string;
  untilUtc?:string;
  gapPolicy:GapPolicy;
  foldPolicy:FoldPolicy;
}
type Occurrence={
  id:string;ordinal:number;local:string;resolvedLocal:string;
  utc:string|null;offset:string|null;kind:'normal'|'gap-adjusted'|'fold';
  framingOffsets:string[];skipped:boolean;skipReason?:string;
};
type OccurrenceResponse={
  occurrences:Occurrence[];skipped:Occurrence[];nextCursor:string|null;exhausted:boolean;
  id:string;revision:number;ruleSource:'saved'|'draft';engine:string;
  fingerprint:string;cached:boolean;window:{fromLocal:string;toLocal:string}|null;
};

const DEFAULT_WINDOW_DAYS=30;

function pad(n:number,w=2){return String(n).padStart(w,'0');}
function localInputToStamp(value:string):string{
  // <input type="datetime-local"> gives "yyyy-MM-ddTHH:mm"; append seconds.
  return value.length===16?`${value}:00`:value;
}
function stampToInput(stamp:string):string{
  return stamp.slice(0,16);
}
/** Split a server local stamp into date / time display parts (no Date parsing). */
function splitStamp(stamp:string){return {date:stamp.slice(0,10),time:stamp.slice(11,19)};}

function emptyDraft():RuleDraft{
  return {tzid:'America/New_York',dtstartLocal:'2024-01-01T02:30',interval:1,
    gapPolicy:'later',foldPolicy:'earlier'};
}
function draftFromContent(content:string):RuleDraft{
  try{
    const parsed=JSON.parse(content) as Partial<RuleDraft>&{dtstartLocal?:string};
    return {
      tzid:String(parsed.tzid??'America/New_York'),
      dtstartLocal:stampToInput(String(parsed.dtstartLocal??'2024-01-01T02:30:00')),
      interval:Number(parsed.interval??1),
      count:parsed.count,
      untilLocal:parsed.untilLocal?stampToInput(parsed.untilLocal):undefined,
      untilUtc:parsed.untilUtc,
      gapPolicy:(parsed.gapPolicy??'later') as GapPolicy,
      foldPolicy:(parsed.foldPolicy??'earlier') as FoldPolicy,
    };
  }catch{return emptyDraft();}
}
function draftToRule(draft:RuleDraft){
  const rule:Record<string,unknown>={
    tzid:draft.tzid,
    dtstartLocal:localInputToStamp(draft.dtstartLocal),
    interval:draft.interval,
    gapPolicy:draft.gapPolicy,
    foldPolicy:draft.foldPolicy,
  };
  if(draft.count)rule.count=draft.count;
  if(draft.untilLocal)rule.untilLocal=localInputToStamp(draft.untilLocal);
  if(draft.untilUtc)rule.untilUtc=draft.untilUtc;
  return rule;
}

/**
 * Window anchor in LOCAL DATE space (yyyy-MM-dd). Paging moves ±N days; the
 * window bounds are local stamps, so adjacency is policy-independent.
 *
 * The ONLY `Date` use on the client: UTC-field calendar arithmetic to add a
 * day to a date-only window anchor. It never resolves occurrences or applies
 * the browser zone — all instants/offsets come pre-computed from the server.
 */
function addDaysToStamp(stamp:string,days:number):string{
  const [y,m,d]=stamp.slice(0,10).split('-').map(Number);
  const t=Date.UTC(y,m-1,d)+days*86_400_000;
  const dt=new Date(t);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())}`;
}

export default function App(){
  const [items,setItems]=useState<Summary[]>([]);
  const [selected,setSelected]=useState('alpha');
  const [row,setRow]=useState<Row|null>(null);
  const [draft,setDraft]=useState<RuleDraft>(emptyDraft());
  const [status,setStatus]=useState('Ready');
  const [error,setError]=useState<string|null>(null);
  const [analysis,setAnalysis]=useState<object|null>(null);
  const [windowStart,setWindowStart]=useState('2024-03-01');
  const [windowDays,setWindowDays]=useState(DEFAULT_WINDOW_DAYS);
  const [loadingPreview,setLoadingPreview]=useState(false);
  const [pageSize,setPageSize]=useState(50);
  const [pagedChunks,setPagedChunks]=useState<OccurrenceResponse[]>([]);
  const reqSeq=useRef(0);

  useEffect(()=>{fetch('/api/schedules').then(r=>r.json()).then(setItems);},[]);

  useEffect(()=>{
    setStatus('Loading');setError(null);setPagedChunks([]);
    fetch('/api/schedules/'+selected).then(r=>r.json()).then((value:Row)=>{
      setRow(value);setDraft(draftFromContent(value.content));setStatus('Loaded');
    });
  },[selected]);

  const windowSpec=useMemo(()=>({
    fromLocal:`${windowStart}T00:00:00`,
    toLocal:`${addDaysToStamp(windowStart,windowDays)}T00:00:00`,
  }),[windowStart,windowDays]);

  const requestPreview=async(chunks:OccurrenceResponse[],cursor:string|null)=>{
    if(!row)return;
    const seq=++reqSeq.current;
    setLoadingPreview(true);
    const response=await fetch(`/api/schedules/${row.id}/occurrences`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({
        rule:draftToRule(draft),
        window:windowSpec,
        cursor,
        pageSize,
      }),
    });
    const value=await response.json();
    if(!response.ok){
      if(seq!==reqSeq.current)return;
      setError(value.error+(value.field?` (${value.field})`:''));
      setLoadingPreview(false);
      return;
    }
    if(seq!==reqSeq.current)return; // stale response after an edit / switch
    setError(null);
    setPagedChunks(cursor?[...chunks,value]:[value]);
    setLoadingPreview(false);
  };

  // Debounced preview of the CURRENT window first chunk; restarts whenever the
  // fingerprint inputs change, so a policy change never shows stale pages.
  useEffect(()=>{
    if(!row)return;
    const handle=setTimeout(()=>{setPagedChunks([]);void requestPreview([],null);},250);
    return ()=>clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[row?.id,draft.tzid,draft.dtstartLocal,draft.interval,draft.count,
     draft.untilLocal,draft.untilUtc,draft.gapPolicy,draft.foldPolicy,
     windowStart,windowDays,pageSize]);

  async function save(){
    if(!row)return;
    setStatus('Saving');
    const response=await fetch('/api/schedules/'+row.id,{
      method:'PUT',headers:{'content-type':'application/json'},
      body:JSON.stringify({content:JSON.stringify(draftToRule(draft),null,2),revision:row.revision}),
    });
    const value=await response.json();
    if(response.status===409){setStatus('Revision conflict');setError('Revision conflict — reloaded');
      setRow(value.current);setDraft(draftFromContent(value.current.content));return;}
    if(!response.ok){setError(value.error??'save failed');setStatus('Save failed');return;}
    setRow(value);setStatus('Saved');setError(null);
  }

  async function analyze(){
    if(!row)return;
    setStatus('Analyzing');
    const response=await fetch('/api/schedules/'+row.id+'/analyze',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({content:JSON.stringify(draftToRule(draft))}),
    });
    setAnalysis(await response.json());setStatus('Ready');
  }

  const lastChunk=pagedChunks[pagedChunks.length-1]??null;
  const allOccurrences=pagedChunks.flatMap(c=>c.occurrences);
  const allSkipped=pagedChunks.flatMap(c=>c.skipped);
  const fingerprint=pagedChunks[0]?.fingerprint??'';

  return <main className="shell">
    <header className="topbar">
      <CalendarClock size={20}/><strong>Recurrence Rule Studio</strong>
      <small>Server-authoritative local-time expansion</small>
    </header>
    <section className="workspace">
      <aside className="pane">
        <h2>Schedules</h2>
        <div className="list">
          {items.map(item=><button className={item.id===selected?'active':''}
            onClick={()=>setSelected(item.id)} key={item.id}>
            {item.name}<br/><small>Revision {item.revision}</small>
          </button>)}
        </div>
      </aside>

      <section className="pane editor">
        <div className="toolbar">
          <button className="primary" onClick={save}><Save size={15}/>Save</button>
          <button onClick={analyze}><Play size={15}/>Analyze</button>
          <span className={error?'error':'ok'}>{error??status}</span>
        </div>

        <div className="form">
          <label>IANA timezone
            <input value={draft.tzid} onChange={e=>setDraft({...draft,tzid:e.target.value})}
              spellCheck={false} placeholder="America/New_York"/></label>
          <label>Start (local wall time)
            <input type="datetime-local" step={1} value={draft.dtstartLocal}
              onChange={e=>setDraft({...draft,dtstartLocal:e.target.value})}/></label>
          <label>Interval (days)
            <input type="number" min={1} value={draft.interval}
              onChange={e=>setDraft({...draft,interval:Number(e.target.value)})}/></label>
          <label>COUNT (emitted)
            <input type="number" min={1} placeholder="no count"
              value={draft.count??''}
              onChange={e=>setDraft({...draft,count:e.target.value?Number(e.target.value):undefined})}/></label>
          <label>UNTIL local
            <input type="datetime-local" step={1} placeholder="no until"
              value={draft.untilLocal??''}
              onChange={e=>setDraft({...draft,untilLocal:e.target.value||undefined})}/></label>
          <label>UNTIL UTC
            <input placeholder="2024-12-31T23:59:59Z" spellCheck={false}
              value={draft.untilUtc??''}
              onChange={e=>setDraft({...draft,untilUtc:e.target.value||undefined})}/></label>

          <fieldset>
            <legend><ShieldAlert size={14}/>Spring gap (missing wall time)</legend>
            {(['skip','earlier','later'] as GapPolicy[]).map(p=>
              <label key={p} className="inline"><input type="radio" name="gap"
                checked={draft.gapPolicy===p}
                onChange={()=>setDraft({...draft,gapPolicy:p})}/>{policyLabel('gap',p)}</label>)}
          </fieldset>
          <fieldset>
            <legend><FlaskConical size={14}/>Autumn fold (repeated wall time)</legend>
            {(['skip','earlier','later'] as FoldPolicy[]).map(p=>
              <label key={p} className="inline"><input type="radio" name="fold"
                checked={draft.foldPolicy===p}
                onChange={()=>setDraft({...draft,foldPolicy:p})}/>{policyLabel('fold',p)}</label>)}
          </fieldset>
        </div>
      </section>

      <aside className="pane preview">
        <h2>Occurrence preview</h2>
        <div className="windowbar">
          <button onClick={()=>setWindowStart(addDaysToStamp(windowStart,-windowDays))}><ChevronLeft size={15}/></button>
          <input type="date" value={windowStart}
            onChange={e=>setWindowStart(e.target.value)}/>
          <span>→ {addDaysToStamp(windowStart,windowDays)}</span>
          <button onClick={()=>setWindowStart(addDaysToStamp(windowStart,windowDays))}><ChevronRight size={15}/></button>
          <select value={windowDays} onChange={e=>setWindowDays(Number(e.target.value))}>
            {[7,30,90,182,365].map(n=><option key={n} value={n}>{n}d</option>)}
          </select>
        </div>
        <div className="meta">
          <span className="pill">{allOccurrences.length} shown</span>
          <span className="pill warn">{allSkipped.length} skipped</span>
          <span className="pill" title={fingerprint}>fp:{fingerprint.slice(0,18)}…</span>
        </div>
        <table>
          <thead><tr><th>#</th><th>scheduled (local)</th><th>actual (local)</th><th>offset</th><th>UTC</th><th></th></tr></thead>
          <tbody>
            {allOccurrences.map(o=>{
              const nom=splitStamp(o.local);const act=splitStamp(o.resolvedLocal);
              return <tr key={o.id} className={o.kind==='normal'?'':'kind-'+o.kind}>
                <td>{o.ordinal}</td>
                <td>{nom.date} {nom.time}</td>
                <td>{act.date} {act.time}</td>
                <td>{o.offset}</td>
                <td className="utc">{o.utc}</td>
                <td>{kindBadge(o)}</td>
              </tr>;
            })}
            {allSkipped.map(o=>{const nom=splitStamp(o.local);
              return <tr key={o.id} className="kind-skip">
                <td>{o.ordinal}</td><td>{nom.date} {nom.time}</td>
                <td colSpan={3}>skipped — gap {o.framingOffsets.join(' → ')}</td>
                <td><span className="badge skip">skip</span></td></tr>;
            })}
          </tbody>
        </table>
        <div className="pager">
          <button disabled={!lastChunk?.nextCursor||loadingPreview}
            onClick={()=>lastChunk&&void requestPreview(pagedChunks,lastChunk.nextCursor)}>
            {loadingPreview?'Loading…':'Load next page'}
          </button>
          <small>pageSize
            <select value={pageSize} onChange={e=>setPageSize(Number(e.target.value))}>
              {[20,50,100,200].map(n=><option key={n} value={n}>{n}</option>)}
            </select>
          </small>
        </div>
        {analysis&&<details><summary>Analyze</summary><pre>{JSON.stringify(analysis,null,2) as string}</pre></details>}
      </aside>
    </section>
  </main>;
}

function policyLabel(shape:'gap'|'fold',p:string){
  if(p==='skip')return '跳过该天';
  if(shape==='gap')return p==='earlier'?'较早偏移（时钟显示后移）':'较晚偏移（时钟显示前移）';
  return p==='earlier'?'第一次（较早偏移）':'第二次（较晚偏移）';
}
function kindBadge(o:Occurrence){
  if(o.kind==='gap-adjusted')return <span className="badge gap" title={'framing '+o.framingOffsets.join(' / ')}>gap</span>;
  if(o.kind==='fold')return <span className="badge fold" title={'framing '+o.framingOffsets.join(' / ')}>fold</span>;
  return null;
}
