const { migrationSql } = require("./support/migration-sql")
require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict')
const {ready,post}=require('./helpers/books-payroll-atomic-fixture')
const {capture}=require('./helpers/books-payroll-workflow-fixture')
const {id,org}=require('./helpers/books-payroll-register-fixture')
const {verifyPayrollNativeOwnership}=require('../lib/services/books/payroll-native-ownership')
async function committed(t){const f=await ready(t);await post(f);f.tables=(await capture(f.db)).tables;return f}
test('atomic posting claims exact original native sources with IDs only and no provider salary or document fields',async t=>{
 const f=await committed(t),rows=f.tables.books_payroll_labor_ownership
 assert.equal(rows.length,1);assert.deepEqual(rows[0],{id:id(80),org_id:org,project_id:id(4),cost_code_id:id(5),posting_id:id(260),time_entry_id:id(81),job_cost_entry_id:id(80),fact_id:id(82),journal_id:id(83),projection_receipt_id:id(87),created_at:f.tables.books_payroll_postings[0].posted_at})
 assert.deepEqual(verifyPayrollNativeOwnership(f.tables.books_payroll_postings[0],f.tables.books_payroll_imports[0],f.tables),rows)
 await assert.rejects(f.db.query('delete from books_payroll_labor_ownership'),/immutable|append-only/i)
 await assert.rejects(f.db.query('update books_payroll_labor_ownership set project_id=$1',[id(4)]),/immutable|append-only/i)
 const flags=(await f.db.query("select has_table_privilege('authenticated','books_payroll_labor_ownership','select') operational_read,has_table_privilege('authenticated','books_payroll_labor_ownership','insert') operational_insert,has_table_privilege('authenticated','books_payroll_postings','select') salary_posting_read,has_function_privilege('authenticated','assert_books_payroll_native_ownership(jsonb)','execute') private_proof")).rows[0]
 assert.deepEqual(flags,{operational_read:true,operational_insert:false,salary_posting_read:false,private_proof:false})
})
test('consumed native wage/scope/status changes, original deletion and receipt replacement require coordinated correction',async t=>{
 const f=await committed(t)
 for(const assignment of ['hours=9','base_rate_cents=3100','burden_multiplier=2','worker_user_id=null',"work_date='2026-09-11'",'project_id=null','cost_code_id=null',"status='submitted'",'status=null','is_overtime=true','is_double_time=true','labor_cost_policy_version=0','cost_cents=37000']){
  await assert.rejects(f.db.query(`update time_entries set ${assignment} where id=$1`,[id(81)]),/coordinated correction/,assignment)
 }
 for(const assignment of ['cost_cents=37000','cost_code_id=null','budget_line_id=null',"gmp_classification='inside_gmp'",'billable_cost_id=null',"status='voided'","metadata=jsonb_set(metadata,'{hours}','9')"]){
  await assert.rejects(f.db.query(`update job_cost_entries set ${assignment} where id=$1`,[id(80)]),/coordinated correction/,assignment)
 }
 for(const [table,identifier] of [['time_entries',id(81)],['job_cost_entries',id(80)],['books_projection_receipts',id(87)]])await assert.rejects(f.db.query(`delete from ${table} where id=$1`,[identifier]),/coordinated correction/)
 await assert.rejects(f.db.query("update books_projection_receipts set source_observed_at='2026-09-11' where id=$1",[id(87)]),/coordinated correction/)
 assert.deepEqual((await capture(f.db)).tables,f.tables)
})
test('approved status, editorial notes, invoice links and idempotent projector refresh remain available without stale cost revision',async t=>{
 const f=await committed(t),before=f.tables.job_cost_entries.find(row=>row.id===id(80)).updated_at
 await f.db.exec('alter table time_entries add notes text')
 await f.db.query("update time_entries set notes='Reviewed field note',status='client_approved',updated_at=now() where id=$1",[id(81)])
 await f.db.query('update time_entries set status=$1 where id=$2',['locked',id(81)])
 await f.db.query("update job_cost_entries set cost_cents=cost_cents,metadata=metadata||'{\"description\":\"Updated field label\",\"time_entry_status\":\"locked\"}',is_billable=true where id=$1",[id(80)])
 await f.db.query('insert into invoices(id,org_id) values($1,$2)',[id(500),org])
 await f.db.query('update job_cost_entries set invoice_id=$1 where id=$2',[id(500),id(80)])
 await f.db.query('select record_books_projection_receipt($1,$2,$3,$4,$5,$6)',[org,'labor_cost',id(80),before,id(82),id(83)])
 const tables=(await capture(f.db)).tables;assert.equal(tables.job_cost_entries.find(row=>row.id===id(80)).updated_at,before)
 assert.equal(tables.books_projection_receipts[0].source_observed_at,f.tables.books_projection_receipts[0].source_observed_at)
 verifyPayrollNativeOwnership(tables.books_payroll_postings[0],tables.books_payroll_imports[0],tables)
 assert.deepEqual((await post(f)).rows[0].result,f.tables.books_payroll_postings[0].result)
})
test('original native journal cannot be reversed independently after payroll reconciliation',async t=>{
 const f=await committed(t),entry={entry_date:'2026-09-20',entry_kind:'reversal',memo:'Reverse original native estimate alone',posting_key:'invalid-native-reversal',policy_version:1,reversal_of_entry_id:id(83),created_by:id(2)}
 await assert.rejects(f.db.query('select reverse_books_journal_entry($1,$2,$3::jsonb,$4::jsonb)',[org,id(83),JSON.stringify(entry),JSON.stringify([{account_id:id(30),line_no:1,debit_cents:36000,credit_cents:0},{account_id:id(32),line_no:2,debit_cents:0,credit_cents:36000}])]),/consumed by posted payroll requires coordinated correction/)
 assert.deepEqual((await capture(f.db)).tables,f.tables)
})
test('ownership publication failure rolls back complete payroll posting including its mapping',async t=>{
 const f=await ready(t),before=(await capture(f.db)).tables
 await f.db.exec("create function fail_native_ownership() returns trigger language plpgsql as $$begin raise exception 'Injected native ownership failure';end $$;create trigger fail_native_ownership before insert on books_payroll_labor_ownership for each row execute function fail_native_ownership()")
 await assert.rejects(post(f),/Injected native ownership failure/);assert.deepEqual((await capture(f.db)).tables,before)
 await f.db.exec('drop trigger fail_native_ownership on books_payroll_labor_ownership');await post(f)
})
test('native ownership uses source RLS without salary access, including writers who can see only one source',async t=>{
 const f=await committed(t)
 await f.db.exec(`grant select,update on time_entries,job_cost_entries to authenticated;
 alter table time_entries enable row level security;alter table job_cost_entries enable row level security;
 create policy fixture_time_access on time_entries to authenticated using(org_id=current_setting('books_payroll_test.org')::uuid and current_setting('books_payroll_test.time')='yes') with check(org_id=current_setting('books_payroll_test.org')::uuid and current_setting('books_payroll_test.time')='yes');
 create policy fixture_job_access on job_cost_entries to authenticated using(org_id=current_setting('books_payroll_test.org')::uuid and current_setting('books_payroll_test.job')='yes') with check(org_id=current_setting('books_payroll_test.org')::uuid and current_setting('books_payroll_test.job')='yes');
 insert into time_entries(id,org_id,worker_user_id,work_date,project_id,cost_code_id,status,hours,base_rate_cents,burden_multiplier,is_overtime,ot_multiplier,is_double_time,dt_multiplier,labor_cost_policy_version,cost_cents,updated_at) values('${id(500)}','${org}','${id(2)}','2026-10-01','${id(4)}','${id(5)}','pm_approved',1,3000,1.5,false,1.5,false,2,1,4500,now());`)
 await f.db.query("select set_config('books_payroll_test.org',$1,false),set_config('books_payroll_test.time','yes',false),set_config('books_payroll_test.job','yes',false)",[org]);await f.db.exec('set role authenticated')
 const count=async()=>(await f.db.query('select count(*)::int n from books_payroll_labor_ownership')).rows[0].n
 assert.equal(await count(),1)
 await assert.rejects(f.db.query('select * from books_payroll_imports'),/permission denied/)
 await assert.rejects(f.db.query('select assert_books_payroll_native_ownership($1::jsonb)',[JSON.stringify(f.tables.books_payroll_postings[0])]),/permission denied/)
 await f.db.query("select set_config('books_payroll_test.time','no',false)");assert.equal(await count(),1,'cost writer can still see source ownership without time-row access')
 await assert.rejects(f.db.query('update job_cost_entries set cost_cents=37000 where id=$1',[id(80)]),/coordinated correction/)
 await f.db.query("select set_config('books_payroll_test.time','yes',false),set_config('books_payroll_test.job','no',false)");assert.equal(await count(),1,'time writer can still see source ownership without cost-row access')
 await assert.rejects(f.db.query('update time_entries set hours=9 where id=$1',[id(81)]),/coordinated correction/)
 assert.equal((await f.db.query('update time_entries set hours=2,cost_cents=9000 where id=$1 returning hours',[id(500)])).rows[0].hours,'2','unconsumed time remains editable')
 await f.db.query("select set_config('books_payroll_test.time','no',false)");assert.equal(await count(),0)
 await f.db.query("select set_config('books_payroll_test.org',$1,false),set_config('books_payroll_test.time','yes',false),set_config('books_payroll_test.job','yes',false)",[id(99)]);assert.equal(await count(),0)
 await f.db.exec('reset role')
})
test('minimal ownership foreign keys independently prohibit moving consumed source dimensions to a different organization',async t=>{
 const f=await committed(t)
 for(const [table,identifier] of [['projects',id(4)],['cost_codes',id(5)]])await assert.rejects(f.db.query(`update ${table} set org_id=$1 where id=$2`,[id(99),identifier]),/foreign key/)
 assert.deepEqual((await capture(f.db)).tables,f.tables)
})
test('existing schema 12 posted payroll receives proven ownership during upgrade; drift aborts upgrade',async t=>{
 const migration=migrationSql("20261004004909_books_payroll_native_ownership")
 const f=await ready(t,{ownership:false}),result=(await post(f)).rows[0].result
 await f.db.exec('drop table books_payroll_labor_ownership');await f.db.exec(migration)
 const tables=(await capture(f.db)).tables;assert.equal(tables.books_payroll_labor_ownership.length,1)
 verifyPayrollNativeOwnership(tables.books_payroll_postings[0],tables.books_payroll_imports[0],tables)
 assert.deepEqual((await post(f)).rows[0].result,result)
 const stale=await ready(t,{ownership:false});await post(stale);await stale.db.query('update time_entries set hours=9 where id=$1',[id(81)])
 await stale.db.exec('drop table books_payroll_labor_ownership')
 await assert.rejects(stale.db.exec(migration),/native time economics differ/)
})

function archive(f,tables,schemaVersion=12){
 const {booksDigest}=require('../lib/services/books/hash'),{historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive')
 return {tables,manifest:{schemaVersion,orgId:org,tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:tables.files.map(file=>({id:file.id,storagePath:file.storage_path,sizeBytes:file.size_bytes,checksum:file.checksum})),supportingHistoricalFiles:historicalDocumentInventory(tables,org)},supportingObjects:[{fileId:id(8),dataBase64:f.registerBytes.toString('base64')}],supportingHistoricalObjects:[]}
}
test('schema 12 recovery derives checked native ownership, preserves archive and restores exact retry into current schema',async t=>{
 const {prepareBooksRestorePlan}=require('../lib/services/books/restore-plan'),{verifyBooksExportBundle,EXPORT_TABLES}=require('../lib/services/books/export-contract'),{booksDigest}=require('../lib/services/books/hash')
 const f=await ready(t,{ownership:false}),result=(await post(f)).rows[0].result,tables=(await capture(f.db)).tables
 delete tables.books_payroll_labor_ownership
 const bundle=archive(f,tables),before=structuredClone(bundle),target=await ready(t)
 assert.equal(verifyBooksExportBundle(bundle).valid,true,'original schema 12 posted archive remains supported')
 const columns=(await target.db.query("select table_name as table,column_name as name,is_nullable='NO' as \"notNull\",column_default is not null as \"hasDefault\",is_generated <> 'NEVER' as generated from information_schema.columns where table_schema='public'")).rows
 const catalog={columns,foreignKeys:[]},input={bundle,catalog,dependencies:[],fundingActors:{}}
 const plan=prepareBooksRestorePlan(input)
 assert.equal(plan.preflight.readyForRestoreAttempt,true,JSON.stringify(plan.preflight));assert.deepEqual(bundle,before)
 assert.equal(plan.sourceSchemaVersion,12);assert.equal(plan.sourceManifestDigest,booksDigest(before.manifest))
 assert.equal(plan.tables.books_payroll_labor_ownership.length,1);assert.equal(plan.tables.books_payroll_labor_ownership[0].created_at,tables.books_payroll_postings[0].posted_at)
 assert.ok(plan.changes.some(change=>change.table==='books_payroll_labor_ownership'&&change.fields.includes('projection_receipt_id')))
 const {planDigest,...body}=plan;assert.equal(planDigest,booksDigest(body));assert.equal(prepareBooksRestorePlan(input).planDigest,planDigest)
 await target.db.exec('set session_replication_role=replica')
 for(const table of EXPORT_TABLES)await target.db.exec(`delete from ${table}`)
 for(const [table,rows] of Object.entries(plan.tables))for(const row of rows){const keys=Object.keys(row);await target.db.query(`insert into ${table}(${keys.map(k=>'"'+k+'"').join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row).map(v=>v&&typeof v==='object'?JSON.stringify(v):v))}
 await target.db.exec('set session_replication_role=origin')
 assert.deepEqual((await post(target,{digest:f.plan.digest})).rows[0].result,result)
 await assert.rejects(target.db.query('update time_entries set hours=9 where id=$1',[id(81)]),/coordinated correction/)
 const generated=structuredClone(input);generated.catalog.columns.find(column=>column.table==='time_entries'&&column.name==='cost_cents').generated=true
 const insertion=prepareBooksRestorePlan(generated);assert.equal(insertion.preflight.readyForRestoreAttempt,true,JSON.stringify(insertion.preflight));assert.equal('cost_cents' in insertion.tables.time_entries[0],false)
 for(const mutate of [b=>b.tables.time_entries[0].hours=9,b=>b.tables.job_cost_entries.find(row=>row.id===id(80)).cost_cents++,b=>b.tables.books_projection_receipts.find(row=>row.source_id===id(80)).source_observed_at='2020-01-01T00:00:00Z']){
  const stale=structuredClone(input);mutate(stale.bundle);for(const [name,rows]of Object.entries(stale.bundle.tables))stale.bundle.manifest.tables[name].checksum=booksDigest(rows)
  assert.throws(()=>prepareBooksRestorePlan(stale),/native|verified versioned archive/i,'old checksum/version cannot invent native ownership for changed sources')
 }
})
test('schema 13 archive rejects forged, orphan, duplicate or drifted native ownership even with rebuilt checksums',async t=>{
 const f=await committed(t),{verifyBooksExportBundle}=require('../lib/services/books/export-contract'),{booksDigest}=require('../lib/services/books/hash'),bundle=archive(f,f.tables,13)
 assert.equal(verifyBooksExportBundle(bundle).valid,true,JSON.stringify(verifyBooksExportBundle(bundle)))
 for(const mutate of [b=>b.tables.books_payroll_labor_ownership=[],b=>b.tables.books_payroll_labor_ownership[0].posting_id=id(999),b=>b.tables.books_payroll_labor_ownership.push({...b.tables.books_payroll_labor_ownership[0],id:id(999)}),b=>b.tables.books_payroll_labor_ownership[0].projection_receipt_id=id(999),b=>b.tables.books_payroll_labor_ownership[0].created_at='2020-01-01T00:00:00Z',b=>b.tables.books_payroll_labor_ownership[0].salary=24000,b=>b.tables.time_entries[0].base_rate_cents++,b=>b.tables.job_cost_entries.find(row=>row.id===id(80)).metadata.burden_multiplier=9]){
  const bad=structuredClone(bundle);mutate(bad);for(const [name,rows]of Object.entries(bad.tables))bad.manifest.tables[name]={rows:rows.length,checksum:booksDigest(rows)}
  assert.equal(verifyBooksExportBundle(bad).valid,false)
 }
})
