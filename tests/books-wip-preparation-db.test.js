const test = require("node:test")
const assert = require("node:assert/strict")
const { createBooksLedgerDb } = require("./helpers/books-ledger-db")
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`
test("historical WIP preparation uses dated sources, preserves provenance and revisions, and invalidates old review", async t => {
  const db = await createBooksLedgerDb(); t.after(() => db.close())
  const org=id(1), actor=id(2), project=id(3), period=id(4)
  await db.exec(`insert into orgs values('${org}'); insert into app_users values('${actor}'); insert into projects(id,org_id) values('${project}','${org}');
    insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period) values('${period}','${org}','2026-09-01','2026-09-30',2026,9);
    insert into job_cost_entries values('${id(10)}','${org}','${project}','posted','2026-09-20',4000),('${id(11)}','${org}','${project}','posted','2026-10-01',9000);
    insert into invoices values('${id(20)}','${org}','${project}','paid','2026-09-20',9000,1000,'{}'),('${id(21)}','${org}','${project}','sent','2026-09-25',2000,0,'{}'),('${id(22)}','${org}','${project}','sent','2026-09-25',99000,0,'{"invoice_kind":"earnest_deposit"}');
    insert into retainage values('${org}','${id(20)}','${id(21)}',2000);
    insert into receivable_adjustments values('${id(30)}','${org}','${project}','posted','credit_memo','2026-09-25',1100,100,null);`)
  const prepare=(original=20000,eac=10000) => db.query('select prepare_books_wip_atomic($1,$2,$3,$4,$5,1000,$6,$7) id',[org,period,project,actor,original,eac,"Estimate supported by September contract review"])
  await assert.rejects(prepare(20000,3000), /below incurred/)
  const first=(await prepare()).rows[0].id
  const row=(await db.query('select * from poc_snapshots where id=$1',[first])).rows[0]
  assert.equal(Number(row.cost_to_date_cents),4000)
  assert.equal(Number(row.billed_cents),9000)
  assert.equal(Number(row.earned_revenue_cents),8400)
  assert.equal(row.preparation.preparedBy,actor)
  assert.equal(row.preparation.sources.costs.length,1)
  assert.equal(row.preparation.sources.billings.length,1)
  assert.equal((await prepare()).rows[0].id,first)
  const evidence={projectId:project,snapshotId:first,inputsHash:row.inputs_hash,asOf:"2026-09-30",earnedRevenueCents:8400,warnings:[]}
  await db.query('select review_books_wip_atomic($1,$2,$3,$4)',[org,period,actor,JSON.stringify({note:"Reviewed costs and contract",snapshots:[evidence]})])
  await db.exec(`insert into job_cost_entries values('${id(12)}','${org}','${project}','posted','2026-09-29',1000)`)
  assert.equal((await db.query('select books_wip_sources_current($1,$2) current',[org,[first]])).rows[0].current,false)
  await assert.rejects(db.query('select review_books_wip_atomic($1,$2,$3,$4)',[org,period,actor,JSON.stringify({note:"Reviewed costs and contract",snapshots:[evidence]})]),/source evidence changed/)
  const second=(await prepare()).rows[0].id
  assert.notEqual(second,first)
  assert.equal(Number((await db.query('select earned_revenue_cents from poc_snapshots where id=$1',[second])).rows[0].earned_revenue_cents),10500)
  await assert.rejects(db.query('select review_books_wip_atomic($1,$2,$3,$4)',[org,period,actor,JSON.stringify({note:"Reviewed costs and contract",snapshots:[evidence]})]),/source evidence changed|superseded/)
  await prepare(22000)
  const reverted=(await prepare()).rows[0].id
  assert.notEqual(reverted,second)
  assert.equal((await prepare()).rows[0].id,reverted)
  await db.query('select begin_books_period_close($1,$2)',[org,period])
  await assert.rejects(prepare(), /Reopen/)
  assert.equal((await db.query("select has_function_privilege('authenticated','prepare_books_wip_atomic(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text)','execute') allowed")).rows[0].allowed,false)
})
