require('../../scripts/register-ts-node-test')
const fs=require('node:fs'),path=require('node:path')
const {setup}=require('./books-payroll-payment-fixture')
const {payrollPaymentReviewEvidence}=require('../../lib/services/books/payroll-payment-review-rules')
const {scenario,refresh,capture}=require('./books-payroll-workflow-fixture')
const {prepare,review}=require('./books-payroll-database')
const {prepareProposal,reviewProposal}=require('./books-payroll-posting-proposal-fixture')
const {payrollPostingPlan}=require('../../lib/services/books/payroll-posting-plan')
const {id,org}=require('./books-payroll-register-fixture')
const read=name=>fs.readFileSync(path.join(__dirname,'../../supabase/migrations',name),'utf8')
const definition=(sql,prefix,end)=>{const start=sql.indexOf(prefix),finish=sql.indexOf(end,start);if(start<0||finish<0)throw new Error(prefix);return sql.slice(start,finish+end.length)}
/** Upgrade only fixture scaffolding using actual production table definitions,
 * constraints and posting/immutability/balance RPCs. Unrelated parents remain fixtures. */
async function upgrade(db,{ownership=true}={}){
 const foundation=read('20260801143926_books_accounting_foundation.sql')
 for(const name of ['accounting_facts','journal_entries','journal_lines','job_cost_entries','books_projection_receipts']){
  const sql=name==='job_cost_entries'?read('20260603210000_add_job_cost_entries.sql'):name==='books_projection_receipts'?read('20261003022656_books_projection_receipts.sql'):foundation
  const prefix=name==='job_cost_entries'?'create table if not exists':'create table'
  await db.exec(definition(sql,`${prefix} public.${name} (`,'\n);').replace(`${prefix} public.${name}`,`create table public.template_${name}`))
  const columns=(await db.query("select a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) def from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=$1::regclass and a.attnum>0 and not a.attisdropped order by a.attnum",[`template_${name}`])).rows
  const existing=new Set((await db.query('select column_name from information_schema.columns where table_schema=$1 and table_name=$2',['public',name])).rows.map(r=>r.column_name))
  for(const column of columns){
   if(!existing.has(column.attname))await db.exec(`alter table ${name} add column ${column.attname} ${column.type}${column.def?` default ${column.def}`:''}`)
   if(column.def)await db.exec(`alter table ${name} alter column ${column.attname} set default ${column.def}`)
  }
  if(name==='accounting_facts')await db.exec("update accounting_facts set source_version=1,fact_kind='labor_cost',occurred_at=now(),payload_hash=encode(sha256(convert_to(payload::text,'UTF8')),'hex'),policy_version=1,idempotency_key='legacy:'||id,created_by='99400000-0000-4000-8000-000000000050'")
  if(name==='journal_entries')await db.exec("update journal_entries set entry_kind='operational',memo='Original source journal',posting_key='legacy:'||id,projection_version=1,policy_version=1,posted_at=now(),posted_by='99400000-0000-4000-8000-000000000050',created_by='99400000-0000-4000-8000-000000000050'")
  if(name==='journal_lines')await db.exec('update journal_lines l set line_no=r.n from(select id,row_number() over(partition by entry_id order by id)::smallint n from journal_lines) r where r.id=l.id')
  if(name==='job_cost_entries')await db.exec('alter table job_cost_entries alter column cost_cents type integer')
  for(const column of columns)if(column.attnotnull)await db.exec(`alter table ${name} alter column ${column.attname} set not null`)
  const constraints=(await db.query("select conname,pg_get_constraintdef(oid) def from pg_constraint where conrelid=$1::regclass and contype in('u','c','f','x')",[`template_${name}`])).rows
  for(const c of constraints){await db.exec(`alter table template_${name} drop constraint ${c.conname}`);await db.exec(`alter table ${name} add constraint ${c.conname.replace('template_','')} ${c.def}`)}
  await db.exec(`drop table template_${name}`)
 }
 for(const fn of ['books_validate_journal_line_scope','books_guard_closed_period','books_reject_mutation','post_books_journal_entry'])await db.exec(definition(foundation,`create or replace function public.${fn}(`,'\n$$;'))
 const hardened=read('20260812120755_books_release_hardening.sql')
 for(const fn of ['books_guard_posted_journal','reverse_books_journal_entry'])await db.exec(definition(hardened,`create or replace function public.${fn}(`,'\n$$;'))
 await db.exec(read('20260808170000_books_balance_trigger_row_type_fix.sql'))
 for(const name of ['journal_lines_validate_scope','journal_entries_guard_posted','journal_entries_closed_period_guard','accounting_facts_immutable'])await db.exec(definition(foundation,`create trigger ${name}\n`,';'))
 await db.exec(definition(hardened,'create trigger journal_lines_guard_posted\n',';'))
 for(const name of ['journal_entries_balanced','journal_lines_balanced'])await db.exec(definition(foundation,`create constraint trigger ${name}\n`,';'))
 await db.exec(definition(read('20261003022656_books_projection_receipts.sql'),'create or replace function public.record_books_projection_receipt','\n$$;'))
 await db.exec('drop table books_payroll_postings');await db.exec(read('20261004001339_books_payroll_atomic_posting.sql'))
 const remote=read('20260517092101_remote_schema.sql');await db.exec(definition(remote,'CREATE OR REPLACE FUNCTION "public"."tg_set_updated_at"()', '$$;'))
 await db.exec(definition(read('20260603210000_add_job_cost_entries.sql'),'create trigger job_cost_entries_set_updated_at',';'))
 if(ownership){await db.exec('drop table books_payroll_labor_ownership');await db.exec(read('20261004004909_books_payroll_native_ownership.sql'))}
 await require('../fixtures/books-export-snapshot-database').installBooksExportSnapshot(db)
}
async function ready(t,{billing='time_and_materials_rate',native=true,paid=false,laterOriginal=false,ownership=true}={}){
 const f=paid?await setup(t):await scenario(t,native)
 await f.db.exec(`insert into accounting_periods(id,org_id,period_start,period_end,status,fiscal_year,fiscal_period) values('${id(250)}','${org}','2026-09-01','2026-09-30','open',2026,9)`)
 if(laterOriginal){await f.db.query("update journal_entries set entry_date='2026-10-02' where id=$1",[id(61)]);await f.db.exec(`insert into accounting_periods(id,org_id,period_start,period_end,status,fiscal_year,fiscal_period) values('${id(251)}','${org}','2026-10-01','2026-10-31','open',2026,10)`)}
 await upgrade(f.db,{ownership})
 if(native)await f.db.query("update billable_costs set metadata=jsonb_set(metadata,'{billing_method}',$1::jsonb)",[JSON.stringify(billing)])
 await refresh(f);await prepare(f.db,f.evidence);await review(f.db,f.evidence)
 f.parent=(await capture(f.db)).tables.books_payroll_imports[0]
 if(paid){
  f.payment=payrollPaymentReviewEvidence(f.evidence,f.request,[f.proof]);const p=f.payment
  await f.db.query('select prepare_books_payroll_payment_review($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7)',[org,id(50),JSON.stringify(p.request),JSON.stringify(p.evidence),p.evidenceDigest,'Reviewed original provider payment allocation','atomic-payment-review-key'])
  await f.db.query('select review_books_payroll_payment_review($1,$2,$3,$4::jsonb,$5,$6)',[org,p.request.id,id(51),JSON.stringify(p.evidence),p.evidenceDigest,'Independent original payment allocation review'])
  f.paymentRecord=(await capture(f.db)).tables.books_payroll_payment_reviews[0]
 }
 f.plan=payrollPostingPlan(f.parent,f.paymentRecord||null)
 await prepareProposal(f);await reviewProposal(f);return f
}
const post=(f,overrides={})=>f.db.query('select post_books_payroll_proposal($1,$2,$3,$4,$5,$6,$7) result',[org,overrides.id||id(260),id(230),id(2),overrides.digest||f.plan.digest,overrides.notes||'Post independently reviewed payroll and project corrections',overrides.key||'atomic-payroll-posting-key'])
module.exports={ready,upgrade,post}
