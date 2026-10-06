require('../../scripts/register-ts-node-test')
const {booksDigest}=require('../../lib/services/books/hash')
const {payrollDraftEvidence}=require('../../lib/services/books/payroll-draft-evidence')
const {reconcilePayrollImport}=require('../../lib/services/books/payroll-import-rules')
const {payrollRegisterFields}=require('../../lib/services/books/payroll-register-csv')
const id=n=>'99400000-0000-4000-8000-'+String(n).padStart(12,'0'),org=id(1)
function fixture(){
 const columns=Object.fromEntries(payrollRegisterFields.map(field=>[field,field])),columnMapping={columns,amount_unit:'dollars',employee_row_value:'employee',control_row_value:'control'}
 const sourceProof={version:1,org_id:org,file_id:id(8),document_version_id:id(7),storage_path:org+'/payroll/original.csv',file_name:'Original.csv',mime_type:'text/csv',size_bytes:3,checksum:require('node:crypto').createHash('sha256').update('abc').digest('hex')}
 const run={id:id(6),org_id:org,provider:'Provider',provider_run_id:'RUN-1',period_start:'2026-09-01',period_end:'2026-09-15',accrual_date:'2026-09-15',pay_date:'2026-09-18',source_checksum:sourceProof.checksum,employees:[{worker_id:id(2),employee_reference:'W-1',gross_cents:24000,net_cents:18000,employee_taxes_cents:5000,employee_deductions_cents:1000,employer_taxes_cents:2500,employer_benefits_cents:500,allocations:[{id:id(3),project_id:id(4),cost_code_id:id(5),cost_account_code:'5030',gross_cents:24000,employer_taxes_cents:2500,employer_benefits_cents:500,labor_evidence_ids:[]}]}],controls:{gross_cents:24000,net_cents:18000,employee_taxes_cents:5000,employee_deductions_cents:1000,employer_taxes_cents:2500,employer_benefits_cents:500,funding_cents:27000}}
 const postingAccounts=[['2200','liability','payroll_clearing'],['2230','liability','other_liability'],['5030','cogs','direct_labor']].map(([code,account_type,subtype],i)=>({id:id(30+i),org_id:org,code,account_type,subtype,active:true}))
 const result={...reconcilePayrollImport(run,[],postingAccounts),postingAccounts,laborEvidence:[],sourceProof,columnMapping,sourceMappingDigest:booksDigest({source:sourceProof,columns:columnMapping,workers:run.employees.map(worker=>({worker_id:worker.worker_id,employee_reference:worker.employee_reference,allocations:worker.allocations}))})}
 const evidence=payrollDraftEvidence(result,'b'.repeat(64))
 return {id,org,run,sourceProof,columnMapping,postingAccounts,result,evidence}
}
module.exports={fixture,id,org}
