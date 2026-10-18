require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module')
const {fixture,id,org}=require('./helpers/books-payroll-register-fixture')
let calls=[],denied=false,actor=id(50),stored=null,rpcError=null,prior=null,lookupError=null,commitLost=false,sourceFailure=false,api
const f=fixture(),snapshot={orgId:org,capturedAt:'2026-09-15T12:00:00Z',databaseSnapshot:'1:2:',payrollSourceRevision:'b'.repeat(64),tables:{budgets:[],budget_lines:[],billable_costs:[],time_entries:[],job_cost_entries:[],accounting_facts:[],journal_entries:[],journal_lines:[],books_projection_receipts:[],gl_accounts:f.postingAccounts}}
const service={rpc:async(name,args)=>{calls.push([name,args]);if(name==='prepare_books_payroll_import'&&commitLost){prior={...f.evidence,id:id(6),org_id:org,prepared_by:actor,preparation_notes:args.p_notes,idempotency_key:args.p_idempotency_key,status:'draft'};return {data:null,error:{message:'Response lost after commit'}}}return {data:name==='capture_books_payroll_context'?snapshot:id(6),error:rpcError}},from(table){calls.push(['table',table]);const q={select(){return q},eq(key,value){calls.push([key,value]);return q},single:async()=>({data:stored,error:null}),maybeSingle:async()=>({data:prior,error:lookupError})};return q}}
const original=Module._load
try{Module._load=function(name,...args){
 if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:actor,supabase:service})}
 if(name==='./access')return {requireBooksAuthorization:async input=>{calls.push(['authorize',input.permission]);if(denied)throw new Error('Denied')}}
 if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>service}
 if(name==='./payroll-register-source')return {previewPayrollRegisterFile:async input=>{calls.push(['verified-source',input]);if(sourceFailure)throw new Error('Labor changed after initial preparation');return f.result}}
 return original.call(this,name,...args)
};api=require('../lib/services/books/payroll-imports')}finally{Module._load=original}
test('preparation authorizes before source/context capture and writes only server-rebuilt evidence',async()=>{
 const input={register:{runId:id(6),fileId:id(8),documentVersionId:id(7),mapping:f.columnMapping,workers:f.run.employees.map(employee=>({employee_reference:employee.employee_reference,worker_id:employee.worker_id,allocations:employee.allocations}))},notes:'Reviewed provider register and construction allocation',idempotencyKey:'payroll-retry-identity'}
 denied=true;calls=[];await assert.rejects(api.preparePayrollImport(input),/Denied/);assert.deepEqual(calls,[['authorize','books.adjust']]);denied=false
 calls=[];assert.equal(await api.preparePayrollImport(input),id(6))
 assert.deepEqual(calls.map(row=>row[0]),['authorize','table','org_id','idempotency_key','verified-source','capture_books_payroll_context','prepare_books_payroll_import'])
 const args=calls.at(-1)[1];assert.equal(args.p_actor_id,id(50));assert.equal(args.p_org_id,org);assert.equal(args.p_evidence.run.controls.gross_cents,24000)
 assert.equal(args.p_evidence.reconciliation.evidenceVersion,2)
 assert.equal(args.p_evidence.reconciliation.workflowEvidence.constructionImpact.projectCostDeltaCents,27000)
 const legacy=structuredClone(args.p_evidence);delete legacy.reconciliation.evidenceVersion;delete legacy.reconciliation.workflowEvidence
 legacy.reconciliation_digest=f.evidence.reconciliation_digest;assert.deepEqual(legacy,f.evidence)
 rpcError={message:'Stale evidence'};await assert.rejects(api.preparePayrollImport(input),/Stale evidence/);rpcError=null
})
test('review scopes its lookup and reloads original source/mappings; self review and corrupt stored plans reject',async()=>{
 stored={...f.evidence,id:id(6),org_id:org,prepared_by:id(50)};calls=[]
 await assert.rejects(api.reviewPayrollImport({id:id(6),notes:'Independent review of original payroll evidence'}),/separate/)
 assert.ok(!calls.some(row=>row[0]==='verified-source'))
 actor=id(51);calls=[];assert.equal(await api.reviewPayrollImport({id:id(6),notes:'Independent review of original payroll evidence'}),id(6))
 assert.ok(calls.some(row=>row[0]==='org_id'&&row[1]===org));assert.ok(calls.some(row=>row[0]==='id'&&row[1]===id(6)))
 const source=calls.find(row=>row[0]==='verified-source')[1];assert.equal(source.documentVersionId,id(7));assert.equal(source.runId,id(6))
 assert.equal(calls.at(-1)[1].p_actor_id,id(51))
 stored={...stored,reconciliation:{...f.evidence.reconciliation,costVarianceCents:1}};calls=[]
 await assert.rejects(api.reviewPayrollImport({id:id(6),notes:'Independent review of original payroll evidence'}),/digest/)
 assert.ok(!calls.some(row=>row[0]==='verified-source'))
 stored={...f.evidence,id:id(6),org_id:id(99),prepared_by:id(50)}
 await assert.rejects(api.reviewPayrollImport({id:id(6),notes:'Independent review of original payroll evidence'}),/organization/)
})
test('withdrawal can close stale imports without fetching unavailable source objects and retains scoped actor',async()=>{
 calls=[];assert.equal(await api.withdrawPayrollImport({id:id(6),reason:'Replace stale evidence after payroll correction'}),id(6))
 assert.deepEqual(calls.map(row=>row[0]),['authorize','withdraw_books_payroll_import']);assert.equal(calls.at(-1)[1].p_org_id,org)
 await assert.rejects(api.withdrawPayrollImport({id:id(6),reason:'ok'}))
})

const register=()=>({runId:id(6),fileId:id(8),documentVersionId:id(7),mapping:f.columnMapping,workers:f.run.employees.map(employee=>({employee_reference:employee.employee_reference,worker_id:employee.worker_id,allocations:employee.allocations}))})
const preparation=()=>({register:register(),notes:'Reviewed payroll register and construction allocations',idempotencyKey:'lost-response-payroll-key'})
const saved=()=>({...structuredClone(f.evidence),id:id(6),org_id:org,prepared_by:actor,preparation_notes:preparation().notes,idempotency_key:preparation().idempotencyKey,status:'draft'})
test('same preparation request recovers original draft without reading changed source/labor, including withdrawn history',async()=>{
 actor=id(50);prior=saved();sourceFailure=true
 for(const status of ['draft','reviewed','withdrawn']){
  prior.status=status;calls=[];assert.equal(await api.preparePayrollImport(preparation()),id(6))
  assert.deepEqual(calls.map(row=>row[0]),['authorize','table','org_id','idempotency_key'])
 }
 sourceFailure=false;prior=null
})
test('lost commit response recovers scoped saved resource and never prepares it twice',async()=>{
 actor=id(50);prior=null;commitLost=true;calls=[]
 assert.equal(await api.preparePayrollImport(preparation()),id(6))
 assert.equal(calls.filter(row=>row[0]==='prepare_books_payroll_import').length,1)
 assert.equal(calls.filter(row=>row[0]==='table').length,2)
 commitLost=false;prior=null
})
test('different actor, notes, source/version, run or construction mapping cannot reuse an existing retry key',async()=>{
 actor=id(50)
 for(const mutate of [p=>p.prepared_by=id(51),p=>p.org_id=id(99),p=>p.preparation_notes='Different original preparation notes',p=>p.idempotency_key='DIFFERENT-KEY']){
  prior=saved();mutate(prior);calls=[];await assert.rejects(api.preparePayrollImport(preparation()),/different/)
  assert.ok(!calls.some(row=>row[0]==='verified-source'))
 }
 for(const mutate of [r=>r.runId=id(99),r=>r.fileId=id(99),r=>r.documentVersionId=id(99),r=>r.workers[0].allocations[0].gross_cents++,r=>r.mapping.amount_unit='cents']){
  prior=saved();const input=structuredClone(preparation());mutate(input.register);calls=[]
  await assert.rejects(api.preparePayrollImport(input),/different/);assert.ok(!calls.some(row=>row[0]==='verified-source'))
 }
 prior=saved();prior.reconciliation.costVarianceCents++;await assert.rejects(api.preparePayrollImport(preparation()),/digest/)
 prior=null
})
test('recovery lookup failure rejects before capture; failed fresh requests do not return an unrelated resource',async()=>{
 prior=null;lookupError={message:'Unavailable retry lookup'};calls=[]
 await assert.rejects(api.preparePayrollImport(preparation()),/retry lookup/);assert.ok(!calls.some(row=>row[0]==='verified-source'))
 lookupError=null;sourceFailure=true;calls=[];await assert.rejects(api.preparePayrollImport(preparation()),/Labor changed/)
 assert.equal(calls.filter(row=>row[0]==='table').length,2);assert.ok(!calls.some(row=>row[0]==='prepare_books_payroll_import'))
 sourceFailure=false
})

test('request canonicalization preserves mapping identity across order and UUID letter case without mutating input',()=>{
 const {canonicalPayrollRegisterRequest}=require('../lib/services/books/payroll-register-request'),{booksDigest}=require('../lib/services/books/hash')
 const input=structuredClone(register()),worker='abcdefab-0000-4000-8000-000000000002'
 input.workers[0].worker_id=worker.toUpperCase()
 const allocation=input.workers[0].allocations[0]
 allocation.labor_evidence_ids=['abcdefab-0000-4000-8000-000000000082','abcdefab-0000-4000-8000-000000000081']
 input.workers[0].allocations.push({...allocation,id:id(10),labor_evidence_ids:[]})
 input.workers[0].allocations.reverse()
 const before=structuredClone(input),first=canonicalPayrollRegisterRequest(input)
 assert.deepEqual(input,before);assert.equal(first.workers[0].worker_id,worker)
 const reordered=structuredClone(input);reordered.workers[0].worker_id=worker;reordered.workers[0].allocations.reverse();reordered.workers[0].allocations[0].labor_evidence_ids.reverse()
 assert.equal(booksDigest(canonicalPayrollRegisterRequest(reordered)),booksDigest(first))
 const duplicate=structuredClone(input);duplicate.workers.push({...duplicate.workers[0],worker_id:worker,employee_reference:'W-2'})
 assert.throws(()=>canonicalPayrollRegisterRequest(duplicate),/Duplicate payroll request worker/)
})
test('v2 review retains the original workflow witness and rejects later withholding before calling review SQL',async()=>{
 actor=id(50);stored=null;prior=null;calls=[]
 await api.preparePayrollImport(preparation())
 const evidence=structuredClone(calls.at(-1)[1].p_evidence)
 stored={...evidence,id:id(6),org_id:org,prepared_by:id(50)};actor=id(51);calls=[]
 assert.equal(await api.reviewPayrollImport({id:id(6),notes:'Independent review of construction and payment witness'}),id(6))
 assert.deepEqual(calls.at(-1)[1].p_evidence,evidence)
 snapshot.tables.journal_entries.push({id:id(70),org_id:org,source_type:'payroll_settlement',source_id:null,status:'posted',entry_date:'2026-09-18'})
 snapshot.tables.journal_lines.push({id:id(71),org_id:org,entry_id:id(70),account_id:id(30),project_id:null,debit_cents:100,credit_cents:0,dimensions:{}},
  {id:id(72),org_id:org,entry_id:id(70),account_id:id(31),project_id:null,debit_cents:0,credit_cents:100,dimensions:{}})
 try{
  calls=[];await assert.rejects(api.reviewPayrollImport({id:id(6),notes:'Independent review of construction and payment witness'}),/workflow evidence changed/)
  assert.ok(!calls.some(row=>row[0]==='review_books_payroll_import'))
 }finally{snapshot.tables.journal_entries=[];snapshot.tables.journal_lines=[];stored=null;actor=id(50)}
})

test('new preparation pins the exact preview evidence, rejects changes before SQL writes and retains original request retries',async()=>{
 const {booksDigest}=require('../lib/services/books/hash');actor=id(50);prior=null;sourceFailure=false;calls=[];
 const evidence=await api.currentPayrollImportEvidence(org,preparation().register);
 const expectedEvidenceDigest=booksDigest(evidence);
 calls=[];assert.equal(await api.preparePayrollImport({...preparation(),expectedEvidenceDigest}),id(6));
 assert.ok(calls.some(row=>row[0]==='prepare_books_payroll_import'));
 snapshot.payrollSourceRevision='c'.repeat(64);
 try{calls=[];await assert.rejects(api.preparePayrollImport({...preparation(),expectedEvidenceDigest}),/changed since preview/);assert.ok(!calls.some(row=>row[0]==='prepare_books_payroll_import'));
  prior={...evidence,id:id(6),org_id:org,prepared_by:actor,preparation_notes:preparation().notes,idempotency_key:preparation().idempotencyKey,status:'reviewed'};sourceFailure=true;calls=[];
  assert.equal(await api.preparePayrollImport({...preparation(),expectedEvidenceDigest}),id(6));assert.ok(!calls.some(row=>row[0]==='verified-source'));
 }finally{snapshot.payrollSourceRevision='b'.repeat(64);prior=null;sourceFailure=false;}
});
