const { migrationSql } = require("../support/migration-sql")
require('../../scripts/register-ts-node-test')
const {lineageFixture,nextSource,postLineage}=require('./books-payroll-correction-lineage-fixture'),{id,org}=require('./books-payroll-register-fixture')
const migration=migrationSql("20261004042836_books_payroll_correction_construction_decisions")
async function setup(f){
 await f.db.exec("alter table projects add status text default 'active' not null;alter table project_financial_settings add project_id uuid,add billing_model text,add setup_completed_at timestamptz;alter table contracts add project_id uuid,add status text,add contract_type text,add gmp_cents bigint;alter table closings add project_id uuid,add status text,add actual_date date,add settlement jsonb;")
 await f.db.query("insert into projects values($1,$2,'active')",[id(994),org])
 for(const [project,setting,contract] of [[id(4),id(990),id(991)],[id(994),id(995),id(996)]]){
  await f.db.query("insert into project_financial_settings values($1,$2,$3,'time_and_materials','2026-09-01')",[setting,org,project]);await f.db.query("insert into contracts values($1,$2,$3,'active','time_materials',null)",[contract,org,project])
 }
 await f.db.query('insert into budgets values($1,$2,$3)',[id(997),org,id(994)]);await f.db.query('insert into budget_lines values($1,$2,$3,$4)',[id(998),org,id(997),id(5)])
 await f.db.exec(migrationSql("20261004041617_books_payroll_correction_construction_policy"))
 await f.db.exec(migration)
}
async function scenario(t){
 const f=await lineageFixture(t,{beforeProposal:setup});await postLineage(f)
 f.source=await nextSource(f,{allocation:{project_id:id(994)}})
 f.unresolved=(await f.db.query('select lock_books_payroll_correction_context($1,$2) result',[org,f.source.id])).rows[0].result
 f.choices=f.unresolved.projectCosts.filter(row=>row.blockers.includes('review_new_or_reallocated_budget_and_gmp')).map(row=>({...Object.fromEntries(['workerId','allocationId','projectId','costCodeId','accountId','component'].map(key=>[key,row[key]])),budgetLineId:id(998),gmpClassification:'outside_gmp',billingTreatment:'preserve_time_and_materials_rates',reason:'Move provider cost to reviewed destination budget; native customer hours and rates remain unchanged.'}))
 return f
}
module.exports={setup,scenario,migration}
