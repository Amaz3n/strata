require('../../scripts/register-ts-node-test')
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto')
const {ready,post}=require('./books-payroll-atomic-fixture'),{capture}=require('./books-payroll-workflow-fixture'),{id,org}=require('./books-payroll-register-fixture')
const {payrollRegisterFields}=require('../../lib/services/books/payroll-register-csv'),{booksDigest}=require('../../lib/services/books/hash'),{payrollCorrectionPlan}=require('../../lib/services/books/payroll-correction-plan'),{payrollCorrectionSourceEvidence}=require('../../lib/services/books/payroll-correction-source')
const migration=fs.readFileSync(path.join(__dirname,'../../supabase/migrations/20261004014207_books_payroll_correction_sources.sql'),'utf8')
async function sourceFixture(t,options={}){
 const f=await ready(t,options);await post(f);await f.db.exec('drop table books_payroll_correction_sources');await f.db.exec(migration)
 await require('../fixtures/books-export-snapshot-database').installBooksExportSnapshot(f.db)
 let tables=(await capture(f.db)).tables,run=structuredClone(tables.books_payroll_imports[0].run);run.id=id(700)
 const gross=options.correctedGrossCents??26000;Object.assign(run.employees[0],{gross_cents:gross,net_cents:gross-6000});run.employees[0].allocations[0].gross_cents=gross;Object.assign(run.controls,{gross_cents:gross,net_cents:gross-6000,funding_cents:gross+3000})
 const keys=['gross_cents','net_cents','employee_taxes_cents','employee_deductions_cents','employer_taxes_cents','employer_benefits_cents'],decimal=value=>(value/100).toFixed(2),meta=[run.provider,run.provider_run_id,run.period_start,run.period_end,run.accrual_date,run.pay_date]
 const bytes=Buffer.from([payrollRegisterFields,['employee',...meta,'W-1',...keys.map(key=>decimal(run.employees[0][key])),''],['control',...meta,'',...keys.map(key=>decimal(run.controls[key])),decimal(run.controls.funding_cents)]].map(row=>row.join(',')).join('\r\n')+'\r\n')
 const proof={version:1,org_id:org,file_id:id(702),document_version_id:id(701),storage_path:org+'/payroll/corrected.csv',file_name:'Corrected.csv',mime_type:'text/csv',size_bytes:bytes.length,checksum:createHash('sha256').update(bytes).digest('hex')};run.source_checksum=proof.checksum
 await f.db.query('insert into files(id,org_id,current_version_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,$5,$6,$7,$8)',[proof.file_id,org,proof.document_version_id,proof.storage_path,proof.file_name,proof.mime_type,proof.size_bytes,proof.checksum])
 await f.db.query('insert into doc_versions(id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,$5,$6,$7,$8)',[proof.document_version_id,org,proof.file_id,proof.storage_path,proof.file_name,proof.mime_type,proof.size_bytes,proof.checksum])
 tables=(await capture(f.db)).tables
 const request={id:run.id,postingId:id(260),accountingDate:'2026-09-20',reason:'Corrected full provider register retaining the original posting'},plan=payrollCorrectionPlan({request,correctedRun:run,tables})
 const accountSnapshot=tables.gl_accounts.map(row=>Object.fromEntries(['id','org_id','code','account_type','subtype','active'].map(key=>[key,row[key]]))).sort((a,b)=>a.id.localeCompare(b.id))
 const evidence=payrollCorrectionSourceEvidence({...plan,sourceProof:proof,columnMapping:f.columnMapping,sourceMappingDigest:booksDigest({source:proof,columns:f.columnMapping,workers:plan.correctedRun.employees.map(worker=>({worker_id:worker.worker_id,employee_reference:worker.employee_reference,allocations:worker.allocations}))}),accountSnapshot})
 return {...f,tables,evidence,bytes,proof}
}
const prepareSource=(f,evidence=f.evidence,key='corrected-register-retry-key',actor=id(50))=>f.db.query('select prepare_books_payroll_correction_source($1,$2,$3::jsonb,$4,$5) id',[org,actor,JSON.stringify(evidence),'Reviewed full corrected register and original posting',key])
const reviewSource=(f,actor=id(51),evidence=f.evidence)=>f.db.query('select review_books_payroll_correction_source($1,$2,$3,$4::jsonb,$5) id',[org,f.evidence.request.id,actor,JSON.stringify(evidence),'Independent review of corrected provider source and allocations'])
module.exports={sourceFixture,prepareSource,reviewSource}
