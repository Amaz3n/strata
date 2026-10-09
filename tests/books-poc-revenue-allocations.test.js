const { migrationSql } = require("./support/migration-sql")
require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { pocRevenueAllocationDeltas } = require("../lib/services/books/poc-revenue-allocations")
const { postRevenueRecognition } = require("../lib/services/books/posting-rules")
const { createBooksLedgerDb } = require("./helpers/books-ledger-db")
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const common = { id: id(3), projectId: id(3), date: "2026-09-30", periodKey: "2026-09", memo: "Reviewed POC", policyVersion: 1, projectionVersion: 1 }
const weights = [
  { account_id: id(10), account_code: "4010", contract_cents: 8000, contract_id: id(15), cost_code_id: id(16) },
  { account_id: id(11), account_code: "4020", contract_cents: 2000 },
]

test("cumulative POC allocation preserves cents, reverses old buckets and supports zero-net reclassification", () => {
  let prior = []
  for (let earned = 0; earned <= 10000; earned += 37) {
    const delta = pocRevenueAllocationDeltas(earned, weights, prior)
    const target = pocRevenueAllocationDeltas(earned, weights, [])
    assert.equal(delta.reduce((sum, row) => sum + row.amount_cents, 0), earned - prior.reduce((sum, row) => sum + row.amount_cents, 0))
    assert.deepEqual(pocRevenueAllocationDeltas(earned, weights, target), [])
    prior = target
  }
  const legacy = [{ account_code: "4000", amount_cents: 5000, dimensions: { wip_snapshot_id: id(40) } }]
  const delta = pocRevenueAllocationDeltas(5000, weights, legacy)
  assert.deepEqual(delta.map(row => [row.account_code, row.amount_cents]), [["4010", 4000], ["4020", 1000], ["4000", -5000]])
  const draft = postRevenueRecognition({ ...common, deltaCents: 0, revenueLines: delta, dimensions: { wip_snapshot_id: id(41) } })
  assert.equal(draft.lines.length, 3)
  assert.equal(draft.lines.some(row => row.accountCode === "2350"), false)
  assert.equal(draft.lines.find(row => row.accountCode === "4010").dimensions.contract_id, id(15))
  assert.ok(draft.lines.every(row => row.dimensions.wip_snapshot_id === id(41)))
  const reduced = pocRevenueAllocationDeltas(2000, weights, pocRevenueAllocationDeltas(5000, weights, []))
  assert.equal(reduced.reduce((sum, row) => sum + row.amount_cents, 0), -3000)
  assert.throws(() => postRevenueRecognition({ ...common, deltaCents: 1, revenueLines: delta }), /do not reconcile/)
})

test("real WIP allocation revisions preserve evidence, validate scope and reconcile native revenue with loss provisions", async t => {
  const db = await createBooksLedgerDb(); t.after(() => db.close())
  await db.exec("create table cost_codes(id uuid primary key,org_id uuid)")
  await db.exec(migrationSql("20261003115030_books_wip_revenue_allocations"))
  const org = id(1), actor = id(2), project = id(3), period = id(4)
  await db.exec(`insert into orgs values('${org}'),('${id(99)}'); insert into app_users values('${actor}'); insert into projects(id,org_id) values('${project}','${org}');
    insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period) values('${period}','${org}','2026-09-01','2026-09-30',2026,9);
    insert into contracts values('${id(15)}','${org}','${project}',null,'active'); insert into cost_codes values('${id(16)}','${org}'),('${id(17)}','${id(99)}');
    insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values
    ('${id(10)}','${org}','4010','Construction labor income','income','construction_revenue','credit'),('${id(11)}','${org}','4020','Construction materials income','income','construction_revenue','credit'),
    ('${id(12)}','${org}','2350','Contract liabilities','liability','billings_in_excess','credit'),('${id(13)}','${id(99)}','4010','Other org income','income','construction_revenue','credit');
    insert into job_cost_entries values('${id(20)}','${org}','${project}','posted','2026-09-20',6000);`)
  const original = (await db.query("select prepare_books_wip_atomic($1,$2,$3,$4,10000,0,12000,'Reviewed September contract and EAC') id", [org, period, project, actor])).rows[0].id
  const allocate = (rows = weights, snapshot = original) => db.query("select allocate_books_wip_revenue_atomic($1,$2,$3,$4,$5,'Reviewed contract income allocation') id", [org, period, snapshot, actor, JSON.stringify(rows)])
  await assert.rejects(allocate([{ ...weights[0], account_id: id(13), contract_cents: 10000 }]), /outside the organization/)
  await assert.rejects(allocate([{ ...weights[0], contract_cents: 9000 }]), /equal the reviewed/)
  await assert.rejects(allocate([{ ...weights[0], contract_cents: 10000, cost_code_id: id(17) }]), /cost code is outside/)
  await assert.rejects(allocate([{ ...weights[0], contract_cents: 10000.5 }]), /positive safe integer/)
  await assert.rejects(allocate([{ ...weights[0], contract_cents: 5000 }, { ...weights[0], contract_cents: 5000 }]), /Duplicate/)
  const allocated = (await allocate()).rows[0].id
  assert.notEqual(allocated, original)
  assert.equal((await allocate()).rows[0].id, allocated)
  assert.deepEqual((await db.query("select revenue_allocations from poc_snapshots where id=$1", [original])).rows[0].revenue_allocations, [])
  const row = (await db.query("select * from poc_snapshots where id=$1", [allocated])).rows[0]
  assert.equal(row.revenue_allocations[0].account_code, "4010")
  await db.query("update gl_accounts set code='4011' where id=$1", [id(10)])
  assert.equal((await db.query("select books_wip_sources_current($1,$2) current", [org, [allocated]])).rows[0].current, false)
  await db.query("update gl_accounts set code='4010' where id=$1", [id(10)])
  const review = async snapshot => {
    const r = (await db.query("select * from poc_snapshots where id=$1", [snapshot])).rows[0]
    return db.query("select review_books_wip_atomic($1,$2,$3,$4)", [org, period, actor, JSON.stringify({ note: "Reviewed amounts and native income accounts", snapshots: [{ projectId: project, snapshotId: snapshot, inputsHash: r.inputs_hash, asOf: "2026-09-30", earnedRevenueCents: Number(r.earned_revenue_cents), warnings: [] }] })])
  }
  await assert.rejects(review(original), /superseded/)
  await review(allocated)
  await db.query("select begin_books_period_close($1,$2)", [org, period])
  await assert.rejects(allocate(weights, allocated), /Reopen/)
  const delta = pocRevenueAllocationDeltas(5000, row.revenue_allocations, [])
  const draft = postRevenueRecognition({ ...common, deltaCents: 5000, revenueLines: delta })
  const accountIds = { "4010": id(10), "4020": id(11), "2350": id(12) }
  await db.query("select post_books_journal_entry($1,$2,$3)", [org, JSON.stringify({ entry_date: common.date, entry_kind: "poc", memo: common.memo, posting_key: "native-poc", source_type: "revenue_recognition", source_id: project, policy_version: 1 }), JSON.stringify(draft.lines.map((line, index) => ({ line_no: index + 1, account_id: accountIds[line.accountCode], project_id: project, debit_cents: line.debitCents, credit_cents: line.creditCents, dimensions: line.dimensions })))])
  const provision = (await db.query("select post_books_expected_loss_atomic($1,$2,$3,$4,1,1) result", [org, period, allocated, actor])).rows[0].result
  assert.equal(provision.deltaCents, 1000)
  await db.query("update accounting_periods set status='reopened' where id=$1", [period])
  const revisedEac = (await db.query("select prepare_books_wip_atomic($1,$2,$3,$4,10000,0,13000,'Reviewed updated completion estimate') id", [org, period, project, actor])).rows[0].id
  assert.deepEqual((await db.query("select revenue_allocations from poc_snapshots where id=$1", [revisedEac])).rows[0].revenue_allocations, row.revenue_allocations)
  const revisedContract = (await db.query("select prepare_books_wip_atomic($1,$2,$3,$4,12000,0,13000,'Reviewed amended contract and estimate') id", [org, period, project, actor])).rows[0].id
  assert.equal((await db.query("select books_wip_sources_current($1,$2) current", [org, [revisedContract]])).rows[0].current, false)
  await assert.rejects(review(revisedContract), /source evidence changed/)
  const anotherEstimate = (await db.query("select prepare_books_wip_atomic($1,$2,$3,$4,12000,0,14000,'Reviewed further completion estimate') id", [org, period, project, actor])).rows[0].id
  assert.equal((await db.query("select books_wip_sources_current($1,$2) current", [org, [anotherEstimate]])).rows[0].current, false)
  const remapped = (await allocate([{ ...weights[0], contract_cents: 10000 }, weights[1]], anotherEstimate)).rows[0].id
  assert.equal((await db.query("select books_wip_sources_current($1,$2) current", [org, [remapped]])).rows[0].current, true)
  await review(remapped)
  assert.equal((await db.query("select has_function_privilege('authenticated','allocate_books_wip_revenue_atomic(uuid,uuid,uuid,uuid,jsonb,text)','execute') allowed")).rows[0].allowed, false)
})

test("recognition service reclassifies unchanged earned totals and ignores unrelated income and closing journals", async () => {
  const Module = require("node:module")
  const posted = []
  let prior = [{ id: id(60), project_id: id(3), debit_cents: 0, credit_cents: 5000, account: { code: "4000" }, entry: { status: "posted", entry_kind: "opening" } }]
  const client = { from(table) {
    const q = {
      select() { return q }, eq() { return q }, in() { return q }, lte() { return q }, order() { return q }, limit() { return q }, like() { return q },
      single: async () => ({ data: { workspace_enabled: true, arc_ledger_mode: "official", active_policy_version: 1 }, error: null }),
      maybeSingle: async () => ({ data: { version: 1 }, error: null }),
      range: async () => ({ data: table === "journal_lines" ? [...prior,
        { project_id: id(3), debit_cents: 0, credit_cents: 777, account: { code: "4090" }, entry: { source_type: "interest", entry_kind: "operational" } },
        { project_id: id(3), debit_cents: 5000, credit_cents: 0, account: { code: "4000" }, entry: { entry_kind: "closing" } },
      ] : [], error: null }),
      then(resolve) { return Promise.resolve({ count: posted.length, error: null }).then(resolve) },
    }
    return q
  } }
  let recognize
  const original = Module._load
  try {
    Module._load = function(name, ...args) {
      if (name === "@/lib/supabase/server") return { createServiceSupabaseClient: () => client }
      if (name === "@/lib/services/books/wip-source-evidence") return { wipSourcesCurrent: async () => true }
      if (name === "@/lib/services/books/ledger") return { postBooksJournalEntryForService: async draft => posted.push(draft) }
      if (name === "@/lib/services/books/wip-project-scope") return { loadWipScopesForPeriod: async () => [{ projectId: id(3), contractId: null }] }
      if (name === "@/lib/services/poc") return { loadPocPositionsAsOf: async () => new Map([[id(3), { asOf: "2026-09-30", contractId: null, snapshotId: id(50), inputsHash: "allocated-hash", earnedRevenueCents: 5000, warnings: [], revenueAllocations: weights }]]) }
      if (name === "@/lib/services/events") return { recordEvent: async () => {} }
      if (name === "@/lib/services/reports/dates") return { todayIsoDateOnly: () => "2026-09-30" }
      return original.call(this, name, ...args)
    }
    recognize = require("../lib/services/books/revenue-recognition").recognizeRevenueForPeriod
  } finally { Module._load = original }
  const first = await recognize("org", "2026-09-30")
  assert.equal(first.postedCents, 0)
  assert.equal(first.recognized, 1)
  assert.equal(posted.length, 1)
  prior = pocRevenueAllocationDeltas(5000, weights, []).map(row => ({ project_id: id(3), debit_cents: 0, credit_cents: row.amount_cents, dimensions: row.dimensions, account: { code: row.account_code }, entry: { source_type: "revenue_recognition", entry_kind: "poc" } }))
  assert.equal((await recognize("org", "2026-09-30")).recognized, 0)
  assert.equal(posted.length, 1)
  prior.push({ ...prior[0], debit_cents: prior[0].credit_cents, credit_cents: 0, entry: { entry_kind: "reversal", original: { source_type: "revenue_recognition" } } })
  assert.equal((await recognize("org", "2026-09-30")).postedCents, 4000)
})
