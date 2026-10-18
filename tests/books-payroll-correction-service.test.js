require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),{createHash}=require('node:crypto')
const {ready,post}=require('./helpers/books-payroll-atomic-fixture'),{capture}=require('./helpers/books-payroll-workflow-fixture'),{id,org}=require('./helpers/books-payroll-register-fixture')
const {payrollRegisterFields}=require('../lib/services/books/payroll-register-csv'),{booksDigest}=require('../lib/services/books/hash')
let snapshot,bytes,sourceBytes,members,denied=false,calls=[]
const service={rpc:async(name,args)=>{calls.push(['capture',name,args]);return {data:snapshot,error:null}},from(table){calls.push(['table',table]);const query={select(){return query},eq(key,value){calls.push([key,value]);return query},in(key,value){calls.push([key,value]);return query},limit:async()=>({data:members,error:null})};return query}}
const original=Module._load
let preview
try{Module._load=function(name,...args){
 if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:id(50),supabase:{}})}
 if(name==='./access')return {requireBooksAuthorization:async input=>{calls.push(['authorize',input.permission]);if(denied)throw new Error('Denied')}}
 if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service}
 if(name==='@/lib/storage/files-storage')return {getFilesObjectStream:async input=>{calls.push(['object',input.path]);return {body:new ReadableStream({start(controller){controller.enqueue(sourceBytes);controller.close()}})}}}
 return original.call(this,name,...args)
};preview=require('../lib/services/books/payroll-corrections').previewPayrollCorrection}finally{Module._load=original}
async function fixture(t){
 const f=await ready(t);await post(f);snapshot=await capture(f.db)
 const run=structuredClone(snapshot.tables.books_payroll_imports[0].run),worker=run.employees[0];run.id=id(700)
 Object.assign(worker,{gross_cents:26000,net_cents:20000})
 worker.allocations[0].gross_cents=26000
 Object.assign(run.controls,{gross_cents:26000,net_cents:20000,funding_cents:29000})
 const fields=['gross_cents','net_cents','employee_taxes_cents','employee_deductions_cents','employer_taxes_cents','employer_benefits_cents'],decimal=amount=>(amount/100).toFixed(2),metadata=[run.provider,run.provider_run_id,run.period_start,run.period_end,run.accrual_date,run.pay_date]
 bytes=Buffer.from([payrollRegisterFields,['employee',...metadata,'W-1',...fields.map(key=>decimal(worker[key])),''],['control',...metadata,'',...fields.map(key=>decimal(run.controls[key])),decimal(run.controls.funding_cents)]].map(row=>row.join(',')).join('\r\n')+'\r\n')
 const version={id:id(701),org_id:org,file_id:id(702),storage_path:org+'/payroll/corrected.csv',file_name:'Corrected.csv',mime_type:'text/csv',size_bytes:bytes.length,checksum:createHash('sha256').update(bytes).digest('hex')}
 snapshot.tables.files.push({id:id(702),org_id:org,current_version_id:id(703),storage_path:org+'/payroll/replaced-again.csv'})
 snapshot.tables.doc_versions.push(version);sourceBytes=bytes;members=[{user_id:id(2),org_id:org}];calls=[];denied=false
 const input={request:{id:id(700),postingId:id(260),accountingDate:'2026-09-20',reason:'Full corrected provider register with original payroll retained'},register:{runId:id(700),fileId:id(702),documentVersionId:id(701),mapping:snapshot.tables.books_payroll_imports[0].column_mapping,workers:run.employees.map(worker=>({worker_id:worker.worker_id,employee_reference:worker.employee_reference,allocations:worker.allocations}))}}
 return {f,input,version}
}
test('correction preview verifies original corrected version bytes and exact posted native ownership without consuming labor twice',async t=>{
 const {f,input,version}=await fixture(t),before=structuredClone(snapshot.tables),databaseBefore=(await capture(f.db)).tables,p=await preview(input)
 assert.deepEqual(calls[0],['authorize','books.adjust']);assert.equal(calls.filter(row=>row[0]==='capture').length,1)
 assert.ok(calls.some(row=>row[0]==='object'&&row[1]===version.storage_path));assert.ok(!calls.some(row=>row[1]===org+'/payroll/replaced-again.csv'))
 assert.equal(p.costDeltaCents,2000);assert.equal(p.correctedRun.employees[0].gross_cents,26000);assert.equal(p.sourceProof.checksum,version.checksum);assert.equal(p.providerSourceVerified,true)
 assert.equal(p.nativeLaborReconciledAgain,false);assert.equal(p.cashDeltaCents,0);assert.equal(p.postingImplemented,false)
 const {digest,...evidence}=p;assert.equal(digest,booksDigest(evidence));assert.equal((await preview(input)).digest,digest)
 assert.deepEqual(snapshot.tables,before);assert.deepEqual((await capture(f.db)).tables,databaseBefore)
 const alternate=structuredClone(snapshot);alternate.tables.doc_versions.find(row=>row.id===id(701)).file_name='Provider-certified replacement.csv';snapshot=alternate
 assert.notEqual((await preview(input)).digest,digest,'review identity binds document proof as well as money')
})
test('correction source rejects unauthorized reads, foreign original ownership, corrupt provider bytes and caller supplied amounts',async t=>{
 const {input}=await fixture(t);denied=true;await assert.rejects(preview(input),/Denied/);assert.deepEqual(calls,[['authorize','books.adjust']]);denied=false
 sourceBytes=Buffer.from('x'.repeat(bytes.length));await assert.rejects(preview(input),/bytes differ/);sourceBytes=bytes
 await assert.rejects(preview({...input,register:{...input.register,gross_cents:1}}),/Unrecognized/)
 const wrong=structuredClone(input);wrong.request.id=id(999);await assert.rejects(preview(wrong),/identity differs/)
 members=[];await assert.rejects(preview(input),/worker mapping/);members=[{user_id:id(2),org_id:org}]
 const saved=structuredClone(snapshot);snapshot.tables.books_payroll_postings[0].org_id=id(999);await assert.rejects(preview(input),/Missing\/ambiguous/);snapshot=saved
 snapshot.tables.time_entries[0].base_rate_cents=1;await assert.rejects(preview(input),/original reviewed sources|ownership|wage/i)
})
