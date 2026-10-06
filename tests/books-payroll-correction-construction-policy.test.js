require('../scripts/register-ts-node-test')
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {lineageFixture,nextSource,nextProposal,postLineage}=require('./helpers/books-payroll-correction-lineage-fixture'),{capture}=require('./helpers/books-payroll-workflow-fixture'),{id,org}=require('./helpers/books-payroll-register-fixture')
const {parsePayrollCorrectionContext}=require('../lib/services/books/payroll-correction-context'),{verifyPayrollCorrectionPosting}=require('../lib/services/books/payroll-correction-posting')
const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261004041617_books_payroll_correction_construction_policy.sql'),'utf8')
async function policySetup(f){
 await f.db.exec("alter table projects add status text default 'active' not null;alter table project_financial_settings add project_id uuid,add billing_model text,add setup_completed_at timestamptz;alter table contracts add project_id uuid,add status text,add contract_type text,add gmp_cents bigint;alter table closings add project_id uuid,add status text,add actual_date date,add settlement jsonb;")
 await f.db.query("insert into project_financial_settings values($1,$2,$3,'time_and_materials','2026-09-01')",[id(990),org,id(4)])
 await f.db.query("insert into contracts values($1,$2,$3,'active','time_materials',null)",[id(991),org,id(4)])
 await f.db.exec(sql)
}
const context=async(f,source=id(700))=>(await f.db.query('select lock_books_payroll_correction_context($1,$2) result',[org,source])).rows[0].result
const money=async f=>(await capture(f.db)).tables
async function checked(f,source){const c=await context(f,source);parsePayrollCorrectionContext(c,await money(f));return c}
test('new commercial context independently proves active T&M settings and contract, then posts and preserves historical review after close',async t=>{
 const f=await lineageFixture(t,{beforeProposal:policySetup}),c=await checked(f)
 assert.equal(c.version,2);assert.deepEqual(c.projectCosts[0].blockers,[]);assert.equal(c.context.contracts[0].id,id(991));assert.equal(c.context.project_financial_settings[0].id,id(990));assert.deepEqual(c.context.closings,[])
 const r=(await postLineage(f)).rows[0].result
 await f.db.query("update projects set status='completed' where id=$1",[id(4)])
 await f.db.query("insert into closings values($1,$2,$3,'closed','2026-09-21',$4::jsonb)",[id(992),org,id(4),JSON.stringify({costs:27000})])
 await f.db.query("update contracts set contract_type='cost_plus' where id=$1",[id(991)])
 const tables=await money(f);verifyPayrollCorrectionPosting(tables.books_payroll_correction_postings[0],tables)
 assert.deepEqual((await postLineage(f)).rows[0].result,r)
 const s=await nextSource(f),next=await checked(f,s.id)
 assert.ok(next.projectCosts[0].blockers.includes('review_late_project_cost_policy'));assert.ok(next.projectCosts[0].blockers.includes('review_closed_home_cost_and_customer_settlement'));assert.ok(next.projectCosts[0].blockers.includes('review_current_customer_billing_policy'))
 await assert.rejects(nextProposal(f,s),/unresolved business/)
})
test('commercial changes after review reject new posting without changing payroll money or native customer billing',async t=>{
 const f=await lineageFixture(t,{beforeProposal:policySetup}),before=await money(f)
 for(const [change,repair] of [
 ["update projects set status='cancelled'","update projects set status='active'"],
 ["update project_financial_settings set billing_model='cost_plus_gmp'","update project_financial_settings set billing_model='time_and_materials'"],
 ["update contracts set contract_type='cost_plus'","update contracts set contract_type='time_materials'"],
 ["update contracts set gmp_cents=100000","update contracts set gmp_cents=null"],
 ["update project_financial_settings set setup_completed_at=null","update project_financial_settings set setup_completed_at='2026-09-01'"]]){
  await f.db.exec(change);await assert.rejects(postLineage(f),/evidence changed|decisions remain/);await f.db.exec(repair)
 }
 const after=await money(f)
 for(const name of ['journal_entries','journal_lines','accounting_facts','job_cost_entries','books_payroll_correction_postings','billable_costs','time_entries'])assert.deepEqual(after[name],before[name],name)
 await postLineage(f)
})
test('missing or ambiguous setup and active contract require review rather than using old native billable metadata',async t=>{
 const f=await lineageFixture(t,{beforeProposal:policySetup})
 await f.db.query('delete from project_financial_settings where id=$1',[id(990)])
 await f.db.query("update contracts set status='draft' where id=$1",[id(991)])
 let c=await checked(f);assert.ok(c.projectCosts[0].blockers.includes('review_incomplete_project_financial_setup'));assert.ok(c.projectCosts[0].blockers.includes('review_missing_or_ambiguous_active_contract'))
 await f.db.query("insert into project_financial_settings values($1,$2,$3,'time_and_materials','2026-09-01')",[id(990),org,id(4)])
 await f.db.query("update contracts set status='active' where id=$1",[id(991)])
 await f.db.query("insert into contracts values($1,$2,$3,'active','time_materials',null)",[id(993),org,id(4)])
 c=await checked(f);assert.ok(c.projectCosts[0].blockers.includes('review_missing_or_ambiguous_active_contract'))
 await assert.rejects(postLineage(f),/evidence changed|decisions remain/)
})
test('late closing insertion during money writes rolls the entire correction and phantom evidence back',async t=>{
 const f=await lineageFixture(t,{beforeProposal:policySetup}),before=await money(f)
 await f.db.exec(`create function late_closing_test() returns trigger language plpgsql as $$begin if new.source_type='payroll_correction' then insert into closings values('${id(992)}','${org}','${id(4)}','closed','2026-09-20','{}');end if;return new;end$$;create trigger late_closing_test after insert on job_cost_entries for each row execute function late_closing_test();`)
 await assert.rejects(postLineage(f),/context changed|evidence changed/)
 const after=await money(f);for(const name of ['journal_entries','journal_lines','accounting_facts','job_cost_entries','books_payroll_correction_postings','books_payroll_correction_proposals','closings'])assert.deepEqual(after[name],before[name],name)
 await f.db.exec('drop trigger late_closing_test on job_cost_entries');await postLineage(f)
})
test('legacy posted correction stays valid after policy migration, while legacy unposted approval needs a fresh commercial review',async t=>{
 const f=await lineageFixture(t);const first=(await postLineage(f)).rows[0].result
 const source=await nextSource(f),proposal=await nextProposal(f,source)
 await policySetup(f)
 const tables=await money(f);verifyPayrollCorrectionPosting(tables.books_payroll_correction_postings[0],tables)
 assert.deepEqual((await postLineage(f)).rows[0].result,first)
 await assert.rejects(postLineage(f,proposal,1),/evidence changed/)
 const c=await checked(f,source.id);assert.equal(c.version,2)
})
test('version-two offline proof cannot omit commercial dependencies, change version, or fabricate closeout status',async t=>{
 const f=await lineageFixture(t,{beforeProposal:policySetup}),c=await checked(f),tables=await money(f)
 for(const key of ['project_financial_settings','contracts','closings']){const forged=structuredClone(c);delete forged.context[key];assert.throws(()=>parsePayrollCorrectionContext(forged,tables,true),/evidence is missing/)}
 const downgraded=structuredClone(c);downgraded.version=1;assert.throws(()=>parsePayrollCorrectionContext(downgraded,tables,true),/Legacy correction/)
 const forged=structuredClone(c);forged.context.projects[0].status='completed';assert.throws(()=>parsePayrollCorrectionContext(forged,tables,true),/projectCosts/)
})
test('commercial writer fences remain invoker triggers with no private payroll reads and private context RPCs',async t=>{
 const f=await lineageFixture(t,{beforeProposal:policySetup})
 const triggers=await f.db.query("select c.relname,p.prosecdef,p.proname from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc p on p.oid=t.tgfoid where t.tgname='books_payroll_source_fence' and c.relname in('projects','contracts','closings','project_financial_settings') order by c.relname")
 assert.equal(triggers.rows.length,4);assert.ok(triggers.rows.every(r=>!r.prosecdef&&r.proname==='books_lock_payroll_source_write'))
 await f.db.exec('grant usage on schema public to authenticated;grant select,update on projects to authenticated;set role authenticated;')
 await f.db.query("update projects set status='on_hold' where id=$1",[id(4)])
 await assert.rejects(f.db.query('select books_payroll_correction_base_context($1,$2)',[org,id(700)]),/permission denied/)
 await f.db.exec('reset role')
 await f.db.query("update projects set status='active' where id=$1",[id(4)])
 await f.db.exec('grant select,insert,update on all tables in schema public to service_role;revoke update on books_payroll_postings,books_payroll_labor_ownership,books_payroll_correction_postings from service_role;alter role service_role bypassrls;set role service_role')
 await postLineage(f)
 await assert.rejects(f.db.query('update books_payroll_correction_postings set posting_notes=posting_notes'),/permission denied/)
 await f.db.exec('reset role')
})
test('archive verifies version-two actual money after later close and rejects rechecksummed commercial evidence tampering',async t=>{
 const {BOOKS_EXPORT_SCHEMA_VERSION,verifyBooksExportBundle}=require('../lib/services/books/export-contract'),{booksDigest}=require('../lib/services/books/hash'),{historicalDocumentInventory}=require('../lib/services/books/tax-attachment-archive'),{createHash}=require('node:crypto')
 const f=await lineageFixture(t,{beforeProposal:policySetup});await postLineage(f)
 await f.db.query("update projects set status='completed' where id=$1",[id(4)])
 const tables=await money(f),archive={tables,manifest:{schemaVersion:BOOKS_EXPORT_SCHEMA_VERSION,orgId:org,tables:Object.fromEntries(Object.entries(tables).map(([table,rows])=>[table,{rows:rows.length,checksum:booksDigest(rows)}])),supportingFiles:tables.files.map(file=>({id:file.id,storagePath:file.storage_path,sizeBytes:file.size_bytes,checksum:file.checksum})),supportingHistoricalFiles:historicalDocumentInventory(tables,org)},supportingObjects:tables.files.map(file=>({fileId:file.id,dataBase64:f.registers.get(file.id).toString('base64')})),supportingHistoricalObjects:[]}
 assert.equal(verifyBooksExportBundle(archive).valid,true)
 const bad=structuredClone(archive),proposal=bad.tables.books_payroll_correction_proposals[0]
 proposal.plan.context.contracts[0].contract_type='cost_plus'
 proposal.context_text=JSON.stringify(proposal.plan.context);proposal.plan.contextHash=createHash('sha256').update(proposal.context_text).digest('hex')
 proposal.plan_text=JSON.stringify(proposal.plan);proposal.plan_digest=createHash('sha256').update(proposal.plan_text).digest('hex')
 bad.manifest.tables.books_payroll_correction_proposals.checksum=booksDigest(bad.tables.books_payroll_correction_proposals)
 const result=verifyBooksExportBundle(bad);assert.equal(result.valid,false);assert.ok(result.integrityErrors.some(error=>/construction context|projectCosts|ownership|digest/.test(error)))
})
