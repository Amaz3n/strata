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
