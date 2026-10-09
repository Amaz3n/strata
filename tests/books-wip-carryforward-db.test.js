const { migrationSql } = require("./support/migration-sql")
const test = require("node:test")
const assert = require("node:assert/strict")
const { createBooksLedgerDb } = require("./helpers/books-ledger-db")
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`
test("completed WIP carries approved final estimates forward only while dated evidence remains unchanged", async t => {
  const db=await createBooksLedgerDb(); t.after(()=>db.close())
  await db.exec("create table cost_codes(id uuid primary key,org_id uuid)")
  await db.exec(migrationSql("20261003115030_books_wip_revenue_allocations"))
  const org=id(1),actor=id(2),project=id(3),prior=id(4),target=id(5)
  await db.exec(`insert into orgs values('${org}'); insert into app_users values('${actor}'); insert into projects(id,org_id,status) values('${project}','${org}','completed');
    insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period) values('${prior}','${org}','2026-08-01','2026-08-31',2026,8),('${target}','${org}','2026-09-01','2026-09-30',2026,9);
    insert into job_cost_entries values('${id(10)}','${org}','${project}','posted','2026-08-20',1000);`)
  const prepare=async eac => (await db.query('select prepare_books_wip_atomic($1,$2,$3,$4,2000,0,$5,$6) id',[org,prior,project,actor,eac,"Final job estimate documented at August end"])).rows[0].id
  const carry=()=>db.query('select carry_forward_books_wip_atomic($1,$2,$3,$4,$5) id',[org,target,project,actor,"Final contract and estimate confirmed unchanged"])
  const approve=async snapshotId=>{
    const snapshot=(await db.query('select * from poc_snapshots where id=$1',[snapshotId])).rows[0]
    await db.query('select review_books_wip_atomic($1,$2,$3,$4)',[org,prior,actor,JSON.stringify({note:"Reviewed final contract and costs",snapshots:[{projectId:project,snapshotId,inputsHash:snapshot.inputs_hash,asOf:"2026-08-31",earnedRevenueCents:Number(snapshot.earned_revenue_cents),warnings:[]}]})])
  }
  await assert.rejects(carry(),/No approved/)
  const unfinished=await prepare(1500); await approve(unfinished)
  await db.query("update accounting_periods set status='closed',closed_at=now(),closed_by=$1,close_digest='fixture' where id=$2",[actor,prior])
  await assert.rejects(carry(),/fully earned/)
  await db.query("update accounting_periods set status='reopened' where id=$1",[prior])
  const unallocatedFinal=await prepare(1000)
  await db.exec(`insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values('${id(20)}','${org}','4010','Custom construction income','income','construction_revenue','credit')`)
  const final=(await db.query("select allocate_books_wip_revenue_atomic($1,$2,$3,$4,$5,'Reviewed final income allocation') id", [org,prior,unallocatedFinal,actor,JSON.stringify([{account_id:id(20),contract_cents:2000}])])).rows[0].id
  await approve(final)
  await assert.rejects(carry(),/No approved/)
  await db.query("update accounting_periods set status='closed' where id=$1",[prior])
  const carried=(await carry()).rows[0].id
  assert.equal((await carry()).rows[0].id,carried)
  const position=(await db.query('select * from poc_snapshots where id=$1',[carried])).rows[0]
  assert.equal(new Date(position.as_of).toISOString().slice(0,10),"2026-09-30")
  assert.equal(Number(position.earned_revenue_cents),2000)
  assert.match(position.preparation.note,new RegExp(final))
  assert.equal(position.preparation.carriedFromSnapshotId,final)
  assert.equal(position.preparation.carriedFromPeriodId,prior)
  assert.equal(position.revenue_allocations[0].account_code,"4010")
  assert.equal(position.revenue_allocations[0].contract_cents,2000)
  assert.equal((await db.query('select count(*)::int n from books_close_items where period_id=$1',[target])).rows[0].n,0)
  await db.query("update projects set status='active' where id=$1",[project])
  await assert.rejects(carry(),/Only completed/)
  await db.query("update projects set status='completed' where id=$1",[project])
  await db.exec(`insert into job_cost_entries values('${id(11)}','${org}','${project}','posted','2026-09-15',100)`)
  await assert.rejects(carry(),/costs or billings changed/)
  assert.equal((await db.query('select books_wip_sources_current($1,$2) current',[org,[carried]])).rows[0].current,false)
})
