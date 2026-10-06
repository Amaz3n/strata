require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {reconcilePayrollImport}=require('../lib/services/books/payroll-import-rules')
const id=n=>'99800000-0000-4000-8000-'+String(n).padStart(12,'0'),org=id(1)
const accounts=[['2200','liability','payroll_clearing'],['2230','liability','other_liability'],['5030','cogs','direct_labor'],['6070','expense','payroll'],['1160','asset','work_in_progress']].map(([code,account_type,subtype])=>({org_id:org,code,account_type,subtype,active:true}))
function fixture(){
 const allocation=(n,gross,employerTax,benefits,project=id(10))=>({id:id(n),project_id:project,cost_code_id:id(11),cost_account_code:'5030',gross_cents:gross,employer_taxes_cents:employerTax,employer_benefits_cents:benefits,labor_evidence_ids:[id(n+100)]})
 const run={id:id(2),org_id:org,provider:'Provider register',provider_run_id:'RUN-100',period_start:'2026-09-01',period_end:'2026-09-15',accrual_date:'2026-09-15',pay_date:'2026-09-18',source_checksum:'a'.repeat(64),employees:[{worker_id:id(3),employee_reference:'W-3',gross_cents:110000,net_cents:80000,employee_taxes_cents:25000,employee_deductions_cents:5000,employer_taxes_cents:10000,employer_benefits_cents:5000,allocations:[allocation(20,70000,6000,3000),allocation(21,40000,4000,2000,id(12))]}],controls:{gross_cents:110000,net_cents:80000,employee_taxes_cents:25000,employee_deductions_cents:5000,employer_taxes_cents:10000,employer_benefits_cents:5000,funding_cents:125000}}
 const labor=run.employees[0].allocations.map((a,index)=>({id:a.labor_evidence_ids[0],org_id:org,worker_id:id(3),project_id:a.project_id,cost_code_id:a.cost_code_id,account_code:a.cost_account_code,incurred_on:'2026-09-10',fact_id:id(200+index),journal_id:id(300+index),source_revision:'2026-09-10T12:00:00.000001Z',gross_cents:index===0?65000:35000,estimated_burden_cents:0,cost_cents:index===0?65000:35000,clearing_cents:index===0?65000:35000}))
 return {run,labor}
}
const net=(lines,code)=>lines.filter(row=>row.accountCode===code).reduce((n,row)=>n+row.debitCents-row.creditCents,0)
test('actual provider burden replaces estimated time-entry burden instead of being added twice',()=>{
 const {run,labor}=fixture()
 for(const row of labor){row.estimated_burden_cents=5000;row.cost_cents=row.gross_cents+5000;row.clearing_cents=row.cost_cents}
 const result=reconcilePayrollImport(run,labor,accounts)
 assert.equal(result.estimatedBurdenCents,10000)
 assert.equal(net(result.draft.lines,'5030'),15000,'110000 estimated native cost plus 15000 change equals 125000 actual gross/burden')
 assert.equal(net(result.draft.lines,'2200'),30000,'110000 old clearing less 30000 leaves 80000 net pay')
 assert.equal(net(result.draft.lines,'2230'),-45000)
 labor[0].cost_cents++;assert.throws(()=>reconcilePayrollImport(run,labor,accounts),/clearing differs/)
})
test('payroll adds only wage variance and employer burden, reclassifies deductions and ties provider funding exactly',()=>{
 const {run,labor}=fixture(),result=reconcilePayrollImport(run,labor,accounts)
 assert.equal(result.recognizedGrossCents,100000);assert.equal(result.wageVarianceCents,10000);assert.equal(result.requiresVarianceReview,true)
 assert.equal(net(result.draft.lines,'5030'),25000,'original 100000 wages must not post twice')
 assert.equal(net(result.draft.lines,'2200'),20000,'100000 original clearing less debit 20000 leaves 80000 net pay')
 assert.equal(net(result.draft.lines,'2230'),-45000);assert.equal(result.fundingCents,125000)
 for(const project of [id(10),id(12)]){const rows=result.draft.lines.filter(row=>row.projectId===project);assert.equal(rows.reduce((n,row)=>n+row.debitCents-row.creditCents,0),0);assert.ok(rows.every(row=>row.dimensions.cost_code_id===id(11)))}
})
test('provider control, employee arithmetic and construction allocations independently reject mismatches',()=>{
 for(const mutate of [r=>r.controls.net_cents++,r=>r.controls.funding_cents++,r=>r.employees[0].net_cents++,r=>r.employees[0].allocations[0].gross_cents++,r=>r.employees[0].allocations[0].employer_taxes_cents++,r=>r.employees[0].allocations[0].employer_benefits_cents++]){
  const {run,labor}=fixture();mutate(run);assert.throws(()=>reconcilePayrollImport(run,labor,accounts),/differs|reconcile|differ/)
 }
})
test('posted labor must be complete, uniquely owned and tied to the original employee, job, period, account and clearing',()=>{
 for(const patch of [{org_id:id(99)},{worker_id:id(99)},{project_id:id(99)},{cost_code_id:null},{account_code:'6070'},{incurred_on:'2026-08-31'},{clearing_cents:1}]){
  const {run,labor}=fixture();Object.assign(labor[0],patch);assert.throws(()=>reconcilePayrollImport(run,labor,accounts),/evidence.*differs/)
 }
 for(const mutate of [l=>l.push({...l[0]}),l=>l.pop(),l=>l.push({...l[0],id:id(99),fact_id:id(98),journal_id:id(97)}),l=>l[1].fact_id=l[0].fact_id,l=>l[1].journal_id=l[0].journal_id]){
  const {run,labor}=fixture();mutate(labor);assert.throws(()=>reconcilePayrollImport(run,labor,accounts),/Duplicate|missing|unassigned/)
 }
 const {run,labor}=fixture();run.employees[0].allocations[1].labor_evidence_ids.push(labor[0].id);assert.throws(()=>reconcilePayrollImport(run,labor,accounts),/reused/)
})
test('one-cent tax/deduction splits never overdraw a project and preserve total liabilities',()=>{
 const {run,labor}=fixture(),employee=run.employees[0]
 Object.assign(employee,{gross_cents:2,net_cents:0,employee_taxes_cents:1,employee_deductions_cents:1,employer_taxes_cents:0,employer_benefits_cents:0})
 for(const row of employee.allocations)Object.assign(row,{gross_cents:1,employer_taxes_cents:0,employer_benefits_cents:0})
 for(const row of labor)Object.assign(row,{gross_cents:1,estimated_burden_cents:0,cost_cents:1,clearing_cents:1})
 run.controls={gross_cents:2,net_cents:0,employee_taxes_cents:1,employee_deductions_cents:1,employer_taxes_cents:0,employer_benefits_cents:0,funding_cents:2}
 const result=reconcilePayrollImport(run,labor,accounts);assert.equal(result.requiresVarianceReview,false)
 for(const project of [id(10),id(12)])assert.equal(net(result.draft.lines.filter(row=>row.projectId===project),'2200'),1)
})
test('signed wage corrections reverse original cost classification and deterministic evidence ignores row order',()=>{
 const {run,labor}=fixture();labor[0].gross_cents=75000;labor[0].cost_cents=75000;labor[0].clearing_cents=75000
 const first=reconcilePayrollImport(run,labor,accounts);assert.equal(first.variances.find(row=>row.allocationId===id(20)).varianceCents,-5000)
 assert.ok(first.draft.lines.some(row=>row.accountCode==='5030'&&row.creditCents===5000))
 run.employees[0].allocations.reverse();labor.reverse();const second=reconcilePayrollImport(run,labor,accounts)
 assert.deepEqual(second,first)
 const foreign=accounts.map(row=>({...row,org_id:id(99)}));assert.throws(()=>reconcilePayrollImport(run,labor,foreign),/account.*missing/)
})
test('exact already-accrued payroll without new deductions or burden produces no duplicate journal',()=>{
 const {run,labor}=fixture(),employee=run.employees[0]
 for(const [i,a] of employee.allocations.entries())Object.assign(a,{gross_cents:labor[i].gross_cents,employer_taxes_cents:0,employer_benefits_cents:0})
 Object.assign(employee,{gross_cents:100000,net_cents:100000,employee_taxes_cents:0,employee_deductions_cents:0,employer_taxes_cents:0,employer_benefits_cents:0})
 run.controls={gross_cents:100000,net_cents:100000,employee_taxes_cents:0,employee_deductions_cents:0,employer_taxes_cents:0,employer_benefits_cents:0,funding_cents:100000}
 const result=reconcilePayrollImport(run,labor,accounts);assert.equal(result.draft,null);assert.equal(result.requiresVarianceReview,false)
})
test('real journal RPC posts native burdened labor and reconciled provider adjustment, with exact ledger liabilities and close protection',async t=>{
 const {createBooksLedgerDb}=require('./helpers/books-ledger-db'),{postLaborCost}=require('../lib/services/books/posting-rules')
 const db=await createBooksLedgerDb();t.after(()=>db.close())
 const {run,labor}=fixture(),period=id(400)
 await db.query('insert into orgs values($1)',[org])
 for(const project of [id(10),id(12)])await db.query('insert into projects(id,org_id) values($1,$2)',[project,org])
 await db.query("insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period) values($1,$2,'2026-09-01','2026-09-30',2026,9)",[period,org])
 const accountIds=new Map()
 for(const [index,row] of accounts.entries()){
  const accountId=id(500+index);accountIds.set(row.code,accountId)
  await db.query('insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values($1,$2,$3,$3,$4,$5,$6)',[accountId,org,row.code,row.account_type,row.subtype,row.account_type==='liability'?'credit':'debit'])
 }
 async function post(draft,key=draft.postingKey){
  const entry={entry_date:draft.entryDate,entry_kind:draft.entryKind,memo:draft.memo,posting_key:key,projection_version:draft.projectionVersion,policy_version:draft.policyVersion,source_type:draft.sourceType,source_id:draft.sourceId}
  const lines=draft.lines.map((row,i)=>({line_no:i+1,account_id:accountIds.get(row.accountCode),project_id:row.projectId??null,debit_cents:row.debitCents,credit_cents:row.creditCents,dimensions:row.dimensions??{}}))
  return db.query('select post_books_journal_entry($1,$2::jsonb,$3::jsonb) id',[org,JSON.stringify(entry),JSON.stringify(lines)])
 }
 for(const row of labor){
  row.estimated_burden_cents=5000;row.cost_cents=row.gross_cents+5000;row.clearing_cents=row.cost_cents
  await post(postLaborCost({id:row.id,date:row.incurred_on,memo:'Native burdened field labor',amountCents:row.cost_cents,projectId:row.project_id,projectionVersion:1,policyVersion:1}))
 }
 const reconciled=reconcilePayrollImport(run,labor,accounts);await post(reconciled.draft)
 const balances=Object.fromEntries((await db.query("select a.code,sum(l.debit_cents-l.credit_cents)::bigint balance from journal_lines l join gl_accounts a on a.id=l.account_id join journal_entries e on e.id=l.entry_id where e.status='posted' group by a.code")).rows.map(row=>[row.code,Number(row.balance)]))
 assert.deepEqual(balances,{'5030':125000,'2200':-80000,'2230':-45000})
 const projectBalances=(await db.query('select project_id,sum(debit_cents-credit_cents)::bigint balance from journal_lines group by project_id')).rows
 assert.ok(projectBalances.every(row=>Number(row.balance)===0))
 await db.query('select begin_books_period_close($1,$2)',[org,period])
 await assert.rejects(post(reconciled.draft,'closed-payroll-attempt'),/closed|closing|reviewing/i)
 assert.equal(Number((await db.query('select count(*) count from journal_entries')).rows[0].count),3,'failed closed-period post leaves no partial journal')
})
test('construction inventory preserves capitalization, and unsafe payroll totals or noncost accounts cannot pass',()=>{
 const {run,labor}=fixture()
 for(const allocation of run.employees[0].allocations)allocation.cost_account_code='1160'
 for(const row of labor)row.account_code='1160'
 const result=reconcilePayrollImport(run,labor,accounts);assert.equal(net(result.draft.lines,'1160'),25000);assert.equal(net(result.draft.lines,'5030'),0)
 const invalid=accounts.map(row=>row.code==='1160'?{...row,account_type:'liability'}:row)
 assert.throws(()=>reconcilePayrollImport(run,labor,invalid),/cost or construction-inventory/)
 const employee=run.employees[0]
 Object.assign(employee,{gross_cents:Number.MAX_SAFE_INTEGER,net_cents:Number.MAX_SAFE_INTEGER,employee_taxes_cents:0,employee_deductions_cents:0,employer_taxes_cents:1,employer_benefits_cents:0})
 Object.assign(run.controls,{gross_cents:employee.gross_cents,net_cents:employee.net_cents,employee_taxes_cents:0,employee_deductions_cents:0,employer_taxes_cents:1,employer_benefits_cents:0,funding_cents:Number.MAX_SAFE_INTEGER})
 assert.throws(()=>reconcilePayrollImport(run,labor,accounts),/safe integer/)
})
test('custom native cost-account codes remain valid and impossible native burden decomposition is rejected',()=>{
 const {run,labor}=fixture(),custom=accounts.map(row=>row.code==='5030'?{...row,code:'LAB-05030'}:row)
 for(const a of run.employees[0].allocations)a.cost_account_code='LAB-05030'
 for(const row of labor)row.account_code='LAB-05030'
 assert.equal(net(reconcilePayrollImport(run,labor,custom).draft.lines,'LAB-05030'),25000)
 labor[0].estimated_burden_cents=-1;labor[0].cost_cents--;labor[0].clearing_cents--
 assert.throws(()=>reconcilePayrollImport(run,labor,custom),/signs differ/)
})
