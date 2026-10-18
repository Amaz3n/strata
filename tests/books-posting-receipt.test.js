const { migrationSql } = require("./support/migration-sql")
require('../scripts/register-ts-node-test');const test=require('node:test');const assert=require('node:assert/strict');
const {resolveBooksPostingState}=require('../lib/services/books/posting-state');
test('posting state requires verification of the current revision and a live journal',()=>{
 const input={sourceUpdatedAt:'2026-09-30T12:00:00Z',receipt:{sourceObservedAt:'2026-09-30T12:00:00Z',journalStatus:'posted'}};
 assert.equal(resolveBooksPostingState(input),'posted');
 assert.equal(resolveBooksPostingState({...input,sourceUpdatedAt:'2026-09-30T12:01:00Z'}),'pending');
 assert.equal(resolveBooksPostingState({...input,receipt:null}),'pending');
 assert.equal(resolveBooksPostingState({...input,receipt:{...input.receipt,journalStatus:'reversed'}}),'pending');
 assert.equal(resolveBooksPostingState({...input,failureCategory:'projection_blocked_by_closed_period'}),'blocked');
 assert.equal(resolveBooksPostingState({...input,failureCategory:'projection_failed'}),'failed');
 assert.equal(resolveBooksPostingState({...input,sourceUpdatedAt:'invalid'}),'pending');
 assert.equal(resolveBooksPostingState({sourceUpdatedAt:'2026-09-30T12:00:00.000002Z',receipt:{sourceObservedAt:'2026-09-30T12:00:00.000001Z',journalStatus:'posted'}}),'pending');
 assert.equal(resolveBooksPostingState({...input,sourceUpdatedAt:'2026-09-30T08:00:00-04:00'}),'posted');
});
test('projection receipts verify journal ownership and never replace newer observations with stale work',async t=>{
 const {createBooksLedgerDb}=require('./helpers/books-ledger-db');const db=await createBooksLedgerDb();t.after(()=>db.close());
 await db.exec(migrationSql("20261003022656_books_projection_receipts"));
 const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;const org=id(1),source=id(2),fact=id(3),cash=id(4),income=id(5);
 await db.exec(`insert into orgs values('${org}');insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values('${cash}','${org}','1000','Cash','asset','cash','debit'),('${income}','${org}','4000','Revenue','income','construction_revenue','credit');
 insert into accounting_facts(id,org_id,source_type,source_id,source_version,fact_kind,occurred_at,accounting_date,payload,payload_hash,policy_version,idempotency_key) values('${fact}','${org}','invoice','${source}',1,'invoice.recognized','2026-09-30','2026-09-30','{}',repeat('a',64),1,'fixture');`);
 const entry=(await db.query('select post_books_journal_entry($1,$2,$3) id',[org,JSON.stringify({fact_id:fact,entry_date:'2026-09-30',entry_kind:'operational',memo:'Invoice',posting_key:'fixture',policy_version:1}),JSON.stringify([{line_no:1,account_id:cash,debit_cents:10000,credit_cents:0},{line_no:2,account_id:income,debit_cents:0,credit_cents:10000}])])).rows[0].id;
 const record=(date,sourceId=source,orgId=org)=>db.query('select record_books_projection_receipt($1,\'invoice\',$2,$3,$4,$5)',[orgId,sourceId,date,fact,entry]);
 await record('2026-10-02T00:00:00Z');await record('2026-10-01T00:00:00Z');
 const rows=(await db.query('select source_observed_at from books_projection_receipts')).rows;assert.equal(rows.length,1);assert.equal(new Date(rows[0].source_observed_at).toISOString(),'2026-10-02T00:00:00.000Z');
 await assert.rejects(record('2026-10-03',id(9)),/requires a posted journal/);await assert.rejects(record('2026-10-03',source,id(9)),/requires a posted journal/);
 await db.exec('set role authenticated');await assert.rejects(db.query('select * from books_projection_receipts'),/permission denied/);await assert.rejects(record('2026-10-03'),/permission denied/);await db.exec('reset role');
});
