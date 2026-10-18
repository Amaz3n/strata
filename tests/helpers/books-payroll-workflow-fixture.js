require('../../scripts/register-ts-node-test')
const {fixture,id,org}=require('./books-payroll-register-fixture')
const {database}=require('./books-payroll-database')
const {payrollDraftEvidence}=require('../../lib/services/books/payroll-draft-evidence')
const {booksDigest}=require('../../lib/services/books/hash')
const {payrollReconciliationFromSnapshot}=require('../../lib/services/books/payroll-labor-snapshot')
const {payrollRegisterFields}=require('../../lib/services/books/payroll-register-csv')
const {createHash}=require('node:crypto')
const capture=async db=>(await db.query('select capture_books_export_snapshot($1) snapshot',[org])).rows[0].snapshot
const revision=async(db,run)=>(await db.query('select books_payroll_source_revision(capture_books_export_snapshot($1),$2::jsonb) revision',[org,JSON.stringify(run)])).rows[0].revision
async function scenario(t,native=false){
 const {db}=await database(t),f=fixture()
 await db.exec('alter table gl_accounts add account_type text,add subtype text,add active boolean;alter table job_cost_entries add cost_code_id uuid,add budget_line_id uuid,add gmp_classification text,add billable_cost_id uuid;alter table budget_lines add budget_id uuid,add cost_code_id uuid;alter table budgets add project_id uuid;alter table billable_costs add project_id uuid,add cost_code_id uuid,add source_type text,add source_id uuid,add status text,add is_billable boolean,add invoice_id uuid,add cost_cents bigint,add markup_cents bigint,add billable_cents bigint,add markup_percent_resolved numeric,add metadata jsonb;alter table journal_lines add entry_id uuid,add account_id uuid,add project_id uuid,add debit_cents bigint,add credit_cents bigint,add dimensions jsonb;alter table accounting_facts add source_version integer default 1;alter table journal_entries add reversal_of_entry_id uuid;alter table time_entries add project_id uuid,add cost_code_id uuid,add status text,add hours numeric,add base_rate_cents bigint,add burden_multiplier numeric,add is_overtime boolean,add ot_multiplier numeric,add is_double_time boolean,add dt_multiplier numeric,add labor_cost_policy_version integer,add cost_cents bigint,add updated_at timestamptz;')
 for(const account of f.postingAccounts)await db.query('update gl_accounts set account_type=$1,subtype=$2,active=$3 where id=$4',[account.account_type,account.subtype,account.active,account.id])
 const decimal=n=>String(BigInt(n)/100n)+'.'+String(BigInt(n)%100n).padStart(2,'0')
 const meta=[f.run.provider,f.run.provider_run_id,f.run.period_start,f.run.period_end,f.run.accrual_date,f.run.pay_date]
 const amounts=values=>['gross_cents','net_cents','employee_taxes_cents','employee_deductions_cents','employer_taxes_cents','employer_benefits_cents'].map(key=>decimal(values[key]))
 f.registerBytes=Buffer.from([payrollRegisterFields,['employee',...meta,'W-1',...amounts(f.run.employees[0]),''],['control',...meta,'',...amounts(f.run.controls),decimal(f.run.controls.funding_cents)]].map(row=>row.join(',')).join('\r\n')+'\r\n')
 Object.assign(f.sourceProof,{size_bytes:f.registerBytes.length,checksum:createHash('sha256').update(f.registerBytes).digest('hex')});f.run.source_checksum=f.sourceProof.checksum
 await db.query('update files set size_bytes=$1,checksum=$2 where id=$3',[f.sourceProof.size_bytes,f.sourceProof.checksum,f.sourceProof.file_id])
 await db.query('update doc_versions set size_bytes=$1,checksum=$2 where id=$3',[f.sourceProof.size_bytes,f.sourceProof.checksum,f.sourceProof.document_version_id])
 if(native){
  const time='2026-09-10T12:00:00.000000+00:00'
  f.labor=[{id:id(80),org_id:org,worker_id:id(2),project_id:id(4),cost_code_id:id(5),account_code:'5030',incurred_on:'2026-09-10',fact_id:id(82),journal_id:id(83),source_revision:time,gross_cents:24000,estimated_burden_cents:12000,cost_cents:36000,clearing_cents:36000}]
  f.run.employees[0].allocations[0].labor_evidence_ids=[id(80)]
  const basis={version:1,org_id:org,job_cost_id:id(80),time_entry_id:id(81),worker_id:id(2),project_id:id(4),cost_code_id:id(5),incurred_on:'2026-09-10',source_revision:time,gross_cents:24000,estimated_burden_cents:12000,cost_cents:36000,cost_policy_version:1,is_overtime:false,is_double_time:false}
  const metadata={worker_user_id:id(2),hours:8,base_rate_cents:3000,burden_multiplier:1.5,is_overtime:false,ot_multiplier:1.5,is_double_time:false,dt_multiplier:2,labor_cost_policy_version:1}
  await db.query("insert into time_entries values($1,$2,$3,'2026-09-10',$4,$5,'pm_approved',8,3000,1.5,false,1.5,false,2,1,36000,$6)",[id(81),org,id(2),id(4),id(5),time])
  await db.query("insert into job_cost_entries(id,org_id,project_id,status,source_type,source_id,incurred_on,cost_cents,updated_at,metadata,cost_code_id,budget_line_id,gmp_classification,billable_cost_id) values($1,$2,$3,'posted','time_entry',$4,'2026-09-10',36000,$5,$6::jsonb,$7,$8,'outside_gmp',$9)",[id(80),org,id(4),id(81),time,JSON.stringify(metadata),id(5),id(84),id(86)])
  await db.query("insert into accounting_facts(id,org_id,source_type,source_id,payload,accounting_date) values($1,$2,'labor_cost',$3,$4::jsonb,'2026-09-10')",[id(82),org,id(80),JSON.stringify({labor_basis:basis,amount_cents:36000,project_id:id(4),cost_account_code:'5030',dimensions:{cost_code_id:id(5)}})])
  await db.query("insert into journal_entries(id,org_id,fact_id,status,source_type,source_id,entry_date) values($1,$2,$3,'posted','labor_cost',$4,'2026-09-10')",[id(83),org,id(82),id(80)])
  await db.query("insert into books_projection_receipts values($1,$2,'labor_cost',$3,$4,$5,$6)",[id(87),org,id(80),id(82),id(83),time])
  await db.query('insert into budgets values($1,$2,$3)',[id(85),org,id(4)])
  await db.query('insert into budget_lines values($1,$2,$3,$4)',[id(84),org,id(85),id(5)])
  await db.query("insert into billable_costs values($1,$2,$3,$4,'time_entry',$5,'open',true,null,36000,4000,40000,11.1111,$6::jsonb)",[id(86),org,id(4),id(5),id(81),JSON.stringify({billing_method:'cost_plus_markup'})])
  for(const [i,code,debit,credit] of [[0,'5030',36000,0],[1,'2200',0,36000]]){
   const account=f.postingAccounts.find(row=>row.code===code),dimensions={cost_code_id:id(5),labor_job_cost_id:id(80),labor_time_entry_id:id(81),labor_worker_id:id(2),labor_basis_hash:booksDigest(basis),books_account_classification:{version:1,account_id:account.id,code,account_type:account.account_type,subtype:account.subtype}}
   await db.query('insert into journal_lines values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[id(88+i),org,id(83),account.id,id(4),debit,credit,JSON.stringify(dimensions)])
  }
 }else f.labor=[]
 f.db=db;return refresh(f)
}
async function refresh(f){
 const db=f.db
 f.snapshot=await capture(db);f.plan=payrollReconciliationFromSnapshot(org,f.run,f.snapshot);f.workflow=f.plan.workflowEvidence
 f.evidence=payrollDraftEvidence({...f.result,...f.plan,laborEvidence:f.labor,workflowEvidence:f.workflow,sourceMappingDigest:booksDigest({source:f.sourceProof,columns:f.columnMapping,workers:f.plan.run.employees.map(w=>({worker_id:w.worker_id,employee_reference:w.employee_reference,allocations:w.allocations}))})},await revision(db,f.run),{requireWorkflow:true})
 return f
}
module.exports={scenario,capture,revision,refresh}
