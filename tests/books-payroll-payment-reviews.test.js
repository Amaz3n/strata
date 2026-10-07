require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto')
const {scenario,capture,refresh}=require('./helpers/books-payroll-workflow-fixture')
const {prepare,withdraw}=require('./helpers/books-payroll-database')
const {id,org}=require('./helpers/books-payroll-register-fixture')
const {payrollPaymentReviewEvidence,parsePayrollPaymentReviewEvidence}=require('../lib/services/books/payroll-payment-review-rules')
const {booksDigest}=require('../lib/services/books/hash')
const notes='Verified original statement and worker allocation'
const prep=(f,p,key='payment-review-retry',actor=id(50))=>f.db.query('select prepare_books_payroll_payment_review($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7) id',[org,actor,JSON.stringify(p.request),JSON.stringify(p.evidence),p.evidenceDigest,notes,key])
const review=(f,p,actor=id(51))=>f.db.query('select review_books_payroll_payment_review($1,$2,$3,$4::jsonb,$5,$6) id',[org,p.request.id,actor,JSON.stringify(p.evidence),p.evidenceDigest,notes])
const withdrawPayment=(f,p)=>f.db.query('select withdraw_books_payroll_payment_review($1,$2,$3,$4)',[org,p.request.id,id(50),'Superseded original payment allocation'])
const {setup,journal,claim,build}=require('./helpers/books-payroll-payment-fixture')
test('mixed prior payment is attributed by exact original lines and SQL independently recomputes all component limits',async t=>{
 const f=await setup(t),p=f.payment,before=(await capture(f.db)).tables
 assert.equal(p.evidence.source_line_claims.find(row=>row.line_id===id(62)).claimed_cents,24000)
 assert.deepEqual(p.evidence.allocation_components.map(row=>[row.component,row.signed_cents,row.limit_cents]),[['employee_deductions_reclassification',1000,1000],['employee_taxes_reclassification',5000,5000],['net_pay_payment',18000,18000]])
 await prepare(f.db,f.evidence);await prep(f,p);await review(f,p)
 const after=(await capture(f.db)).tables
 for(const name of ['journal_entries','journal_lines','job_cost_entries','billable_costs'])assert.deepEqual(after[name],before[name],name+' is unchanged by attribution')
 assert.equal(after.books_payroll_payment_reviews[0].status,'reviewed')
 assert.deepEqual(parsePayrollPaymentReviewEvidence(f.evidence,p.request,p.evidence,p.evidenceDigest),p)
 assert.equal(p.evidence.postingImplemented,false)
})
test('review requires an independent active reviewer; request, evidence and audit history are immutable',async t=>{
 const f=await setup(t),p=f.payment;await prepare(f.db,f.evidence);await prep(f,p)
 for(const actor of [id(50),id(52)])await assert.rejects(review(f,p,actor),/separate active/)
 await review(f,p);await review(f,p)
 await assert.rejects(f.db.exec("update books_payroll_payment_reviews set evidence=jsonb_set(evidence,'{postingImplemented}','true')"),/immutable/)
 await assert.rejects(f.db.exec('delete from books_payroll_payment_reviews'),/history cannot/)
 await withdrawPayment(f,p);await withdrawPayment(f,p)
 const row=(await f.db.query('select * from books_payroll_payment_reviews')).rows[0]
 assert.equal(row.reviewed_by,id(51));assert.equal(row.status,'withdrawn');assert.deepEqual(row.evidence,p.evidence)
})
test('canonical proof rejects wrong worker, direction, journal, component, capacity and register-only support',async t=>{
 const f=await setup(t)
 for(const [mutate,pattern] of [
  [r=>r.decisions[0].claims[0].worker_id=id(52),/worker\/allocation/],
  [r=>r.decisions[0].claims[0].signed_cents=-18000,/direction/],
  [r=>r.decisions[0].claims[0].counterpart_line_id=id(88),/original journal/],
  [r=>r.decisions[0].claims[0].component='employee_taxes_payment',/liability/],
  [r=>r.decisions[0].claims[0].signed_cents=18001,/capacity/],
  [r=>r.decisions[0].claims[1].signed_cents=5001,/capacity/],
  [r=>r.decisions[0].claims.push({...r.decisions[0].claims[0]}),/Duplicate/],
  [r=>r.decisions[0].disposition='unrelated',/unrelated/],
 ]){const r=structuredClone(f.request);mutate(r);assert.throws(()=>payrollPaymentReviewEvidence(f.evidence,r,[f.proof]),pattern)}
 const r=structuredClone(f.request);r.decisions[0].document_version_id=f.sourceProof.document_version_id
 assert.throws(()=>payrollPaymentReviewEvidence(f.evidence,r,[f.sourceProof]),/register alone/)
 const altered=structuredClone(f.payment.evidence);altered.allocation_components[0].signed_cents=0
 assert.throws(()=>parsePayrollPaymentReviewEvidence(f.evidence,f.request,altered,booksDigest(altered)),/differs/)
})
test('independent SQL rejects rehashed invented summaries, direction and missing disposition',async t=>{
 const f=await setup(t);await prepare(f.db,f.evidence)
 for(const [mutate,pattern] of [
  [p=>p.evidence.source_line_claims[0].claimed_cents--,/summary differs/],
  [p=>p.evidence.allocation_components[0].limit_cents++,/provider controls/],
  [p=>{delete p.request.decisions[0].disposition;p.evidence.decisions=p.request.decisions},/disposition/],
  [p=>{p.request.decisions[0].claims[0].signed_cents=-18000;p.evidence.decisions=p.request.decisions},/direction/],
  [p=>p.evidence.supporting_documents[0].checksum='a'.repeat(64),/version changed/],
 ]){const p=structuredClone(f.payment);mutate(p);p.evidenceDigest=booksDigest(p.evidence);await assert.rejects(prep(f,p),pattern)}
 assert.equal((await f.db.query('select count(*)::int count from books_payroll_payment_reviews')).rows[0].count,0)
 await prep(f,f.payment)
})
test('partial source claims cannot be reused across active runs; parent withdrawal releases reservations and retains proof',async t=>{
 const f=await setup(t);f.request.decisions[0].claims=[claim(73,'net_pay_payment',62,63,10000)];const p=build(f)
 await prepare(f.db,f.evidence);await prep(f,p);await review(f,p)
 const other=structuredClone(f.evidence);other.run.id=id(90);other.run.provider_run_id='separate-run';other.run.period_start='2026-09-20';other.run.period_end='2026-09-25';other.run.accrual_date='2026-09-25';other.run.pay_date='2026-09-26'
 // A different run with no native labor still sees the same organization payment history.
 const registerBytes=Buffer.from(f.registerBytes.toString('utf8').replaceAll(f.run.provider_run_id,other.run.provider_run_id).replaceAll(f.run.period_start,other.run.period_start).replaceAll(f.run.period_end,other.run.period_end).replaceAll(f.run.accrual_date,other.run.accrual_date).replaceAll(f.run.pay_date,other.run.pay_date))
 const sourceProof={...f.sourceProof,file_id:id(130),document_version_id:id(131),storage_path:org+'/payroll/second-register.csv',size_bytes:registerBytes.length,checksum:createHash('sha256').update(registerBytes).digest('hex')}
 other.run.source_checksum=sourceProof.checksum
 await f.db.query('insert into files values($1,$2,$3,$4,$5,$6,$7,$8)',[sourceProof.file_id,org,sourceProof.document_version_id,sourceProof.storage_path,sourceProof.file_name,sourceProof.mime_type,sourceProof.size_bytes,sourceProof.checksum])
 await f.db.query('insert into doc_versions(id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,$5,$6,$7,$8)',[sourceProof.document_version_id,org,sourceProof.file_id,sourceProof.storage_path,sourceProof.file_name,sourceProof.mime_type,sourceProof.size_bytes,sourceProof.checksum])
 const g={...f,run:other.run,labor:[],sourceProof,result:{...f.result,sourceProof}};g.run.employees[0].allocations[0].labor_evidence_ids=[];await refresh(g)
 await prepare(g.db,g.evidence,'other-payroll-retry')
 const r=structuredClone(f.request);r.id=id(91);r.payroll_import_id=id(90);r.decisions[0].claims=[claim(92,'net_pay_payment',62,63,10000)]
 const second=payrollPaymentReviewEvidence(g.evidence,r,[f.proof])
 await assert.rejects(prep(g,second,'other-payment-retry'),/across active reviews/)
 await withdraw(f.db)
 const old=(await f.db.query('select * from books_payroll_payment_reviews where id=$1',[p.request.id])).rows[0]
 assert.equal(old.status,'withdrawn');assert.equal(old.reviewed_by,id(51));assert.match(old.withdrawal_reason,/Parent payroll/)
 await prep(g,second,'other-payment-retry')
 assert.equal((await prep(f,p)).rows[0].id,p.request.id,'same-key replay returns original withdrawn review')
})
test('recorded refunds require their paired original claim and consume both real line capacities',async t=>{
 const f=await setup(t)
 await journal(f,100,[[101,30,0,2000],[102,60,2000,0]])
 await refresh(f)
 f.request.decisions.push({journal_id:id(100),disposition:'allocated',explanation:notes,document_version_id:id(71),claims:[claim(103,'net_pay_payment',101,102,-2000)]})
 const p=build(f);assert.equal(p.evidence.allocation_components.find(r=>r.component==='net_pay_payment').signed_cents,16000)
 await prepare(f.db,f.evidence);await prep(f,p);await review(f,p)
 f.request.decisions[0].claims=f.request.decisions[0].claims.filter(c=>c.component!=='net_pay_payment')
 assert.throws(()=>build(f),/unpaired refund/)
})
test('every liability journal is explicitly allocated or excluded; prior costs require exact construction dimensions',async t=>{
 const f=await setup(t)
 await journal(f,110,[[111,32,3000,0],[112,31,0,3000]],id(4),id(5))
 await refresh(f)
 assert.throws(()=>build(f),/every retained/)
 f.request.decisions.push({journal_id:id(110),disposition:'allocated',explanation:notes,document_version_id:id(71),claims:[claim(113,'employer_taxes_recognition',112,111,2500),claim(114,'employer_benefits_recognition',112,111,500)]})
 const p=build(f);await prepare(f.db,f.evidence);await prep(f,p)
 const wrong=structuredClone(f.evidence);wrong.reconciliation.workflowEvidence.sourceTables.journal_lines.find(l=>l.id===id(111)).dimensions.cost_code_id=id(99)
 // Original parent replay catches changed retained records even before attribution.
 assert.throws(()=>payrollPaymentReviewEvidence(wrong,f.request,[f.proof]),/integrity|workflow|differs/i)
})
test('all statuses retain payment supporting versions while current file replacement remains possible',async t=>{
 const f=await setup(t),p=f.payment;await prepare(f.db,f.evidence);await prep(f,p);await withdrawPayment(f,p)
 await assert.rejects(f.db.query('delete from files where id=$1',[id(70)]),/history cannot/)
 await assert.rejects(f.db.query('delete from doc_versions where id=$1',[id(71)]),/immutable/)
 await assert.rejects(f.db.query('update doc_versions set checksum=$1 where id=$2',['a'.repeat(64),id(71)]),/immutable/)
 await f.db.query('update doc_versions set label=$1,notes=$2 where id=$3',['Original settlement','Audited supporting evidence',id(71)])
 await f.db.query('insert into doc_versions(id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,$5,$6,$7,$8)',[id(120),org,id(70),org+'/payroll/later.pdf','Later.pdf','application/pdf',1,'b'.repeat(64)])
 await f.db.query('update files set current_version_id=$1,storage_path=$2,file_name=$3,size_bytes=1,checksum=$4 where id=$5',[id(120),org+'/payroll/later.pdf','Later.pdf','b'.repeat(64),id(70)])
 assert.deepEqual((await f.db.query('select storage_path,checksum from doc_versions where id=$1',[id(71)])).rows[0],{storage_path:f.proof.storage_path,checksum:f.proof.checksum})
})
test('changed construction/payment sources block review; stale review can still be withdrawn',async t=>{
 const f=await setup(t),p=f.payment;await prepare(f.db,f.evidence);await prep(f,p)
 await f.db.query('update journal_lines set dimensions=$1::jsonb where id=$2',[JSON.stringify({payment_reference:'Changed statement reference'}),id(63)])
 await assert.rejects(review(f,p),/evidence changed/)
 await withdrawPayment(f,p)
 await assert.rejects(prep(f,{...p,request:{...p.request,id:id(121)}},'changed-request-retry'),/identity|changed/)
})
test('private payroll attribution tables and RPCs are not available to browser roles',async t=>{
 const f=await setup(t)
 const flags=(await f.db.query("select has_table_privilege('authenticated','books_payroll_payment_reviews','select') browser,has_function_privilege('anon','prepare_books_payroll_payment_review(uuid,uuid,jsonb,jsonb,text,text,text)','execute') anon,has_function_privilege('service_role','review_books_payroll_payment_review(uuid,uuid,uuid,jsonb,text,text)','execute') service,has_function_privilege('authenticated','protect_payroll_payment_documents()','execute') document_guard")).rows[0]
 assert.deepEqual(flags,{browser:false,anon:false,service:true,document_guard:false})
})
test('all ten components distinguish wage recognition, employer burden, reclassification and cash remittance',async t=>{
 const f=await setup(t)
 await journal(f,140,[[141,32,24000,0],[142,30,0,24000]],id(4),id(5))
 await journal(f,143,[[144,32,3000,0],[145,31,0,3000]],id(4),id(5))
 await journal(f,146,[[147,31,9000,0],[148,60,0,9000]])
 await journal(f,149,[[150,30,100,0],[151,60,0,100]])
 await refresh(f)
 for(const [journalId,claims] of [[140,[claim(152,'gross_wages_recognition',142,141,24000)]],[143,[claim(153,'employer_taxes_recognition',145,144,2500),claim(154,'employer_benefits_recognition',145,144,500)]],[146,[claim(155,'employee_taxes_payment',147,148,5000),claim(156,'employee_deductions_payment',147,148,1000),claim(157,'employer_taxes_payment',147,148,2500),claim(158,'employer_benefits_payment',147,148,500)]]])f.request.decisions.push({journal_id:id(journalId),disposition:'allocated',explanation:notes,document_version_id:id(71),claims})
 f.request.decisions.push({journal_id:id(149),disposition:'unrelated',explanation:'Separate worker settlement identified in original bank statement',document_version_id:id(71),claims:[]})
 const p=build(f);assert.equal(p.evidence.allocation_components.length,10)
 await prepare(f.db,f.evidence);await prep(f,p);await review(f,p)
 assert.equal(p.evidence.source_line_claims.find(row=>row.line_id===id(147)).claimed_cents,9000)
 assert.ok(!p.evidence.source_line_claims.some(row=>row.line_id===id(150)))
})
test('SQL largest-remainder component limits agree with the core plan across ties and all-withheld wages',async t=>{
 const f=await setup(t),{reconcilePayrollImport}=require('../lib/services/books/payroll-import-rules')
 for(const [gross,taxes,deductions] of [[3,1,1],[3,2,1],[3,3,0],[101,7,11]]){
  const run=structuredClone(f.run),w=run.employees[0];w.gross_cents=gross;w.employee_taxes_cents=taxes;w.employee_deductions_cents=deductions;w.net_cents=gross-taxes-deductions;w.employer_taxes_cents=0;w.employer_benefits_cents=0
  w.allocations=[0,1,2].map((_,i)=>({...w.allocations[0],id:id(160+i),gross_cents:i===2?gross-2*Math.floor(gross/3):Math.floor(gross/3),employer_taxes_cents:0,employer_benefits_cents:0,labor_evidence_ids:[]}))
  Object.assign(run.controls,{gross_cents:gross,employee_taxes_cents:taxes,employee_deductions_cents:deductions,net_cents:w.net_cents,employer_taxes_cents:0,employer_benefits_cents:0,funding_cents:gross})
  const plan=reconcilePayrollImport(run,[],f.postingAccounts)
  for(const a of w.allocations)for(const component of ['employee_taxes','employee_deductions']){
   const expected=plan.draft.lines.filter(l=>l.accountCode==='2230'&&l.dimensions.payroll_allocation_id===a.id&&l.dimensions.payroll_component===component).reduce((n,l)=>n+l.creditCents-l.debitCents,0)
   const sql=(await f.db.query('select books_payroll_payment_component_limit($1::jsonb,$2,$3) amount',[JSON.stringify(run),a.id,component+'_payment'])).rows[0].amount
   assert.equal(Number(sql),expected)
  }
 }
})
test('schema 10 archive proves payment evidence and original bytes, restores all rows and rejects rehashed corruption',async t=>{
 const f=await setup(t),p=f.payment;await prepare(f.db,f.evidence);await prep(f,p);await review(f,p);await withdraw(f.db)
 const {verifyBooksExportBundle,BOOKS_EXPORT_SCHEMA_VERSION,EXPORT_TABLES}=require('../lib/services/books/export-contract'),{historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive')
 const tables=(await capture(f.db)).tables
 const bundle={tables,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:tables.files.map(file=>({id:file.id,storagePath:file.storage_path,sizeBytes:file.size_bytes,checksum:file.checksum})),supportingHistoricalFiles:historicalDocumentInventory(tables,org)},supportingObjects:[{fileId:id(8),dataBase64:f.registerBytes.toString('base64')},{fileId:id(70),dataBase64:f.paymentBytes.toString('base64')}],supportingHistoricalObjects:[]}
 assert.equal(BOOKS_EXPORT_SCHEMA_VERSION,33)
 assert.equal(verifyBooksExportBundle(bundle).valid,true,JSON.stringify(verifyBooksExportBundle(bundle)))
 for(const mutate of [b=>b.tables.books_payroll_payment_reviews[0].reviewed_by=null,b=>b.tables.books_payroll_payment_reviews[0].prepared_at='invalid',b=>{const l=b.tables.journal_lines.find(row=>row.id===id(63));l.debit_cents=l.credit_cents;l.credit_cents=0},b=>{const e=b.tables.books_payroll_payment_reviews[0];e.evidence.allocation_components[0].signed_cents++;e.evidence_digest=booksDigest(e.evidence)}]){
  const b=structuredClone(bundle);mutate(b);for(const [name,rows] of Object.entries(b.tables))b.manifest.tables[name].checksum=booksDigest(rows)
  assert.equal(verifyBooksExportBundle(b).valid,false)
 }
 const broken=structuredClone(bundle);broken.supportingObjects[1].dataBase64=Buffer.from('Invented payment proof').toString('base64');assert.equal(verifyBooksExportBundle(broken).valid,false)
 const target=(await scenario(t)).db;await target.exec('set session_replication_role=replica')
 for(const name of EXPORT_TABLES)await target.exec(`delete from ${name}`)
 for(const [name,rows] of Object.entries(tables))for(const row of rows){const keys=Object.keys(row);await target.query(`insert into ${name}(${keys.map(key=>'"'+key+'"').join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row).map(value=>value&&typeof value==='object'?JSON.stringify(value):value))}
 await target.exec('set session_replication_role=origin');assert.deepEqual((await capture(target)).tables,tables)
 await assert.rejects(target.exec('delete from books_payroll_payment_reviews'),/history cannot/)
 await assert.rejects(target.query('delete from doc_versions where id=$1',[id(71)]),/immutable/)
})
test('archive retains original payment proof after current-file replacement and extracts both versions',async t=>{
 const f=await setup(t);await prepare(f.db,f.evidence);await prep(f,f.payment);await withdrawPayment(f,f.payment)
 const replacement=Buffer.from('Later uploaded payment statement'),checksum=createHash('sha256').update(replacement).digest('hex'),storagePath=org+'/payroll/later-statement.pdf'
 await f.db.query('insert into doc_versions(id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum) values($1,$2,$3,$4,$5,$6,$7,$8)',[id(170),org,id(70),storagePath,'Later statement.pdf','application/pdf',replacement.length,checksum])
 await f.db.query('update files set current_version_id=$1,storage_path=$2,file_name=$3,size_bytes=$4,checksum=$5 where id=$6',[id(170),storagePath,'Later statement.pdf',replacement.length,checksum,id(70)])
 const {verifyBooksExportBundle,BOOKS_EXPORT_SCHEMA_VERSION}=require('../lib/services/books/export-contract'),{historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive')
 const tables=(await capture(f.db)).tables,historical=historicalDocumentInventory(tables,org),original=historical.find(item=>item.storagePath===f.proof.storage_path)
 const bundle={tables,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:tables.files.map(file=>({id:file.id,storagePath:file.storage_path,sizeBytes:file.size_bytes,checksum:file.checksum})),supportingHistoricalFiles:historical},supportingObjects:[{fileId:id(8),dataBase64:f.registerBytes.toString('base64')},{fileId:id(70),dataBase64:replacement.toString('base64')}],supportingHistoricalObjects:[{attachmentId:original.id,dataBase64:f.paymentBytes.toString('base64')}]}
 assert.equal(original.currentFileId,null);assert.equal(verifyBooksExportBundle(bundle).valid,true,JSON.stringify(verifyBooksExportBundle(bundle)))
 const missing=structuredClone(bundle);missing.supportingHistoricalObjects=[];assert.equal(verifyBooksExportBundle(missing).valid,false)
 const fs=require('node:fs'),path=require('node:path'),{tmpdir}=require('node:os'),{gzipSync}=require('node:zlib'),{extractSupportingFiles}=require('../scripts/verify-books-export.cjs')
 const directory=fs.mkdtempSync(path.join(tmpdir(),'payroll-payment-recovery-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
 const archive=path.join(directory,'archive.gz');fs.writeFileSync(archive,gzipSync(JSON.stringify(bundle)));const root=path.join(directory,'objects')
 assert.equal((await extractSupportingFiles(archive,root)).verifiedFiles,3)
 assert.deepEqual(fs.readFileSync(path.join(root,f.proof.storage_path)),f.paymentBytes);assert.deepEqual(fs.readFileSync(path.join(root,storagePath)),replacement)
})
test('original explicit run/worker/allocation ownership cannot be reassigned by a reviewed claim or fresh hashes',async t=>{
 for(const field of ['payroll_run_id','payroll_worker_id','labor_worker_id','payroll_allocation_id']){
  const f=await setup(t),p=structuredClone(f.payment)
  await f.db.query('update journal_lines set dimensions=$1::jsonb where id=$2',[JSON.stringify({[field]:id(99)}),id(62)])
  await refresh(f)
  assert.throws(()=>build(f),/contradicts original/)
  p.evidence.payroll_reconciliation_digest=f.evidence.reconciliation_digest;p.evidenceDigest=booksDigest(p.evidence)
  await prepare(f.db,f.evidence)
  await assert.rejects(prep(f,p),/contradicts original/)
 }
})
