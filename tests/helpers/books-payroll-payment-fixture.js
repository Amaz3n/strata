require('../../scripts/register-ts-node-test')
const {createHash}=require('node:crypto')
const {scenario,refresh}=require('./books-payroll-workflow-fixture')
const {id,org}=require('./books-payroll-register-fixture')
const {payrollPaymentReviewEvidence}=require('../../lib/services/books/payroll-payment-review-rules')
const notes='Verified original statement and worker allocation'
async function setup(t){
 const f=await scenario(t,true)
 await f.db.query("insert into gl_accounts values($1,$2,'1000','asset','cash',true)",[id(60),org])
 await journal(f,61,[[62,30,24000,0],[63,60,0,18000],[64,31,0,6000]])
 const bytes=Buffer.from('Original bank/provider settlement statement'),checksum=createHash('sha256').update(bytes).digest('hex')
 f.proof={version:1,org_id:org,file_id:id(70),document_version_id:id(71),storage_path:org+'/payroll/original-payment.pdf',file_name:'Original payment.pdf',mime_type:'application/pdf',size_bytes:bytes.length,checksum}
 await f.db.query('insert into files values($1,$2,$3,$4,$5,$6,$7,$8)',[id(70),org,id(71),f.proof.storage_path,f.proof.file_name,f.proof.mime_type,bytes.length,checksum])
 await f.db.query('insert into doc_versions(id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,$5,$6,$7,$8)',[id(71),org,id(70),f.proof.storage_path,f.proof.file_name,f.proof.mime_type,bytes.length,checksum])
 f.paymentBytes=bytes
 await refresh(f)
 f.request={id:id(72),payroll_import_id:f.run.id,decisions:[{journal_id:id(61),disposition:'allocated',explanation:notes,document_version_id:id(71),claims:[claim(73,'net_pay_payment',62,63,18000),claim(74,'employee_taxes_reclassification',62,64,5000),claim(75,'employee_deductions_reclassification',62,64,1000)]}]}
 f.payment=payrollPaymentReviewEvidence(f.evidence,f.request,[f.proof])
 return f
}
async function journal(f,journalId,legs,project=null,costCode=null){
 await f.db.query("insert into journal_entries(id,org_id,fact_id,status,source_type,source_id,entry_date) values($1,$2,null,'posted','manual_journal',null,'2026-09-18')",[id(journalId),org])
 for(const [line,account,debit,credit] of legs)await f.db.query('insert into journal_lines values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[id(line),org,id(journalId),id(account),project,debit,credit,JSON.stringify(costCode?{cost_code_id:costCode}:{})])
}
const claim=(i,component,liability,counterpart,amount)=>({id:id(i),worker_id:id(2),allocation_id:id(3),component,liability_line_id:id(liability),counterpart_line_id:id(counterpart),signed_cents:amount})
const build=f=>payrollPaymentReviewEvidence(f.evidence,f.request,[f.proof])
module.exports={setup,journal,claim,build}
