require('../scripts/register-ts-node-test');
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
const {projectionFindingWasEvaluated,planReconciliationItemSync,notifiableFindingCount,PROJECTION_RUN_SOURCE_TYPE,ledgerProofFindings,LEDGER_PROOF_CATEGORY}=require('../lib/services/books/reconciliation-rules');
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
test('a pass that did not reach a company opens an item but never alerts its owner; a source record that cannot post does',()=>{
 const org='00000000-0000-4000-8000-000000000001',bill='00000000-0000-4000-8000-000000000002';
 const notReached={category:'projection_failed',entityType:PROJECTION_RUN_SOURCE_TYPE,entityId:org,details:{severity:'critical'}};
 const failedBill={category:'projection_failed',entityType:'vendor_bill',entityId:bill,details:{severity:'critical'}};
 const plan=planReconciliationItemSync({findings:[notReached,failedBill],existing:[],ownsCategory:()=>true});
 assert.equal(plan.insert.length,2);
 assert.equal(notifiableFindingCount(plan),1);
 assert.equal(notifiableFindingCount(planReconciliationItemSync({findings:[notReached],existing:[],ownsCategory:()=>true})),0);
});
test('what the ledger proof finds becomes a finding with its cure and a link to the entry; proof bookkeeping is not a finding',()=>{
 const entry='00000000-0000-4000-8000-000000000011',fact='00000000-0000-4000-8000-000000000012';
 const findings=ledgerProofFindings([{type:'journal_divergence',fact_id:fact,entry_id:entry},{type:'missing_journal',fact_id:fact},{type:'unexpected_journal',entry_id:entry},{type:'orphan_scan_capped',scanned:5000}]);
 assert.deepEqual(findings.map(f=>[f.category,f.entityType,f.findingKey]),[[LEDGER_PROOF_CATEGORY,'journal_entry','journal_divergence'],[LEDGER_PROOF_CATEGORY,'accounting_fact','missing_journal'],[LEDGER_PROOF_CATEGORY,'journal_entry','unexpected_journal']]);
 assert.equal(findings[0].details.href,`/books/ledger?entry=${entry}`);
 assert.match(findings[0].details.cure,/Reverse it with the reason, then run posting/);
});
