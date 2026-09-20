import express, {Request, Response} from 'express';
import {fileURLToPath} from 'node:url';
import {
  RecurrenceRule, NormalizedRule, OccurrencePage, normalizeRule, expand,
  ENGINE_VERSION, GAP_POLICIES, FOLD_POLICIES, ruleFingerprint,
} from '../shared/recurrence';
import {isValidTimezone} from '../shared/timezone';
import {ExpansionCache} from './cache';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};

const rows: RecordRow[] = [
  {id:'alpha',name:'Daily 02:30 (New York)',revision:1,content:JSON.stringify(defaultRule(),null,2),updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Half-hour zone (Adelaide)',revision:1,content:JSON.stringify({
    tzid:'Australia/Adelaide',dtstartLocal:'2024-01-01T02:30:00',interval:1,gapPolicy:'later',foldPolicy:'earlier',
  } satisfies RecurrenceRule,null,2),updatedAt:new Date(1000).toISOString()},
];

function defaultRule(): RecurrenceRule {
  return {
    tzid:'America/New_York',
    dtstartLocal:'2024-01-01T02:30:00',
    interval:1,
    gapPolicy:'later',
    foldPolicy:'earlier',
  };
}

const occurrenceCache = new ExpansionCache<OccurrencePage>();

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));

  app.get('/api/bootstrap',(_req,res)=>res.json({
    family:'recurrence-rule',count:rows.length,engine:ENGINE_VERSION,
    policies:{gap:GAP_POLICIES,fold:FOLD_POLICIES},
  }));

  app.get('/api/schedules',(_req,res)=>res.json(rows.map(({content,...row})=>row)));

  app.get('/api/schedules/:id',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    res.set('ETag',String(row.revision)).json(row);
  });

  app.put('/api/schedules/:id',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    if(req.body.revision!==row.revision){
      return res.status(409).json({error:'revision_conflict',current:row});
    }
    const content=String(req.body.content??'');
    // Persisted content must be a valid rule document.
    const parsed=tryParseRule(content);
    if('error'in parsed)return res.status(400).json(parsed);

    row.content=content;
    row.revision+=1;
    row.updatedAt=new Date().toISOString();
    // Any occurrence page derived from the old rule is now stale.
    occurrenceCache.purgeScope(row.id);
    res.json({...row,fingerprint:fingerprintOrNull(parsed.rule)});
  });

  app.post('/api/schedules/:id/analyze',async(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?5:2));
    const content=req.body && typeof req.body.content==='string'?req.body.content:row.content;
    const parsed=tryParseRule(content);
    if('error'in parsed){
      return res.status(400).json({id:row.id,revision:row.revision,lines:content.split(/\r?\n/).length,
        diagnostics:[{severity:'error',message:parsed.error,field:parsed.field}]});
    }
    res.json({id:row.id,revision:row.revision,lines:content.split(/\r?\n/).length,
      rule:parsed.rule,fingerprint:ruleFingerprint(parsed.rule),diagnostics:[]});
  });

  /**
   * Expand occurrences.
   *
   * The server is the single source of truth: every occurrence carries its
   * nominal local fields, the resolved local fields, the UTC instant, the
   * effective offset and a stable id. Clients render only — never recompute.
   *
   * Body:
   *   {rule?, window?:{fromLocal,toLocal}, cursor?, pageSize?}
   * `rule` previews unsaved edits; without it the saved content is used.
   */
  app.post('/api/schedules/:id/occurrences',(req:Request,res:Response)=>handleOccurrences(req,res));

  /** Cursor-first alias for continuing a paged expansion (window optional). */
  app.post('/api/schedules/:id/occurrences/page',(req:Request,res:Response)=>handleOccurrences(req,res));

  function handleOccurrences(req:Request,res:Response){
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});

    const body=(req.body ?? {}) as OccurrenceRequestBody;
    let normalized: NormalizedRule;
    let ruleSource: 'saved'|'draft';
    if(body.rule !== undefined){
      const parsed=validateRule(body.rule);
      if('error'in parsed)return res.status(400).json(parsed);
      normalized=parsed.rule;
      ruleSource='draft';
    } else {
      const parsed=tryParseRule(row.content);
      if('error'in parsed)return res.status(409).json({error:'saved_rule_invalid',detail:parsed.error});
      normalized=parsed.rule;
      ruleSource='saved';
    }

    const pageSize=body.pageSize ?? 100;
    if(typeof pageSize!=='number'||!Number.isInteger(pageSize)||pageSize<1||pageSize>10_000){
      return res.status(400).json({error:'invalid_page_size'});
    }

    let window: {fromLocal:string;toLocal:string}|undefined;
    if(body.window){
      const w=body.window as {fromLocal?:unknown;toLocal?:unknown};
      if(typeof w.fromLocal!=='string'||typeof w.toLocal!=='string'){
        return res.status(400).json({error:'invalid_window'});
      }
      window={fromLocal:w.fromLocal,toLocal:w.toLocal};
    }
    const cursor=typeof body.cursor==='string'?body.cursor:null;

    const query={window:window??null,cursor,pageSize};
    const cacheKey=occurrenceCache.key(normalized,row.id,query);
    const cached=ruleSource==='saved'?occurrenceCache.get(cacheKey):undefined;
    let page: OccurrencePage;
    if(cached){
      page=cached;
    } else {
      try{
        page=expand(normalized,{scope:row.id,window,cursor,pageSize});
      }catch(err){
        return res.status(400).json({error:'expand_failed',detail:(err as Error).message});
      }
      if(ruleSource==='saved')occurrenceCache.set(cacheKey,page);
    }

    res.json({
      id:row.id,
      revision:row.revision,
      ruleSource,
      engine:ENGINE_VERSION,
      fingerprint:ruleFingerprint(normalized),
      cached:Boolean(cached),
      window:window??null,
      ...page,
    });
  }

  return app;
}

interface OccurrenceRequestBody {
  rule?: RecurrenceRule;
  window?: {fromLocal:string;toLocal:string};
  cursor?: string|null;
  pageSize?: number;
}

type RuleOk = {rule: NormalizedRule};
type RuleErr = {error:string;field?:string};

function validateRule(raw: unknown): RuleOk | RuleErr {
  if(!raw||typeof raw!=='object')return {error:'rule_must_be_object',field:'rule'};
  const candidate=raw as RecurrenceRule;
  if(typeof candidate.tzid!=='string'||!isValidTimezone(candidate.tzid)){
    return {error:'unknown_timezone',field:'tzid'};
  }
  try{
    return {rule:normalizeRule(candidate)};
  }catch(err){
    const message=(err as Error).message;
    const field=message.split(':')[0];
    return {error:message,field:guessField(field)};
  }
}

function guessField(token:string):string|undefined{
  if(token.includes('tzid'))return 'tzid';
  if(token.includes('dtstart')||token.includes('local_stamp'))return 'dtstartLocal';
  if(token.includes('interval'))return 'interval';
  if(token.includes('count'))return 'count';
  if(token.includes('until'))return 'untilLocal';
  if(token.includes('policy'))return token.includes('gap')?'gapPolicy':'foldPolicy';
  if(token.includes('cursor'))return 'cursor';
  return undefined;
}

function tryParseRule(content:string): RuleOk|RuleErr {
  let raw: unknown;
  try{
    raw=JSON.parse(content);
  }catch{
    return {error:'content_must_be_json',field:'content'};
  }
  return validateRule(raw);
}

function fingerprintOrNull(rule: NormalizedRule): string {
  return ruleFingerprint(rule);
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'));
}
