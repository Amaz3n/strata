// Run with @electric-sql/pglite installed, or set ARC_PGLITE_MODULE to its ESM entry.
// No network, credentials or shared database. Surrounding schema is a fixture;
// posting, reversal, matching, and this feature's migration are real SQL.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const { PGlite }=await import(process.env.ARC_PGLITE_MODULE ?? '@electric-sql/pglite')
const db=new PGlite()
const read=file=>fs.readFileSync(path.join(root,file),'utf8')
await db.exec(read('tests/fixtures/books-banking-schema.sql'))
function functionSql(file,name) {
 const sql=read(file); const start=sql.toLowerCase().indexOf('create or replace function public.'+name+'(')
 assert.ok(start>=0,`Function ${name} exists`)
 const end=sql.indexOf('$$;',sql.indexOf('$$',start)+2)
 return sql.slice(start,end+3)
}
await db.exec(functionSql('supabase/migrations/20260801143926_books_accounting_foundation.sql','post_books_journal_entry'))
await db.exec(functionSql('supabase/migrations/20260812120755_books_release_hardening.sql','reverse_books_journal_entry'))
await db.exec(functionSql('supabase/migrations/20260908010036_books_bank_integrity.sql','confirm_books_bank_match_atomic'))
await db.exec(functionSql('supabase/migrations/20260908010036_books_bank_integrity.sql','validate_books_bank_match'))
await db.exec('create trigger bank_matches_validate before insert or update on public.bank_transaction_matches for each row execute function public.validate_books_bank_match();')
await db.exec(read('supabase/migrations/20260913222918_banking_workspace.sql'))
await db.exec('create trigger books_bank_job_cost_reversal after update of status on public.journal_entries for each row execute function public.reverse_books_bank_job_cost();')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
await db.query(`insert into orgs(id,name) values ($1,'Test')`,[id(1)]);await db.query(`insert into app_users(id) values ($1)`,[id(2)])
await db.query(`insert into gl_accounts(id,org_id,code,name,account_type,active) values ($1,$4,'1000','Cash','asset',true),($2,$4,'6100','Overhead','expense',true),($3,$4,'5100','Materials','cogs',true)`,[id(3),id(4),id(5),id(1)])
await db.query(`insert into projects(id,org_id,name) values($1,$2,'Project')`,[id(6),id(1)])
await db.query(`insert into books_settings(org_id,workspace_enabled,arc_ledger_mode,active_policy_version) values($1,true,'official',1)`,[id(1)])
await db.query(`insert into bank_accounts(id,org_id,name,gl_account_id) values($1,$2,'Checking',$3)`,[id(7),id(1),id(3)])
await db.query(`insert into bank_transactions(id,org_id,bank_account_id,transaction_date,amount_cents,direction,description,lifecycle_status,excluded) values($1,$2,$3,'2026-09-10',10000,'outflow','Test purchase','posted',false)`,[id(8),id(1),id(7)])
const coding={vendorId:null,memo:'Test',receiptStatus:'missing',lines:[{id:id(20),accountId:id(4),projectId:null,costCodeId:null,amountCents:4000},{id:id(21),accountId:id(5),projectId:id(6),costCodeId:null,amountCents:6000}]}
const mutate=async(action,version,draft=coding,org=id(1))=>(await db.query(`select mutate_books_banking_atomic($1,$2,$3,$4,$5,$6::jsonb) as result`,[org,id(8),id(2),action,version,JSON.stringify(draft)])).rows[0].result
assert.equal((await mutate('save',0)).version,1)
assert.equal((await db.query('select count(*)::int as n from journal_entries')).rows[0].n,0)
await assert.rejects(mutate('post',0),/changed/)
await assert.rejects(mutate('post',1,{...coding,lines:[{...coding.lines[0],amountCents:1}]}),/Splits/)
assert.equal((await db.query('select count(*)::int as n from journal_entries')).rows[0].n,0)
const posted=await mutate('post',1)
assert.ok(posted.entryId)
assert.equal((await db.query('select sum(debit_cents-credit_cents)::int as balance from journal_lines')).rows[0].balance,0)
assert.equal((await db.query("select sum(cost_cents)::int as cost from job_cost_entries where status='posted'")).rows[0].cost,6000)
assert.equal((await db.query('select review_status from banking_workspace_rows')).rows[0].review_status,'posted')
await assert.rejects(mutate('post',2),/Undo existing/)
await assert.rejects(mutate('save',2,coding,id(100)),/not found/)
const undone=await mutate('undo',2)
assert.equal(undone.version,3)
assert.equal((await db.query('select review_status from banking_workspace_rows')).rows[0].review_status,'review')
assert.equal((await db.query("select count(*)::int as n from job_cost_entries where status='posted'")).rows[0].n,0)
await mutate('post',3)
await mutate('undo',4)
await mutate('exclude',5)
assert.equal((await db.query('select review_status from banking_workspace_rows')).rows[0].review_status,'excluded')
await mutate('undo',6)
assert.equal((await db.query('select review_status from banking_workspace_rows')).rows[0].review_status,'review')

// A remembered rule is persisted only with a successful explicit posting.
await db.query(`update bank_transactions set merchant_name='Example Merchant' where id=$1`,[id(8)])
const single={...coding,learn:true,lines:[{...coding.lines[0],amountCents:10000}]}
await mutate('post',7,single)
assert.equal((await db.query('select count(*)::int as n from bank_rules')).rows[0].n,1)
await mutate('undo',8)
// Multiple ledger lines can satisfy one transaction without creating another journal.
const existing=(await db.query(`select post_books_journal_entry($1,$2::jsonb,$3::jsonb) as id`,[id(1),JSON.stringify({entry_date:'2026-09-10',entry_kind:'adjusting',posting_key:'fixture-payment',policy_version:1}),JSON.stringify([{line_no:1,account_id:id(4),debit_cents:10000,credit_cents:0},{line_no:2,account_id:id(3),debit_cents:0,credit_cents:4000},{line_no:3,account_id:id(3),debit_cents:0,credit_cents:6000}])])).rows[0].id
const matchLines=(await db.query('select id,credit_cents from journal_lines where entry_id=$1 and account_id=$2 order by line_no',[existing,id(3)])).rows
await db.query(`select mutate_books_banking_atomic($1,$2,$3,'match',9,null,$4::jsonb)`,[id(1),id(8),id(2),JSON.stringify([{journalLineId:matchLines[0].id,amountCents:4000}])])
assert.equal((await db.query('select review_status from banking_workspace_rows')).rows[0].review_status,'review')
await db.query(`select mutate_books_banking_atomic($1,$2,$3,'match',10,null,$4::jsonb)`,[id(1),id(8),id(2),JSON.stringify([{journalLineId:matchLines[1].id,amountCents:6000}])])
assert.equal((await db.query('select review_status from banking_workspace_rows')).rows[0].review_status,'posted')
await mutate('undo',11)
assert.equal((await db.query('select status from journal_entries where id=$1',[existing])).rows[0].status,'posted')
await db.query(`update bank_transactions set currency='eur' where id=$1`,[id(8)])
await assert.rejects(mutate('post',12),/currency conversion/)
await db.query(`update bank_transactions set currency='usd' where id=$1`,[id(8)])
await db.query(`insert into accounting_periods(id,org_id,period_start,period_end,status) values ($1,$2,'2026-09-01','2026-09-30','closed')`,[id(30),id(1)])
await assert.rejects(mutate('post',12),/Reopen the accounting period/)
await db.exec(`set role authenticated`)
await assert.rejects(db.query('select * from bank_receipts'),/permission denied/)
await assert.rejects(mutate('save',12),/permission denied/)
console.log('PASS: migration, draft isolation, balanced splits, job costs, stale version rejection, duplicate-post protection, cross-org rejection, undo/repost, exclusion/restore, closed period and browser-role access.')
await db.close()
