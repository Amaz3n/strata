const {EXPORT_TABLES}=require('../../lib/services/books/export-contract')
const org='00000000-0000-4000-8000-000000000001',revision='2026-09-20T12:00:00Z'
function classification(id,code,type,subtype){return {version:1,account_id:id,code,account_type:type,subtype,normal_balance:['asset','expense','cogs'].includes(type)?'debit':'credit'}}
function fixture(){
 const tables=Object.fromEntries(EXPORT_TABLES.map(name=>[name,[]]))
 tables.gl_accounts=[{id:'cogs',org_id:org,code:'5000',account_type:'cogs',subtype:'construction_costs',normal_balance:'debit'},{id:'expense',org_id:org,code:'6000',account_type:'expense',subtype:'operating_expense',normal_balance:'debit'},{id:'cash',org_id:org,code:'1000',account_type:'asset',subtype:'cash',normal_balance:'debit'}]
 tables.projects=[{id:'job',org_id:org,name:'Native construction job'}]
 tables.project_expenses=[{id:'purchase',org_id:org,project_id:'job',status:'approved',expense_date:'2026-09-20',amount_cents:3,tax_cents:0,payment_method:'cash',updated_at:revision}]
 tables.accounting_facts=[{id:'fact',org_id:org,source_type:'expense',source_id:'purchase',accounting_date:'2026-09-20',payload:{amount_cents:3,project_id:'job',cost_lines:[{account_code:'5000',amount_cents:2,project_id:'job'},{account_code:'6000',amount_cents:1,project_id:'job'}]}}]
 tables.journal_entries=[{id:'entry',org_id:org,fact_id:'fact',source_type:'expense',source_id:'purchase',status:'posted',entry_kind:'operational',entry_date:'2026-09-20',reversal_of_entry_id:null}]
 tables.journal_lines=tables.gl_accounts.map((account,index)=>({id:'line'+index,org_id:org,entry_id:'entry',account_id:account.id,line_no:index+1,project_id:'job',company_id:null,debit_cents:[2,1,0][index],credit_cents:[0,0,3][index],dimensions:{books_account_classification:classification(account.id,account.code,account.account_type,account.subtype)}}))
 tables.books_projection_receipts=[{org_id:org,source_type:'expense',source_id:'purchase',fact_id:'fact',journal_id:'entry',source_observed_at:revision}]
 return {orgId:org,capturedAt:revision,databaseSnapshot:'one-revision',tables}
}
function unsupported(snapshot,{date='2026-09-21',source='manual',cash=true}={}){
 const t=snapshot.tables;t.gl_accounts.push({id:'income',org_id:org,code:'4000',account_type:'income',subtype:'construction_revenue',normal_balance:'credit'},{id:'offset',org_id:org,code:'1000',account_type:'asset',subtype:cash?'cash':'work_in_progress',normal_balance:'debit'});t.journal_entries.push({id:'unknown',org_id:org,fact_id:null,source_type:source,source_id:'source',status:'posted',entry_kind:source==='revenue_recognition'?'poc':'operational',entry_date:date,reversal_of_entry_id:null})
 t.journal_lines.push({id:'u1',org_id:org,entry_id:'unknown',account_id:'income',line_no:1,debit_cents:0,credit_cents:100,dimensions:{books_account_classification:classification('income','4000','income','construction_revenue')}},{id:'u2',org_id:org,entry_id:'unknown',account_id:'offset',line_no:2,debit_cents:100,credit_cents:0,dimensions:{books_account_classification:classification('offset','1000','asset',cash?'cash':'work_in_progress')}})
}
module.exports={org,revision,classification,fixture,unsupported}
