require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { computeProjectPoc } = require("../lib/financials/poc-rules")
const { hasInvalidWipInputs } = require("../lib/financials/wip-validation")
const position=(contract,cost,eac,billed=0)=>computeProjectPoc({originalContractCents:contract,approvedChangeOrdersCents:0,revisedContractCents:contract,actualCostCents:cost,eacCents:eac,billedCents:billed})
test("earned revenue rounds exact cents rather than a floating-point completion product",()=>{
  assert.equal(Math.round(1000031715595*(29/110)),263644725020)
  assert.equal(position(1000031715595,29,110).earnedRevenueCents,263644725021)
  assert.equal(position(101,1,2).earnedRevenueCents,51)
  assert.equal(position(Number.MAX_SAFE_INTEGER,1,2).earnedRevenueCents,4503599627370496)
  assert.equal(position(1000,1200,1000).earnedRevenueCents,1000)
})
test("invalid EAC and unsafe derived amounts cannot become trusted WIP",()=>{
  for(const warning of ["missing_contract_value","missing_eac","negative_actual_cost","missing_budget","eac_below_actual_cost"]) assert.equal(hasInvalidWipInputs([warning]),true)
  assert.equal(hasInvalidWipInputs([]),false)
  assert.ok(position(1000,1200,1000).warnings.includes("eac_below_actual_cost"))
  assert.throws(()=>position(Number.MAX_SAFE_INTEGER,1,1,-Number.MAX_SAFE_INTEGER),/integer cents/)
})


test("database preparation and previews agree on exact rounding and snapshots remain immutable",async t=>{
  const { createBooksLedgerDb } = require("./helpers/books-ledger-db")
  const db=await createBooksLedgerDb(); t.after(()=>db.close())
  const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`
  await db.exec(`insert into orgs values('${id(1)}'); insert into app_users values('${id(2)}'); insert into projects(id,org_id) values('${id(3)}','${id(1)}');
    insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period) values('${id(4)}','${id(1)}','2026-09-01','2026-09-30',2026,9);
    insert into job_cost_entries values('${id(5)}','${id(1)}','${id(3)}','posted','2026-09-20',29);`)
  const snapshot=(await db.query('select prepare_books_wip_atomic($1,$2,$3,$4,$5,0,110,$6) id',[id(1),id(4),id(3),id(2),1000031715595,"Exact cent rounding evidence fixture"])).rows[0].id
  const row=(await db.query('select earned_revenue_cents from poc_snapshots where id=$1',[snapshot])).rows[0]
  assert.equal(Number(row.earned_revenue_cents),position(1000031715595,29,110).earnedRevenueCents)
  await assert.rejects(db.query('update poc_snapshots set earned_revenue_cents=0 where id=$1',[snapshot]),/append-only/)
  await db.query(`insert into poc_snapshots select $1,org_id,project_id,as_of,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,earned_revenue_cents-1,billed_cents,over_under_cents,forecast_gross_profit_cents,'old-rounding',warnings,clock_timestamp(),preparation from poc_snapshots where id=$2`,[id(6),snapshot])
  assert.equal((await db.query('select books_wip_sources_current($1,$2) current',[id(1),[id(6)]])).rows[0].current,false)
  const repaired=(await db.query('select prepare_books_wip_atomic($1,$2,$3,$4,$5,0,110,$6) id',[id(1),id(4),id(3),id(2),1000031715595,"Exact cent rounding evidence fixture"])).rows[0].id
  assert.notEqual(repaired,id(6))
  assert.equal(Number((await db.query('select earned_revenue_cents from poc_snapshots where id=$1',[repaired])).rows[0].earned_revenue_cents),263644725021)

})
