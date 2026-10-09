const { migrationSql } = require("../support/migration-sql")
require('../../scripts/register-ts-node-test')
const {createHash}=require('node:crypto')
const {proposalFixture,prepareProposal,reviewProposal}=require('./books-payroll-correction-proposal-fixture'),{capture}=require('./books-payroll-workflow-fixture'),{id,org}=require('./books-payroll-register-fixture')
const {payrollCorrectionSourceEvidence}=require('../../lib/services/books/payroll-correction-source'),{payrollCorrectionPlan}=require('../../lib/services/books/payroll-correction-plan'),{booksDigest}=require('../../lib/services/books/hash'),{payrollRegisterFields}=require('../../lib/services/books/payroll-register-csv')
const migration=()=>migrationSql("20261004033518_books_payroll_correction_lineage")
async function lineageFixture(t,options={}){
 const f=await proposalFixture(t,options)
 await f.db.exec('drop table books_payroll_correction_postings')
 await f.db.exec(migrationSql("20261004031113_books_payroll_correction_atomic_posting"))
 await f.db.exec(migration())
 await require('../fixtures/books-export-snapshot-database').installBooksExportSnapshot(f.db)
 if(options.beforeProposal)await options.beforeProposal(f)
 f.plan=(await f.db.query('select lock_books_payroll_correction_context($1,$2) result',[org,id(700)])).rows[0].result;delete f.plan.locksHeldUntilTransactionEnd
 await prepareProposal(f);await reviewProposal(f)
 f.proposal=(await f.db.query('select to_jsonb(p) row from books_payroll_correction_proposals p where id=$1',[id(750)])).rows[0].row
 f.registers=new Map([[id(8),f.registerBytes],[id(702),f.bytes]])
 return f
}
async function nextSource(f,{number=1,gross=28000,date='2026-09-21',allocation,actor=id(50),review=true}={}){
 const sourceId=id(900+number*10),fileId=id(901+number*10),versionId=id(902+number*10)
 const tables=(await capture(f.db)).tables,run=structuredClone(f.evidence.run);run.id=sourceId;Object.assign(run.employees[0],{gross_cents:gross,net_cents:gross-6000});run.employees[0].allocations[0].gross_cents=gross
 if(allocation)Object.assign(run.employees[0].allocations[0],allocation)
 Object.assign(run.controls,{gross_cents:gross,net_cents:gross-6000,funding_cents:gross+3000})
 const keys=['gross_cents','net_cents','employee_taxes_cents','employee_deductions_cents','employer_taxes_cents','employer_benefits_cents'],decimal=value=>(value/100).toFixed(2),meta=[run.provider,run.provider_run_id,run.period_start,run.period_end,run.accrual_date,run.pay_date]
 const bytes=Buffer.from([payrollRegisterFields,['employee',...meta,'W-1',...keys.map(key=>decimal(run.employees[0][key])),''],['control',...meta,'',...keys.map(key=>decimal(run.controls[key])),decimal(run.controls.funding_cents)]].map(row=>row.join(',')).join('\r\n')+'\r\n')
 const proof={version:1,org_id:org,file_id:fileId,document_version_id:versionId,storage_path:org+'/payroll/correction-'+number+'.csv',file_name:'Correction-'+number+'.csv',mime_type:'text/csv',size_bytes:bytes.length,checksum:createHash('sha256').update(bytes).digest('hex')};run.source_checksum=proof.checksum
 await f.db.query('insert into files(id,org_id,current_version_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,$5,$6,$7,$8)',[fileId,org,versionId,proof.storage_path,proof.file_name,proof.mime_type,proof.size_bytes,proof.checksum])
 await f.db.query('insert into doc_versions(id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,$5,$6,$7,$8)',[versionId,org,fileId,proof.storage_path,proof.file_name,proof.mime_type,proof.size_bytes,proof.checksum])
 f.registers.set(fileId,bytes)
 const request={id:sourceId,postingId:id(260),accountingDate:date,reason:'Reviewed subsequent full provider register correction '+number},plan=payrollCorrectionPlan({request,correctedRun:run,tables:(await capture(f.db)).tables})
 const accountSnapshot=tables.gl_accounts.map(row=>Object.fromEntries(['id','org_id','code','account_type','subtype','active'].map(key=>[key,row[key]]))).sort((a,b)=>a.id.localeCompare(b.id))
 const evidence=payrollCorrectionSourceEvidence({...plan,sourceProof:proof,columnMapping:f.columnMapping,sourceMappingDigest:booksDigest({source:proof,columns:f.columnMapping,workers:run.employees.map(worker=>({worker_id:worker.worker_id,employee_reference:worker.employee_reference,allocations:worker.allocations}))}),accountSnapshot})
 await f.db.query('select prepare_books_payroll_correction_source($1,$2,$3::jsonb,$4,$5)',[org,actor,JSON.stringify(evidence),'Prepare full subsequent corrective provider register','lineage-source-key-'+number])
 if(review)await f.db.query('select review_books_payroll_correction_source($1,$2,$3,$4::jsonb,$5)',[org,sourceId,id(51),JSON.stringify(evidence),'Independent subsequent provider register review'])
 return {id:sourceId,evidence,bytes,plan}
}
async function nextProposal(f,source,number=1){
 const plan=(await f.db.query('select lock_books_payroll_correction_context($1,$2) result',[org,source.id])).rows[0].result;delete plan.locksHeldUntilTransactionEnd
 const proposalId=id(903+number*10)
 await f.db.query('select prepare_books_payroll_correction_proposal($1,$2,$3,$4,$5::jsonb,$6,$7)',[org,proposalId,source.id,id(2),JSON.stringify(plan),'Prepare exact subsequent corrective monetary and construction proposal','lineage-proposal-key-'+number])
 const proposal=(await f.db.query('select to_jsonb(p) row from books_payroll_correction_proposals p where id=$1',[proposalId])).rows[0].row
 await f.db.query('select review_books_payroll_correction_proposal($1,$2,$3,$4,$5)',[org,proposalId,id(51),proposal.plan_digest,'Independent sequential monetary correction review'])
 return {...proposal,status:'reviewed',plan}
}
const postLineage=(f,proposal=f.proposal,number=0,overrides={})=>f.db.query('select post_books_payroll_correction_proposal($1,$2,$3,$4,$5,$6,$7) result',[org,overrides.id||id(960+number),proposal.id,overrides.actor||id(2),overrides.digest||proposal.plan_digest,overrides.notes||'Post exact sequential corrected payroll and preserve customer billing',overrides.key||'lineage-post-key-'+number])
module.exports={lineageFixture,nextSource,nextProposal,postLineage,migration}
