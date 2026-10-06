const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
function load(client,overrides={}) {
  const file=path.resolve(__dirname,'../lib/services/drawings-pipeline.ts')
  const m=new Module(file,module);m.filename=file;m.paths=module.paths
  m.require=id=>id in overrides?overrides[id]:id==='@/lib/supabase/server'?{createServiceSupabaseClient:()=>client,createDrawingWorkerSupabaseClient:()=>client}:id.startsWith('@/')||id==='server-only'?{}:require(id)
  m._compile(ts.transpileModule(fs.readFileSync(file,'utf8')+'\nexport {processJob};',{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,file)
  return m.exports
}
test('deadline releases every unstarted owned claim',async()=>{
  let clock=0;const actions=[]
  const client={rpc:async(name,args)=>{
    if(name==='recover_drawing_job_leases')return {data:0}
    if(name==='claim_drawing_jobs'){clock=80000;return {data:[1,2,3].map(job_id=>({job_id,claim_token:String(job_id),job_type:'process_drawing_page',payload:{},retry_count:0}))}}
    actions.push([args.p_id,args.p_action]);return {data:true}
  },from:()=>{const q=new Proxy({},{get:(_,key)=>key==='then'?resolve=>resolve({data:[],count:3}):()=>q});return q}}
  const now=Date.now;Date.now=()=>clock
  try{await load(client).runDrawingsPipeline({deadlineMs:100000})}finally{Date.now=now}
  assert.deepEqual(actions,[[1,'release'],[2,'release'],[3,'release']])
})
test('lease errors and lost ownership are not success',async()=>{
 const api=load({}),job={job_id:1,claim_token:'token'}
 await assert.rejects(api.transitionDrawingJobLease({rpc:async()=>({error:{message:'offline'}})},job,'heartbeat'),/offline/)
 assert.equal(await api.transitionDrawingJobLease({rpc:async()=>({data:false})},job,'complete'),false)
})
const runtime=process.env.ARC_TEST_PGLITE_MODULE || "@electric-sql/pglite"
test('real SQL rejects stale ownership and deleted revision writes',{},async()=>{
 const {PGlite}=require(runtime),db=new PGlite()
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table outbox(id bigint generated always as identity primary key,org_id uuid,job_type text,payload jsonb,retry_count integer default 0,status text default 'pending',run_at timestamptz default now(),updated_at timestamptz default now(),created_at timestamptz default now(),priority integer default 0,last_error text);
 create table drawing_revisions(id uuid primary key,org_id uuid,status text default 'processing',processing_stage text,error_message text);create table drawing_sheets(id uuid primary key,org_id uuid);create table drawing_sheet_versions(id uuid primary key,org_id uuid,extracted_metadata jsonb);`)
 await db.exec(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261001121920_drawing_job_leases.sql'),'utf8'))
 const org='00000000-0000-0000-0000-000000000001',rev='00000000-0000-0000-0000-000000000002'
 await db.query('insert into drawing_revisions(id,org_id) values($1,$2)',[rev,org])
 await db.query("insert into outbox(org_id,job_type,payload) values($1,'process_drawing_page',$2)",[org,{draftRevisionId:rev}])
 const claim=async()=>(await db.query("select * from claim_drawing_jobs(array['process_drawing_page'],3)")).rows[0]
 const old=await claim();assert.ok(old.claim_token);assert.equal(await claim(),undefined)
 await db.exec("update outbox set drawing_lease_expires_at=now()-interval '1 second'")
 assert.equal((await db.query("select recover_drawing_job_leases(array['process_drawing_page']) as n")).rows[0].n,1)
 const fresh=await claim();assert.notEqual(fresh.claim_token,old.claim_token)
 for(const action of ['heartbeat','complete','retry','release'])assert.equal((await db.query('select transition_drawing_job_lease($1,$2,$3) as ok',[old.job_id,old.claim_token,action])).rows[0].ok,false)
 const headers=async(job)=>db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-drawing-job-id':String(job.job_id),'x-drawing-claim-token':job.claim_token})])
 await headers(old)
 await assert.rejects(db.query('insert into drawing_sheets values(gen_random_uuid(),$1)',[org]),/lease lost/)
 await headers(fresh);await db.query('insert into drawing_sheets values(gen_random_uuid(),$1)',[org])
 await db.exec('delete from drawing_revisions')
 await assert.rejects(db.query('insert into drawing_sheets values(gen_random_uuid(),$1)',[org]),/no longer exists/)
 await db.exec("select set_config('request.headers','{}',false)")
 assert.equal((await db.query("select transition_drawing_job_lease($1,$2,'retry','failure') as ok",[fresh.job_id,fresh.claim_token])).rows[0].ok,true)
 assert.equal(await claim(),undefined)
 const row=(await db.query('select * from outbox')).rows[0];assert.equal(row.status,'pending');assert.equal(row.retry_count,2)
 await db.exec("update outbox set run_at=now()-interval '1 second'")
 const last=await claim()
 assert.equal((await db.query("select transition_drawing_job_lease($1,$2,'complete') as ok",[last.job_id,last.claim_token])).rows[0].ok,true)
 }finally{await db.close()}
})
test('claim and pending-query errors cannot masquerade as an empty queue',async()=>{
 const api=load({rpc:async(name)=>name==='recover_drawing_job_leases'?{data:0}:{error:{message:'queue offline'}}})
 await assert.rejects(api.runDrawingsPipeline(),/queue offline/)
 const query=new Proxy({},{get:(_,key)=>key==='then'?resolve=>resolve({error:{message:'read offline'}}):()=>query})
 await assert.rejects(load({from:()=>query}).hasPendingDrawingJobs(),/read offline/)
})
test('owned job execution emits separate verification and queue wait measurements',async()=>{
 const measures=[]
 const client={rpc:async()=>({data:true}),from:table=>{const q=new Proxy({},{get:(_,key)=>key==='then'?resolve=>resolve({data:table==='drawing_sheet_versions'?{id:'v',drawing_revision_id:'r'}:{status:'published'}}):()=>q});return q}}
 const api=load(client,{'@/lib/drawings/lifecycle-metrics':{startDrawingLifecycleStage:(stage,context)=>{let done=false;return(outcome,counts)=>{if(!done){done=true;measures.push({stage,context,outcome,counts})}}}}})
 await api.processJob(client,{job_id:1,org_id:'org',claim_token:'claim',job_type:'enrich_drawing_metadata',retry_count:0,payload:{sheetVersionId:'v',sheetId:'s',draftRevisionId:'r',pageNumber:1,detected:{},drawingEnqueuedAt:new Date(Date.now()-1000).toISOString()}},Date.now()+10000)
 assert.deepEqual(measures.map(m=>m.stage),['queue_wait','verification']);assert.equal(measures[1].outcome,'success');assert.equal(measures[1].counts.attempts,1)
})
