require("../scripts/register-ts-node-test")
const test=require("node:test")
const assert=require("node:assert/strict")
const {expectedContractLoss}=require("../lib/financials/expected-loss")
test("expected loss reserve excludes the loss already incurred and unwinds as work completes",()=>{
  assert.deepEqual(expectedContractLoss({contractCents:100000,eacCents:120000,costCents:60000,earnedCents:50000}),{totalExpectedLossCents:20000,incurredLossCents:10000,reserveCents:10000})
  assert.equal(expectedContractLoss({contractCents:100000,eacCents:120000,costCents:120000,earnedCents:100000}).reserveCents,0)
  assert.equal(expectedContractLoss({contractCents:100000,eacCents:90000,costCents:60000,earnedCents:66667}).reserveCents,0)
  assert.throws(()=>expectedContractLoss({contractCents:100000,eacCents:50000,costCents:60000,earnedCents:50000}),/below incurred/)
})
test("real expected-loss RPC posts, retries without duplication, releases at completion and rejects contract netting",async t=>{
  const {createBooksLedgerDb}=require("./helpers/books-ledger-db")
  const db=await createBooksLedgerDb();t.after(()=>db.close())
  const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`
  const org=id(1),actor=id(2),project=id(3),period=id(4),cash=id(5),income=id(6),cost=id(7)
  await db.exec(`insert into orgs values('${org}');insert into app_users values('${actor}');insert into projects(id,org_id) values('${project}','${org}');
    insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period) values('${period}','${org}','2026-09-01','2026-09-30',2026,9);
    insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values('${cash}','${org}','1000','Cash','asset','cash','debit'),('${income}','${org}','4000','Revenue','income','construction_revenue','credit'),('${cost}','${org}','5000','Job costs','cogs','job_costs','debit');
    insert into job_cost_entries values('${id(10)}','${org}','${project}','posted','2026-09-20',60000);`)
  const post=(key,amount,expense=false)=>db.query('select post_books_journal_entry($1,$2,$3)',[org,JSON.stringify({entry_date:"2026-09-30",entry_kind:"operational",memo:key,posting_key:key,source_type:"test",source_id:project,policy_version:1}),JSON.stringify([{line_no:1,account_id:expense?cost:cash,project_id:project,debit_cents:amount,credit_cents:0},{line_no:2,account_id:expense?cash:income,project_id:project,debit_cents:0,credit_cents:amount}])])
  const prepare=async()=>{
    const snapshotId=(await db.query('select prepare_books_wip_atomic($1,$2,$3,$4,100000,0,120000,$5) id',[org,period,project,actor,"Expected final contract costs supported by estimate"])).rows[0].id
    const row=(await db.query('select * from poc_snapshots where id=$1',[snapshotId])).rows[0]
    await db.query('select review_books_wip_atomic($1,$2,$3,$4)',[org,period,actor,JSON.stringify({note:"Reviewed expected contract loss",snapshots:[{projectId:project,snapshotId,inputsHash:row.inputs_hash,asOf:"2026-09-30",earnedRevenueCents:Number(row.earned_revenue_cents),warnings:[]}]})])
    return snapshotId
  }
  await post("cost",60000,true)
  const first=await prepare()
  await db.query('select begin_books_period_close($1,$2)',[org,period])
  const provision=snapshot=>db.query('select post_books_expected_loss_atomic($1,$2,$3,$4,1,1) result',[org,period,snapshot,actor])
  await assert.rejects(provision(first),/Post reviewed WIP revenue/)
  await db.query("update accounting_periods set status='reopened' where id=$1",[period])
  await post("earned",50000)
  await db.exec(`insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values('${id(30)}','${org}','2360','Existing unrelated liability','liability','other_liability','credit')`)
  await assert.rejects(prepare(),/account codes conflict/)
  await db.query('delete from gl_accounts where id=$1',[id(30)])
  await db.exec(`insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values('${id(31)}','${org}','1160','Capitalized costs','asset','work_in_progress','debit')`)
  const capitalize=(key,reverse=false)=>db.query('select post_books_journal_entry($1,$2,$3)',[org,JSON.stringify({entry_date:"2026-09-30",entry_kind:"operational",memo:key,posting_key:key,source_type:"test",source_id:project,policy_version:1}),JSON.stringify([{line_no:1,account_id:id(31),project_id:project,debit_cents:reverse?0:1000,credit_cents:reverse?1000:0},{line_no:2,account_id:cash,project_id:project,debit_cents:reverse?1000:0,credit_cents:reverse?0:1000}])])
  await capitalize("capitalized")
  await assert.rejects(prepare(),/impairment review/)
  await capitalize("capitalized-reversal",true)
  assert.equal(await prepare(),first)
  await db.query('select begin_books_period_close($1,$2)',[org,period])
  assert.equal((await provision(first)).rows[0].result.deltaCents,10000)
  assert.equal((await provision(first)).rows[0].result.posted,false)
  const net=async()=>Number((await db.query("select sum(l.credit_cents-l.debit_cents) amount from journal_lines l join gl_accounts a on a.id=l.account_id where a.account_type in ('income','cogs')")).rows[0].amount)
  assert.equal(await net(),-20000)
  await db.query("update accounting_periods set status='reopened' where id=$1",[period])
  await db.exec(`insert into job_cost_entries values('${id(11)}','${org}','${project}','posted','2026-09-29',60000)`)
  await post("finish-cost",60000,true);await post("finish-revenue",50000)
  const final=await prepare()
  await db.query('select begin_books_period_close($1,$2)',[org,period])
  assert.equal((await provision(final)).rows[0].result.deltaCents,-10000)
  assert.equal(await net(),-20000)
  assert.equal(Number((await db.query("select sum(l.credit_cents-l.debit_cents) amount from journal_lines l join gl_accounts a on a.id=l.account_id where a.code='2360'")).rows[0].amount),0)
  await db.exec(`insert into contracts values('${id(20)}','${org}','${project}',null,'active'),('${id(21)}','${org}','${project}',null,'active')`)
  await assert.rejects(provision(final),/multiple primary contracts/)
})
