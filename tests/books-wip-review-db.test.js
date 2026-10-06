const test = require("node:test")
const assert = require("node:assert/strict")
const { createBooksLedgerDb } = require("./helpers/books-ledger-db")
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`
test("WIP review RPC binds exact scoped immutable evidence and refuses a closing period", async t => {
  const db = await createBooksLedgerDb(); t.after(() => db.close())
  const org=id(1), actor=id(2), period=id(3), project=id(4), snapshot=id(5)
  await db.exec(`insert into orgs values('${org}'); insert into app_users values('${actor}'); insert into projects(id,org_id) values('${project}','${org}');
    insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period) values('${period}','${org}','2026-09-01','2026-09-30',2026,9);
    insert into poc_snapshots(id,org_id,project_id,as_of,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,earned_revenue_cents,billed_cents,over_under_cents,forecast_gross_profit_cents,inputs_hash,preparation)
    values('${snapshot}','${org}','${project}','2026-09-30',10000,0,10000,4000,8000,0.5,5000,3000,-2000,2000,'hash','{"kind":"period_prepared","sources":{"costs":[],"billings":[],"credits":[]}}');`)
  const evidence={ projectId:project, snapshotId:snapshot, inputsHash:"hash", asOf:"2026-09-30",earnedRevenueCents:5000,warnings:[] }
  const review=(rows=[evidence],note="Reviewed contract and estimate") => db.query('select review_books_wip_atomic($1,$2,$3,$4::jsonb) result',[org,period,actor,JSON.stringify({snapshots:rows,note})])
  await assert.rejects(review([evidence],"short"), /explanation/)
  await assert.rejects(review([{...evidence,projectId:id(99)}]), /outside/)
  await assert.rejects(review([{...evidence,earnedRevenueCents:5001}]), /evidence changed/)
  await assert.rejects(review([evidence,evidence]), /Duplicate/)
  const saved=(await review()).rows[0].result
  assert.equal(saved.reviewerId,actor)
  assert.equal((await db.query('select support_review from books_close_items')).rows[0].support_review.snapshots[0].snapshotId,snapshot)
  await db.query('select begin_books_period_close($1,$2)',[org,period])
  await assert.rejects(review(), /Reopen/)
  await assert.rejects(db.exec(`insert into poc_snapshots select '${id(7)}',org_id,project_id,as_of,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,earned_revenue_cents,billed_cents,over_under_cents,forecast_gross_profit_cents,'frozen-hash',warnings,created_at,preparation from poc_snapshots where id='${snapshot}'`), /evidence is frozen/)

  await db.query("update accounting_periods set status='reopened' where id=$1",[period])
  await db.exec(`insert into poc_snapshots select '${id(6)}',org_id,project_id,as_of,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,earned_revenue_cents,billed_cents,over_under_cents,forecast_gross_profit_cents,'new-hash',warnings,created_at+interval '1 second',preparation from poc_snapshots where id='${snapshot}'`)
  await assert.rejects(review(), /superseded/)
  for (const [index, warning] of ["missing_contract_value", "missing_eac", "negative_actual_cost", "missing_budget", "eac_below_actual_cost"].entries()) {
    const invalidId = id(20 + index)
    await db.query(`insert into poc_snapshots select $1,org_id,project_id,as_of,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,earned_revenue_cents,billed_cents,over_under_cents,forecast_gross_profit_cents,$2,$3::jsonb,clock_timestamp(),preparation from poc_snapshots where id=$4`, [invalidId, `invalid-${warning}`, JSON.stringify([warning]), snapshot])
    await assert.rejects(review([{ ...evidence, snapshotId: invalidId, inputsHash: `invalid-${warning}`, warnings: [warning] }]), /inputs require correction/)
  }
  const privilege = await db.query("select has_function_privilege('authenticated','review_books_wip_atomic(uuid,uuid,uuid,jsonb)','execute') allowed")
  assert.equal(privilege.rows[0].allowed,false)
})
