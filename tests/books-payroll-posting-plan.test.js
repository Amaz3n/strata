require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {setup,journal,claim,build}=require('./helpers/books-payroll-payment-fixture')
const {scenario,refresh}=require('./helpers/books-payroll-workflow-fixture')
const {prepare,review}=require('./helpers/books-payroll-database')
const {id,org}=require('./helpers/books-payroll-register-fixture')
const {payrollPostingPlan}=require('../lib/services/books/payroll-posting-plan')
const {booksDigest}=require('../lib/services/books/hash')
const notes='Reviewed original recorded payroll and bank evidence'
async function records(f,p){
 await prepare(f.db,f.evidence);await review(f.db,f.evidence)
 if(p){await f.db.query('select prepare_books_payroll_payment_review($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7)',[org,id(50),JSON.stringify(p.request),JSON.stringify(p.evidence),p.evidenceDigest,notes,'posting-plan-payments-key']);await f.db.query('select review_books_payroll_payment_review($1,$2,$3,$4::jsonb,$5,$6)',[org,p.request.id,id(51),JSON.stringify(p.evidence),p.evidenceDigest,notes])}
 return JSON.parse(JSON.stringify({parent:(await f.db.query('select * from books_payroll_imports')).rows[0],payment:p?(await f.db.query('select * from books_payroll_payment_reviews')).rows[0]:null}))
}
async function verifiedPlan(f,r){
 const plan=payrollPostingPlan(r.parent,r.payment)
 const sql=(await f.db.query('select books_payroll_posting_plan_math($1::jsonb,$2::jsonb) plan',[JSON.stringify(r.parent),r.payment?JSON.stringify(r.payment):null])).rows[0].plan
 const {digest,...economic}=plan;assert.deepEqual(sql,economic)
 assert.equal((await f.db.query('select verify_books_payroll_posting_plan($1,$2,$3::jsonb) verified',[org,f.run.id,JSON.stringify(plan)])).rows[0].verified,true)
 return plan
}
function liabilityBalance(f,plan,code){
 const account=f.postingAccounts.find(row=>row.code===code).id
 const sources=f.evidence.reconciliation.workflowEvidence.sourceTables
 // Include native accrued journal, which the non-native liability witness excludes.
 const native=code==='2200'?f.labor.reduce((n,l)=>n+l.clearing_cents,0):0
 const original=sources.journal_lines.filter(line=>line.account_id===account).reduce((n,l)=>n+l.credit_cents-l.debit_cents,0)
 const adjustment=plan.journalDrafts.flatMap(draft=>draft.lines).filter(line=>line.accountCode===code).reduce((n,l)=>n+l.creditCents-l.debitCents,0)
 return native+original+adjustment
}
test('prior gross settlement does not duplicate withholding; native estimated burden is replaced and remaining obligations reconcile',async t=>{
 const f=await setup(t),r=await records(f,f.payment),plan=await verifiedPlan(f,r)
 assert.equal(plan.ledgerCostDeltaCents,-9000);assert.equal(plan.operationalCostDeltaCents,-9000)
 assert.equal(plan.outstanding.netPayCents,0);assert.equal(plan.outstanding.employeeTaxesCents,5000);assert.equal(plan.outstanding.employeeDeductionsCents,1000)
 assert.equal(liabilityBalance(f,plan,'2200'),0);assert.equal(liabilityBalance(f,plan,'2230'),9000)
 assert.equal(plan.allocations[0].components.find(row=>row.component==='employee_taxes').signedCents,0)
 assert.equal(plan.previewOnly,true);assert.equal(plan.postingImplemented,false);assert.equal(plan.requiresCommitRevalidation,true)
 assert.equal(plan.requiresBillingReview,true,'actual cost-plus write still requires explicit billing review')
 assert.equal(booksDigest(Object.fromEntries(Object.entries(plan).filter(([key])=>key!=='digest'))),plan.digest)
})
test('prior manual employer costs reduce GL adjustment while construction still receives actual burden correction',async t=>{
 const f=await setup(t)
 await journal(f,180,[[181,32,3000,0],[182,31,0,3000]],id(4),id(5));await refresh(f)
 f.request.decisions.push({journal_id:id(180),disposition:'allocated',explanation:notes,document_version_id:id(71),claims:[claim(183,'employer_taxes_recognition',182,181,2500),claim(184,'employer_benefits_recognition',182,181,500)]})
 const p=build(f),r=await records(f,p),plan=await verifiedPlan(f,r),a=plan.allocations[0]
 assert.equal(a.originalLedgerCostCents,39000);assert.equal(a.originalOperationalCostCents,36000)
 assert.equal(a.ledgerCostDeltaCents,-12000);assert.equal(a.operationalCostDeltaCents,-9000);assert.equal(a.ledgerOperationalBridgeCents,3000)
 assert.equal(a.originalLedgerCostCents+a.ledgerCostDeltaCents,27000);assert.equal(a.originalOperationalCostCents+a.operationalCostDeltaCents,27000)
 assert.equal(a.components.find(row=>row.component==='employer_taxes').signedCents,0)
 assert.equal(liabilityBalance(f,plan,'2200'),0);assert.equal(liabilityBalance(f,plan,'2230'),9000)
 const accrued=plan.journalDrafts.filter(draft=>draft.entryDate===f.run.accrual_date).flatMap(draft=>draft.lines)
 assert.equal(accrued.filter(line=>line.accountCode==='5030').reduce((sum,line)=>sum+line.debitCents-line.creditCents,0),-9000,'later original burden must not remove the actual accrual cost prematurely')
 const later=plan.journalDrafts.find(draft=>draft.entryDate==='2026-09-18')
 assert.equal(later.lines.filter(line=>line.accountCode==='5030').reduce((sum,line)=>sum+line.debitCents-line.creditCents,0),-3000)
 assert.equal(new Set(plan.journalDrafts.map(draft=>draft.postingKey)).size,plan.journalDrafts.length)
})
test('prior duplicate wage recognition is corrected without removing the required project cost correction',async t=>{
 const f=await setup(t)
 await journal(f,190,[[191,32,24000,0],[192,30,0,24000]],id(4),id(5));await refresh(f)
 f.request.decisions.push({journal_id:id(190),disposition:'allocated',explanation:notes,document_version_id:id(71),claims:[claim(193,'gross_wages_recognition',192,191,24000)]})
 const r=await records(f,build(f)),plan=await verifiedPlan(f,r),a=plan.allocations[0]
 assert.equal(a.originalLedgerCostCents,60000);assert.equal(a.ledgerCostDeltaCents,-33000);assert.equal(a.operationalCostDeltaCents,-9000)
 const reversal=plan.journalDrafts.flatMap(draft=>draft.lines).filter(line=>line.dimensions.payroll_component==='prior_gross_wages_recognition_offset')
 assert.equal(reversal.find(line=>line.accountCode==='5030').creditCents,24000)
 assert.equal(liabilityBalance(f,plan,'2200'),0);assert.equal(liabilityBalance(f,plan,'2230'),9000)
})
test('remittance and refund claims reduce only actual cash obligations, with no cash journal proposed',async t=>{
 const f=await setup(t)
 await journal(f,200,[[201,31,9000,0],[202,60,0,9000]])
 await journal(f,203,[[204,31,0,500],[205,60,500,0]])
 await refresh(f)
 f.request.decisions.push({journal_id:id(200),disposition:'allocated',explanation:notes,document_version_id:id(71),claims:[claim(206,'employee_taxes_payment',201,202,5000),claim(207,'employee_deductions_payment',201,202,1000),claim(208,'employer_taxes_payment',201,202,2500),claim(209,'employer_benefits_payment',201,202,500)]},
  {journal_id:id(203),disposition:'allocated',explanation:notes,document_version_id:id(71),claims:[claim(210,'employee_taxes_payment',204,205,-500)]})
 const r=await records(f,build(f)),plan=await verifiedPlan(f,r)
 assert.deepEqual(plan.outstanding,{netPayCents:0,employeeTaxesCents:500,employeeDeductionsCents:0,employerTaxesCents:0,employerBenefitsCents:0})
 assert.equal(liabilityBalance(f,plan,'2230'),500);assert.ok(!plan.journalDrafts.flatMap(draft=>draft.lines).some(line=>line.accountCode==='1000'))
})
test('partial old reclassification leaves only its unrecorded remainder in the new journal',async t=>{
 const f=await setup(t);f.request.decisions[0].claims=[claim(73,'net_pay_payment',62,63,9000),claim(74,'employee_taxes_reclassification',62,64,2000),claim(75,'employee_deductions_reclassification',62,64,500)]
 const r=await records(f,build(f)),plan=await verifiedPlan(f,r),a=plan.allocations[0]
 assert.equal(a.components.find(row=>row.component==='employee_taxes').signedCents,3000);assert.equal(a.components.find(row=>row.component==='employee_deductions').signedCents,500)
 assert.equal(a.outstanding.netPayCents,9000)
 assert.equal(a.liabilityBridge.wages.originalCents+a.liabilityBridge.wages.deltaCents,9000)
 // Unclaimed old settlement portions belong to another reviewed scope; the
 // run-owned bridge does not disguise them as this run's organization balance.
 assert.equal(liabilityBalance(f,plan,'2200'),-3500)
 assert.equal(plan.runOwnedBalancesOnly,true);assert.equal(plan.organizationBalancesProven,false)
 assert.equal(plan.retainedLiabilityLines.find(row=>row.lineId===id(62)).unclaimedCents,12500)
})
test('empty prior history needs no attribution and retains native/project cost plan without changing customer hourly rates',async t=>{
 const f=await scenario(t,true)
 await f.db.exec("update billable_costs set metadata=jsonb_set(metadata,'{billing_method}','\"time_and_materials_rate\"')");await refresh(f)
 const r=await records(f,null),plan=await verifiedPlan(f,r)
 assert.equal(plan.paymentReviewId,null);assert.equal(plan.ledgerCostDeltaCents,-9000);assert.equal(plan.outstanding.netPayCents,18000)
 assert.equal(plan.requiresBillingReview,false);assert.equal(plan.allocations[0].construction.billing.customerAmountDeltaCents,0)
 assert.equal(liabilityBalance(f,plan,'2200'),18000);assert.equal(liabilityBalance(f,plan,'2230'),9000)
})
test('draft/withdrawn/self-reviewed attribution and parent evidence, missing decisions and rehashed fabricated summaries cannot authorize a plan',async t=>{
 const f=await setup(t),r=await records(f,f.payment)
 assert.throws(()=>payrollPostingPlan(r.parent,null),/reviewed allocation/)
 for(const mutate of [x=>x.status='draft',x=>x.status='withdrawn',x=>x.reviewed_by=x.prepared_by,x=>x.payroll_import_id=id(99),x=>{x.evidence.allocation_components[0].signed_cents++;x.evidence_digest=booksDigest(x.evidence)}]){const row=structuredClone(r.payment);mutate(row);assert.throws(()=>payrollPostingPlan(r.parent,row))}
 for(const mutate of [x=>x.status='draft',x=>x.reviewed_by=x.prepared_by,x=>x.id=id(99),x=>x.reconciliation_digest='a'.repeat(64)]){const row=structuredClone(r.parent);mutate(row);assert.throws(()=>payrollPostingPlan(row,r.payment))}
})
test('later original cost in a different month is offset on its own date and cannot understate payroll accrual at month-end',async t=>{
 const f=await setup(t)
 await journal(f,220,[[221,32,3000,0],[222,31,0,3000]],id(4),id(5))
 await f.db.query('update journal_entries set entry_date=$1 where id=$2',['2026-10-07',id(220)]);await refresh(f)
 f.request.decisions.push({journal_id:id(220),disposition:'allocated',explanation:notes,document_version_id:id(71),claims:[claim(223,'employer_taxes_recognition',222,221,2500),claim(224,'employer_benefits_recognition',222,221,500)]})
 const r=await records(f,build(f)),plan=await verifiedPlan(f,r)
 const sources=f.evidence.reconciliation.workflowEvidence.sourceTables
 const costAt=date=>{
  const journals=new Set(sources.journal_entries.filter(row=>row.entry_date<=date).map(row=>row.id))
  return 36000+sources.journal_lines.filter(row=>row.account_id===id(32)&&journals.has(row.entry_id)).reduce((sum,row)=>sum+row.debit_cents-row.credit_cents,0)+plan.journalDrafts.filter(draft=>draft.entryDate<=date).flatMap(draft=>draft.lines).filter(row=>row.accountCode==='5030').reduce((sum,row)=>sum+row.debitCents-row.creditCents,0)
 }
 assert.equal(costAt('2026-09-30'),27000);assert.equal(costAt('2026-10-07'),27000)
 assert.ok(plan.journalDrafts.some(draft=>draft.entryDate==='2026-10-07'))
 assert.ok(plan.journalDrafts.every(draft=>draft.entryDate>=f.run.accrual_date))
})
test('SQL rejects balanced, freshly hashed journal/date/dimension/bridge/ownership fabrications and stale sources',async t=>{
 const f=await setup(t),r=await records(f,f.payment),plan=await verifiedPlan(f,r)
 for(const mutate of [
  p=>{p.journalDrafts[0].lines[0].debitCents++;p.journalDrafts[0].lines[1].creditCents++},
  p=>p.journalDrafts[0].entryDate='2026-09-14',p=>p.journalDrafts[0].postingKey='payroll_import:invented',
  p=>p.journalDrafts[0].lines[0].accountCode='1000',p=>p.journalDrafts[0].lines[0].projectId=id(99),
  p=>p.journalDrafts[0].lines[0].dimensions.cost_code_id=id(99),p=>p.journalDrafts[0].lines[0].dimensions.payroll_worker_id=id(52),
  p=>p.journalDrafts[0].lines[0].debitCents=String(p.journalDrafts[0].lines[0].debitCents),
  p=>p.allocations[0].ledgerOperationalBridgeCents++,p=>p.allocations[0].liabilityBridge.wages.remainingCents++,
  p=>p.outstanding.netPayCents++,p=>p.paymentReviewId=null,p=>p.sourceRevision='a'.repeat(64),
  p=>p.retainedLiabilityLines[0].unclaimedCents++,p=>p.requiresCommitRevalidation=false,p=>p.postingImplemented=true,
 ]){
  const forged=structuredClone(plan);mutate(forged);delete forged.digest;forged.digest=booksDigest(forged)
  await assert.rejects(f.db.query('select verify_books_payroll_posting_plan($1,$2,$3::jsonb)',[org,f.run.id,JSON.stringify(forged)]),/independently reconstructed/)
 }
 await assert.rejects(f.db.query('select verify_books_payroll_posting_plan($1,$2,$3::jsonb)',[id(99),f.run.id,JSON.stringify(plan)]),/unavailable in organization/)
 const flags=(await f.db.query("select has_function_privilege('authenticated','verify_books_payroll_posting_plan(uuid,uuid,jsonb)','execute') browser,has_function_privilege('anon','books_payroll_posting_plan_math(jsonb,jsonb)','execute') anon,has_function_privilege('service_role','verify_books_payroll_posting_plan(uuid,uuid,jsonb)','execute') service")).rows[0]
 assert.deepEqual(flags,{browser:false,anon:false,service:true})
 await f.db.query('update journal_lines set dimensions=$1::jsonb where id=$2',[JSON.stringify({payment_reference:'Changed original evidence'}),id(63)])
 await assert.rejects(f.db.query('select verify_books_payroll_posting_plan($1,$2,$3::jsonb)',[org,f.run.id,JSON.stringify(plan)]),/source revision changed/)
})
test('SQL verifies new project payroll math without inventing budget/GMP or billing approval',async t=>{
 const f=await scenario(t),r=await records(f,null),plan=await verifiedPlan(f,r)
 assert.equal(plan.ledgerCostDeltaCents,27000);assert.equal(plan.operationalCostDeltaCents,27000)
 assert.equal(plan.requiresAllocationReview,true);assert.equal(plan.requiresBillingReview,true)
 assert.ok(plan.allocations[0].construction.blockers.includes('new_project_cost_requires_budget_and_gmp_allocation'))
 assert.equal(plan.journalDrafts.length,1);assert.equal(plan.journalDrafts[0].entryDate,f.run.accrual_date)
 assert.equal(plan.postingImplemented,false)
})
