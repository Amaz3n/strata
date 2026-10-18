const { migrationSql } = require("./support/migration-sql")
require('../scripts/register-ts-node-test');const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
const {resolveBooksPostingState}=require('../lib/services/books/posting-state');
test('line edits invalidate receipts and source revisions advance past transaction-time triggers',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec("create role anon;create role authenticated;create function tg_set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end;$$");
 for(const table of ['invoices','vendor_bills','project_expenses']) {
  await db.exec(`create table ${table}(id uuid primary key,org_id uuid,updated_at timestamptz default now());create trigger ${table}_set_updated_at before update on ${table} for each row execute function tg_set_updated_at();`);
 }
 await db.exec('create table invoice_lines(id uuid primary key,org_id uuid,invoice_id uuid,amount_cents bigint);');
 await db.exec('create table bill_lines(id uuid primary key,bill_id uuid,amount_cents bigint);create table project_expense_lines(id uuid primary key,expense_id uuid,amount_cents bigint);');
 const hardening=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260812120755_books_release_hardening.sql'),'utf8');
 for(const [table,fn] of [['bill_lines','books_touch_vendor_bill_from_line'],['project_expense_lines','books_touch_expense_from_line']]) {
  const start=hardening.indexOf(`create or replace function public.${fn}()`);await db.exec(hardening.slice(start,hardening.indexOf('\n$$;',start)+4));
  await db.exec(`create trigger touch_parent after insert or update or delete on ${table} for each row execute function ${fn}()`);
 }

 await db.exec(migrationSql("20261003023206_books_source_revision_invalidation"));
 const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;const org=id(1),first=id(2),second=id(3),line=id(4);
 const stamp=async(table,record)=>(await db.query(`select to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') stamp from ${table} where id=$1`,[record])).rows[0].stamp;
 await db.query("insert into invoices values($1,$3,'2099-01-01'),($2,$3,'2099-01-01')",[first,second,org]);
 const initial=await stamp('invoices',first);
 await db.query('insert into invoice_lines values($1,$2,$3,10000)',[line,org,first]);
 const inserted=await stamp('invoices',first);assert.ok(inserted>initial);
 assert.equal(resolveBooksPostingState({sourceUpdatedAt:inserted,receipt:{sourceObservedAt:initial,journalStatus:'posted'}}),'pending');
 await db.query('update invoice_lines set amount_cents=12000 where id=$1',[line]);const edited=await stamp('invoices',first);assert.ok(edited>inserted);
 await db.query('update invoice_lines set invoice_id=$1 where id=$2',[second,line]);assert.ok((await stamp('invoices',first))>edited);assert.ok((await stamp('invoices',second))>initial);
 const moved=await stamp('invoices',second);await db.query('delete from invoice_lines where id=$1',[line]);assert.ok((await stamp('invoices',second))>moved);
 for(const table of ['vendor_bills','project_expenses']) {
  await db.query(`insert into ${table} values($1,$2,'2099-01-01')`,[first,org]);const before=await stamp(table,first);
  await db.query(`update ${table} set updated_at='2000-01-01' where id=$1`,[first]);assert.ok((await stamp(table,first))>before);
  const child=table==='vendor_bills'?'bill_lines':'project_expense_lines';const parent=table==='vendor_bills'?'bill_id':'expense_id';
  const beforeChild=await stamp(table,first);await db.query(`insert into ${child} values($1,$2,1000)`,[line,first]);const insertedChild=await stamp(table,first);assert.ok(insertedChild>beforeChild);
  await db.query(`update ${child} set amount_cents=2000 where ${parent}=$1`,[first]);const editedChild=await stamp(table,first);assert.ok(editedChild>insertedChild);
  await db.query(`delete from ${child} where id=$1`,[line]);assert.ok((await stamp(table,first))>editedChild);

 }
});

test('a voided or rejected source with a reversed entry reads reversed, never pending or posted',()=>{
 const receipt={sourceObservedAt:'2026-10-06T12:00:00.000000Z',journalStatus:'reversed'};
 assert.equal(resolveBooksPostingState({sourceUpdatedAt:'2026-10-06T12:00:01.000000Z',receipt,sourceProjectable:false}),'reversed');
 assert.equal(resolveBooksPostingState({sourceUpdatedAt:'2026-10-06T12:00:01.000000Z',receipt,sourceProjectable:true}),'pending');
 assert.equal(resolveBooksPostingState({sourceUpdatedAt:'2026-10-06T12:00:01.000000Z',receipt,sourceProjectable:false,failureCategory:'projection_failed'}),'failed');
});
