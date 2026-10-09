const { migrationSql } = require("./support/migration-sql")
require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
const {sourceFixture}=require('./helpers/books-payroll-correction-source-fixture'),{capture}=require('./helpers/books-payroll-workflow-fixture'),{id,org}=require('./helpers/books-payroll-register-fixture')
let f,actor=id(50),denied=false,offline=false,lost=false,calls=[],tamper=null
const service={async rpc(name,args){calls.push(['rpc',name]);try{
 if(name==='capture_books_export_snapshot')return {data:await capture(f.db),error:null}
 if(name==='lock_books_payroll_correction_context'){
  const row=(await f.db.query('select lock_books_payroll_correction_context($1,$2) result',[args.p_org_id,args.p_source_id])).rows[0].result
  if(tamper)await tamper(row)
  return {data:row,error:null}
 }
 const values=name==='prepare_books_payroll_correction_source'?[args.p_org_id,args.p_actor_id,JSON.stringify(args.p_evidence),args.p_notes,args.p_key]:name==='review_books_payroll_correction_source'?[args.p_org_id,args.p_id,args.p_actor_id,JSON.stringify(args.p_evidence),args.p_notes]:[args.p_org_id,args.p_id,args.p_actor_id,args.p_reason]
 const result=await f.db.query(`select ${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) id`,values)
 if(lost&&name==='prepare_books_payroll_correction_source'){lost=false;return {data:null,error:{message:'Response lost after source commit'}}}
 return {data:result.rows[0].id,error:null}
 }catch(error){return {data:null,error:{message:error.message}}}},from(table){calls.push(['read',table]);let conditions=[],ids
 const query={select(){return query},eq(key,value){conditions.push([key,value]);return query},in(key,value){ids=[key,value];return query},async read(){const values=conditions.map(([,value])=>value),where=conditions.map(([key],i)=>`${key}=$${i+1}`);if(ids){values.push(ids[1]);where.push(`${ids[0]}=any($${values.length}::uuid[])`)}const rows=(await f.db.query(`select to_jsonb(source) row from ${table} source${where.length?' where '+where.join(' and '):''}`,values)).rows.map(result=>result.row);return {data:rows,error:null}},async maybeSingle(){const result=await query.read();return {...result,data:result.data[0]??null}},async single(){return query.maybeSingle()},async limit(){return query.read()}}
 return query}}
const original=Module._load;let prepare,review,withdraw,getContext
try{Module._load=function(name,...args){
 if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:actor,supabase:{}})}
 if(name==='./access')return {requireBooksAuthorization:async input=>{calls.push(['authorize',input.permission]);if(denied)throw new Error('Denied')}}
 if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service}
 if(name==='@/lib/storage/files-storage')return {getFilesObjectStream:async()=>{calls.push(['object']);if(offline)throw new Error('Storage unavailable');return {body:new ReadableStream({start(controller){controller.enqueue(f.bytes);controller.close()}})}}}
 return original.call(this,name,...args)
};const loaded=require('../lib/services/books/payroll-corrections');prepare=loaded.preparePayrollCorrectionSource;review=loaded.reviewPayrollCorrectionSource;withdraw=loaded.withdrawPayrollCorrectionSource;getContext=loaded.getPayrollCorrectionContext}finally{Module._load=original}
function input(){const e=f.evidence;return {request:e.request,register:{runId:e.request.id,fileId:e.source_proof.file_id,documentVersionId:e.source_proof.document_version_id,mapping:e.column_mapping,workers:e.run.employees.map(worker=>({worker_id:worker.worker_id,employee_reference:worker.employee_reference,allocations:worker.allocations}))},notes:'Reviewed full corrected register and original payroll posting',idempotencyKey:'service-corrected-register-retry'}}
test('actual correction service recovers lost source commit without storage, independently reviews and preserves withdrawn retry history',async t=>{
 f=await sourceFixture(t);actor=id(50);calls=[];denied=false;offline=false;lost=true
 const before=(await capture(f.db)).tables,args=input();assert.equal(await prepare(args),id(700));assert.deepEqual(calls[0],['authorize','books.adjust'])
 assert.equal((await f.db.query('select count(*)::int n from books_payroll_correction_sources')).rows[0].n,1)
 offline=true;calls=[];assert.equal(await prepare(args),id(700));assert.ok(!calls.some(row=>row[0]==='object'))
 await assert.rejects(prepare({...args,notes:'Different retry preparation explanation'}),/different intent/)
 await assert.rejects(review({id:id(700),notes:'Independent review of original corrected register'}),/independent reviewer/)
 actor=id(51);await assert.rejects(review({id:id(700),notes:'Independent review of original corrected register'}),/Storage unavailable/)
 offline=false;await review({id:id(700),notes:'Independent review of original corrected register'})
 actor=id(50);await withdraw({id:id(700),reason:'Superseded corrected provider documentary history'});offline=true;assert.equal(await prepare(args),id(700))
 const after=(await capture(f.db)).tables;assert.equal(after.books_payroll_correction_sources[0].status,'withdrawn');assert.equal(after.books_payroll_correction_sources[0].reviewed_by,id(51))
 for(const table of ['journal_entries','journal_lines','accounting_facts','job_cost_entries','billable_costs','time_entries'])assert.deepEqual(after[table],before[table])
})
test('whole organization authorization precedes every correction lifecycle private read or write',async t=>{
 f=await sourceFixture(t);actor=id(50);denied=true;offline=false
 for(const run of [()=>prepare(input()),()=>review({id:id(700),notes:'Independent review of corrected source'}),()=>withdraw({id:id(700),reason:'Withdraw corrected source with explicit reason'}),()=>getContext({id:id(700)})]){calls=[];await assert.rejects(run(),/Denied/);assert.deepEqual(calls,[['authorize','books.adjust']])}
 denied=false
})
test('authorized service verifies real SQL correction closure and never represents expired preflight locks as held',async t=>{
 f=await sourceFixture(t);actor=id(50);denied=false;offline=false;lost=false;tamper=null;calls=[]
 for(const name of ['20261004021236_books_payroll_correction_math.sql','20261004022226_books_payroll_correction_context.sql'])await f.db.exec(migrationSql(name.replace(/\.sql$/, "")))
 await prepare(input());actor=id(51);await review({id:id(700),notes:'Independent corrected provider source review'})
 const before=(await capture(f.db)).tables;calls=[];const context=await getContext({id:id(700)})
 assert.deepEqual(calls[0],['authorize','books.adjust']);assert.equal(context.preflightOnly,true);assert.equal(context.requiresCommitRevalidation,true);assert.equal(context.postingImplemented,false);assert.ok(!Object.hasOwn(context,'locksHeldUntilTransactionEnd'))
 assert.equal(context.math.costDeltaCents,2000);assert.equal(context.projectCosts[0].budgetLineId,id(84));assert.deepEqual((await capture(f.db)).tables,before)
 for(const change of [row=>row.orgId=id(999),row=>row.sourceHash='a'.repeat(64),row=>row.math.journalDraft.lines[0].debitCents++,row=>row.projectCosts[0].budgetLineId=null,row=>row.workers[0].remainingBeforeAdditionalAttribution.netPayCents++,row=>row.context.billable_costs[0].billable_cents++,row=>row.additionalLiabilityJournalIds.push(id(999))]){
  tamper=change;await assert.rejects(getContext({id:id(700)}))
 }
 tamper=async()=>{await f.db.query("update billable_costs set metadata=jsonb_set(metadata,'{billing_method}','\"cost_plus_markup\"') where id=$1",[id(86)])}
 await assert.rejects(getContext({id:id(700)}),/context changed/)
 tamper=null
})
