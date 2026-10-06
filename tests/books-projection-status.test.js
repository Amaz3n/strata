require('../scripts/register-ts-node-test');
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
const {projectionFindingWasEvaluated,planReconciliationItemSync}=require('../lib/services/books/reconciliation-rules');
test('incremental projection resolves only evaluated sources and retains unrelated failures',()=>{
 const existing=[{id:'checked',category:'projection_failed',entityType:'invoice',entityId:'one',status:'open',differenceCents:null},{id:'unchecked',category:'projection_failed',entityType:'vendor_bill',entityId:'two',status:'open',differenceCents:null}];
 const evaluated=new Set(['invoice:one']);const scope=existing.filter(item=>projectionFindingWasEvaluated(item,evaluated));
 const plan=planReconciliationItemSync({findings:[],existing:scope,ownsCategory:()=>true});
 assert.deepEqual(plan.resolveIds,['checked']);assert.equal(projectionFindingWasEvaluated({entityType:null,entityId:'one'},evaluated),false);
 assert.equal(projectionFindingWasEvaluated(existing[1],new Set()),false);
});
test('regular projection job persists actionable failures with explicit scan scope',async()=>{
 let authorized=true;const calls=[];const result={organizations:1,results:[{orgId:'org',evaluatedSourceKeys:['invoice:one'],failures:[{sourceType:'invoice',sourceId:'one',error:'Accounting period is closed and cannot accept postings'}]}]};
 const original=Module._load;let GET;
 try{Module._load=function(name,...args){
 if(name==='@/lib/services/books/projector')return {runBooksProjection:async options=>{calls.push({projection:options});return result}};
 if(name==='@/lib/services/books/reconciliation')return {recordProjectionFailures:async(results,options)=>{calls.push({results,scope:options});return {opened:1,resolved:0}}};
 if(name==='@/lib/services/cron-auth')return {isAuthorizedCronRequest:()=>authorized};
 if(name==='@/lib/services/job-runs')return {withCronRun:(_name,handler)=>handler};
 return original.call(this,name,...args);
 };GET=require('../app/api/jobs/books-projection/route').GET;}finally{Module._load=original}
 const response=await GET({nextUrl:new URL('http://localhost/api/jobs/books-projection')});assert.equal(response.status,207);assert.equal((await response.json()).surfaced.opened,1);assert.equal(calls[1].scope.full,false);assert.deepEqual(calls[1].results,result.results);
 await GET({nextUrl:new URL('http://localhost/api/jobs/books-projection?full=1')});assert.equal(calls[3].scope.full,true);
 authorized=false;assert.equal((await GET({nextUrl:new URL('http://localhost')})).status,401);assert.equal(calls.length,4);
});
