#!/usr/bin/env node
// Explicit isolated Docker target; every fixture is rolled back. Never loads .env.
require('./register-ts-node-test')
const {execFileSync}=require('node:child_process')
const {randomUUID,createHash}=require('node:crypto')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{gzipSync}=require('node:zlib')
const assert=require('node:assert/strict')
const {CONSTRUCTION_CHART_TEMPLATE}=require('../lib/services/books/chart-of-accounts')
const {draftFromFact,hashableFactPayload}=require('../lib/services/books/fact-drafts')
const {booksDigest}=require('../lib/services/books/hash')
const {directSettlementEvidence}=require('../lib/services/books/settlement-evidence')
const {cashInvoiceIncomeFromSnapshot}=require('../lib/services/books/cash-income-snapshot')
const {cashCostBasisFromBillJournal,allocateCashBillCosts}=require('../lib/services/books/cash-costs')
const {cashBillSettlementsFromLedger}=require('../lib/services/books/cash-settlement-ledger')
const {cashBillCostsFromSnapshot}=require('../lib/services/books/cash-cost-snapshot')
const {cashDirectExpensesFromSnapshot}=require('../lib/services/books/cash-expense-snapshot')
const {verifyBooksExportBundle,EXPORT_TABLES,BOOKS_EXPORT_SCHEMA_VERSION}=require('../lib/services/books/export-contract')
const {historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive')
const {preflightBooksRestore}=require('../lib/services/books/restore-preflight')
const {prepareBooksRestorePlan}=require('../lib/services/books/restore-plan')
const {cashProfitAndLossFromSnapshot}=require('../lib/services/books/cash-profit-loss')
const {taxAttachmentFromFile}=require('../lib/services/books/tax-attachment-rules')
const {cashTaxWorkpaperBasis,reconcileTaxWorkpaper}=require('../lib/services/books/tax-adjustment-rules')
const {cashSettlementAncillaryFromSnapshot}=require('../lib/services/books/cash-settlement-ancillary')
const container=process.argv[2]
if(!/^supabase_db_arc-books-acceptance-[a-z0-9-]+$/.test(container??''))throw new Error('Pass the explicitly isolated Arc Books acceptance container name')
const q=value=>"'"+String(value).replaceAll("'","''")+"'"
const json=value=>q(JSON.stringify(value))+'::jsonb'
const org=randomUUID(),actor=randomUUID(),reviewer=randomUUID(),taxRole=randomUUID(),project=randomUUID(),general=randomUUID(),progress=randomUUID(),payment=randomUUID(),refund=randomUUID()
const jurisdiction=randomUUID()
const file=randomUUID(),documentBytes=Buffer.from('Synthetic invoice backup: construction cash accounting restoration drill.\n'),documentPath=org+'/recovery/invoice-backup.txt'
const documentChecksum=createHash('sha256').update(documentBytes).digest('hex')
const revisedDocumentBytes=Buffer.from('Later revision: original reviewed construction evidence must remain available.\n'),revisedDocumentPath=org+'/recovery/invoice-backup-revised.txt'
const revisedDocumentChecksum=createHash('sha256').update(revisedDocumentBytes).digest('hex')
const supportingFiles=[{id:file,storagePath:documentPath,sizeBytes:documentBytes.length,checksum:documentChecksum}]
const supportingObjects=[{fileId:file,dataBase64:documentBytes.toString('base64')}]
const accountIds=new Map(CONSTRUCTION_CHART_TEMPLATE.map(account=>[account.code,randomUUID()]))
const sql=['begin;']
sql.push(`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at,raw_app_meta_data,raw_user_meta_data) values(${q(actor)},'00000000-0000-0000-0000-000000000000','authenticated','authenticated',${q(actor+'@example.test')},'',now(),now(),'{}','{}');`)
sql.push(`insert into app_users(id,email,full_name) values(${q(actor)},${q(actor+'@example.test')},'Cash income acceptance');`)
sql.push(`insert into auth.users(id,email) values(${q(reviewer)},${q(reviewer+'@example.test')});`)
sql.push(`insert into app_users(id,email,full_name) values(${q(reviewer)},${q(reviewer+'@example.test')},'Independent tax reviewer');`)
sql.push(`insert into orgs(id,name,slug,created_by) values(${q(org)},'Cash income acceptance',${q(org)},${q(actor)});`)
sql.push(`insert into projects(id,org_id,name) values(${q(project)},${q(org)},'POC construction workflow');`)
sql.push(`insert into books_tax_jurisdictions(id,org_id,name,sales_tax_rate_micros,effective_from) values(${q(jurisdiction)},${q(org)},'Acceptance jurisdiction',70000,'2026-01-01');`)
for(const account of CONSTRUCTION_CHART_TEMPLATE)sql.push(`insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values(${q(accountIds.get(account.code))},${q(org)},${q(account.code)},${q(account.name)},${q(account.accountType)},${q(account.subtype)},${q(account.normalBalance)});`)
// Native income allocations exercise independent general and progress billing.
const nativeAccounts=[{code:'4010',id:randomUUID()},{code:'4020',id:randomUUID()}]
for(const account of nativeAccounts){accountIds.set(account.code,account.id);sql.push(`insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values(${q(account.id)},${q(org)},${q(account.code)},'Native income','income','construction_revenue','credit');`)}
function projectFact(sourceType,sourceId,date,payload,table,expected='null',version=1,writer=sql){
 const draft=draftFromFact({sourceType,sourceId,accountingDate:date,sourceVersion:version,projectionVersion:1,policyVersion:1,payload})
 const fact={source_type:sourceType,source_id:sourceId,source_version:version,fact_kind:sourceType+'.recognized',occurred_at:date+'T12:00:00Z',accounting_date:date,payload,payload_hash:booksDigest({accountingDate:date,payload:hashableFactPayload(sourceType,payload)}),policy_version:1,idempotency_key:sourceType+':'+sourceId+':'+version}
 const entry={entry_date:date,entry_kind:draft.entryKind,memo:draft.memo,posting_key:draft.postingKey,projection_version:1,policy_version:1,source_type:draft.sourceType,source_id:draft.sourceId}
 const lines=draft.lines.map((line,i)=>({line_no:i+1,account_id:accountIds.get(line.accountCode),project_id:line.projectId??null,company_id:line.companyId??null,description:line.description??null,debit_cents:line.debitCents,credit_cents:line.creditCents,dimensions:line.dimensions??{}}))
 const name='projection_'+writer.length
 writer.push(`create temporary table ${name} as select project_books_fact_and_journal_atomic(${q(org)},${expected},jsonb_set(${json(fact)},'{occurred_at}',to_jsonb((select updated_at from ${table} where id=${q(sourceId)}))),${json(entry)},${json(lines)},${q(date)},'Acceptance correction') result;`)
 writer.push(`select record_books_projection_receipt(${q(org)},${q(sourceType)},${q(sourceId)},(select updated_at from ${table} where id=${q(sourceId)}),(result->>'fact_id')::uuid,(result->>'journal_id')::uuid) from ${name};`)
 return name
}
for(const [invoiceId,gross,tax,code,basis,job] of [[general,10700,700,'4010','on_invoice',null],[progress,5350,350,'4020','percentage_of_completion',project]]){
 sql.push(`insert into invoices(id,org_id,project_id,invoice_number,status,issue_date,total_cents,tax_cents,balance_due_cents,tax_jurisdiction_id) values(${q(invoiceId)},${q(org)},${job?q(job):'null'},${q(invoiceId)},'sent','2026-09-01',${gross},${tax},${gross},${q(jurisdiction)});`)
 sql.push(`insert into invoice_lines(org_id,invoice_id,description,quantity,unit_price_cents,metadata) values(${q(org)},${q(invoiceId)},'Native services',1,${gross-tax},${json({arc_books_gl_account_id:accountIds.get(code)})});`)
 projectFact('invoice',invoiceId,'2026-09-01',{total_cents:gross,tax_cents:tax,retainage_cents:0,revenue_basis:basis,revenue_lines:[{account_code:code,amount_cents:gross-tax}],project_id:job},'invoices')
}
sql.push(`insert into payments(id,org_id,amount_cents,gross_cents,fee_cents,net_cents,status,received_at) values(${q(payment)},${q(org)},8025,8075,125,7950,'completed','2026-09-20T12:00:00Z');`)
const allocations=[{allocation_id:randomUUID(),invoice_id:general,bill_id:null,project_id:null,amount_cents:5350},{allocation_id:randomUUID(),invoice_id:progress,bill_id:null,project_id:project,amount_cents:2675}]
for(const allocation of allocations)sql.push(`insert into payment_allocations(id,org_id,payment_id,invoice_id,project_id,amount_cents) values(${q(allocation.allocation_id)},${q(org)},${q(payment)},${q(allocation.invoice_id)},${allocation.project_id?q(allocation.project_id):'null'},${allocation.amount_cents});`)
const paymentProjection=projectFact('invoice_payment',payment,'2026-09-20',{amount_cents:8025,gross_cents:8075,fee_cents:125,settlement_evidence:{version:2,kind:'allocated',payment_id:payment,payment_amount_cents:8025,allocations}},'payments')
sql.push(`select 'SNAPSHOT_INITIAL='||capture_books_export_snapshot(${q(org)})::text;`)
sql.push(`update payments set fee_cents=200,net_cents=7875 where id=${q(payment)};`)
projectFact('invoice_payment',payment,'2026-09-20',{amount_cents:8025,gross_cents:8075,fee_cents:200,settlement_evidence:{version:2,kind:'allocated',payment_id:payment,payment_amount_cents:8025,allocations}},'payments',`(select (result->>'fact_id')::uuid from ${paymentProjection})`,2)
sql.push(`select 'SNAPSHOT_CORRECTED='||capture_books_export_snapshot(${q(org)})::text;`)
sql.push(`insert into payment_reversals(id,org_id,payment_id,invoice_id,amount_cents,status,reversal_type,occurred_at) values(${q(refund)},${q(org)},${q(payment)},${q(general)},1070,'succeeded','refund','2026-10-10T12:00:00Z');`)
projectFact('payment_reversal',refund,'2026-10-10',{amount_cents:1070,side:'invoice_payment',settlement_evidence:directSettlementEvidence({paymentId:payment,invoiceId:general})},'payment_reversals')
sql.push(`select 'SNAPSHOT_REFUND='||capture_books_export_snapshot(${q(org)})::text;`)
const bill=randomUUID(),supplierPayment=randomUUID(),supplierRefund=randomUUID(),costCode=randomUUID()
sql.push(`insert into vendor_bills(id,org_id,project_id,bill_number,status,bill_date,total_cents) values(${q(bill)},${q(org)},${q(project)},'Paid cost fixture','approved','2026-09-01',10000);`)
projectFact('vendor_bill',bill,'2026-09-01',{total_cents:10000,project_id:project,cost_lines:[{account_code:'5000',amount_cents:6000,project_id:project,dimensions:{cost_code_id:costCode}},{account_code:'6000',amount_cents:3000,project_id:null},{account_code:'1500',amount_cents:1000,project_id:project}]},'vendor_bills')
sql.push(`insert into payments(id,org_id,bill_id,amount_cents,status,received_at) values(${q(supplierPayment)},${q(org)},${q(bill)},5000,'completed','2026-09-20T12:00:00Z');`)
projectFact('bill_payment',supplierPayment,'2026-09-20',{amount_cents:5000,project_id:project,settlement_evidence:directSettlementEvidence({paymentId:supplierPayment,billId:bill})},'payments')
sql.push(`insert into payment_reversals(id,org_id,payment_id,bill_id,amount_cents,status,reversal_type,occurred_at) values(${q(supplierRefund)},${q(org)},${q(supplierPayment)},${q(bill)},1000,'succeeded','refund','2026-10-10T12:00:00Z');`)
projectFact('payment_reversal',supplierRefund,'2026-10-10',{amount_cents:1000,side:'bill_payment',project_id:project,settlement_evidence:directSettlementEvidence({paymentId:supplierPayment,billId:bill})},'payment_reversals')
// Live chart edits must not rewrite the classification of already-posted purchases or income.
sql.push(`update gl_accounts set code='6998',account_type='expense',subtype='other_expense' where id=${q(accountIds.get('1500'))};`)
sql.push(`update gl_accounts set code='4998' where id=${q(accountIds.get('4010'))};`)
const expense=randomUUID()
sql.push(`insert into project_expenses(id,org_id,project_id,expense_date,amount_cents,tax_cents,payment_method,status,description) values(${q(expense)},${q(org)},${q(project)},'2026-09-21',3000,0,'cash','approved','Direct native purchase');`)
const expenseProjection=projectFact('expense',expense,'2026-09-21',{amount_cents:3000,project_id:project,cost_lines:[{account_code:'5000',amount_cents:2000,project_id:project,dimensions:{cost_code_id:costCode}},{account_code:'6000',amount_cents:1000,project_id:project}]},'project_expenses')
sql.push(`update project_expenses set expense_date='2026-10-11',amount_cents=2700 where id=${q(expense)};`)
projectFact('expense',expense,'2026-10-11',{amount_cents:2700,project_id:project,cost_lines:[{account_code:'5000',amount_cents:1800,project_id:project,dimensions:{cost_code_id:costCode}},{account_code:'6000',amount_cents:900,project_id:project}]},'project_expenses',`(select (result->>'fact_id')::uuid from ${expenseProjection})`,2)
const fundingSource=randomUUID(),paymentRun=randomUUID(),feeCharge=randomUUID()
sql.push(`insert into org_funding_sources(id,org_id,provider,provider_customer_id,provider_payment_method_id,created_by) values(${q(fundingSource)},${q(org)},'acceptance','customer','method',${q(actor)});`)
sql.push(`insert into payment_runs(id,org_id,funding_source_id,approval_mode_snapshot,required_approvals,idempotency_key,requested_by) values(${q(paymentRun)},${q(org)},${q(fundingSource)},'sole',1,${q(paymentRun)},${q(actor)});`)
sql.push(`insert into payment_run_fee_charges(id,org_id,run_id,funding_source_id,provider,status,processor_fee_cents,platform_fee_cents,amount_cents,idempotency_key,settled_at) values(${q(feeCharge)},${q(org)},${q(paymentRun)},${q(fundingSource)},'acceptance','succeeded',200,100,300,${q(feeCharge)},'2026-09-20T12:00:00Z');`)
projectFact('ap_fee_charge',feeCharge,'2026-09-20',{amount_cents:300},'payment_run_fee_charges')
sql.push(`insert into files(id,org_id,project_id,file_name,storage_path,mime_type,size_bytes,checksum,uploaded_by,category,source) values(${q(file)},${q(org)},${q(project)},'invoice-backup.txt',${q(documentPath)},'text/plain',${documentBytes.length},${q(documentChecksum)},${q(actor)},'financials','upload');`)
sql.push(`select public.commit_document_version(${q(org)},${q(file)},${q(actor)},${json({storage_path:documentPath,file_name:'invoice-backup.txt',mime_type:'text/plain',size_bytes:documentBytes.length,checksum:documentChecksum})},true);`)
sql.push(`insert into file_links(org_id,file_id,project_id,entity_type,entity_id,created_by,link_role) values(${q(org)},${q(file)},${q(project)},'invoice',${q(progress)},${q(actor)},'invoice_backup');`)
sql.push(`select 'SNAPSHOT_COSTS='||capture_books_tax_workpaper_context(${q(org)},'2026-10-31')::text;`)
sql.push(`create function pg_temp.probe_redacted_funding_restore() returns jsonb language plpgsql as $$ declare failed_column text; begin begin insert into public.org_funding_sources select * from jsonb_populate_record(null::public.org_funding_sources,(select to_jsonb(f)-array['provider_customer_id','provider_payment_method_id','provider_mandate_id','created_by'] from public.org_funding_sources f where id=${q(fundingSource)})); raise exception 'Redacted funding restore unexpectedly succeeded'; exception when not_null_violation then get stacked diagnostics failed_column=column_name; return jsonb_build_object('sqlstate','23502','column',failed_column); end; end $$;`)
sql.push(`select 'SNAPSHOT_RESTORE_PROBE='||pg_temp.probe_redacted_funding_restore()::text;`)
sql.push(`select 'SNAPSHOT_IDENTITIES='||jsonb_build_object('organization',(select to_jsonb(o) from public.orgs o where id=${q(org)}),'actor',(select to_jsonb(u) from public.app_users u where id=${q(actor)}),'reviewer',(select to_jsonb(u) from public.app_users u where id=${q(reviewer)}),'authentication',jsonb_build_object('id',${q(actor)},'email',${q(actor+'@example.test')},'banned_until','infinity'),'reviewerAuthentication',jsonb_build_object('id',${q(reviewer)},'email',${q(reviewer+'@example.test')},'banned_until','infinity'))::text;`)
const catalogTables=[...EXPORT_TABLES,'orgs','app_users'].map(q).join(',')
sql.push(`select 'SNAPSHOT_CATALOG='||jsonb_build_object('columns',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',a.attname,'notNull',a.attnotnull,'hasDefault',a.atthasdef,'generated',a.attgenerated<>'')) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid where ((n.nspname='public' and c.relname in(${catalogTables})) or (n.nspname='auth' and c.relname='users')) and a.attnum>0 and not a.attisdropped),'foreignKeys',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'match',case when f.confmatchtype='f' then 'full' else 'simple' end,'columns',(select jsonb_agg(a.attname order by k.ordinality) from unnest(f.conkey) with ordinality k(attnum,ordinality) join pg_attribute a on a.attrelid=f.conrelid and a.attnum=k.attnum),'targetSchema',rn.nspname,'targetTable',rc.relname,'targetColumns',(select jsonb_agg(a.attname order by k.ordinality) from unnest(f.confkey) with ordinality k(attnum,ordinality) join pg_attribute a on a.attrelid=f.confrelid and a.attnum=k.attnum))) from pg_constraint f join pg_class c on c.oid=f.conrelid join pg_namespace n on n.oid=c.relnamespace join pg_class rc on rc.oid=f.confrelid join pg_namespace rn on rn.oid=rc.relnamespace where f.contype='f' and ((n.nspname='public' and c.relname in(${catalogTables})) or (n.nspname='auth' and c.relname='users'))))::text;`)
sql.push('set constraints all immediate; rollback;')
sql.push(`select 'ROLLBACK_COUNT='||((select count(*) from orgs where id=${q(org)})+(select count(*) from app_users where id in(${q(actor)},${q(reviewer)}))+(select count(*) from auth.users where id in(${q(actor)},${q(reviewer)}))+(select count(*) from roles where id=${q(taxRole)})+(select count(*) from memberships where org_id=${q(org)}))::text;`)
const output=execFileSync('docker',['exec','-i',container,'psql','-X','-U','postgres','-d','postgres','-At','-v','ON_ERROR_STOP=1'],{input:sql.join('\n'),encoding:'utf8',maxBuffer:128*1024*1024,timeout:120000})
const snapshots={}
for(const line of output.split('\n'))if(line.startsWith('SNAPSHOT_')){const separator=line.indexOf('=');snapshots[line.slice(0,separator)]=JSON.parse(line.slice(separator+1))}
assert.ok(output.split('\n').includes('ROLLBACK_COUNT=0'),'all org/user fixtures must disappear after rollback')
const initial=cashInvoiceIncomeFromSnapshot(org,'2026-09-01','2026-09-30',snapshots.SNAPSHOT_INITIAL)
assert.equal(initial.incomeCents,7500);assert.equal(initial.salesTaxCents,525);assert.equal(initial.appliedPrincipalCents,8025)
assert.equal(initial.rows.find(row=>row.accountCode==='4020').dimensions.project_id,project)
const corrected=cashInvoiceIncomeFromSnapshot(org,'2026-09-01','2026-09-30',snapshots.SNAPSHOT_CORRECTED)
assert.deepEqual(corrected.rows,initial.rows)
assert.ok(corrected.settlementEvidence.length>initial.settlementEvidence.length,'real correction must include original, reversal and replacement')
const septemberAfterRefund=cashInvoiceIncomeFromSnapshot(org,'2026-09-01','2026-09-30',snapshots.SNAPSHOT_REFUND)
assert.deepEqual(septemberAfterRefund.rows,initial.rows)
const october=cashInvoiceIncomeFromSnapshot(org,'2026-10-01','2026-10-31',snapshots.SNAPSHOT_REFUND)
assert.equal(october.incomeCents,-1000);assert.equal(october.salesTaxCents,-70)
const total=cashInvoiceIncomeFromSnapshot(org,'2026-09-01','2026-10-31',snapshots.SNAPSHOT_REFUND)
assert.equal(total.incomeCents,6500);assert.equal(total.salesTaxCents,455);assert.equal(total.appliedPrincipalCents,6955)
const stale=structuredClone(snapshots.SNAPSHOT_REFUND);stale.tables.books_projection_receipts=stale.tables.books_projection_receipts.filter(row=>row.source_type!=='invoice_payment')
assert.throws(()=>cashInvoiceIncomeFromSnapshot(org,'2026-09-01','2026-10-31',stale),/Refresh/)
assert.deepEqual(cashInvoiceIncomeFromSnapshot(org,'2026-09-01','2026-10-31',snapshots.SNAPSHOT_COSTS).rows,total.rows,'posted income codes survive later chart edits')
const costSnapshot=snapshots.SNAPSHOT_COSTS.tables
const billFact=costSnapshot.accounting_facts.find(row=>row.source_type==='vendor_bill'&&row.source_id===bill)
const billEntry=costSnapshot.journal_entries.find(row=>row.fact_id===billFact.id&&!row.reversal_of_entry_id)
const costBasis=cashCostBasisFromBillJournal({factId:billFact.id,billId:bill,accountingDate:billFact.accounting_date,grossCents:10000,useTaxCents:0,lines:costSnapshot.journal_lines.filter(row=>row.entry_id===billEntry.id),completeSettlementHistory:true})
const vendorEntries=costSnapshot.journal_entries.filter(row=>['bill_payment','payment_reversal'].includes(row.source_type))
const vendorIds=new Set(vendorEntries.map(row=>row.id))
const vendorEvents=cashBillSettlementsFromLedger({entries:vendorEntries,facts:costSnapshot.accounting_facts,lines:costSnapshot.journal_lines.filter(row=>vendorIds.has(row.entry_id)).map(row=>({...row,account_code:row.dimensions.books_account_classification.code}))})
const costs=(startDate,endDate)=>allocateCashBillCosts({startDate,endDate,documents:[costBasis],settlements:vendorEvents.map(row=>({...row,snapshotId:costBasis.snapshotId}))})
const septemberCosts=costs('2026-09-01','2026-09-30'),octoberCosts=costs('2026-10-01','2026-10-31'),totalCosts=costs('2026-09-01','2026-10-31')
assert.equal(septemberCosts.cogsCents,3000);assert.equal(septemberCosts.expenseCents,1500);assert.equal(septemberCosts.capitalizedCents,500)
assert.equal(octoberCosts.appliedPrincipalCents,-1000)
assert.equal(totalCosts.cogsCents,2400);assert.equal(totalCosts.expenseCents,1200);assert.equal(totalCosts.capitalizedCents,400)
assert.equal(totalCosts.rows.find(row=>row.kind==='cogs').dimensions.cost_code_id,costCode)
assert.equal(totalCosts.rows.find(row=>row.kind==='capitalized').accountCode,'1500')
assert.equal(septemberCosts.appliedPrincipalCents+octoberCosts.appliedPrincipalCents,totalCosts.appliedPrincipalCents)
const reconciledCosts=cashBillCostsFromSnapshot(org,'2026-09-01','2026-10-31',snapshots.SNAPSHOT_COSTS)
assert.deepEqual(reconciledCosts.rows,totalCosts.rows)
const omittedCost=structuredClone(snapshots.SNAPSHOT_COSTS);omittedCost.tables.books_projection_receipts=omittedCost.tables.books_projection_receipts.filter(row=>row.source_type!=='bill_payment')
assert.throws(()=>cashBillCostsFromSnapshot(org,'2026-09-01','2026-10-31',omittedCost),/Refresh/)
const directCosts=cashDirectExpensesFromSnapshot(org,'2026-09-01','2026-10-31',snapshots.SNAPSHOT_COSTS)
assert.equal(directCosts.cogsCents,1800);assert.equal(directCosts.expenseCents,900);assert.equal(directCosts.paidPrincipalCents,2700)
assert.equal(directCosts.rows.find(row=>row.kind==='cogs').dimensions.cost_code_id,costCode)
assert.equal(cashDirectExpensesFromSnapshot(org,'2026-10-01','2026-10-31',snapshots.SNAPSHOT_COSTS).paidPrincipalCents,2700)
assert.equal(cashDirectExpensesFromSnapshot(org,'2026-09-01','2026-09-30',snapshots.SNAPSHOT_COSTS).paidPrincipalCents,0)
const missingExpense=structuredClone(snapshots.SNAPSHOT_COSTS);missingExpense.tables.books_projection_receipts=missingExpense.tables.books_projection_receipts.filter(row=>row.source_type!=='expense')
assert.throws(()=>cashDirectExpensesFromSnapshot(org,'2026-09-01','2026-10-31',missingExpense),/Refresh/)
assert.equal(costSnapshot.payment_run_fee_charges.length,1)
assert.equal(costSnapshot.payment_run_fee_charges[0].amount_cents,300)
const recovery=verifyBooksExportBundle({tables:costSnapshot,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(Object.entries(costSnapshot).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles,supportingHistoricalFiles:historicalDocumentInventory(costSnapshot,org)},supportingObjects,supportingHistoricalObjects:[]})
assert.equal(recovery.valid,true,JSON.stringify(recovery))
const ancillary=cashSettlementAncillaryFromSnapshot(org,'2026-09-01','2026-10-31',snapshots.SNAPSHOT_COSTS)
assert.equal(ancillary.feeExpenseCents,500);assert.equal(ancillary.ancillaryIncomeCents,50)
assert.equal(ancillary.rows.filter(row=>row.accountCode==='4920'&&row.dimensions.project_id===project).reduce((sum,row)=>sum+row.amountCents,0),17)
const omittedFee=structuredClone(snapshots.SNAPSHOT_COSTS);omittedFee.tables.payment_run_fee_charges=[]
assert.throws(()=>cashSettlementAncillaryFromSnapshot(org,'2026-09-01','2026-10-31',omittedFee),/operational source history/)
const cashPnl=cashProfitAndLossFromSnapshot(org,'2026-09-01','2026-10-31',snapshots.SNAPSHOT_COSTS)
assert.equal(cashPnl.revenueCents,6550);assert.equal(cashPnl.cogsCents,4200);assert.equal(cashPnl.expenseCents,2600);assert.equal(cashPnl.netIncomeCents,-250)
assert.equal(cashPnl.netCashMovementCents,-195);assert.equal(cashPnl.salesTaxCollectedCents,455);assert.equal(cashPnl.capitalizedPurchasesCents,400);assert.equal(cashPnl.paidPurchasePrincipalCents,6700)
const septemberPnl=cashProfitAndLossFromSnapshot(org,'2026-09-01','2026-09-30',snapshots.SNAPSHOT_COSTS),octoberPnl=cashProfitAndLossFromSnapshot(org,'2026-10-01','2026-10-31',snapshots.SNAPSHOT_COSTS)
for(const key of ['revenueCents','cogsCents','expenseCents','netIncomeCents','netCashMovementCents','salesTaxCollectedCents','capitalizedPurchasesCents'])assert.equal(septemberPnl[key]+octoberPnl[key],cashPnl[key],key+' must telescope by month')
const restoreTables=structuredClone(costSnapshot)
// Exercise the actual provider-field redaction performed by the export service.
restoreTables.org_funding_sources=restoreTables.org_funding_sources.map(record=>Object.fromEntries(['id','org_id','provider','bank_name','account_type','last4','status','books_gl_account_id','created_at','updated_at'].map(key=>[key,record[key]])))
const restoreBundle={tables:restoreTables,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(Object.entries(restoreTables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles,supportingHistoricalFiles:historicalDocumentInventory(restoreTables,org)},supportingObjects,supportingHistoricalObjects:[]}
const restorePreflight=preflightBooksRestore(restoreBundle,snapshots.SNAPSHOT_CATALOG)
assert.equal(restorePreflight.readyForRestoreAttempt,false)
assert.equal(snapshots.SNAPSHOT_RESTORE_PROBE.sqlstate,'23502');assert.equal(snapshots.SNAPSHOT_RESTORE_PROBE.column,'provider_customer_id')
assert.ok(restorePreflight.blockers.some(blocker=>blocker.table==='org_funding_sources'&&blocker.column==='provider_customer_id'))
assert.ok(restorePreflight.externalDependencies.some(dependency=>dependency.targetTable==='orgs'))
assert.ok(restorePreflight.externalDependencies.some(dependency=>dependency.targetTable==='app_users'))
const identities=snapshots.SNAPSHOT_IDENTITIES
const restorePlan=prepareBooksRestorePlan({bundle:restoreBundle,catalog:snapshots.SNAPSHOT_CATALOG,dependencies:[{schema:'public',table:'orgs',rows:[identities.organization]},{schema:'public',table:'app_users',rows:[identities.actor,identities.reviewer]},{schema:'auth',table:'users',rows:[identities.authentication,identities.reviewerAuthentication]}],fundingActors:{[fundingSource]:{actorId:actor,explanation:'Fixture actor owns the source funding record; provider access stays disconnected'}}})
assert.equal(restorePlan.preflight.readyForRestoreAttempt,true,JSON.stringify(restorePlan.preflight))
function restorationSql(plan) {
const writer=['begin;',`do $$ begin if exists(select 1 from public.orgs where id=${q(org)}) or exists(select 1 from auth.users where id in(${q(actor)},${q(reviewer)})) then raise exception 'Restore fixture target identities must be absent'; end if; end $$;`,'set local session_replication_role=replica;']
const quotedIdentifier=value=>'"'+String(value).replaceAll('"','""')+'"'
const records=[...plan.dependencies,...Object.entries(plan.tables).map(([table,rows])=>({schema:'public',table,rows}))]
for(const group of records)for(const record of group.rows){
 const names=Object.keys(record),target=quotedIdentifier(group.schema)+'.'+quotedIdentifier(group.table)
 writer.push(`insert into ${target}(${names.map(quotedIdentifier).join(',')}) select ${names.map(quotedIdentifier).join(',')} from jsonb_populate_record(null::${target},${json(record)});`)
}
writer.push('set local session_replication_role=origin;')
// Replica insertion skips FK triggers for cyclic historical dependencies. Check
// every actual foreign key explicitly before accepting any restoration evidence.
for(const fk of snapshots.SNAPSHOT_CATALOG.foreignKeys){
 const group=records.find(group=>group.schema===(fk.schema??'public')&&group.table===fk.table)
 if(!group?.rows.length)continue
 const left=quotedIdentifier(fk.schema??'public')+'.'+quotedIdentifier(fk.table),right=quotedIdentifier(fk.targetSchema)+'.'+quotedIdentifier(fk.targetTable)
 const present=fk.columns.map(column=>'l.'+quotedIdentifier(column)+' is not null').join(' and ')
 const matches=fk.columns.map((column,i)=>'r.'+quotedIdentifier(fk.targetColumns[i])+'=l.'+quotedIdentifier(column)).join(' and ')
 const rowIds=group.rows.map(record=>q(record.id)).join(',')
 writer.push(`do $$ begin if exists(select 1 from ${left} l where l.id in(${rowIds}) and ${present} and not exists(select 1 from ${right} r where ${matches})) then raise exception 'Restored foreign key mismatch in ${fk.table}'; end if; end $$;`)
}
return writer
}
const restoreSql=restorationSql(restorePlan)
const taxBasis=cashTaxWorkpaperBasis(cashPnl,snapshots.SNAPSHOT_COSTS.taxSourceRevision)
const taxAttachment=taxAttachmentFromFile(org,costSnapshot.files.find(row=>row.id===file))
const taxLines=[{id:randomUUID(),kind:'permanent',amount_cents:500,description:'Reviewed permanent fixture difference',evidence_reference:'Accountant calculation TAX-1',evidence_file_id:file,project_id:project,evidence_snapshot:taxAttachment},{id:randomUUID(),kind:'timing',amount_cents:-200,description:'Reviewed timing fixture difference',evidence_reference:'Accountant calculation TAX-2',evidence_file_id:file,project_id:project,evidence_snapshot:taxAttachment}]
function taxMembershipSql() { return [
 `insert into public.roles(id,key,label,scope) values(${q(taxRole)},${q('tax-acceptance-'+taxRole)},'Tax drill accounting','org');`,
 `insert into public.memberships(org_id,user_id,role_id) values(${q(org)},${q(actor)},${q(taxRole)}),(${q(org)},${q(reviewer)},${q(taxRole)});`,
] }
restoreSql.push(...taxMembershipSql(),'set local role service_role;')
restoreSql.push(`select prepare_books_tax_workpaper(${q(org)},${q(actor)},'2026-09-01','2026-10-31',${q(taxBasis.digest)},${json(taxBasis.snapshot)},${json(taxLines)},'native-tax-adjusted-key',null,'Reviewed posted native construction source evidence');`)
const taxIdFor=key=>`(select id from public.books_tax_adjustment_workpapers where org_id=${q(org)} and idempotency_key=${q(key)})`
restoreSql.push(`select review_books_tax_workpaper(${q(org)},${taxIdFor('native-tax-adjusted-key')},${q(reviewer)},${q(taxBasis.digest)},'Independently reconciled native receipts and tax calculations TAX-1 and TAX-2');`)
restoreSql.push(`select 'TAX_ADJUSTED='||capture_books_tax_workpaper_context(${q(org)},'2026-10-31')::text;`)
restoreSql.push(`select prepare_books_tax_workpaper(${q(org)},${q(actor)},'2026-09-01','2026-10-31',${q(taxBasis.digest)},${json(taxBasis.snapshot)},'[]','native-tax-confirmed-key',${taxIdFor('native-tax-adjusted-key')},'Reviewed revised TAX-3 calculation and native evidence; no adjustments remain');`)
restoreSql.push(`select review_books_tax_workpaper(${q(org)},${taxIdFor('native-tax-confirmed-key')},${q(reviewer)},${q(taxBasis.digest)},'Independently checked TAX-3 and replacement removes both differences');`)
restoreSql.push(`select prepare_books_tax_workpaper(${q(org)},${q(actor)},'2026-09-01','2026-10-31',${q(taxBasis.digest)},${json(taxBasis.snapshot)},${json(taxLines)},'native-tax-withdrawn-key',${taxIdFor('native-tax-confirmed-key')},'Duplicate replacement entered for withdrawal acceptance');`)
restoreSql.push(`select withdraw_books_tax_workpaper(${q(org)},${taxIdFor('native-tax-withdrawn-key')},${q(actor)},'Duplicate replacement draft entered in error');`,'reset role;')
restoreSql.push(`select 'RESTORED='||capture_books_tax_workpaper_context(${q(org)},'2026-10-31')::text;`)
// Advance through the ordinary document-version RPC after tax evidence freezes.
// Both the archived original and current pointer must survive reconstruction.
restoreSql.push(`select public.commit_document_version(${q(org)},${q(file)},${q(actor)},${json({storage_path:revisedDocumentPath,file_name:'invoice-backup-revised.txt',mime_type:'text/plain',size_bytes:revisedDocumentBytes.length,checksum:revisedDocumentChecksum})},false);`)
restoreSql.push(`select 'DOCUMENT_ADVANCED='||capture_books_tax_workpaper_context(${q(org)},'2026-10-31')::text;`)


// With all normal triggers re-enabled, prove a new source can post against the
// restored organization, chart and project without changing historical entries.
const postRestoreExpense=randomUUID()
restoreSql.push(`insert into project_expenses(id,org_id,project_id,expense_date,amount_cents,tax_cents,payment_method,status,description) values(${q(postRestoreExpense)},${q(org)},${q(project)},'2026-10-12',111,0,'cash','approved','Post-restoration transaction');`)
projectFact('expense',postRestoreExpense,'2026-10-12',{amount_cents:111,project_id:project,cost_lines:[{account_code:'5000',amount_cents:111,project_id:project}]},'project_expenses','null',1,restoreSql)
restoreSql.push(`select 'POST_RESTORE='||capture_books_tax_workpaper_context(${q(org)},'2026-10-31')::text;`);
restoreSql.push(`create function pg_temp.tax_stale_review_probe() returns text language plpgsql as $$ begin perform public.review_books_tax_workpaper(${q(org)},${taxIdFor('native-tax-confirmed-key')},${q(reviewer)},${q(taxBasis.digest)},'Independently checked TAX-3 and replacement removes both differences'); return 'unexpected approval'; exception when raise_exception then return sqlerrm; end $$;`)
restoreSql.push(`select 'TAX_STALE_REVIEW='||pg_temp.tax_stale_review_probe();`,'rollback;',`select 'RESTORE_ROLLBACK_COUNT='||((select count(*) from orgs where id=${q(org)})+(select count(*) from app_users where id in(${q(actor)},${q(reviewer)}))+(select count(*) from auth.users where id in(${q(actor)},${q(reviewer)}))+(select count(*) from roles where id=${q(taxRole)})+(select count(*) from memberships where org_id=${q(org)}))::text;`)
const restoreOutput=execFileSync('docker',['exec','-i',container,'psql','-X','-U','postgres','-d','postgres','-At','-v','ON_ERROR_STOP=1'],{input:restoreSql.join('\n'),encoding:'utf8',maxBuffer:128*1024*1024,timeout:120000})
assert.ok(restoreOutput.split('\n').includes('RESTORE_ROLLBACK_COUNT=0'))
const restored=JSON.parse(restoreOutput.split('\n').find(line=>line.startsWith('RESTORED=')).slice('RESTORED='.length))
for(const [table,rows] of Object.entries(costSnapshot))if(!['org_funding_sources','books_tax_adjustment_workpapers'].includes(table))assert.equal(booksDigest(restored.tables[table]),booksDigest(rows),'restored table differs: '+table)
assert.equal(restored.tables.org_funding_sources[0].status,'disabled')
assert.ok(restored.tables.org_funding_sources[0].provider_customer_id.startsWith('restore-disconnected:'))
assert.deepEqual(cashInvoiceIncomeFromSnapshot(org,'2026-09-01','2026-10-31',restored).rows,total.rows)
assert.deepEqual(cashBillCostsFromSnapshot(org,'2026-09-01','2026-10-31',restored).rows,totalCosts.rows)
assert.deepEqual(cashDirectExpensesFromSnapshot(org,'2026-09-01','2026-10-31',restored).rows,directCosts.rows)
assert.deepEqual(cashSettlementAncillaryFromSnapshot(org,'2026-09-01','2026-10-31',restored).rows,ancillary.rows)
const postRestore=JSON.parse(restoreOutput.split('\n').find(line=>line.startsWith('POST_RESTORE=')).slice('POST_RESTORE='.length))
const postRestoreCosts=cashDirectExpensesFromSnapshot(org,'2026-09-01','2026-10-31',postRestore)
assert.equal(postRestoreCosts.cogsCents,directCosts.cogsCents+111)
assert.equal(postRestoreCosts.expenseCents,directCosts.expenseCents)
assert.equal(postRestoreCosts.paidPrincipalCents,directCosts.paidPrincipalCents+111)
assert.equal(postRestore.tables.books_projection_receipts.filter(row=>row.source_type==='expense'&&row.source_id===postRestoreExpense).length,1)
assert.deepEqual(cashProfitAndLossFromSnapshot(org,'2026-09-01','2026-10-31',restored).rows,cashPnl.rows)
assert.equal(cashProfitAndLossFromSnapshot(org,'2026-09-01','2026-10-31',postRestore).netIncomeCents,cashPnl.netIncomeCents-111)
const snapshotLine=(output,prefix)=>JSON.parse(output.split('\n').find(line=>line.startsWith(prefix+'=')).slice(prefix.length+1))
function taxReportFromCaptured(snapshot) {
 const report=cashProfitAndLossFromSnapshot(org,'2026-09-01','2026-10-31',snapshot)
 const basis=cashTaxWorkpaperBasis(report,snapshot.taxSourceRevision)
 const approved=snapshot.tables.books_tax_adjustment_workpapers.filter(row=>row.status==='approved'&&row.period_start==='2026-09-01'&&row.period_end==='2026-10-31')
 assert.equal(approved.length,1,'exactly one approved tax workpaper')
 assert.ok(approved[0].reviewed_at&&approved[0].review_notes.length>=10)
 return reconcileTaxWorkpaper({orgId:org,basis,batch:approved[0]})
}
const adjusted=snapshotLine(restoreOutput,'TAX_ADJUSTED'),adjustedReport=taxReportFromCaptured(adjusted)
assert.equal(adjustedReport.bookIncomeCents,-250);assert.equal(adjustedReport.totalCents,300);assert.equal(adjustedReport.adjustedIncomeCents,50)
assert.equal(adjustedReport.lines[0].evidence_file_id,file)
const confirmedReport=taxReportFromCaptured(restored)
assert.equal(confirmedReport.totalCents,0);assert.equal(confirmedReport.adjustedIncomeCents,-250)
assert.equal(restored.tables.books_tax_adjustment_workpapers.length,3)
assert.deepEqual(restored.tables.books_tax_adjustment_workpapers.map(row=>row.status).sort(),['approved','superseded','withdrawn'])
assert.equal(restored.tables.books_tax_adjustment_workpapers.find(row=>row.status==='superseded').reviewed_by,reviewer)
assert.equal(restored.tables.books_tax_adjustment_workpapers.find(row=>row.status==='withdrawn').closed_by,actor)
assert.throws(()=>taxReportFromCaptured(postRestore),/books changed/)
assert.ok(restoreOutput.includes('TAX_STALE_REVIEW=Cash source revision changed before review'),'actual database rejects stale restored tax review after new dated posting')
// Recover an archive containing reviewed/superseded/withdrawn tax history,
// rather than proving only reconstruction of an empty workpaper table.
const advanced=snapshotLine(restoreOutput,'DOCUMENT_ADVANCED')
assert.equal(advanced.tables.files[0].storage_path,revisedDocumentPath)
assert.equal(advanced.tables.doc_versions.filter(row=>row.file_id===file).length,2)
assert.deepEqual(taxReportFromCaptured(advanced),confirmedReport)
const taxRestoreTables=structuredClone(advanced.tables)
taxRestoreTables.org_funding_sources=structuredClone(restoreTables.org_funding_sources)
const taxHistoricalFiles=historicalDocumentInventory(taxRestoreTables,org)
assert.equal(taxHistoricalFiles.length,2);assert.equal(taxHistoricalFiles.filter(item=>!item.currentFileId).length,1)
const taxRestoreBundle={tables:taxRestoreTables,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(Object.entries(taxRestoreTables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:[{id:file,storagePath:revisedDocumentPath,sizeBytes:revisedDocumentBytes.length,checksum:revisedDocumentChecksum}],supportingHistoricalFiles:taxHistoricalFiles},supportingObjects:[{fileId:file,dataBase64:revisedDocumentBytes.toString('base64')}],supportingHistoricalObjects:taxHistoricalFiles.filter(item=>!item.currentFileId).map(item=>({attachmentId:item.id,dataBase64:documentBytes.toString('base64')}))}
assert.equal(verifyBooksExportBundle(taxRestoreBundle).valid,true)
const taxRestorePlan=prepareBooksRestorePlan({bundle:taxRestoreBundle,catalog:snapshots.SNAPSHOT_CATALOG,dependencies:restorePlan.dependencies,fundingActors:{[fundingSource]:{actorId:actor,explanation:'Original funding actor supplied; restored funding remains disconnected'}}})
assert.equal(taxRestorePlan.preflight.readyForRestoreAttempt,true,JSON.stringify(taxRestorePlan.preflight))
const taxRecoverySql=restorationSql(taxRestorePlan)
taxRecoverySql.push(...taxMembershipSql(),'set local role service_role;')
taxRecoverySql.push(`select review_books_tax_workpaper(${q(org)},${taxIdFor('native-tax-confirmed-key')},${q(reviewer)},${q(taxBasis.digest)},'Independently checked TAX-3 and replacement removes both differences');`,'reset role;')
taxRecoverySql.push(`select 'TAX_RECOVERED='||capture_books_tax_workpaper_context(${q(org)},'2026-10-31')::text;`,'rollback;',`select 'TAX_RECOVERY_ROLLBACK_COUNT='||((select count(*) from orgs where id=${q(org)})+(select count(*) from app_users where id in(${q(actor)},${q(reviewer)}))+(select count(*) from auth.users where id in(${q(actor)},${q(reviewer)}))+(select count(*) from roles where id=${q(taxRole)})+(select count(*) from memberships where org_id=${q(org)}))::text;`)
const taxRecoveryOutput=execFileSync('docker',['exec','-i',container,'psql','-X','-U','postgres','-d','postgres','-At','-v','ON_ERROR_STOP=1'],{input:taxRecoverySql.join('\n'),encoding:'utf8',maxBuffer:128*1024*1024,timeout:120000})
assert.ok(taxRecoveryOutput.split('\n').includes('TAX_RECOVERY_ROLLBACK_COUNT=0'))
const taxRecovered=snapshotLine(taxRecoveryOutput,'TAX_RECOVERED')
for(const [table,rows] of Object.entries(taxRestoreTables))if(table!=='org_funding_sources')assert.equal(booksDigest(taxRecovered.tables[table]),booksDigest(rows),'tax archive restored table differs: '+table)
assert.deepEqual(taxReportFromCaptured(taxRecovered),confirmedReport)
assert.equal(booksDigest(taxRecovered.tables.books_tax_adjustment_workpapers),booksDigest(restored.tables.books_tax_adjustment_workpapers),'all tax versions and evidence preserved exactly')
const documentRoot=fs.mkdtempSync(path.join(os.tmpdir(),'arc-books-native-document-restore-'))
try{
 const archivePath=path.join(documentRoot,'archive.json.gz'),extracted=path.join(documentRoot,'extracted')
 fs.writeFileSync(archivePath,gzipSync(JSON.stringify(taxRestoreBundle)),{mode:0o600,flag:'wx'})
 const result=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'verify-books-export.cjs'),archivePath,'--extract',extracted],{encoding:'utf8'}))
 assert.equal(result.verifiedFiles,2)
 assert.deepEqual(fs.readFileSync(path.join(extracted,restored.tables.files[0].storage_path)),documentBytes)
 assert.deepEqual(fs.readFileSync(path.join(extracted,taxRecovered.tables.files[0].storage_path)),revisedDocumentBytes)
 assert.ok(taxRecovered.tables.doc_versions.some(row=>row.id===taxAttachment.document_version_id && row.storage_path===documentPath && row.checksum===documentChecksum))
 assert.equal(restored.tables.file_links[0].file_id,file)
 assert.equal(restored.tables.file_links[0].entity_id,progress)
}finally{fs.rmSync(documentRoot,{recursive:true,force:true})}
// Exercise the actual service and report/CSV implementation against captured
// native database evidence. Only context/transport are adapted here; HTTP,
// login, immutable report runs and browser/PDF remain separate acceptance.
async function verifyNativeTaxReportExports() {
 const Module=require('node:module'),original=Module._load
 let currentSnapshot=adjusted,captures=0,api,definition
 const client={rpc:async(name,args)=>{
  assert.equal(name,'capture_books_tax_workpaper_context');assert.equal(args.p_org_id,org);assert.equal(args.p_period_end,'2026-10-31');captures++
  return {data:currentSnapshot,error:null}
 }}
 try {
  Module._load=function(name,...args) {
   if(name==='@/lib/storage/files-storage')return {getFilesObjectStream:async(args)=>{assert.equal(args.orgId,org);assert.equal(args.path,taxAttachment.storage_path);return {body:new ReadableStream({start(controller){controller.enqueue(documentBytes);controller.close()}})}}}
   if(name==='@/lib/supabase/server')return {createServiceSupabaseClient:()=>client}
   if(name==='@/lib/services/context')return {requireOrgContext:async()=>({orgId:org,userId:reviewer,supabase:client})}
   if(name==='@/lib/services/books/access')return {requireBooksAuthorization:async(input)=>{assert.equal(input.permission,'books.read');assert.equal(input.orgId,org);assert.equal(input.userId,reviewer)}}
   return original.call(this,name,...args)
  }
  api=require('../lib/services/books/tax-adjustments')
  definition=require('../lib/reports/definitions/financial').FINANCIAL_REPORTS.find(report=>report.slug==='books-tax-workpaper')
 } finally {Module._load=original}
 const {reportToCsv}=require('../lib/reports/export-csv')
 const context={scope:'org',scopeLabel:'Native construction tax acceptance',params:{period:'range:2026-09-01:2026-10-31'}}
 assert.deepEqual(definition.permissions,['books.read'])
 const signedResult=await definition.run(context),signedCsv=reportToCsv(signedResult)
 assert.equal(signedResult.tables.find(table=>table.key==='tax-bridge').totals.amount,50)
 assert.ok(signedCsv.includes('Accountant calculation TAX-1')&&signedCsv.includes('Accountant calculation TAX-2'))
 assert.ok(signedCsv.includes(file)&&signedCsv.includes(project)&&signedCsv.includes(taxBasis.digest))
 assert.ok(signedCsv.includes(reviewer)&&signedCsv.includes(actor))
 currentSnapshot=taxRecovered
 const confirmed=await api.buildTaxWorkpaperReport('2026-09-01','2026-10-31')
 assert.equal(confirmed.adjustedIncomeCents,-250);assert.equal(confirmed.reviewedBy,reviewer)
 const recoveredResult=await definition.run(context),recoveredCsv=reportToCsv(recoveredResult)
 assert.equal(recoveredResult.tables.find(table=>table.key==='tax-bridge').totals.amount,-250)
 assert.ok(recoveredCsv.includes('Reviewed no-adjustments confirmation')&&recoveredCsv.includes('TAX-3'))
 assert.ok(recoveredCsv.includes('Independently checked TAX-3'))
 currentSnapshot=postRestore
 await assert.rejects(definition.run(context),/books changed/)
 assert.equal(captures,4,'each service/report evaluation captures one native context')
}
verifyNativeTaxReportExports().then(()=>{
console.log(JSON.stringify({result:'PASS',fixtureTransaction:'rolled back and absence verified',september:{incomeCents:initial.incomeCents,salesTaxCents:initial.salesTaxCents},october:{incomeCents:october.incomeCents,salesTaxCents:october.salesTaxCents},total:{incomeCents:total.incomeCents,salesTaxCents:total.salesTaxCents},directExpenses:{cogsCents:directCosts.cogsCents,expenseCents:directCosts.expenseCents,paidPrincipalCents:directCosts.paidPrincipalCents},paidCosts:{cogsCents:totalCosts.cogsCents,expenseCents:totalCosts.expenseCents,capitalizedCents:totalCosts.capitalizedCents},settlementAncillary:{feeExpenseCents:ancillary.feeExpenseCents,ancillaryIncomeCents:ancillary.ancillaryIncomeCents},cashProfitLoss:{revenueCents:cashPnl.revenueCents,cogsCents:cashPnl.cogsCents,expenseCents:cashPnl.expenseCents,netIncomeCents:cashPnl.netIncomeCents,netCashMovementCents:cashPnl.netCashMovementCents,salesTaxCents:cashPnl.salesTaxCollectedCents,capitalizedCents:cashPnl.capitalizedPurchasesCents},restorePreflight:{readyForRestoreAttempt:restorePreflight.readyForRestoreAttempt,blockers:restorePreflight.blockers.length,externalDependencies:restorePreflight.externalDependencies.length},taxWorkpaper:{result:'PASS',signedAdjustedIncomeCents:adjustedReport.adjustedIncomeCents,confirmedIncomeCents:confirmedReport.adjustedIncomeCents,restoredVersions:taxRecovered.tables.books_tax_adjustment_workpapers.length,staleReviewBlocked:true,populatedArchiveRecovered:true,serviceReportAndCsvVerified:true},restoreAttempt:{result:'PASS',allArchivedTablesCompared:true,foreignKeysExplicitlyValidated:true,fundingDisabled:true,supportingDocumentsVerified:1,normalTriggersReenabled:true,newExpenseProjectionVerified:true,fixtureRollbackVerified:true},checks:['native signed tax adjustments reconcile, independent review and no-adjustments replacement preserve version history','populated schema 7 workpaper archive restores exact reviewer, preparer, basis and linked document evidence','actual new dated posting invalidates tax report and database review','cash P&L reconciles exactly to frozen posted cash movements after tax and capitalization','cash P&L combines native classifications and monthly results, separates tax/capitalization and survives restore','new source expense and atomic posting work after restoration with normal triggers','offline archived document bytes match restored invoice/file relationship','actual full-schema table reconstruction and cash activity tie-outs','all target foreign keys verified after cyclic restore','generated values reproduced and compared','actual database rejects redacted funding restore at its required provider field','actual target catalog detects missing restore identities and redacted required provider fields','customer fee recoveries retain allocated project grain','receipt plus separate AP fees counted exactly once','correcting fee journals cancel before replacement','missing fee source blocks ancillary report','actual Arc Pay fee source and posting captured together','schema 7 actual snapshot recovery integrity and relationships','actual direct expense and correcting reversal/repost','direct cost cutoff and source receipt reconciliation','paid-cost MVCC source-to-ledger reconciliation','missing supplier posting receipt blocks costs','actual bill/payment/supplier refund projection','posted classification survives live chart edits','paid cost capitalization and cost-code grain','actual atomic invoice/payment/refund projection','actual projection receipts and snapshot RPC','general plus POC billing','native accounts and job dimensions','processor fee separation','allocated receipt','actual fee correction cancels prior journal before replacement','historical cutoff after later refund','monthly/combined reconciliation','missing receipt blocks income','fixture absence after rollback']}))
}).catch(error=>{console.error(error);process.exitCode=1})
