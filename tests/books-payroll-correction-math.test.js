const { migrationSql } = require("./support/migration-sql")
require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {sourceFixture,prepareSource,reviewSource}=require('./helpers/books-payroll-correction-source-fixture'),{capture}=require('./helpers/books-payroll-workflow-fixture'),{id,org,fixture}=require('./helpers/books-payroll-register-fixture')
const {payrollCorrectionPlan}=require('../lib/services/books/payroll-correction-plan'),{reconcilePayrollImport}=require('../lib/services/books/payroll-import-rules')
const migration=migrationSql("20261004021236_books_payroll_correction_math")
async function ready(t){const f=await sourceFixture(t);await f.db.exec(migration);return f}
const delta=(f,before,accounts,after,nextAccounts,request=f.evidence.request)=>f.db.query('select books_payroll_provider_delta($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb) result',[before,accounts,after,nextAccounts,request].map(JSON.stringify)).then(result=>result.rows[0].result)
test('independent SQL reviewed-source delta matches actual posting preview and writes no accounting money',async t=>{
 const f=await ready(t),before=(await capture(f.db)).tables
 await assert.rejects(f.db.query('select reviewed_books_payroll_correction_delta($1,$2)',[org,id(700)]),/reviewed source/)
 await prepareSource(f);await assert.rejects(f.db.query('select reviewed_books_payroll_correction_delta($1,$2)',[org,id(700)]),/reviewed source/)
 await reviewSource(f)
 const actual=(await f.db.query('select reviewed_books_payroll_correction_delta($1,$2) result',[org,id(700)])).rows[0].result
 const plan=payrollCorrectionPlan({request:f.evidence.request,correctedRun:f.evidence.run,tables:(await capture(f.db)).tables})
 for(const key of Object.keys(actual))assert.deepEqual(actual[key],plan[key],key)
 assert.equal(actual.costDeltaCents,2000);assert.equal(actual.nativeLaborReconciledAgain,false)
 const after=(await capture(f.db)).tables
 for(const name of ['accounting_facts','journal_entries','journal_lines','job_cost_entries','books_payroll_postings','books_payroll_labor_ownership','time_entries','billable_costs'])assert.deepEqual(after[name],before[name])
 const acl=(await f.db.query("select has_function_privilege('authenticated','reviewed_books_payroll_correction_delta(uuid,uuid)','execute') exposed,prosecdef definer from pg_proc where proname='reviewed_books_payroll_correction_delta'")).rows[0];assert.deepEqual(acl,{exposed:false,definer:false})
 await f.db.query('select withdraw_books_payroll_correction_source($1,$2,$3,$4)',[org,id(700),id(50),'Withdraw original correction documentary evidence'])
 await assert.rejects(f.db.query('select reviewed_books_payroll_correction_delta($1,$2)',[org,id(700)]),/reviewed source/)
})
test('SQL largest remainders conserve every cent near safe limits with stable ties and zero capacity',async t=>{
 const f=await ready(t)
 const shares=(amount,capacities)=>f.db.query('select books_payroll_apportion_cents($1::jsonb,$2::jsonb) result',[JSON.stringify(amount),JSON.stringify(capacities)]).then(r=>r.rows[0].result)
 assert.deepEqual(await shares(2,[{id:id(12),cents:1},{id:id(10),cents:1},{id:id(11),cents:1}]),{[id(10)]:1,[id(11)]:1,[id(12)]:0})
 assert.deepEqual(await shares(0,[{id:id(10),cents:0}]),{[id(10)]:0})
 const max=Number.MAX_SAFE_INTEGER
 assert.deepEqual(await shares(max-1,[{id:id(10),cents:max-1},{id:id(11),cents:1}]),{[id(10)]:max-2,[id(11)]:1})
 for(const [amount,rows] of [[1,[{id:id(10),cents:0}]],[1,[{id:id(10),cents:1},{id:id(10),cents:1}]],[0,[{id:id(10),cents:max},{id:id(11),cents:1}]],[0,[{id:id(10),cents:-1}]],[0,[]]])await assert.rejects(shares(amount,rows))
})
test('SQL allocation/worker/account reallocation preserves zero-total legs, overhead and inventory scope',async t=>{
 const f=await ready(t),base=fixture(),before=base.run,after=structuredClone(before);after.id=id(700)
 after.employees[0].allocations[0].project_id=null;after.employees[0].allocations[0].cost_code_id=null
 let result=await delta(f,before,base.postingAccounts,after,base.postingAccounts)
 assert.equal(result.costDeltaCents,0);assert.equal(result.projectCostDeltaCents,-27000);assert.equal(result.overheadCostDeltaCents,27000)
 assert.ok(result.journalDraft.lines.some(row=>row.projectId===id(4)));assert.ok(result.journalDraft.lines.some(row=>!row.projectId))
 assert.equal(result.journalDraft.lines.reduce((sum,row)=>sum+row.debitCents-row.creditCents,0),0)
 after.employees[0].worker_id=id(450);result=await delta(f,before,base.postingAccounts,after,base.postingAccounts)
 assert.deepEqual(new Set(result.journalDraft.lines.map(row=>row.dimensions.payroll_worker_id)),new Set([id(2),id(450)]))
 const inventory={id:id(460),org_id:org,code:'1250',account_type:'asset',subtype:'work_in_progress',active:true};after.employees[0].allocations[0].cost_account_code='1250'
 await assert.rejects(delta(f,before,base.postingAccounts,after,[...base.postingAccounts,inventory]),/inventory account/)
 after.employees[0].allocations[0].project_id=id(4);result=await delta(f,before,base.postingAccounts,after,[...base.postingAccounts,inventory]);assert.ok(result.journalDraft.lines.some(row=>row.accountCode==='1250'))
 const noOp=await delta(f,before,base.postingAccounts,{...before,id:id(700)},base.postingAccounts);assert.equal(noOp.journalDraft,null);assert.equal(noOp.costDeltaCents,0)
})
test('SQL provider components agree with independent JS for multi-worker split withholding and reject invented controls',async t=>{
 const f=await ready(t),base=fixture()
 for(let n=1;n<=24;n++){
  const run=structuredClone(base.run),w=run.employees[0];Object.assign(w,{gross_cents:3*n+1,employee_taxes_cents:n+1,employee_deductions_cents:n,net_cents:n,employer_taxes_cents:n,employer_benefits_cents:1})
  w.allocations=[1,2,3].map((v,i)=>({...w.allocations[0],id:id(500+i),gross_cents:i===2?n+1:n,employer_taxes_cents:i===0?n:0,employer_benefits_cents:i===1?1:0}))
  const worker=structuredClone(w);worker.worker_id=id(550);worker.employee_reference='W-2';worker.allocations.forEach((a,i)=>a.id=id(560+i));run.employees.push(worker)
  for(const key of Object.keys(run.controls))if(key!=='funding_cents')run.controls[key]=run.employees.reduce((sum,w)=>sum+w[key],0)
  run.controls.funding_cents=run.controls.gross_cents+run.controls.employer_taxes_cents+run.controls.employer_benefits_cents
  const components=(await f.db.query('select books_payroll_provider_components($1::jsonb,$2::jsonb) result',[JSON.stringify(run),JSON.stringify(base.postingAccounts)])).rows[0].result
  const js=reconcilePayrollImport(run,[],base.postingAccounts).draft.lines.map(line=>({key:[line.dimensions.payroll_worker_id,line.dimensions.payroll_allocation_id,line.projectId??null,line.dimensions.cost_code_id??null,base.postingAccounts.find(a=>a.code===line.accountCode).id,line.dimensions.payroll_component],accountCode:line.accountCode,amountCents:line.debitCents-line.creditCents}))
  const sorted=rows=>rows.sort((a,b)=>JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)))
  assert.deepEqual(sorted(components),sorted(js),`split ${n}`)
 }
 for(const mutate of [r=>r.controls.net_cents++,r=>r.employees[0].allocations[0].gross_cents++,r=>r.employees.push(structuredClone(r.employees[0])),r=>r.employees[0].net_cents++,r=>r.controls.funding_cents++,r=>r.employees[0].gross_cents=-1]){
  const run=structuredClone(base.run);mutate(run);await assert.rejects(f.db.query('select books_payroll_provider_components($1::jsonb,$2::jsonb)',[JSON.stringify(run),JSON.stringify(base.postingAccounts)]))
 }
 const foreign=structuredClone(base.postingAccounts);foreign[0].org_id=id(999)
 await assert.rejects(delta(f,base.run,foreign,{...base.run,id:id(700)},base.postingAccounts),/scope differs/)
})
test('SQL decreases, withholding-only corrections and split reallocation match exact reviewed-root draft order',async t=>{
 const f=await ready(t),tables=(await capture(f.db)).tables,parent=tables.books_payroll_imports[0]
 for(const values of [
  {gross_cents:20000,net_cents:14000},
  {gross_cents:24000,net_cents:17000,employee_taxes_cents:6000},
  {gross_cents:24000,net_cents:17500,employee_deductions_cents:1500,employer_taxes_cents:2400,employer_benefits_cents:700},
 ]){
  const run=structuredClone(parent.run);run.id=id(700);Object.assign(run.employees[0],values)
  const w=run.employees[0];for(const key of ['gross_cents','employer_taxes_cents','employer_benefits_cents'])w.allocations[0][key]=w[key]
  for(const key of Object.keys(run.controls))if(key!=='funding_cents')run.controls[key]=w[key]
  run.controls.funding_cents=w.gross_cents+w.employer_taxes_cents+w.employer_benefits_cents
  const compare=async()=>{
   const plan=payrollCorrectionPlan({request:f.evidence.request,correctedRun:run,tables}),actual=await delta(f,parent.run,parent.reconciliation.postingAccounts,run,tables.gl_accounts)
   for(const key of Object.keys(actual))assert.deepEqual(actual[key],plan[key],key)
  }
  await compare()
  const a=w.allocations[0],newAllocation={...a,id:id(710),gross_cents:Math.floor(a.gross_cents/3),employer_taxes_cents:Math.floor(a.employer_taxes_cents/3),employer_benefits_cents:Math.floor(a.employer_benefits_cents/3),labor_evidence_ids:[]}
  for(const key of ['gross_cents','employer_taxes_cents','employer_benefits_cents'])a[key]-=newAllocation[key]
  w.allocations.push(newAllocation);await compare()
 }
})
