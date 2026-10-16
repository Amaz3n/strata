const { migrationSql } = require("./support/migration-sql")
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs")
const {PGlite}=require("@electric-sql/pglite")
const ORG="00000000-0000-4000-8000-000000000001",PKG="00000000-0000-4000-8000-000000000002",HOME="00000000-0000-4000-8000-000000000003",LOT="00000000-0000-4000-8000-000000000004",OTHER="00000000-0000-4000-8000-000000000005",VENDOR="00000000-0000-4000-8000-000000000006"
async function setup(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec("create role anon;create role authenticated;create role service_role;create table outbox(id bigint generated always as identity primary key,org_id uuid,job_type text,payload jsonb,status text default 'pending',retry_count integer default 0,last_error text,run_at timestamptz default now(),updated_at timestamptz default now(),created_at timestamptz default now(),priority integer default 0);create table start_packages(id uuid primary key,org_id uuid,project_id uuid,lot_id uuid,status text,metadata jsonb default '{}');")
 for(const table of ['schedule_items','budgets','inspections'])await db.exec(`create table ${table}(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid)`)
 await db.exec("create table budget_lines(id uuid primary key default gen_random_uuid(),org_id uuid,budget_id uuid);create table inspection_items(id uuid primary key default gen_random_uuid(),org_id uuid,inspection_id uuid);create table schedule_assignments(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,schedule_item_id uuid);create table schedule_dependencies(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,item_id uuid,depends_on_item_id uuid);create table companies(id uuid primary key,org_id uuid);create table commitments(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,company_id uuid,commitment_type text);create table commitment_lines(id uuid primary key default gen_random_uuid(),org_id uuid,commitment_id uuid,budget_line_id uuid);create table po_generation_runs(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,lot_id uuid);create table po_generation_exceptions(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,run_id uuid);create table project_vendors(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,company_id uuid)")
 for(const file of ['20261003023000_starts_job_claim_leases.sql','20261003025000_starts_generated_artifact_fences.sql','20261003031000_starts_purchasing_write_fences.sql'])await db.exec(migrationSql(file.replace(/\.sql$/, "")))
 await db.query("insert into companies values($1,$2)",[VENDOR,ORG])
 await db.query("insert into start_packages(id,org_id,project_id,lot_id,status) values($1,$2,$3,$4,'releasing')",[PKG,ORG,HOME,LOT])
 await db.query("insert into outbox(org_id,job_type,payload) values($1,'start_release',$2)",[ORG,{start_package_id:PKG}])
 const job=(await db.query("select * from claim_starts_jobs(1)")).rows[0]
 await db.query("update start_packages set metadata=jsonb_build_object('release_lease_token',$1::text,'release_lease_at',clock_timestamp())",[job.claim_token])
 const headers=active=>db.query("select set_config('request.headers',$1,false)",[JSON.stringify(active?{'x-starts-job-id':String(job.job_id),'x-starts-claim-token':job.claim_token}:{})])
 const po=async(project=HOME,type='purchase_order',vendor=VENDOR)=>(await db.query("insert into commitments(org_id,project_id,company_id,commitment_type) values($1,$2,$3,$4) returning id",[ORG,project,vendor,type])).rows[0].id
 await headers(true);return {db,headers,po,job}
}
test("owned PO, vendor, generation run and exception writes are accepted",async t=>{
 const h=await setup(t),po=await h.po()
 await h.db.query("insert into commitment_lines(org_id,commitment_id) values($1,$2)",[ORG,po])
 const run=(await h.db.query("insert into po_generation_runs(org_id,project_id,lot_id) values($1,$2,$3) returning id",[ORG,HOME,LOT])).rows[0].id
 await h.db.query("insert into po_generation_exceptions(org_id,project_id,run_id) values($1,$2,$3)",[ORG,HOME,run])
 await h.db.query("insert into project_vendors(org_id,project_id,company_id) values($1,$2,$3)",[ORG,HOME,VENDOR])
 await assert.rejects(h.po(HOME,'subcontract'),/non-PO/)
 await assert.rejects(h.po(OTHER),/project mismatch/)
 await assert.rejects(h.db.query("insert into po_generation_runs(org_id,project_id,lot_id) values($1,$2,$3)",[ORG,HOME,OTHER]),/lot mismatch/)
})
test("old purchasing ancestry cannot be laundered by changing parent or home",async t=>{
 const h=await setup(t);await h.headers(false);const foreign=await h.po(OTHER)
 const line=(await h.db.query("insert into commitment_lines(org_id,commitment_id) values($1,$2) returning id",[ORG,foreign])).rows[0].id
 await h.headers(true);const owned=await h.po()
 await assert.rejects(h.db.query("update commitment_lines set commitment_id=$1 where id=$2",[owned,line]),/purchase order mismatch/)
 await assert.rejects(h.db.query("update commitments set project_id=$1 where id=$2",[HOME,foreign]),/project mismatch/)
 await assert.rejects(h.db.query("delete from commitment_lines where id=$1",[line]),/purchase order mismatch/)
})
test("vendors and line budget mappings must be in the owned organization and home",async t=>{
 const h=await setup(t);await h.headers(false)
 await h.db.query("insert into companies values($1,$2)",[OTHER,OTHER])
 const budget=(await h.db.query("insert into budgets(org_id,project_id) values($1,$2) returning id",[ORG,OTHER])).rows[0].id
 const line=(await h.db.query("insert into budget_lines(org_id,budget_id) values($1,$2) returning id",[ORG,budget])).rows[0].id
 await h.headers(true)
 await assert.rejects(h.po(HOME,'purchase_order',OTHER),/vendor mismatch/)
 const po=await h.po()
 await assert.rejects(h.db.query("insert into commitment_lines(org_id,commitment_id,budget_line_id) values($1,$2,$3)",[ORG,po,line]),/budget line mismatch/)
})
test("expiry during a transaction rolls back the PO instead of leaving a partial financial artifact",async t=>{
 const h=await setup(t);await h.db.exec('begin');const po=await h.po()
 await h.db.exec("update outbox set start_job_lease_expires_at=now()-interval '1 second'")
 await assert.rejects(h.db.query("insert into commitment_lines(org_id,commitment_id) values($1,$2)",[ORG,po]),/worker lease lost/)
 await h.db.exec('rollback')
 assert.equal((await h.db.query("select count(*)::int n from commitments")).rows[0].n,0)
})

test("generation exceptions validate prior run ancestry and cannot be reassigned to hide a foreign source",async t=>{
 const h=await setup(t);await h.headers(false)
 const foreign=(await h.db.query("insert into po_generation_runs(org_id,project_id,lot_id) values($1,$2,$3) returning id",[ORG,OTHER,LOT])).rows[0].id
 const exception=(await h.db.query("insert into po_generation_exceptions(org_id,project_id,run_id) values($1,$2,$3) returning id",[ORG,HOME,foreign])).rows[0].id
 await h.headers(true)
 const owned=(await h.db.query("insert into po_generation_runs(org_id,project_id,lot_id) values($1,$2,$3) returning id",[ORG,HOME,LOT])).rows[0].id
 await assert.rejects(h.db.query("update po_generation_exceptions set run_id=$1 where id=$2",[owned,exception]),/generation run mismatch/)
 await assert.rejects(h.db.query("insert into po_generation_exceptions(org_id,project_id,run_id) values($1,$2,$3)",[ORG,HOME,foreign]),/generation run mismatch/)
})
test("service-role execution can create a PO line mapped to its owned budget",async t=>{
 const h=await setup(t)
 await h.db.exec("grant all on outbox,start_packages,companies,commitments,commitment_lines,budgets,budget_lines to service_role;set role service_role")
 const budget=(await h.db.query("insert into budgets(org_id,project_id) values($1,$2) returning id",[ORG,HOME])).rows[0].id
 const line=(await h.db.query("insert into budget_lines(org_id,budget_id) values($1,$2) returning id",[ORG,budget])).rows[0].id
 const po=await h.po()
 await h.db.query("insert into commitment_lines(org_id,commitment_id,budget_line_id) values($1,$2,$3)",[ORG,po,line])
})

// ---------------------------------------------------------------------------
// run_po_generation_commit: the repository RPC replayed over a fixture that adds
// only the columns the function reads. Each case is one claim about what a house's
// purchase orders and budget look like after a commit.

const CODE = "00000000-0000-4000-8000-0000000000c1"
const OTHER_CODE = "00000000-0000-4000-8000-0000000000c2"
const SECOND_VENDOR = "00000000-0000-4000-8000-0000000000a2"
const AGREEMENT = "00000000-0000-4000-8000-0000000000a1"
const PREFIX = "PO-CYP-7"

async function setupCommit(t) {
  const h = await setup(t)
  await h.db.exec(`
    create type public.cost_type as enum ('labor','material','equipment','other');
    create function public.is_org_member(uuid) returns boolean language sql as 'select true';
    alter table budgets add column version integer, add column status text, add column total_cents integer, add column metadata jsonb,
      add column baseline_locked_at timestamptz;
    alter table budget_lines add column cost_code_id uuid, add column description text, add column amount_cents integer,
      add column sort_order integer, add column cost_type cost_type, add column metadata jsonb,
      add foreign key (budget_id) references budgets(id) on delete cascade;
    alter table commitments add column title text, add column status text, add column total_cents integer, add column currency text,
      add column contract_number text, add column scope text, add column issued_at timestamptz, add column metadata jsonb,
      add column created_at timestamptz default clock_timestamp();
    alter table commitment_lines add column cost_code_id uuid, add column description text, add column quantity numeric, add column unit text,
      add column unit_cost_cents integer, add column scheduled_value_cents integer, add column sort_order integer, add column metadata jsonb,
      add foreign key (commitment_id) references commitments(id) on delete cascade,
      add foreign key (budget_line_id) references budget_lines(id) on delete set null;
    alter table po_generation_runs add column mode text default 'commit', add column status text default 'running',
      add column input_fingerprint text, add column summary jsonb, add column error text, add column completed_at timestamptz,
      add column created_at timestamptz default clock_timestamp();
    alter table po_generation_exceptions add column cost_code_id uuid, add column source_kind text, add column source_ref jsonb,
      add column description text, add column quantity numeric, add column uom text, add column reason text, add column candidates jsonb,
      add column status text default 'open', add column resolution jsonb, add column resolved_by uuid, add column resolved_at timestamptz,
      add column created_at timestamptz default clock_timestamp();
    alter table project_vendors add column role text, add column scope text, add column status text, add column notes text, add unique (project_id, company_id);
    create table vendor_bills (id uuid primary key default gen_random_uuid(), org_id uuid, commitment_id uuid references commitments(id));
  `)
  await h.db.query("insert into companies values ($1, $2)", [SECOND_VENDOR, ORG])
  await h.db.exec(fs.readFileSync(require.resolve("../supabase/migrations/20260817120100_po_generation_serialization.sql"), "utf8"))
  await h.db.exec(migrationSql("20261015110000_po_generation_reconcile"))
  await h.db.exec(migrationSql("20261015161000_po_generation_review_fixes"))

  let fingerprints = 0
  const run = async (fingerprint = `${String(++fingerprints).padStart(64, "0")}`) =>
    (await h.db.query("insert into po_generation_runs(org_id, project_id, lot_id, input_fingerprint) values ($1, $2, $3, $4) returning id", [ORG, HOME, LOT, fingerprint])).rows[0].id
  const line = (key, overrides = {}) => ({
    source_kind: "takeoff_line", source_id: key, company_id: VENDOR, cost_code_id: CODE, cost_type: "labor",
    description: `Line ${key}`, quantity: 1, unit: "ea", unit_cost_cents: 100, total_cents: 100,
    agreement_id: AGREEMENT, scope_text: null, option_descriptor: null, ...overrides,
  })
  const commit = async (runId, { lines = [line("a")], scope = null, prior = null, exceptions = [], resolve = null, summary = {} } = {}) =>
    (await h.db.query("select run_po_generation_commit($1, $2, $3) result", [ORG, runId, {
      prior_run_id: prior, scope_source_keys: scope, po_number_prefix: PREFIX, lot_label: "Cypress Lot 7", plan_name: "Mangrove",
      lines, exceptions, resolve_exception: resolve, summary: { exception_count: exceptions.length, ...summary },
    }])).rows[0].result
  const orders = async () => (await h.db.query(`
    select c.id, c.company_id, c.status, c.total_cents, c.contract_number, c.title,
      (select count(*)::int from commitment_lines l where l.commitment_id = c.id) lines
    from commitments c order by c.contract_number`)).rows
  const lineKeys = async () => (await h.db.query(`
    select l.metadata->>'source' || ':' || (l.metadata->>'source_ref') key, l.scheduled_value_cents cents, c.status
    from commitment_lines l join commitments c on c.id = l.commitment_id order by 1, 2`)).rows
  const budgetState = async () => {
    const budgets = (await h.db.query("select id, status, total_cents from budgets")).rows
    const lines = (await h.db.query("select cost_code_id, cost_type::text, amount_cents from budget_lines order by cost_code_id, cost_type")).rows
    const unlinked = (await h.db.query("select count(*)::int n from commitment_lines where budget_line_id is null")).rows[0].n
    const committed = (await h.db.query("select coalesce(sum(scheduled_value_cents), 0)::int n from commitment_lines")).rows[0].n
    return { budgets, lines, unlinked, committed }
  }
  const setStatus = (status) => h.db.query("update commitments set status = $1", [status])
  return { ...h, run, line, commit, orders, lineKeys, budgetState, setStatus }
}

test("a first commit orders each vendor once, numbers the orders, and budgets what is committed", async (t) => {
  const h = await setupCommit(t)
  const result = await h.commit(await h.run(), { lines: [
    h.line("a"), h.line("b", { total_cents: 300, unit_cost_cents: 300, description: "Second framing line" }),
    h.line("c", { company_id: SECOND_VENDOR, cost_code_id: OTHER_CODE, cost_type: "material", total_cents: 500, unit_cost_cents: 500 }),
  ] })

  const orders = await h.orders()
  assert.deepEqual(orders.map((order) => [order.contract_number, order.company_id, order.total_cents, order.lines, order.status]), [
    [`${PREFIX}-01`, VENDOR, 400, 2, "draft"], [`${PREFIX}-02`, SECOND_VENDOR, 500, 1, "draft"],
  ])
  assert.equal(orders[0].title, "PO — Line a — Cypress Lot 7")
  const budget = await h.budgetState()
  assert.equal(budget.budgets.length, 1)
  assert.deepEqual(budget.lines.map((row) => [row.cost_type, row.amount_cents]), [["labor", 400], ["material", 500]])
  assert.equal(budget.budgets[0].total_cents, 900)
  assert.equal(budget.unlinked, 0)
  assert.equal(result.budget_line_count, 2)
  assert.equal((await h.db.query("select count(*)::int n from project_vendors")).rows[0].n, 2)
  assert.equal((await h.db.query("select issued_at from commitments limit 1")).rows[0].issued_at, null)
})

test("resolutions and regenerations across several runs leave one order per source line and one budget", async (t) => {
  const h = await setupCommit(t)
  const first = await h.run()
  await h.commit(first, { lines: [h.line("a"), h.line("b")] })
  // Two scoped resolutions, each a run of its own that touches only its line.
  const second = await h.run()
  await h.commit(second, { lines: [h.line("a"), h.line("b"), h.line("c")], scope: ["takeoff_line:c"] })
  const third = await h.run()
  await h.commit(third, { lines: [h.line("a"), h.line("b"), h.line("c"), h.line("d", { company_id: SECOND_VENDOR })], scope: ["takeoff_line:d"] })

  // A whole-house regeneration after a price moved: drafts are re-priced where they stand.
  const fourth = await h.run()
  const result = await h.commit(fourth, {
    prior: third,
    lines: [h.line("a", { unit_cost_cents: 150, total_cents: 150 }), h.line("b"), h.line("c"), h.line("d", { company_id: SECOND_VENDOR })],
  })

  assert.deepEqual((await h.lineKeys()).map((row) => [row.key, Number(row.cents)]), [
    ["takeoff_line:a", 150], ["takeoff_line:b", 100], ["takeoff_line:c", 100], ["takeoff_line:d", 100],
  ])
  assert.equal(result.replaced_line_count, 1)
  assert.equal(result.created_line_count, 0)
  assert.deepEqual((await h.orders()).map((order) => [order.company_id, order.total_cents, order.lines]), [[VENDOR, 350, 3], [SECOND_VENDOR, 100, 1]])
  const budget = await h.budgetState()
  assert.equal(budget.budgets.length, 1)
  assert.equal(budget.lines.reduce((sum, row) => sum + row.amount_cents, 0), budget.committed)
  assert.equal(budget.budgets[0].total_cents, budget.committed)
  assert.equal(budget.unlinked, 0)
  // A whole-house commit retires every earlier run of the house, scoped ones included.
  const history = (await h.db.query("select id, status from po_generation_runs order by created_at")).rows
  assert.deepEqual(history.map((row) => row.status), ["superseded", "superseded", "superseded", "succeeded"])
})

test("a commit identical to the last one changes nothing", async (t) => {
  const h = await setupCommit(t)
  const first = await h.run()
  const lines = [h.line("a"), h.line("b", { company_id: SECOND_VENDOR })]
  await h.commit(first, { lines })
  const before = (await h.db.query("select id from commitment_lines order by id")).rows
  const result = await h.commit(await h.run(), { prior: first, lines })
  assert.equal(result.replaced_line_count, 0)
  assert.equal(result.removed_line_count, 0)
  assert.equal(result.created_line_count, 0)
  assert.deepEqual((await h.db.query("select id from commitment_lines order by id")).rows, before)
})

test("orders that were approved or billed are never rewritten, and the difference is reported", async (t) => {
  const h = await setupCommit(t)
  const first = await h.run()
  await h.commit(first, { lines: [h.line("a"), h.line("b", { company_id: SECOND_VENDOR }), h.line("c", { cost_code_id: OTHER_CODE })] })
  const [vendorOrder, secondOrder] = await h.orders()
  // The first vendor's order is approved; the second vendor's order is still a draft but has a bill against it.
  await h.db.query("update commitments set status = 'approved' where id = $1", [vendorOrder.id])
  await h.db.query("insert into vendor_bills(org_id, commitment_id) values ($1, $2)", [ORG, secondOrder.id])

  const second = await h.run()
  const result = await h.commit(second, { prior: first, lines: [
    h.line("a", { unit_cost_cents: 175, total_cents: 175 }),
    h.line("b", { company_id: VENDOR }),
    h.line("c", { cost_code_id: OTHER_CODE, unit_cost_cents: 90, total_cents: 90 }),
  ] })

  const keys = await h.lineKeys()
  assert.deepEqual(keys.map((row) => [row.key, Number(row.cents), row.status]), [
    ["takeoff_line:a", 100, "approved"], ["takeoff_line:b", 100, "draft"], ["takeoff_line:c", 100, "approved"],
  ])
  assert.deepEqual(result.preserved_changed.map((change) => [change.source_key, change.contract_number, change.was_cents, change.now_cents, change.was_company_id === change.now_company_id]), [
    ["takeoff_line:a", `${PREFIX}-01`, 100, 175, true],
    ["takeoff_line:b", `${PREFIX}-02`, 100, 100, false],
    ["takeoff_line:c", `${PREFIX}-01`, 100, 90, true],
  ])
  assert.equal(result.preserved_line_count, 3)
  assert.equal((await h.orders()).length, 2)
  // The run records what it left alone, for the purchasing desk.
  const stored = (await h.db.query("select summary from po_generation_runs where id = $1", [second])).rows[0].summary
  assert.equal(stored.preserved_changed.length, 3)
})

test("a source that is no longer wanted leaves with its draft order and stays on an order in progress", async (t) => {
  const h = await setupCommit(t)
  const first = await h.run()
  await h.commit(first, { lines: [h.line("a"), h.line("b", { company_id: SECOND_VENDOR }), h.line("c", { company_id: SECOND_VENDOR })] })
  const [vendorOrder] = await h.orders()
  await h.db.query("update commitments set status = 'sent' where id = $1", [vendorOrder.id])

  const result = await h.commit(await h.run(), { prior: first, lines: [h.line("c", { company_id: SECOND_VENDOR })] })

  assert.deepEqual((await h.lineKeys()).map((row) => row.key), ["takeoff_line:a", "takeoff_line:c"])
  assert.deepEqual(result.preserved_orphaned.map((orphan) => [orphan.source_key, orphan.contract_number]), [["takeoff_line:a", `${PREFIX}-01`]])
  assert.equal(result.removed_line_count, 1)
  assert.equal((await h.orders()).length, 2)
})

test("an order emptied of lines is removed, and numbers are never reissued", async (t) => {
  const h = await setupCommit(t)
  const first = await h.run()
  await h.commit(first, { lines: [h.line("a"), h.line("b", { company_id: SECOND_VENDOR })] })
  const second = await h.run()
  await h.commit(second, { prior: first, lines: [h.line("a")] })
  assert.deepEqual((await h.orders()).map((order) => order.contract_number), [`${PREFIX}-01`])

  // The second vendor comes back: its order is new, and 02 is not handed out twice.
  await h.commit(await h.run(), { prior: second, lines: [h.line("a"), h.line("b", { company_id: SECOND_VENDOR })] })
  assert.deepEqual((await h.orders()).map((order) => order.contract_number), [`${PREFIX}-01`, `${PREFIX}-03`])
  await h.db.query("update commitments set status = 'canceled' where contract_number = $1", [`${PREFIX}-03`])
  await h.commit(await h.run(), { lines: [h.line("a"), h.line("b", { company_id: SECOND_VENDOR })], prior: (await h.db.query("select id from po_generation_runs where status = 'succeeded' order by created_at desc limit 1")).rows[0].id })
  assert.deepEqual((await h.orders()).map((order) => order.contract_number), [`${PREFIX}-01`, `${PREFIX}-03`, `${PREFIX}-04`])
  assert.deepEqual((await h.lineKeys()).map((row) => row.key), ["takeoff_line:a", "takeoff_line:b", "takeoff_line:b"])
})

test("a whole-house commit prepared against a run that is no longer the latest is refused", async (t) => {
  const h = await setupCommit(t)
  const first = await h.run()
  await h.commit(first, { lines: [h.line("a")] })
  await h.commit(await h.run(), { lines: [h.line("a"), h.line("b")], scope: ["takeoff_line:b"] })

  const stale = await h.run()
  await assert.rejects(h.commit(stale, { prior: first, lines: [h.line("a")] }), /preview again/)
  assert.equal((await h.db.query("select status from po_generation_runs where id = $1", [stale])).rows[0].status, "running")
  assert.deepEqual((await h.lineKeys()).map((row) => row.key), ["takeoff_line:a", "takeoff_line:b"])
})

test("an identical commit that arrives second returns the first one's run and writes nothing", async (t) => {
  const h = await setupCommit(t)
  const fingerprint = "f".repeat(64)
  const first = await h.run()
  await h.commit(first, { lines: [h.line("a")] })
  await h.db.query("update po_generation_runs set input_fingerprint = $1 where id = $2", [fingerprint, first])
  const second = await h.run(fingerprint)

  const result = await h.commit(second, { prior: null, lines: [h.line("a")] })

  assert.equal(result.run_id, first)
  assert.equal(result.already_generated, true)
  assert.equal((await h.db.query("select status from po_generation_runs where id = $1", [second])).rows[0].status, "superseded")
  assert.equal((await h.orders()).length, 1)
})

test("a resolution creates its order and closes its exception together, and the second resolver is refused", async (t) => {
  const h = await setupCommit(t)
  const first = await h.run()
  await h.commit(first, {
    lines: [h.line("a")],
    exceptions: [{ source_kind: "takeoff_line", source_ref: { takeoff_line_id: "b" }, description: "Unpriced", reason: "no_agreement", quantity: 1, uom: "ea" }],
  })
  const exceptionId = (await h.db.query("select id from po_generation_exceptions")).rows[0].id
  const resolve = { id: exceptionId, status: "resolved_manual", resolution: { kind: "manual" }, resolved_by: null }
  const lines = [h.line("a"), h.line("b", { company_id: SECOND_VENDOR })]

  const winner = await h.commit(await h.run(), { lines, scope: ["takeoff_line:b"], resolve })
  assert.equal(winner.created_line_count, 1)
  const row = (await h.db.query("select status, resolution, resolved_at from po_generation_exceptions where id = $1", [exceptionId])).rows[0]
  assert.equal(row.status, "resolved_manual")
  assert.ok(row.resolved_at)

  const loserRun = await h.run()
  const loser = await h.commit(loserRun, { lines: [h.line("a"), h.line("b", { company_id: VENDOR })], scope: ["takeoff_line:b"], resolve })
  assert.equal(loser.refused, "exception_closed")
  assert.equal((await h.db.query("select status from po_generation_runs where id = $1", [loserRun])).rows[0].status, "superseded")
  assert.deepEqual((await h.lineKeys()).map((row) => row.key), ["takeoff_line:a", "takeoff_line:b"])
  assert.deepEqual((await h.orders()).map((order) => order.company_id), [VENDOR, SECOND_VENDOR])
})

test("a resolution leaves a line that already has an order alone", async (t) => {
  const h = await setupCommit(t)
  await h.commit(await h.run(), { lines: [h.line("a")] })
  const result = await h.commit(await h.run(), { lines: [h.line("a", { unit_cost_cents: 999, total_cents: 999 })], scope: ["takeoff_line:a"] })
  assert.equal(result.replaced_line_count, 1)
  assert.deepEqual((await h.lineKeys()).map((row) => Number(row.cents)), [999])
  await h.setStatus("approved")
  const again = await h.commit(await h.run(), { lines: [h.line("a", { unit_cost_cents: 5, total_cents: 5 })], scope: ["takeoff_line:a"] })
  assert.equal(again.preserved_changed.length, 1)
  assert.deepEqual((await h.lineKeys()).map((row) => Number(row.cents)), [999])
})

test("lines on a canceled order do not count as ordered", async (t) => {
  const h = await setupCommit(t)
  await h.commit(await h.run(), { lines: [h.line("a")] })
  await h.setStatus("canceled")
  await h.commit(await h.run(), { lines: [h.line("a")], scope: ["takeoff_line:a"] })
  assert.deepEqual((await h.orders()).map((order) => [order.status, order.contract_number]), [["canceled", `${PREFIX}-01`], ["draft", `${PREFIX}-02`]])
})

test("the living budget follows the commitments, and a budget past draft is reported rather than edited", async (t) => {
  const h = await setupCommit(t)
  await h.commit(await h.run(), { lines: [h.line("a"), h.line("b", { cost_code_id: OTHER_CODE })] })
  const { budgets: [budget] } = await h.budgetState()

  // A cost code drops out of the order set: its budget line goes; the budget is the same row.
  const second = await h.run()
  await h.commit(second, { prior: (await h.db.query("select id from po_generation_runs where status = 'succeeded'")).rows[0].id, lines: [h.line("a")] })
  const trimmed = await h.budgetState()
  assert.deepEqual(trimmed.budgets.map((row) => row.id), [budget.id])
  assert.equal(trimmed.lines.length, 1)

  await h.db.query("update budgets set status = 'approved'")
  const result = await h.commit(await h.run(), { prior: second, lines: [h.line("a"), h.line("c", { cost_code_id: OTHER_CODE, total_cents: 700, unit_cost_cents: 700 })] })
  const frozen = await h.budgetState()
  assert.equal(result.budget_editable, false)
  assert.equal(frozen.lines.length, 1)
  assert.equal(frozen.lines[0].amount_cents, 100)
  assert.equal(frozen.budgets[0].total_cents, trimmed.budgets[0].total_cents)
  assert.equal((await h.orders()).reduce((sum, order) => sum + order.total_cents, 0), 800)
})

test("budgets left by earlier generations collapse onto one living budget", async (t) => {
  const h = await setupCommit(t)
  await h.commit(await h.run(), { lines: [h.line("a")] })
  const old = (await h.db.query("insert into budgets(org_id, project_id, version, status, total_cents, metadata) values ($1, $2, 0, 'draft', 0, '{\"source\":\"po_generation\"}') returning id", [ORG, HOME])).rows[0].id
  const oldLine = (await h.db.query("insert into budget_lines(org_id, budget_id, cost_code_id, cost_type, amount_cents, description, metadata) values ($1, $2, $3, 'labor', 100, 'Line a', '{\"source\":\"po_generation\"}') returning id", [ORG, old, CODE])).rows[0].id
  await h.db.query("update commitment_lines set budget_line_id = $1", [oldLine])

  await h.commit(await h.run(), { lines: [h.line("a"), h.line("b")], scope: ["takeoff_line:b"] })

  const living = (await h.db.query("select budget_id from budget_lines bl join commitment_lines cl on cl.budget_line_id = bl.id group by budget_id")).rows
  assert.equal(living.length, 1)
  assert.notEqual(living[0].budget_id, old)
  assert.equal((await h.db.query("select count(*)::int n from commitment_lines where budget_line_id is null")).rows[0].n, 0)
})

test("a vendor outside the organization rolls the whole commit back", async (t) => {
  const h = await setupCommit(t)
  const first = await h.run()
  await h.commit(first, { lines: [h.line("a")] })
  const second = await h.run()
  await assert.rejects(h.commit(second, { prior: first, lines: [h.line("a", { unit_cost_cents: 5, total_cents: 5 }), h.line("b", { company_id: OTHER })] }), /vendor is not in this organization/)
  assert.deepEqual((await h.lineKeys()).map((row) => [row.key, Number(row.cents)]), [["takeoff_line:a", 100]])
  assert.equal((await h.budgetState()).committed, 100)
  assert.equal((await h.db.query("select status from po_generation_runs where id = $1", [second])).rows[0].status, "running")
})

test("a commit by the starts release worker reconciles its own house under the fences", async (t) => {
  const h = await setupCommit(t)
  const first = await h.run()
  await h.commit(first, { lines: [h.line("a"), h.line("b", { company_id: SECOND_VENDOR })] })
  const second = await h.run()
  await h.db.exec("set role service_role")
  await h.commit(second, { prior: first, lines: [h.line("a", { unit_cost_cents: 120, total_cents: 120 }), h.line("c", { cost_code_id: OTHER_CODE })] })
  await h.db.exec("reset role")
  assert.deepEqual((await h.lineKeys()).map((row) => [row.key, Number(row.cents)]), [["takeoff_line:a", 120], ["takeoff_line:c", 100]])
  assert.equal((await h.budgetState()).unlinked, 0)
})

test("ordinary service-role generation works without worker headers, and a member cannot run the commit", async (t) => {
  const h = await setupCommit(t)
  await h.headers(false)
  const first = await h.run()
  await h.db.exec("set role service_role")
  const result = await h.commit(first, { lines: [h.line("a")] })
  assert.equal(result.commitment_ids.length, 1)
  await h.db.exec("set role authenticated")
  await assert.rejects(h.commit(first), /permission denied for function run_po_generation_commit/)
})

test("the worker commit refuses expired ownership, another home and another lot before writing anything", async (t) => {
  const h = await setupCommit(t)
  const run = await h.run()
  await h.db.exec("update outbox set start_job_lease_expires_at = clock_timestamp() - interval '1 second'")
  await assert.rejects(h.commit(run), /worker lease lost/)
  for (const table of ["budgets", "budget_lines", "commitments", "commitment_lines", "project_vendors"]) {
    assert.equal((await h.db.query(`select count(*)::int n from ${table}`)).rows[0].n, 0, table)
  }
  assert.equal((await h.db.query("select status from po_generation_runs where id = $1", [run])).rows[0].status, "running")
})

test("a worker cannot commit a run of a different home or lot", async (t) => {
  const h = await setupCommit(t)
  await h.headers(false)
  const wrongHome = (await h.db.query("insert into po_generation_runs(org_id, project_id, lot_id) values ($1, $2, $3) returning id", [ORG, OTHER, LOT])).rows[0].id
  const wrongLot = (await h.db.query("insert into po_generation_runs(org_id, project_id, lot_id) values ($1, $2, $3) returning id", [ORG, HOME, OTHER])).rows[0].id
  await h.headers(true)
  await assert.rejects(h.commit(wrongHome), /project mismatch/)
  await assert.rejects(h.commit(wrongLot), /lot mismatch/)
  assert.equal((await h.db.query("select count(*)::int n from budgets")).rows[0].n, 0)
})

test("members read generation runs and exceptions but cannot write them, even if a grant drifts back", async (t) => {
  const h = await setupCommit(t)
  await h.headers(false)
  const run = await h.run()
  await h.commit(run, { exceptions: [{ source_kind: "takeoff_line", source_ref: {}, description: "Unpriced", reason: "no_agreement" }] })

  await h.db.exec("set role authenticated")
  assert.equal((await h.db.query("select count(*)::int n from po_generation_runs")).rows[0].n, 1)
  assert.equal((await h.db.query("select count(*)::int n from po_generation_exceptions")).rows[0].n, 1)
  for (const statement of [
    "update po_generation_exceptions set status = 'resolved_manual'",
    "delete from po_generation_exceptions",
    "update po_generation_runs set status = 'failed'",
    "delete from po_generation_runs",
  ]) await assert.rejects(h.db.query(statement), /permission denied/, statement)
  await assert.rejects(h.db.query("insert into po_generation_runs(org_id, project_id, lot_id, input_fingerprint) values ($1, $2, $3, 'x')", [ORG, HOME, LOT]), /permission denied/)

  await h.db.exec("reset role; grant insert, update, delete on po_generation_runs, po_generation_exceptions to authenticated; set role authenticated")
  await assert.rejects(h.db.query("update po_generation_exceptions set status = 'resolved_manual'"), /written by the generation service/)
  await assert.rejects(h.db.query("insert into po_generation_runs(org_id, project_id, lot_id, input_fingerprint) values ($1, $2, $3, 'x')", [ORG, HOME, LOT]), /written by the generation service/)
})

test("a completed order with no bill is preserved, not stripped and re-ordered", async (t) => {
  const h = await setupCommit(t)
  const first = await h.run()
  await h.commit(first, { lines: [h.line("a")] })
  await h.setStatus("complete")
  const result = await h.commit(await h.run(), { prior: first, lines: [h.line("a", { unit_cost_cents: 130, total_cents: 130 })] })
  assert.equal(result.preserved_changed.length, 1)
  assert.equal(result.removed_line_count, 0)
  assert.deepEqual((await h.orders()).map((order) => [order.status, order.lines]), [["complete", 1]])
})

test("the read-only report names what a commit would change and writes nothing", async (t) => {
  const h = await setupCommit(t)
  const first = await h.run()
  const lines = [h.line("a"), h.line("b", { company_id: SECOND_VENDOR })]
  await h.commit(first, { lines })
  const report = async (wanted, scope = null) => (await h.db.query("select po_generation_reconcile_report($1, $2, $3, $4) r", [ORG, HOME, JSON.stringify(wanted), scope])).rows[0].r
  assert.equal((await report(lines)).changes, 0)
  assert.equal((await report([h.line("a", { unit_cost_cents: 5, total_cents: 5 }), lines[1]])).changes, 1)
  assert.equal((await report([lines[0]])).changes, 1)
  assert.equal((await report([...lines, h.line("c")])).changes, 1)
  await h.db.query("update commitments set status = 'approved' where company_id = $1", [VENDOR])
  const progressed = await report([h.line("a", { total_cents: 175, unit_cost_cents: 175 }), lines[1]])
  assert.equal(progressed.changes, 0)
  assert.deepEqual(progressed.preserved_changed.map((change) => [change.source_key, change.was_cents, change.now_cents]), [["takeoff_line:a", 100, 175]])
  assert.equal((await h.orders()).length, 2)
})

test("an identical commit repairs a draft order a member deleted instead of trusting the last run", async (t) => {
  const h = await setupCommit(t)
  const fingerprint = "e".repeat(64)
  const first = await h.run(fingerprint)
  const lines = [h.line("a"), h.line("b", { company_id: SECOND_VENDOR })]
  await h.commit(first, { lines })
  await h.headers(false)
  await h.db.query("delete from commitments where company_id = $1", [SECOND_VENDOR])
  const second = await h.run("d".repeat(64))
  await h.db.query("update po_generation_runs set input_fingerprint = $1 where id = $2", [fingerprint, second])
  // Same fingerprint as the last run, but the house no longer matches it.
  const result = await h.commit(second, { prior: first, lines })
  assert.equal(result.already_generated, undefined)
  assert.equal(result.created_line_count, 1)
  assert.deepEqual((await h.lineKeys()).map((row) => row.key), ["takeoff_line:a", "takeoff_line:b"])
})

test("an order number is not given twice after its order was deleted", async (t) => {
  const h = await setupCommit(t)
  const first = await h.run()
  await h.commit(first, { lines: [h.line("a"), h.line("b", { company_id: SECOND_VENDOR })] })
  const second = await h.run()
  await h.commit(second, { prior: first, lines: [h.line("a")] })
  const third = await h.run()
  await h.commit(third, { prior: second, lines: [h.line("a"), h.line("b", { company_id: SECOND_VENDOR })] })
  assert.deepEqual((await h.orders()).map((order) => order.contract_number), [`${PREFIX}-01`, `${PREFIX}-03`])
})

test("exceptions: a line that is now ordered closes its exception, a dismissed one stays dismissed, one is open per line", async (t) => {
  const h = await setupCommit(t)
  const raised = (key, reason = "no_agreement") => ({ source_kind: "takeoff_line", source_ref: { takeoff_line_id: key }, description: key, reason, quantity: 1, uom: "ea" })
  const first = await h.run()
  await h.commit(first, { lines: [h.line("a")], exceptions: [raised("b"), raised("c")] })
  const idOf = async (key) => (await h.db.query("select id from po_generation_exceptions where source_ref->>'takeoff_line_id' = $1 order by created_at desc limit 1", [key])).rows[0].id
  await h.db.query("update po_generation_exceptions set status = 'dismissed', resolution = '{\"note\": \"n\"}' where id = $1", [await idOf("c")])

  // Next whole-house commit: b is priceable now, c is raised again for the same reason, d is new.
  const second = await h.run()
  await h.commit(second, { prior: first, lines: [h.line("a"), h.line("b")], exceptions: [raised("c"), raised("d"), raised("d")] })
  const states = (await h.db.query("select source_ref->>'takeoff_line_id' k, status from po_generation_exceptions order by k, created_at")).rows.map((row) => [row.k, row.status])
  assert.deepEqual(states, [["b", "resolved_agreement"], ["c", "dismissed"], ["d", "open"]])

  // A different reason is a new exception.
  await h.commit(await h.run(), { prior: second, lines: [h.line("a"), h.line("b")], exceptions: [raised("c", "expired_agreement")] })
  assert.equal((await h.db.query("select count(*)::int n from po_generation_exceptions where source_ref->>'takeoff_line_id' = 'c' and status = 'open'")).rows[0].n, 1)
  await assert.rejects(h.db.query("insert into po_generation_exceptions(org_id, project_id, run_id, source_kind, source_ref, status) select org_id, project_id, run_id, source_kind, source_ref, 'open' from po_generation_exceptions where status = 'open' limit 1"), /po_generation_exceptions_open_source_uidx/)
})
