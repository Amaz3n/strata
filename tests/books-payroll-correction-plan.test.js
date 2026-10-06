require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {ready,post}=require('./helpers/books-payroll-atomic-fixture'),{capture}=require('./helpers/books-payroll-workflow-fixture'),{id,org}=require('./helpers/books-payroll-register-fixture')
const {payrollCorrectionPlan}=require('../lib/services/books/payroll-correction-plan'),{booksDigest}=require('../lib/services/books/hash')
async function fixture(t,options={}){
 const f=await ready(t,options);await post(f);const tables=(await capture(f.db)).tables
 const run=structuredClone(tables.books_payroll_imports[0].run);run.id=id(700);run.source_checksum='c'.repeat(64)
 return {...f,tables,run,request:{id:run.id,postingId:id(260),accountingDate:options.laterOriginal?'2026-10-03':'2026-09-20',reason:'Corrected full provider register and construction allocation'}}
}
function amounts(run,values){
 Object.assign(run.employees[0],values)
 const worker=run.employees[0],allocation=worker.allocations[0]
 for(const key of ['gross_cents','employer_taxes_cents','employer_benefits_cents'])allocation[key]=worker[key]
 for(const key of Object.keys(run.controls))if(key!=='funding_cents')run.controls[key]=run.employees.reduce((total,row)=>total+row[key],0)
 run.controls.funding_cents=run.controls.gross_cents+run.controls.employer_taxes_cents+run.controls.employer_benefits_cents
}
const plan=f=>payrollCorrectionPlan({request:f.request,correctedRun:f.run,tables:f.tables})
test('corrected full register adjusts only posted provider delta, preserves original time and billing and binds exact identity',async t=>{
 const f=await fixture(t),before=structuredClone(f.tables)
 amounts(f.run,{gross_cents:26000,net_cents:19500,employee_taxes_cents:5500,employee_deductions_cents:1000,employer_taxes_cents:2600,employer_benefits_cents:600})
 const p=plan(f);assert.equal(p.costDeltaCents,2200);assert.equal(p.projectCostDeltaCents,2200);assert.equal(p.overheadCostDeltaCents,0)
 assert.equal(p.liabilityDelta.netPayCents,1500);assert.equal(p.liabilityDelta.employeeTaxesCents,500)
 assert.equal(p.remainingBeforeAdditionalAttribution.netPayCents,19500)
 assert.deepEqual(p.projectCosts.map(row=>[row.component,row.costCents]).sort(),[['employer_benefits',100],['employer_taxes',100],['gross_variance',2000]])
 assert.ok(p.projectCosts.every(row=>row.budgetLineId===id(84)&&row.gmpClassification==='outside_gmp'&&row.blockers.length===0))
 assert.deepEqual(p.preservedBillableCostIds,[id(86)]);assert.equal(p.cashDeltaCents,0);assert.equal(p.customerAmountDeltaCents,0);assert.equal(p.nativeLaborReconciledAgain,false)
 assert.equal(p.postingImplemented,false);assert.equal(p.previewOnly,true);assert.ok(p.blockers.includes('review_provider_tax_correction_evidence'))
 assert.deepEqual(f.tables,before);assert.deepEqual((await capture(f.db)).tables,before)
 assert.deepEqual(p.correctedRun.employees[0].allocations[0].labor_evidence_ids,f.run.employees[0].allocations[0].labor_evidence_ids)
 const {digest,...body}=p;assert.equal(digest,booksDigest(body));assert.equal(plan(f).digest,digest)
})
test('already paid original register receives no second cash payment and correction cannot precede later original recognition',async t=>{
 const f=await fixture(t,{paid:true,laterOriginal:true});amounts(f.run,{gross_cents:26000,net_cents:20000})
 const p=plan(f);assert.equal(p.remainingBeforeAdditionalAttribution.netPayCents,2000);assert.equal(p.cashDeltaCents,0);assert.equal(p.costDeltaCents,2000)
 assert.equal(p.journalDraft.entryDate,'2026-10-03');assert.ok(!p.journalDraft.lines.some(line=>line.accountCode==='1000'))
 f.request.accountingDate='2026-09-30';assert.throws(()=>plan(f),/cannot precede/)
})
test('lower corrected wages retain signed credits and expose employee overpayment without inventing a refund',async t=>{
 const f=await fixture(t,{paid:true});amounts(f.run,{gross_cents:12000,net_cents:6000})
 const p=plan(f);assert.equal(p.costDeltaCents,-12000);assert.equal(p.liabilityDelta.netPayCents,-12000);assert.equal(p.remainingBeforeAdditionalAttribution.netPayCents,-12000)
 assert.ok(p.blockers.includes('review_employee_or_provider_overpayment_recovery'));assert.equal(p.cashDeltaCents,0)
 assert.equal(p.projectCosts[0].costCents,-12000);assert.ok(p.journalDraft.lines.some(line=>line.accountCode==='5030'&&line.creditCents===12000))
})
test('project reallocation keeps separate negative old and positive new cost legs even when total cost and wages do not change',async t=>{
 const f=await fixture(t);f.tables.projects.push({id:id(400),org_id:org});f.tables.cost_codes.push({id:id(401),org_id:org})
 Object.assign(f.run.employees[0].allocations[0],{project_id:id(400),cost_code_id:id(401)})
 const p=plan(f);assert.equal(p.costDeltaCents,0);assert.equal(p.projectCostDeltaCents,0);assert.equal(p.liabilityDelta.netPayCents,0)
 assert.equal(p.projectCosts.filter(row=>row.projectId===id(4)).reduce((sum,row)=>sum+row.costCents,0),-27000)
 assert.equal(p.projectCosts.filter(row=>row.projectId===id(400)).reduce((sum,row)=>sum+row.costCents,0),27000)
 assert.ok(p.projectCosts.filter(row=>row.projectId===id(400)).every(row=>row.blockers.includes('review_new_or_reallocated_budget_and_gmp')))
 assert.equal(p.requiresConstructionReview,true);assert.deepEqual(p.preservedBillableCostIds,[id(86)])
})
test('a removed worker cannot hide overpayment behind wages added for another worker',async t=>{
 const f=await fixture(t,{paid:true}),worker=structuredClone(f.run.employees[0]);worker.worker_id=id(450);worker.employee_reference='W-2';worker.allocations[0].id=id(451);worker.allocations[0].labor_evidence_ids=[]
 f.run.employees=[worker]
 const p=plan(f);assert.equal(p.liabilityDelta.netPayCents,0);assert.equal(p.remainingBeforeAdditionalAttribution.netPayCents,0)
 assert.equal(p.workers.find(row=>row.workerId===id(2)).remainingBeforeAdditionalAttribution.netPayCents,-18000)
 assert.equal(p.workers.find(row=>row.workerId===id(450)).remainingBeforeAdditionalAttribution.netPayCents,18000)
 assert.ok(p.blockers.includes('review_employee_or_provider_overpayment_recovery'))
})
test('additional liability movements remain unassigned evidence rather than silently reducing the corrected amount',async t=>{
 const f=await fixture(t);amounts(f.run,{gross_cents:26000,net_cents:20000})
 f.tables.journal_entries.push({id:id(500),org_id:org,source_type:'payroll_settlement',source_id:id(501),status:'posted',entry_date:'2026-09-19'})
 f.tables.journal_lines.push({id:id(502),org_id:org,entry_id:id(500),account_id:id(30),project_id:null,debit_cents:100,credit_cents:0,dimensions:{}},{id:id(503),org_id:org,entry_id:id(500),account_id:id(32),project_id:null,debit_cents:0,credit_cents:100,dimensions:{}})
 const p=plan(f);assert.equal(p.additionalLiabilityMovements.length,1);assert.ok(p.blockers.includes('review_additional_liability_attribution'));assert.equal(p.remainingBeforeAdditionalAttribution.netPayCents,20000)
})
test('unchanged money is an explicit no-op and closed or missing correction calendar remains a blocker',async t=>{
 const f=await fixture(t);let p=plan(f);assert.equal(p.journalDraft,null);assert.equal(p.projectCosts.length,0);assert.ok(p.blockers.includes('no_accounting_change'))
 amounts(f.run,{gross_cents:26000,net_cents:20000})
 f.tables.accounting_periods[0].status='closed';p=plan(f);assert.ok(p.blockers.includes('correction_date_requires_one_open_period'))
 f.tables.accounting_periods=[];assert.ok(plan(f).blockers.includes('correction_date_requires_one_open_period'))
})
test('correction proves original posting/native sources and rejects different run, scope, dates, reused native labor or tampered money',async t=>{
 const f=await fixture(t)
 for(const mutate of [x=>x.run.provider_run_id='OTHER',x=>x.run.org_id=id(999),x=>x.run.accrual_date='2026-09-14',x=>x.run.controls.gross_cents++,x=>x.run.employees[0].allocations[0].project_id=id(999),x=>x.run.employees[0].allocations[0].labor_evidence_ids.push(id(80)),x=>x.tables.time_entries[0].hours=9,x=>x.tables.books_payroll_postings[0].result.journals=[],x=>x.run.id=id(6)]){
  const bad=structuredClone({run:f.run,request:f.request,tables:f.tables});mutate(bad);assert.throws(()=>plan(bad))
 }
})
test('changed current budget scope or customer billing policy cannot inherit the original approval',async t=>{
 const f=await fixture(t);amounts(f.run,{gross_cents:26000,net_cents:20000})
 const original=plan(f),budget=structuredClone(f.tables.budgets)
 f.tables.budgets[0].project_id=id(999)
 let p=plan(f);assert.ok(p.projectCosts.every(row=>row.blockers.includes('review_changed_budget_scope')));assert.notEqual(p.digest,original.digest)
 f.tables.budgets=budget;f.tables.billable_costs[0].metadata.billing_method='cost_plus_markup'
 p=plan(f);assert.ok(p.projectCosts.every(row=>row.blockers.includes('review_changed_customer_billing_basis')));assert.equal(p.customerAmountDeltaCents,0)
})
test('project-to-overhead reallocation preserves original project credit and produces separate overhead debit',async t=>{
 const f=await fixture(t);Object.assign(f.run.employees[0].allocations[0],{project_id:null,cost_code_id:null,labor_evidence_ids:[]})
 const p=plan(f);assert.equal(p.costDeltaCents,0);assert.equal(p.projectCostDeltaCents,-27000);assert.equal(p.overheadCostDeltaCents,27000)
 assert.ok(p.journalDraft.lines.some(line=>line.accountCode==='5030'&&!line.projectId&&line.debitCents===24000));assert.equal(p.cashDeltaCents,0)
})
