import fs from 'node:fs';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.ARC_BOOKS_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
process.on('uncaughtException', e => { console.error(e.message, e.where ?? ''); process.exit(1); });
const read = name => fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const foundation=read('20260801143926_books_accounting_foundation.sql'),sole=read('20260812150201_books_sole_ledger_operations.sql'),remote=read('20260517092101_remote_schema.sql');
await db.exec(`create role anon;create role authenticated;create role service_role;create schema extensions;
create function extensions.digest(text,text) returns bytea language sql immutable as $$select decode(md5($1),'hex')$$;
create table orgs(id uuid primary key);create table app_users(id uuid primary key);create table accounting_connections(id uuid primary key);
create table companies(id uuid primary key,org_id uuid);create table contacts(id uuid primary key,org_id uuid);create table projects(id uuid primary key,org_id uuid,client_id uuid);create table contracts(id uuid primary key,org_id uuid,project_id uuid);
create table gl_accounts(id uuid primary key default gen_random_uuid(),org_id uuid,code text,subtype text,active boolean default true);
create table bank_accounts(id uuid primary key,org_id uuid,gl_account_id uuid);
create table journal_entries(id uuid primary key default gen_random_uuid(),org_id uuid,entry_date date,status text default 'posted',entry_kind text,source_type text,source_id uuid,posting_key text,unique(org_id,posting_key));
create table journal_lines(id uuid primary key default gen_random_uuid(),org_id uuid,entry_id uuid,account_id uuid,debit_cents bigint,credit_cents bigint,project_id uuid,dimensions jsonb);
create table books_settings(org_id uuid,active_policy_version integer,workspace_enabled boolean,arc_ledger_mode text);
create table accounting_facts(id uuid primary key,org_id uuid,source_type text,source_id uuid);`);
for (const table of ['invoices','invoice_lines','payments','vendor_bills','bill_lines','retainage']) {
 const start=remote.indexOf('CREATE TABLE IF NOT EXISTS "public"."'+table+'" (');
 assert.ok(start>=0,table);await db.exec(remote.slice(start,remote.indexOf('\n);',start)+4));
 await db.exec(`alter table ${table} add primary key(id)`);
}
await db.exec('alter table vendor_bills add company_id uuid; alter table vendor_bills add retainage_released_cents bigint default 0;');
for (const [sql,tables] of [[foundation,['opening_balance_batches','opening_balance_lines','opening_balance_approvals']],[sole,['books_debt_instruments','books_debt_events','books_fixed_assets','books_fixed_asset_events']]]) for(const table of tables){
 const start=sql.indexOf('create table public.'+table+' (');await db.exec(sql.slice(start,sql.indexOf('\n);',start)+4));
}
await db.exec(`create function post_books_journal_entry(org uuid,e jsonb,lines jsonb) returns uuid language plpgsql set search_path=public as $$declare eid uuid;l jsonb;begin
if (select sum((x->>'debit_cents')::bigint-(x->>'credit_cents')::bigint) from jsonb_array_elements(lines)x)<>0 then raise exception 'Unbalanced';end if;
insert into journal_entries(org_id,entry_date,entry_kind,source_type,source_id,posting_key)values(org,(e->>'entry_date')::date,e->>'entry_kind',e->>'source_type',(e->>'source_id')::uuid,e->>'posting_key')returning id into eid;
for l in select * from jsonb_array_elements(lines)loop insert into journal_lines(org_id,entry_id,account_id,debit_cents,credit_cents,project_id,dimensions)values(org,eid,(l->>'account_id')::uuid,(l->>'debit_cents')::bigint,(l->>'credit_cents')::bigint,(l->>'project_id')::uuid,l->'dimensions');end loop;return eid;end$$;`);
await db.exec(`alter table journal_entries add reversal_of_entry_id uuid;alter table journal_entries add projection_version integer default 1;alter table journal_entries add policy_version integer default 1;alter table journal_lines add line_no integer default 1;alter table journal_lines add company_id uuid;alter table journal_lines add description text;`);
const hardening=read('20260812120755_books_release_hardening.sql');
const reverseStart=hardening.indexOf('create or replace function public.reverse_books_journal_entry(');
await db.exec(hardening.slice(reverseStart,hardening.indexOf('\n$$;',reverseStart)+4));
await db.exec(read('20260908024655_books_opening_continuity.sql'));
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,org=id(1),owner=id(2),accountant=id(3),customer=id(4),project=id(5),vendor=id(6),batch=id(7);
await db.exec(`insert into orgs values('${org}');insert into app_users values('${owner}'),('${accountant}');insert into contacts values('${customer}','${org}');insert into companies values('${vendor}','${org}');insert into projects values('${project}','${org}','${customer}');insert into books_settings values('${org}',1,true,'parallel');insert into contracts values('${id(8)}','${org}','${project}');`);
const accounts=[['1100','accounts_receivable'],['2000','accounts_payable'],['2300','customer_deposits'],['1500','fixed_assets'],['1590','accumulated_depreciation'],['2500','long_term_debt'],['1000','cash'],['6100','interest'],['6200','depreciation'],['3000','owner_equity'],['1110','retainage_receivable'],['2010','retainage_payable']];
for(const [i,[code,type]] of accounts.entries()) await db.query('insert into gl_accounts(id,org_id,code,subtype)values($1,$2,$3,$4)',[id(20+i),org,code,type]);
await db.query(`insert into opening_balance_batches(id,org_id,cutover_date,status,digest,source_content_hash)values($1,$2,'2026-01-31','validated','reviewed','source')`,[batch,org]);
const lines=[
 [0,'ar',100000,0,{document_number:'AR-1'}], [1,'ap',0,80000,{document_number:'AP-1'}], [2,'deposit',0,50000,{document_number:'DEP-1'}],
 [3,'fixed_asset',1000000,0,{asset_number:'TRUCK',useful_life_months:60,accumulated_depreciation_account_id:id(24),depreciation_expense_account_id:id(28),funding_account_id:id(26)}],
 [4,'fixed_asset',0,300000,{asset_number:'TRUCK'}], [5,'loan',0,2000000,{cash_account_id:id(26),interest_account_id:id(27)}],
 [10,'ar',10000,0,{document_number:'AR-RETAINED',contract_id:id(8)}], [11,'ap',0,20000,{document_number:'AP-RETAINED'}], [9,'equity',1340000,0,{}]
];
for(const [i,[account,type,debit,credit,details]]of lines.entries()) await db.query(`insert into opening_balance_lines(org_id,batch_id,line_no,account_id,subledger_type,project_id,company_id,description,debit_cents,credit_cents,details)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[org,batch,i+1,id(20+account),type,project,type==='ap'?vendor:null,'Opening '+i,debit,credit,JSON.stringify(details)]);
assert.equal((await db.query(`select approve_books_opening_batch($1,$2,'owner',$3)n`,[org,batch,owner])).rows[0].n,1);
await assert.rejects(db.query(`update opening_balance_lines set debit_cents=debit_cents+1 where batch_id=$1 and line_no=1`,[batch]),/frozen/);
await assert.rejects(db.query(`select approve_books_opening_batch($1,$2,'accountant',$3)`,[org,batch,owner]),/unique/);
await db.query(`select approve_books_opening_batch($1,$2,'accountant',$3)`,[org,batch,accountant]);
const posted=(await db.query('select post_books_opening_batch($1,$2,$3)id',[org,batch,owner])).rows[0].id;
assert.equal((await db.query('select post_books_opening_batch($1,$2,$3)id',[org,batch,owner])).rows[0].id,posted);
assert.deepEqual((await db.query('select invoice_number,total_cents,balance_due_cents from invoices order by invoice_number')).rows,[{invoice_number:'AR-1',total_cents:100000,balance_due_cents:100000},{invoice_number:'AR-RETAINED',total_cents:0,balance_due_cents:0},{invoice_number:'DEP-1',total_cents:50000,balance_due_cents:0}]);
assert.equal(Number((await db.query('select sum(amount_cents)n from retainage')).rows[0].n),10000);
assert.equal(Number((await db.query('select opening_accumulated_depreciation_cents n from books_fixed_assets')).rows[0].n),300000);
assert.equal(Number((await db.query('select original_principal_cents n from books_debt_instruments')).rows[0].n),2000000);
assert.equal(Number((await db.query('select sum(total_cents-retainage_cents)n from vendor_bills')).rows[0].n),80000);
// Execute the actual AP payment RPC, not a hand-written balance update.
await db.exec(`create table payment_run_items(org_id uuid,bill_id uuid,status text);create table audit_log(org_id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,before_data jsonb,after_data jsonb,source text);alter table payments add check_number text;alter table payments add release_evidence jsonb;`);
const apMigration=read('20260812120508_harden_payable_payment_lifecycle.sql');
const apStart=apMigration.indexOf('create or replace function public.record_manual_ap_payment_atomic(');
await db.exec(apMigration.slice(apStart,apMigration.indexOf('\n$$;',apStart)+4));
await db.exec(read('20260908031539_books_manual_payment_funding.sql'));
const ap=(await db.query("select id from vendor_bills where bill_number='AP-1'")).rows[0].id;
await db.exec(`create table payment_allocations(org_id uuid,invoice_id uuid,payment_id uuid,amount_cents bigint);create table payment_reversals(org_id uuid,invoice_id uuid,payment_id uuid,amount_cents bigint,status text);create table receivable_adjustments(org_id uuid,invoice_id uuid,amount_cents bigint,status text);create table invoice_payment_reservations(id uuid,org_id uuid,invoice_id uuid,principal_cents bigint,status text,updated_at timestamptz,expires_at timestamptz);`);
function functionSql(file,name) { const sql=read(file);const start=sql.indexOf('create or replace function public.'+name+'(');assert.ok(start>=0,name);return sql.slice(start,sql.indexOf('\n$$;',start)+4); }
for(const [file,name] of [
 ['20260812160000_receivable_adjustments.sql','invoice_paid_cents'],
 ['20260715100001_unify_invoice_status_engine.sql','derive_invoice_status'],
 ['20260715100001_unify_invoice_status_engine.sql','recalc_invoice_balance_atomic'],
 ['20260821122229_payment_engine_overpayment_and_ordering.sql','invoice_pending_payment_cents'],
 ['20260821122229_payment_engine_overpayment_and_ordering.sql','apply_invoice_payment_atomic'],
 ['20260821122229_payment_engine_overpayment_and_ordering.sql','apply_invoice_payment_with_details_atomic'],
 ['20260812120755_books_release_hardening.sql','apply_customer_deposit_atomic'],
]) await db.exec(functionSql(file,name));
await db.exec('begin');
const payAp=`select record_manual_ap_payment_with_books_atomic('${org}','${ap}','${owner}',30000,'usd','check','check 100','100','2026-02-02',null,'opening-ap-first','${id(26)}') result`;
const firstAp=(await db.query(payAp)).rows[0].result;
assert.equal((await db.query(payAp)).rows[0].result.duplicate,true);
assert.equal(Number((await db.query('select total_cents-retainage_cents-paid_cents n from vendor_bills where id=$1',[ap])).rows[0].n),50000);
assert.equal((await db.query('select metadata from payments where id=$1',[firstAp.payment_id])).rows[0].metadata.books_payment_account_id,id(26));
await assert.rejects(db.query(payAp.replace(id(26),id(20))),/native bank/);
await db.exec('rollback');
const ar=(await db.query("select id from invoices where invoice_number='AR-1'")).rows[0].id;
await db.exec('begin');
const receiptCall=`select apply_invoice_payment_with_details_atomic('${org}','${ar}',40000,'usd','check','manual','opening-receipt','succeeded','receipt 1',0,40000,40000,'opening-receipt','{}','2026-02-02',null,null,0,0,0,null,null) result`;
const firstReceipt=(await db.query(receiptCall)).rows[0].result;
assert.equal((await db.query(receiptCall)).rows[0].result.id,firstReceipt.id);
assert.equal((await db.query('select balance_due_cents from invoices where id=$1',[ar])).rows[0].balance_due_cents,60000);
const deposit=(await db.query("select p.id from payments p join invoices i on i.id=p.invoice_id where i.invoice_number='DEP-1'")).rows[0].id;
await db.query(`select apply_customer_deposit_atomic('${org}','${deposit}','${ar}',20000,'${owner}','2026-02-02')`);
assert.equal((await db.query('select balance_due_cents from invoices where id=$1',[ar])).rows[0].balance_due_cents,40000);
assert.equal(Number((await db.query("select sum(amount_cents)n from payments where metadata->>'deposit_payment_id'=$1",[deposit])).rows[0].n),20000);
await assert.rejects(db.query(`select apply_customer_deposit_atomic('${org}','${deposit}','${ar}',40000,'${owner}','2026-02-02')`),/unapplied/);
await db.exec('rollback');
await assert.rejects(db.query('update invoices set total_cents=1 where id=$1',[ar]),/frozen/);
await db.query('update invoices set balance_due_cents=60000 where id=$1',[ar]);
await db.query("insert into payments(org_id,invoice_id,amount_cents,status)values($1,$2,40000,'succeeded')",[org,ar]);
await assert.rejects(db.query("select reverse_books_opening_batch($1,$2,'2026-02-01','Correct import test',$3)",[org,batch,owner]),/downstream/);
await db.query('delete from payments where invoice_id=$1',[ar]);
await db.query("select reverse_books_opening_batch($1,$2,'2026-02-01','Correct import test',$3)",[org,batch,owner]);
assert.equal((await db.query('select status from opening_balance_batches where id=$1',[batch])).rows[0].status,'reversed');
assert.equal(Number((await db.query('select count(*)n from books_fixed_assets')).rows[0].n),0);
assert.equal(Number((await db.query('select count(*)n from books_debt_instruments')).rows[0].n),0);
console.log('PASS: actual AR receipt/retry, deposit application/capacity and remaining balances; first imported AP payment/retry/funding, remaining payable; opening atomic materialization, AR/AP/deposit/retainage/assets/debt, distinct approvals, frozen manifest, idempotent post. Minimal dependency fixture; posting RPC stub, no live database.');
await db.close();
