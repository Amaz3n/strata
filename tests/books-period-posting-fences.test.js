const test=require('node:test'),assert=require('node:assert/strict')
const {createBooksLedgerDb}=require('./helpers/books-ledger-db')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
async function fixture(t){
 const db=await createBooksLedgerDb();t.after(()=>db.close())
 await db.exec(`insert into orgs values('${id(1)}'),('${id(9)}');insert into app_users values('${id(2)}');
 insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values('${id(4)}','${id(1)}','1000','Cash','asset','cash','debit'),('${id(5)}','${id(1)}','4000','Revenue','income','construction_revenue','credit');
 insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period) values('${id(3)}','${id(1)}','2026-09-01','2026-09-30',2026,9),('${id(7)}','${id(1)}','2026-10-01','2026-10-31',2026,10),('${id(8)}','${id(9)}','2026-09-01','2026-09-30',2026,9);`)
 const insert=(i,extra={})=>db.query("insert into journal_entries(id,org_id,entry_date,entry_kind,memo,posting_key,policy_version,source_type,period_id) values($1,$2,$3,'operational','Sale',$4,1,'invoice',$5) returning period_id",[id(i),id(1),extra.date||'2026-09-15',`sale:${i}`,extra.period||null])
 const lines=i=>db.query('insert into journal_lines(org_id,entry_id,account_id,line_no,debit_cents,credit_cents) values($1,$2,$3,1,10000,0),($1,$2,$4,2,0,10000)',[id(1),id(i),id(4),id(5)])
 const post=i=>db.query("update journal_entries set status='posted',posted_at=now() where id=$1",[id(i)])
 return {db,insert,lines,post}
}
test('closing review blocks a previously prepared draft from becoming posted and rejects omitted period IDs',async t=>{
 const {db,insert,lines,post}=await fixture(t)
 assert.equal((await insert(20)).rows[0].period_id,id(3));await lines(20)
 await db.query('select begin_books_period_close($1,$2)',[id(1),id(3)])
 await assert.rejects(post(20),/reviewing/);await assert.rejects(insert(21),/reviewing/)
 assert.equal((await db.query('select status from journal_entries where id=$1',[id(20)])).rows[0].status,'draft')
 await db.query("update accounting_periods set status='closed',closed_at=now(),closed_by='00000000-0000-4000-8000-000000000002',close_digest='verified' where id=$1",[id(3)])
 await assert.rejects(insert(22),/closed/)
 await db.query("update accounting_periods set status='reopened' where id=$1",[id(3)]);await post(20)
})
test('explicit journal periods cannot redirect dates or cross organization boundaries',async t=>{
 const {insert}=await fixture(t)
 await assert.rejects(insert(20,{period:id(7)}),/organization and accounting period/)
 await assert.rejects(insert(21,{period:id(8)}),/organization and accounting period/)
 await assert.rejects(insert(22,{period:id(99)}),/organization and accounting period/)
})
test('recorded journal calendar cannot be moved or removed; closed original can be reversed in an open later month',async t=>{
 const {db,insert,lines,post}=await fixture(t)
 await insert(20);await lines(20);await post(20)
 await assert.rejects(db.query('delete from accounting_periods where id=$1',[id(3)]),/recorded journals/)
 await assert.rejects(db.query("update accounting_periods set period_start='2026-09-02' where id=$1",[id(3)]),/recorded journals/)
 await db.query("update accounting_periods set status='closed',closed_at=now(),closed_by='00000000-0000-4000-8000-000000000002',close_digest='verified' where id=$1",[id(3)])
 const entry={entry_date:'2026-10-15',entry_kind:'reversal',memo:'Reverse prior sale',posting_key:'reverse:20',policy_version:1,source_type:'invoice',reversal_of_entry_id:id(20),created_by:id(2)}
 const reversalLines=[{account_id:id(4),line_no:1,debit_cents:0,credit_cents:10000},{account_id:id(5),line_no:2,debit_cents:10000,credit_cents:0}]
 const result=(await db.query('select reverse_books_journal_entry($1,$2,$3::jsonb,$4::jsonb) result',[id(1),id(20),JSON.stringify(entry),JSON.stringify(reversalLines)])).rows[0].result
 assert.equal(result.created,true);assert.equal((await db.query('select status from journal_entries where id=$1',[id(20)])).rows[0].status,'reversed')
 assert.equal((await db.query('select period_id from journal_entries where id=$1',[result.id])).rows[0].period_id,id(7))
 await assert.rejects(db.query("update journal_entries set memo='Rewrite history' where id=$1",[id(20)]),/immutable/)
})
