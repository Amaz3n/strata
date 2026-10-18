const { migrationSql } = require("./support/migration-sql")
const test=require("node:test"),assert=require("node:assert/strict")
const {PGlite}=require("@electric-sql/pglite")
const ORG="00000000-0000-4000-8000-000000000001",PKG="00000000-0000-4000-8000-000000000002",PROJECT="00000000-0000-4000-8000-000000000003",LOT="00000000-0000-4000-8000-000000000004"
async function setup(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec("create role anon;create role authenticated;create role service_role;create table outbox(id bigint generated always as identity primary key,org_id uuid,job_type text,payload jsonb,status text default 'pending',retry_count integer default 0,last_error text,run_at timestamptz default now(),updated_at timestamptz default now(),created_at timestamptz default now(),priority integer default 0);create table start_packages(id uuid primary key,org_id uuid,project_id uuid,lot_id uuid,status text,metadata jsonb default '{}');create table projects(id uuid primary key,org_id uuid,phase text);create table lots(id uuid primary key,org_id uuid,status text);create table start_release_steps(id uuid primary key,org_id uuid,start_package_id uuid,status text);create table start_package_gates(id uuid primary key,org_id uuid,start_package_id uuid,status text)")
 for(const file of ["20261003023000_starts_job_claim_leases.sql","20261003024000_starts_core_write_fences.sql"])await db.exec(migrationSql(file.replace(/\.sql$/, "")))
 await db.query("insert into start_packages(id,org_id,project_id,lot_id,status) values($1,$2,$3,$4,'releasing');",[PKG,ORG,PROJECT,LOT])
 await db.query("insert into projects values($1,$2,'precon')",[PROJECT,ORG]);await db.query("insert into lots values($1,$2,'assigned')",[LOT,ORG])
 await db.query("insert into outbox(org_id,job_type,payload) values($1,'start_release',$2)",[ORG,{start_package_id:PKG}])
 const claim=(await db.query("select * from claim_starts_jobs(1)")).rows[0]
 const headers=job=>db.query("select set_config('request.headers',$1,false)",[JSON.stringify(job?{"x-starts-job-id":String(job.job_id),"x-starts-claim-token":job.claim_token}:{})])
 await headers(claim)
 const acquire=()=>db.query("update start_packages set metadata=jsonb_build_object('release_lease_token',$1::text,'release_lease_at',clock_timestamp()) where id=$2",[claim.claim_token,PKG])
 return {db,claim,headers,acquire}
}
test("core writes require both active job and package ownership",async t=>{
 const h=await setup(t)
 await assert.rejects(h.db.query("update projects set phase='delivery'"),/package lease lost/)
 await h.acquire();await h.db.query("update projects set phase='delivery'")
 await h.headers(null);await h.db.exec("update outbox set start_job_lease_expires_at=now()-interval '1 second'")
 await h.headers(h.claim);await assert.rejects(h.db.query("update lots set status='started'"),/worker lease lost/)
})
test("stale claims and forged browser headers cannot mutate core records",async t=>{
 const h=await setup(t);await h.acquire();await h.headers(null)
 await h.db.exec("update outbox set start_claim_token=gen_random_uuid()")
 await h.headers(h.claim);await assert.rejects(h.db.query("update start_packages set status='released'"),/worker lease lost/)
 await h.db.exec("grant select,update on projects to authenticated;set role authenticated")
 await assert.rejects(h.db.query("update projects set phase='delivery'"),/Browser cannot use/)
})
test("a fresh worker cannot mutate another home or smuggle domain edits during lease acquisition",async t=>{
 const h=await setup(t)
 await assert.rejects(h.db.query("update start_packages set status='released',metadata=jsonb_build_object('release_lease_token',$1::text) where id=$2",[h.claim.claim_token,PKG]),/package lease lost/)
 await h.acquire()
 await h.headers(null);await h.db.query("insert into projects values(gen_random_uuid(),$1,'precon')",[ORG]);await h.headers(h.claim)
 await assert.rejects(h.db.query("update projects set phase='delivery' where id<>$1",[PROJECT]),/project mismatch/)
 await assert.rejects(h.db.query("update lots set org_id=gen_random_uuid()"),/organization mismatch/)
 await assert.rejects(h.db.query("insert into start_release_steps values(gen_random_uuid(),$1,gen_random_uuid(),'completed')",[ORG]),/package mismatch/)
})
test("cancellation invalidates the fence while ordinary non-worker edits remain unchanged",async t=>{
 const h=await setup(t);await h.acquire();await h.headers(null);await h.db.exec("update start_packages set status='ready'")
 await h.headers(h.claim);await assert.rejects(h.db.query("update projects set phase='delivery'"),/no longer releasing/)
 await h.headers(null);await h.db.query("update projects set phase='delivery'")
})

test("ledger and gate writes reject package expiry, null parents and worker deletes",async t=>{
 const h=await setup(t);await h.acquire()
 for(const table of ["start_release_steps","start_package_gates"]){
  await h.db.query(`insert into ${table} values(gen_random_uuid(),$1,$2,'pending')`,[ORG,PKG])
  await assert.rejects(h.db.query(`insert into ${table} values(gen_random_uuid(),$1,null,'pending')`,[ORG]),/package mismatch/)
  await assert.rejects(h.db.query(`delete from ${table}`),/cannot delete/)
 }
 await h.headers(null);await h.db.exec("update start_packages set metadata=jsonb_set(metadata,'{release_lease_at}',to_jsonb('2020-01-01'::text))")
 await h.headers(h.claim)
 for(const table of ["start_release_steps","start_package_gates"])await assert.rejects(h.db.query(`update ${table} set status='completed'`),/package lease lost/)
})
test("direct browser writes to start records are denied even without worker headers",async t=>{
 const h=await setup(t);await h.headers(null)
 await h.db.exec("grant select,insert,update,delete on start_packages,start_release_steps,start_package_gates to authenticated;set role authenticated")
 await assert.rejects(h.db.query("update start_packages set status='released'"),/authorized server actions/)
 for(const table of ["start_release_steps","start_package_gates"])await assert.rejects(h.db.query(`insert into ${table} values(gen_random_uuid(),$1,$2,'completed')`,[ORG,PKG]),/authorized server actions/)
})

// ---------------------------------------------------------------------------
// Coordinator release controls against the full migration chain. The fences
// above refuse every browser-role write to packages, steps, gates and starts
// jobs, so the Starts desk acts through the service role after authorizing the
// caller, and the controls that race a worker re-check the actor in SQL.
// ---------------------------------------------------------------------------

const full = require("./support/pglite")

async function desk(t, { role = "org_starts_coordinator", status = "ready" } = {}) {
  const db = await full.createDatabase(t)
  const { orgId, userId: actorId } = await full.seedMember(db, { role })
  const community = await full.insert(db, "communities", { org_id: orgId, name: "Harbor Point" })
  const home = await full.insert(db, "projects", { org_id: orgId, name: "Lot 7", superintendent_id: actorId })
  const lot = await full.insert(db, "lots", { org_id: orgId, community_id: community.id, project_id: home.id, lot_number: "7", status: "assigned" })
  const pkg = await full.insert(db, "start_packages", { org_id: orgId, lot_id: lot.id, community_id: community.id, project_id: home.id, status })
  const h = { db, orgId, actorId, community, home, lot, pkg }
  const scope = { p_org_id: orgId, p_package_id: pkg.id, p_actor_id: actorId }
  h.queue = (overrides = {}) => full.rpc(db, "queue_start_release", {
    ...scope, p_scheduled_start_date: "2026-11-02", p_target_week: "2026-11-02", p_slot_target: 4, p_confirm_over_slot: false, ...overrides,
  })
  h.retry = (actor = actorId) => full.rpc(db, "retry_start_release", { ...scope, p_actor_id: actor })
  h.cancel = (actor = actorId) => full.rpc(db, "cancel_start_release", { ...scope, p_actor_id: actor })
  h.claim = async () => {
    const [job] = await full.rpc(db, "claim_starts_jobs", { p_limit: 1 })
    const acquired = await full.rpc(db, "transition_starts_package_lease", { p_org_id: orgId, p_job_id: job.job_id, p_token: job.claim_token, p_action: "acquire" })
    assert.equal(acquired, true)
    return job
  }
  h.asWorker = (job) => full.setRequestHeaders(db, job ? { "x-starts-job-id": String(job.job_id), "x-starts-claim-token": job.claim_token } : {})
  h.row = async (sql, params = [pkg.id]) => (await db.query(sql, params)).rows[0]
  h.audit = (source) => h.row("select count(*)::int as n from audit_log where entity_id = $1 and source = $2", [pkg.id, source])
  h.reindexed = async () => (await db.query(
    "select payload->>'entity_type' as type from outbox where job_type = 'reindex_search' order by 1",
  )).rows.map((row) => row.type)
  return h
}

test("the desk's service-role writes pass the fences that refuse the browser", async (t) => {
  const h = await desk(t, { status: "open" })
  const definition = await full.insert(h.db, "start_gate_definitions", { org_id: h.orgId, key: "soil_report", label: "Soil report", check_kind: "manual", applies_when: "always", sort_order: 10 })
  const gate = await full.insert(h.db, "start_package_gates", { org_id: h.orgId, start_package_id: h.pkg.id, gate_definition_id: definition.id })
  const attest = "update start_package_gates set status = 'passed', passed_via = 'attested' where id = $1"

  await assert.rejects(
    full.asRole(h.db, { role: "authenticated", userId: h.actorId }, (tx) => tx.query(attest, [gate.id])),
    /authorized server actions/,
  )
  await full.asRole(h.db, { role: "service_role" }, (tx) => tx.query(attest, [gate.id]))
  await full.asRole(h.db, { role: "service_role" }, (tx) => tx.query("update start_packages set status = 'ready' where id = $1", [h.pkg.id]))
  assert.equal((await h.row("select status from start_package_gates where id = $1", [gate.id])).status, "passed")
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "ready")
})

test("queueing a release claims the package, seeds its ledger and job, and is audited", async (t) => {
  const h = await desk(t)
  const queued = await h.queue()

  assert.equal(queued.queued, true)
  const pkg = await h.row("select status, released_by, scheduled_start_date::text as start from start_packages where id = $1")
  assert.deepEqual(pkg, { status: "releasing", released_by: h.actorId, start: "2026-11-02" })
  assert.equal((await h.row("select count(*)::int as n from start_release_steps where start_package_id = $1")).n, 8)
  const job = await h.row("select status, payload->>'actor_id' as actor from outbox where job_type = 'start_release' and payload->>'start_package_id' = $1", [h.pkg.id])
  assert.deepEqual(job, { status: "pending", actor: h.actorId })
  assert.equal((await h.audit("starts.release_queued")).n, 1)
  await assert.rejects(h.queue(), /not ready to release/)
})

test("an over-slot release changes nothing until the coordinator confirms it", async (t) => {
  const h = await desk(t)
  const slot = await h.queue({ p_slot_target: 0 })

  assert.deepEqual(slot, {
    queued: false, target_week: "2026-11-02", target: 0, already_targeted: 0, limit: "community",
    exceeded: [{ limit: "community", target: 0, already_targeted: 0 }],
  })
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "ready")
  assert.equal((await h.row("select count(*)::int as n from outbox where payload->>'start_package_id' = $1", [h.pkg.id])).n, 0)
  await assert.rejects(h.queue({ p_slot_target: 0, p_confirm_over_slot: true }), /needs a reason/)
  await assert.rejects(h.queue({ p_slot_target: 0, p_confirm_over_slot: true, p_over_reason: "too short" }), /needs a reason/)
  assert.equal((await h.queue({ p_slot_target: 0, p_confirm_over_slot: true, p_over_reason: "Model home must start before the open house" })).over_slot, true)
  const event = await h.row("select payload from events where entity_id = $1 and event_type = 'start.released_over_slot'")
  assert.equal(event.payload.over_reason, "Model home must start before the open house")
  assert.deepEqual(event.payload.exceeded, [{ limit: "community", target: 0, already_targeted: 0 }])
})

test("release controls refuse an actor without release authority, and the browser outright", async (t) => {
  const h = await desk(t, { role: "org_viewer" })
  await assert.rejects(h.queue(), /release permission/)
  await assert.rejects(h.cancel(), /release permission/)
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "ready")

  const coordinator = await desk(t)
  await assert.rejects(
    full.rpc(coordinator.db, "queue_start_release", {
      p_org_id: coordinator.orgId, p_package_id: coordinator.pkg.id, p_actor_id: coordinator.actorId,
      p_scheduled_start_date: "2026-11-02", p_target_week: "2026-11-02", p_slot_target: 4, p_confirm_over_slot: false,
    }, { role: "authenticated", userId: coordinator.actorId }),
    /permission denied/,
  )
})

test("retry only requeues a parked release with no attempt still running", async (t) => {
  const h = await desk(t)
  await h.queue()
  await assert.rejects(h.retry(), /needing attention/)

  await h.db.query("update start_packages set status = 'attention' where id = $1", [h.pkg.id])
  await assert.rejects(h.retry(), /still running/)

  await h.db.query("update outbox set status = 'failed', retry_count = 3 where payload->>'start_package_id' = $1", [h.pkg.id])
  await h.retry()
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "releasing")
  const job = await h.row("select status, retry_count from outbox where payload->>'start_package_id' = $1", [h.pkg.id])
  assert.deepEqual(job, { status: "pending", retry_count: 0 })
  assert.equal((await h.audit("starts.release_retried")).n, 1)
})

test("cancel revokes a live worker claim so nothing the worker writes afterwards lands", async (t) => {
  const h = await desk(t)
  await h.queue()
  const job = await h.claim()
  await h.db.query("update start_release_steps set status = 'completed', completed_at = now() where start_package_id = $1 and step_key = 'budget'", [h.pkg.id])

  const result = await h.cancel()
  assert.deepEqual(result.preserved, ["budget", "project"])
  assert.equal(result.reset.length, 6)
  const claim = await h.row("select status, start_claim_token from outbox where id = $1", [job.job_id])
  assert.deepEqual(claim, { status: "failed", start_claim_token: null })
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "ready")

  await h.asWorker(job)
  await assert.rejects(
    full.asRole(h.db, { role: "service_role" }, (tx) =>
      tx.query("update start_release_steps set status = 'completed' where start_package_id = $1 and step_key = 'schedule'", [h.pkg.id])),
    /lease lost/,
  )
  await h.asWorker(null)
  assert.equal(await full.rpc(h.db, "transition_starts_job_lease", { p_org_id: h.orgId, p_id: job.job_id, p_token: job.claim_token, p_action: "complete" }), false)
  await assert.rejects(h.cancel(), /not cancellable/)
})

test("publication starts the lot and home, releases the package, and records its event, audit and reindex together", async (t) => {
  const h = await desk(t)
  await h.queue()
  const job = await h.claim()
  const eventId = full.uuid()
  const publish = (token = job.claim_token) => full.rpc(h.db, "publish_start_release", { p_org_id: h.orgId, p_job_id: job.job_id, p_token: token, p_event_id: eventId })
  const settle = () => h.db.query("update start_release_steps set status = 'completed', completed_at = now() where start_package_id = $1", [h.pkg.id])

  await assert.rejects(publish(full.uuid()), /lease lost/)
  await assert.rejects(publish(), /not proven for: budget, checklists, drawings, finalize, notify_trades, pos, schedule/)
  await settle()
  await h.db.query("update start_release_steps set error = 'Schedule failed' where start_package_id = $1 and step_key = 'schedule'", [h.pkg.id])
  await assert.rejects(publish(), /not proven for: schedule/)
  assert.equal((await h.row("select status from lots where id = $1", [h.lot.id])).status, h.lot.status)
  assert.equal((await h.audit("starts.release_published")).n, 0)

  await settle()
  await h.db.query("update start_release_steps set error = null where start_package_id = $1", [h.pkg.id])
  await publish()
  const pkg = await h.row("select status, released_by, actual_start_date::text as started from start_packages where id = $1")
  assert.deepEqual(pkg, { status: "released", released_by: h.actorId, started: "2026-11-02" })
  assert.equal((await h.row("select status from lots where id = $1", [h.lot.id])).status, "started")
  assert.deepEqual(await h.row("select phase, start_date::text as start from projects where id = $1", [h.home.id]), { phase: "delivery", start: "2026-11-02" })
  assert.equal((await h.audit("starts.release_published")).n, 1)
  assert.equal((await h.row("select event_type from events where id = $1", [eventId])).event_type, "start.released")
  assert.deepEqual(await h.reindexed(), ["lot", "project", "start_package", "start_package"])
  await assert.rejects(publish(), /no longer releasing/)
})

test("a worker that finished every step cannot publish once the coordinator has cancelled", async (t) => {
  const h = await desk(t)
  await h.queue()
  const job = await h.claim()
  await h.db.query("update start_release_steps set status = 'completed', completed_at = now() where start_package_id = $1", [h.pkg.id])

  await h.cancel()
  const eventId = full.uuid()
  await assert.rejects(
    full.rpc(h.db, "publish_start_release", { p_org_id: h.orgId, p_job_id: job.job_id, p_token: job.claim_token, p_event_id: eventId }),
    /lease lost/,
  )
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "ready")
  assert.equal((await h.row("select status from lots where id = $1", [h.lot.id])).status, h.lot.status)
  assert.equal((await h.row("select phase from projects where id = $1", [h.home.id])).phase, h.home.phase)
  assert.equal((await h.audit("starts.release_published")).n, 0)
  assert.equal((await h.row("select count(*)::int as n from events where id = $1", [eventId])).n, 0)
})

test("a release whose lot left its home publishes nothing at all", async (t) => {
  const h = await desk(t)
  await h.queue()
  const job = await h.claim()
  await h.db.query("update start_release_steps set status = 'completed', completed_at = now() where start_package_id = $1", [h.pkg.id])
  const other = await full.insert(h.db, "projects", { org_id: h.orgId, name: "Lot 8" })
  // The lot guard refuses this while the package is live; the case is a lot moved by a path that bypassed it.
  await h.db.exec("alter table lots disable trigger lots_active_start_guard")
  await h.db.query("update lots set project_id = $1 where id = $2", [other.id, h.lot.id])
  await h.db.exec("alter table lots enable trigger lots_active_start_guard")

  await assert.rejects(
    full.rpc(h.db, "publish_start_release", { p_org_id: h.orgId, p_job_id: job.job_id, p_token: job.claim_token, p_event_id: full.uuid() }),
    /ancestry/,
  )
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "releasing")
  assert.equal((await h.row("select status from lots where id = $1", [h.lot.id])).status, h.lot.status)
  assert.equal((await h.row("select phase from projects where id = $1", [h.home.id])).phase, h.home.phase)
})

test("a release that never took its package lease still parks for attention on its final failure", async (t) => {
  const h = await desk(t)
  await h.queue()
  await h.db.query("update outbox set retry_count = 2 where payload->>'start_package_id' = $1", [h.pkg.id])
  const [job] = await full.rpc(h.db, "claim_starts_jobs", { p_limit: 1 })

  const moved = await full.rpc(h.db, "transition_starts_job_lease", {
    p_org_id: h.orgId, p_id: job.job_id, p_token: job.claim_token, p_action: "retry", p_error: "Pinned plan version is no longer released",
  })
  assert.equal(moved, true)
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "attention")
  assert.equal((await h.row("select status from outbox where id = $1", [job.job_id])).status, "failed")
})

// ---------------------------------------------------------------------------
// A house's home is created and linked in the transaction that needs it, so a
// failure orphans nothing and a retry reuses what committed.
// ---------------------------------------------------------------------------

/** What `prepareStartHome` hands SQL: the same rows createProject writes, with no placeholder contract. */
function preparedHome(orgId, actorId, projectId = full.uuid()) {
  return {
    projectId,
    project: { org_id: orgId, created_by: actorId, name: "HP 9", status: "active", phase: "precon", property_type: "production", retainage_percent: 0 },
    billingContract: null,
    financialSettings: {
      org_id: orgId, project_id: projectId, billing_model: "fixed_price", fixed_price_billing_basis: "draws", paid_costs_required: false,
      proof_required: false, client_cost_approval_required: false, open_book_required: false, cost_codes_enabled: null,
      setup_completed_by: actorId, updated_by: actorId, created_by: actorId, metadata: { source: "project_settings" },
    },
    accountingDimensions: {},
  }
}

async function yard(t, { role = "org_starts_coordinator" } = {}) {
  const db = await full.createDatabase(t)
  const { orgId, userId: actorId } = await full.seedMember(db, { role })
  const community = await full.insert(db, "communities", { org_id: orgId, name: "Harbor Point" })
  const lot = await full.insert(db, "lots", { org_id: orgId, community_id: community.id, lot_number: "9", status: "developed" })
  for (const [key, isActive] of [["soil_report", true], ["financing", true], ["retired", false]]) {
    await full.insert(db, "start_gate_definitions", { org_id: orgId, key, label: key, check_kind: "manual", applies_when: "always", sort_order: 10, is_active: isActive })
  }
  const count = async (sql, params = []) => (await db.query(sql, params)).rows[0].n
  const open = (home = preparedHome(orgId, actorId), actor = actorId) => full.rpc(db, "open_start_package", {
    p_org_id: orgId, p_actor_id: actor, p_lot_id: lot.id, p_is_financed: false, p_target_week: null, p_home: home,
  })
  return { db, orgId, actorId, community, lot, count, open }
}

test("owned land opens a package only under a live delivery exception", async (t) => {
  const y = await yard(t)
  await y.db.query("update lots set status = 'owned', delivered_at = null where id = $1", [y.lot.id])
  await assert.rejects(y.open(), /owned lots with a delivery exception/)

  await full.insert(y.db, "lot_delivery_exceptions", { org_id: y.orgId, lot_id: y.lot.id, reason: "Pad is graded; the plat records next week.", approved_by: y.actorId })
  const opened = await y.open()

  assert.equal(await y.count("select count(*)::int as n from start_packages where id = $1", [opened.start_package_id]), 1)
  assert.equal((await y.db.query("select project_id from lots where id = $1", [y.lot.id])).rows[0].project_id, opened.project_id)
})

test("opening a lot creates its home, links it and opens the package with every active gate at once", async (t) => {
  const y = await yard(t)
  const home = preparedHome(y.orgId, y.actorId)
  const opened = await y.open(home)

  assert.equal(opened.project_id, home.projectId)
  const lot = (await y.db.query("select project_id, status from lots where id = $1", [y.lot.id])).rows[0]
  assert.deepEqual(lot, { project_id: home.projectId, status: "assigned" })
  const project = (await y.db.query("select phase, property_type, division_id from projects where id = $1", [home.projectId])).rows[0]
  assert.deepEqual(project, { phase: "precon", property_type: "production", division_id: null })
  assert.equal(await y.count("select count(*)::int as n from contracts where project_id = $1", [home.projectId]), 0)
  assert.equal(await y.count("select count(*)::int as n from project_financial_settings where project_id = $1", [home.projectId]), 1)
  assert.equal(await y.count("select count(*)::int as n from start_package_gates where start_package_id = $1", [opened.start_package_id]), 2)
  const reindexed = (await y.db.query("select payload->>'entity_type' as type from outbox where job_type = 'reindex_search' order by 1")).rows
  assert.deepEqual(reindexed.map((row) => row.type), ["lot", "project", "start_package"])
})

test("a home prepared with explicit billing terms still opens that contract", async (t) => {
  const y = await yard(t)
  const home = preparedHome(y.orgId, y.actorId)
  home.billingContract = {
    org_id: y.orgId, project_id: home.projectId, title: "HP 9 Contract", status: "active", contract_type: "cost_plus", currency: "usd", fee_presentation: "embedded",
    savings_split_owner_pct: 0, savings_split_builder_pct: 0, labor_burden_multiplier: 1, requires_client_cost_approval: false,
    open_book: true, retainage_percent: 0, retainage_applies_to_fee: false, snapshot: {},
  }
  await y.open(home)
  assert.equal(await y.count("select count(*)::int as n from contracts where project_id = $1", [home.projectId]), 1)
})

test("a retried open finds the committed package and builds no second home", async (t) => {
  const y = await yard(t)
  await y.open()
  await assert.rejects(y.open(), /already has an active start package/)
  assert.equal(await y.count("select count(*)::int as n from projects where org_id = $1", [y.orgId]), 1)
  assert.equal(await y.count("select count(*)::int as n from start_packages where org_id = $1", [y.orgId]), 1)
})

test("an open that fails leaves no orphaned home behind", async (t) => {
  for (const failure of ["actor", "bundle"]) {
    const y = await yard(t, { role: failure === "actor" ? "org_viewer" : "org_starts_coordinator" })
    const home = preparedHome(y.orgId, y.actorId)
    // A bundle prepared for someone else cannot become this actor's house.
    if (failure === "bundle") home.financialSettings.created_by = full.uuid()
    await assert.rejects(y.open(home), failure === "actor" ? /start\.write permission/ : /settings ownership mismatch/)
    assert.equal(await y.count("select count(*)::int as n from projects where org_id = $1", [y.orgId]), 0, failure)
    assert.equal(await y.count("select count(*)::int as n from start_packages where org_id = $1", [y.orgId]), 0, failure)
    assert.equal((await y.db.query("select project_id from lots where id = $1", [y.lot.id])).rows[0].project_id, null, failure)
  }
})

test("a lot that already has a home keeps it and the prepared one is never built", async (t) => {
  const y = await yard(t)
  const existing = await full.insert(y.db, "projects", { org_id: y.orgId, name: "Lot 9" })
  await y.db.query("update lots set project_id = $1, status = 'assigned' where id = $2", [existing.id, y.lot.id])
  const opened = await y.open()
  assert.equal(opened.project_id, existing.id)
  assert.equal(await y.count("select count(*)::int as n from projects where org_id = $1", [y.orgId]), 1)
})

test("a homeless package is given one home however often its release retries", async (t) => {
  const y = await yard(t)
  const pkg = await full.insert(y.db, "start_packages", { org_id: y.orgId, lot_id: y.lot.id, community_id: y.community.id, status: "ready" })
  const ensure = (home) => full.rpc(y.db, "ensure_start_package_home", { p_org_id: y.orgId, p_actor_id: y.actorId, p_package_id: pkg.id, p_home: home })

  const first = await ensure(preparedHome(y.orgId, y.actorId))
  const second = await ensure(preparedHome(y.orgId, y.actorId))
  assert.equal(second.project_id, first.project_id)
  assert.equal(second.created_home, false)
  assert.equal(await y.count("select count(*)::int as n from projects where org_id = $1", [y.orgId]), 1)
  const linked = (await y.db.query("select p.project_id as package_home, l.project_id as lot_home from start_packages p join lots l on l.id = p.lot_id where p.id = $1", [pkg.id])).rows[0]
  assert.deepEqual(linked, { package_home: first.project_id, lot_home: first.project_id })
})

test("an actor assigned to another division cannot open a lot or give a package a home", async (t) => {
  const y = await yard(t)
  const mine = await full.insert(y.db, "divisions", { org_id: y.orgId, name: "North" })
  const theirs = await full.insert(y.db, "divisions", { org_id: y.orgId, name: "South" })
  await y.db.query("update communities set division_id = $1 where id = $2", [theirs.id, y.community.id])
  await y.db.query("update lots set division_id = $1 where id = $2", [theirs.id, y.lot.id])
  await y.db.query("update memberships set division_scope = 'assigned' where org_id = $1 and user_id = $2", [y.orgId, y.actorId])
  await y.db.query("insert into membership_divisions (membership_id, division_id) select id, $1 from memberships where org_id = $2 and user_id = $3", [mine.id, y.orgId, y.actorId])
  const otherLot = await full.insert(y.db, "lots", { org_id: y.orgId, community_id: y.community.id, lot_number: "10", status: "developed", division_id: theirs.id })
  const pkg = await full.insert(y.db, "start_packages", { org_id: y.orgId, lot_id: otherLot.id, community_id: y.community.id, status: "ready" })

  await assert.rejects(y.open(), /outside actor division access/)
  await assert.rejects(
    full.rpc(y.db, "ensure_start_package_home", { p_org_id: y.orgId, p_actor_id: y.actorId, p_package_id: pkg.id, p_home: preparedHome(y.orgId, y.actorId) }),
    /outside actor division access/,
  )
  assert.equal(await y.count("select count(*)::int as n from projects where org_id = $1", [y.orgId]), 0)
  assert.equal((await y.db.query("select project_id from lots where id in ($1, $2)", [y.lot.id, otherLot.id])).rows.every((row) => row.project_id === null), true)
})

test("a home cannot be created inside a worker claim or by a browser role", async (t) => {
  const y = await yard(t)
  await full.setRequestHeaders(y.db, { "x-starts-job-id": "1", "x-starts-claim-token": full.uuid() })
  await assert.rejects(y.open(), /cannot be created inside a worker claim/)
  await full.setRequestHeaders(y.db, {})
  await assert.rejects(
    full.asRole(y.db, { role: "authenticated", userId: y.actorId }, (tx) => tx.query(
      "select open_start_package($1, $2, $3, false, null, $4::jsonb)", [y.orgId, y.actorId, y.lot.id, JSON.stringify(preparedHome(y.orgId, y.actorId))])),
    /permission denied/,
  )
  assert.equal(await y.count("select count(*)::int as n from projects where org_id = $1", [y.orgId]), 0)
})

// ---------------------------------------------------------------------------
// The desk's package and gate mutations, and a release's terminal failure.
// Each re-checks the actor under the package lock and commits its state with
// its audit, event, reindex and notification intent — or commits nothing.
// ---------------------------------------------------------------------------

/** Make one insert fail mid-transaction, after the state it records has changed. */
async function failInsert(db, table, when) {
  await db.exec(`
    create or replace function pg_temp.injected_failure() returns trigger language plpgsql as $$
    begin raise exception 'injected failure'; end $$;
    create trigger injected_failure before insert on ${table} for each row when (${when})
      execute function pg_temp.injected_failure();
  `)
}

async function gated(t, options = {}) {
  const h = await desk(t, { status: "open", ...options })
  const definition = (row) => full.insert(h.db, "start_gate_definitions", {
    org_id: h.orgId, label: row.key, check_kind: "manual", applies_when: "always", sort_order: 10, ...row,
  })
  const gate = async (row, status = "pending") => full.insert(h.db, "start_package_gates", {
    org_id: h.orgId, start_package_id: h.pkg.id, gate_definition_id: (await definition(row)).id, status,
  })
  h.gates = {
    soil: await gate({ key: "soil_report" }),
    financing: await gate({ key: "financing", applies_when: "financed_only" }, "not_applicable"),
    selections: await gate({ key: "selections_locked", check_kind: "auto", auto_source: "selections_locked" }),
    approval: await gate({ key: "final_approval" }),
  }
  // A fact gate is attested with its evidence: a file on this home.
  h.evidence = { evidence_file_id: (await full.insert(h.db, "files", { org_id: h.orgId, project_id: h.home.id, file_name: "soil-report.pdf", storage_path: "acceptance/soil-report.pdf" })).id }
  const scope = { p_org_id: h.orgId, p_package_id: h.pkg.id }
  h.mutate = (gate, action, input = {}, actor = h.actorId) => full.rpc(h.db, "mutate_start_gate", {
    ...scope, p_gate_id: gate.id, p_actor_id: actor, p_action: action, p_input: input, p_purchasing_enabled: false,
  })
  h.refresh = (evidence, actor = h.actorId) => full.rpc(h.db, "refresh_start_package_gates", {
    ...scope, p_actor_id: actor, p_purchasing_enabled: false, p_evidence: evidence,
  })
  h.update = (patch, actor = h.actorId) => full.rpc(h.db, "update_start_package", {
    ...scope, p_actor_id: actor, p_patch: patch, p_purchasing_enabled: false,
  })
  h.cancelPackage = (reason = "Buyer walked away from the lot", actor = h.actorId) => full.rpc(h.db, "cancel_start_package", {
    ...scope, p_actor_id: actor, p_reason: reason,
  })
  h.status = async () => (await h.row("select status from start_packages where id = $1")).status
  h.gateStatus = async (gate) => (await h.row("select status from start_package_gates where id = $1", [gate.id])).status
  h.count = async (sql, params = []) => (await h.db.query(sql, params)).rows[0].n
  h.events = (type) => h.count("select count(*)::int as n from events where event_type = $1", [type])
  return h
}

test("clearing the last gate makes the package ready with its event and notice in the same commit", async (t) => {
  const h = await gated(t)
  await assert.rejects(h.mutate(h.gates.approval, "attest"), /Clear every other readiness gate/)
  await h.mutate(h.gates.soil, "attest", { ...h.evidence, notes: "Geotech report 24-118" })
  assert.deepEqual(await h.refresh({ [h.gates.selections.id]: true }), { status: "open", changed: 1 })
  assert.equal(await h.status(), "open")

  assert.deepEqual(await h.mutate(h.gates.approval, "attest"), { status: "ready" })
  const ready = await h.row("select id from events where event_type = 'start_package.ready' and entity_id = $1")
  const notice = await h.row("select payload from outbox where job_type = 'start_package_notice'", [])
  assert.deepEqual(notice.payload, { start_package_id: h.pkg.id, kind: "ready", event_id: ready.id, message: null })
  assert.equal((await h.audit("starts.readiness_changed")).n, 1)
  assert.equal(await h.count("select count(*)::int as n from audit_log where entity_type = 'start_gate' and source = 'starts.gate_attested'"), 2)

  await h.mutate(h.gates.soil, "reopen")
  assert.equal(await h.status(), "open")
  assert.equal(await h.events("start_package.not_ready"), 1)
})

test("a gate change that fails after it is written leaves no gate, readiness, audit or notice behind", async (t) => {
  const h = await gated(t)
  await h.mutate(h.gates.soil, "attest", h.evidence)
  await h.refresh({ [h.gates.selections.id]: true })
  await failInsert(h.db, "outbox", "new.job_type = 'start_package_notice'")

  await assert.rejects(h.mutate(h.gates.approval, "attest"), /injected failure/)
  assert.equal(await h.gateStatus(h.gates.approval), "pending")
  assert.equal(await h.status(), "open")
  assert.equal(await h.count("select count(*)::int as n from audit_log where entity_id = $1", [h.gates.approval.id]), 0)
  assert.equal(await h.events("start_gate.attested"), 1, "only the permit's attestation committed")
  assert.equal(await h.events("start_package.ready"), 0)

  await assert.rejects(h.mutate(h.gates.soil, "waive", { reason: "Soil report is issued at the counter on start day" }), /injected failure/)
  assert.equal(await h.gateStatus(h.gates.soil), "passed")
  assert.equal(await h.events("start_gate.waived"), 0)
})

test("gate and package edits re-check the actor's authority inside the transaction", async (t) => {
  const viewer = await gated(t, { role: "org_viewer" })
  await assert.rejects(viewer.mutate(viewer.gates.soil, "attest"), /start\.write permission/)
  await assert.rejects(viewer.update({ notes: "x" }), /start\.write permission/)
  await assert.rejects(viewer.cancelPackage(), /start\.write permission/)

  const h = await gated(t)
  const definition = await full.insert(h.db, "start_gate_definitions", {
    org_id: h.orgId, key: "survey", label: "Survey", check_kind: "manual", applies_when: "always", sort_order: 20,
    requires_attestation_permission: "org.admin",
  })
  const survey = await full.insert(h.db, "start_package_gates", { org_id: h.orgId, start_package_id: h.pkg.id, gate_definition_id: definition.id })
  await assert.rejects(h.mutate(survey, "attest"), /org\.admin permission/)

  const division = await full.insert(h.db, "divisions", { org_id: h.orgId, name: "South" })
  const mine = await full.insert(h.db, "divisions", { org_id: h.orgId, name: "North" })
  await h.db.query("update communities set division_id = $1 where id = $2", [division.id, h.community.id])
  await h.db.query("update memberships set division_scope = 'assigned' where org_id = $1 and user_id = $2", [h.orgId, h.actorId])
  await h.db.query("insert into membership_divisions (membership_id, division_id) select id, $1 from memberships where org_id = $2 and user_id = $3", [mine.id, h.orgId, h.actorId])
  await assert.rejects(h.mutate(h.gates.soil, "attest"), /outside actor division access/)
  await assert.rejects(h.refresh({ [h.gates.selections.id]: true }), /outside actor division access/)
  await assert.rejects(h.update({ notes: "Moved to the north phase" }), /outside actor division access/)

  for (const gate of [h.gates.soil, h.gates.selections, survey]) assert.equal(await h.gateStatus(gate), "pending")
  assert.equal(await h.count("select count(*)::int as n from audit_log where org_id = $1", [h.orgId]), 0)

  await full.setRequestHeaders(h.db, { "x-starts-job-id": "1", "x-starts-claim-token": full.uuid() })
  await assert.rejects(h.cancelPackage(), /inside a worker claim/)
  await full.setRequestHeaders(h.db, {})
  await assert.rejects(
    full.rpc(h.db, "cancel_start_package", { p_org_id: h.orgId, p_package_id: h.pkg.id, p_actor_id: h.actorId, p_reason: "Buyer walked away" },
      { role: "authenticated", userId: h.actorId }),
    /permission denied/,
  )
})

test("a refresh records only evidence it was given, and never touches a package already releasing", async (t) => {
  const h = await gated(t)
  await assert.rejects(h.refresh({}), /evidence is missing for the selections_locked gate/)
  assert.equal(await h.gateStatus(h.gates.selections), "pending")

  assert.deepEqual(await h.refresh({ [h.gates.selections.id]: false }), { status: "open", changed: 0 })
  assert.equal(await h.events("start_gate.refreshed"), 0, "a refresh that changes nothing records nothing")
  await h.refresh({ [h.gates.selections.id]: true })
  assert.equal((await h.audit("starts.gates_refreshed")).n, 1)
  assert.equal(await h.events("start_gate.refreshed"), 1)

  await h.db.exec("alter table start_packages disable trigger start_packages_gate_completion_guard")
  await h.db.query("update start_packages set status = 'releasing' where id = $1", [h.pkg.id])
  await h.db.exec("alter table start_packages enable trigger start_packages_gate_completion_guard")
  assert.deepEqual(await h.refresh({ [h.gates.selections.id]: false }), { status: "releasing", changed: 0 })
  assert.equal(await h.gateStatus(h.gates.selections), "passed")
  await assert.rejects(h.mutate(h.gates.soil, "attest"), /cannot change after release begins/)
  await assert.rejects(h.update({ notes: "x" }), /Only open or ready/)
})

test("financing a package re-decides which gates apply in the edit that changes it", async (t) => {
  const h = await gated(t)
  await h.mutate(h.gates.soil, "attest", h.evidence)
  await h.refresh({ [h.gates.selections.id]: true })
  await h.mutate(h.gates.approval, "attest")
  assert.equal(await h.status(), "ready")

  assert.deepEqual(await h.update({ is_financed: true, notes: "Construction loan" }), { status: "open" })
  assert.equal(await h.gateStatus(h.gates.financing), "pending")
  const pkg = await h.row("select is_financed, notes from start_packages where id = $1")
  assert.deepEqual(pkg, { is_financed: true, notes: "Construction loan" })
  assert.equal((await h.audit("starts.package_updated")).n, 1)
  assert.equal(await h.events("start_package.updated"), 1)

  await failInsert(h.db, "events", "new.event_type = 'start_package.updated'")
  await assert.rejects(h.update({ is_financed: false }), /injected failure/)
  assert.equal((await h.row("select is_financed from start_packages where id = $1")).is_financed, true)
  assert.equal(await h.gateStatus(h.gates.financing), "pending")
  assert.equal((await h.audit("starts.package_updated")).n, 1)
  await assert.rejects(h.update({ status: "released" }), /Invalid start package update/)
})

test("cancelling a package commits with its audit and event, or not at all", async (t) => {
  const h = await gated(t)
  await failInsert(h.db, "audit_log", "new.source = 'starts.package_cancelled'")
  await assert.rejects(h.cancelPackage(), /injected failure/)
  assert.equal(await h.status(), "open")
  assert.equal(await h.events("start_package.cancelled"), 0)

  await h.db.exec("drop trigger injected_failure on audit_log")
  await assert.rejects(h.cancelPackage("too short"), /at least 10 characters/)
  await h.cancelPackage()
  assert.equal(await h.status(), "cancelled")
  assert.equal((await h.row("select metadata->>'cancellation_reason' as reason from start_packages where id = $1")).reason, "Buyer walked away from the lot")
  assert.equal(await h.events("start_package.cancelled"), 1)
  assert.deepEqual(await h.reindexed(), ["start_package"])

  const releasing = await desk(t)
  await releasing.queue()
  await assert.rejects(
    full.rpc(releasing.db, "cancel_start_package", { p_org_id: releasing.orgId, p_package_id: releasing.pkg.id, p_actor_id: releasing.actorId, p_reason: "Buyer walked away from the lot" }),
    /releasing or released/,
  )
})

test("a failed trade notice is requeued under the coordinator with its audit and event, once", async (t) => {
  const h = await desk(t, { status: "released" })
  const notice = await full.insert(h.db, "outbox", {
    org_id: h.orgId, job_type: "start_release_trade_notice", status: "failed", retry_count: 3, last_error: "Mail unavailable",
    payload: { start_package_id: h.pkg.id, company_id: full.uuid(), actor_id: full.uuid() },
  })
  const retry = () => full.rpc(h.db, "retry_start_trade_notice", { p_org_id: h.orgId, p_package_id: h.pkg.id, p_notice_id: notice.id, p_actor_id: h.actorId })

  await failInsert(h.db, "events", "new.event_type = 'start.trade_notice_retried'")
  await assert.rejects(retry(), /injected failure/)
  assert.equal((await h.row("select status from outbox where id = $1", [notice.id])).status, "failed")
  assert.equal((await h.audit("starts.trade_notice_retried")).n, 0)

  await h.db.exec("drop trigger injected_failure on events")
  await retry()
  const requeued = await h.row("select status, retry_count, payload->>'actor_id' as actor from outbox where id = $1", [notice.id])
  assert.deepEqual(requeued, { status: "pending", retry_count: 0, actor: h.actorId })
  const audit = await h.row("select before_data->>'id' as notice from audit_log where source = 'starts.trade_notice_retried'", [])
  assert.equal(audit.notice, String(notice.id), "the audit names the notice it requeued")
  await assert.rejects(retry(), /Only failed trade notices/)
})

test("a release's final failure parks it with its event, audit and notice, or does not park it at all", async (t) => {
  const h = await desk(t)
  await h.queue()
  await h.db.query("update outbox set retry_count = 2 where payload->>'start_package_id' = $1", [h.pkg.id])
  const job = await h.claim()
  const fail = () => full.rpc(h.db, "transition_starts_job_lease", {
    p_org_id: h.orgId, p_id: job.job_id, p_token: job.claim_token, p_action: "retry", p_error: "Plan set is missing",
  })

  await failInsert(h.db, "outbox", "new.job_type = 'start_package_notice'")
  await assert.rejects(fail(), /injected failure/)
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "releasing")
  assert.equal((await h.row("select status from outbox where id = $1", [job.job_id])).status, "processing")
  assert.equal((await h.audit("starts.release_failed")).n, 0)

  await h.db.exec("drop trigger injected_failure on outbox")
  assert.equal(await fail(), true)
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "attention")
  const event = await h.row("select id, payload->>'error' as error from events where event_type = 'start.release_failed' and entity_id = $1")
  assert.equal(event.error, "Plan set is missing")
  const notice = await h.row("select payload from outbox where job_type = 'start_package_notice'", [])
  assert.deepEqual(notice.payload, { start_package_id: h.pkg.id, kind: "release_failed", event_id: event.id, message: "Plan set is missing" })
  assert.equal((await h.audit("starts.release_failed")).n, 1)
})

test("the lease reaper records the failure of a release it parks, and nothing for one it only requeues", async (t) => {
  const h = await desk(t)
  await h.queue()
  const job = await h.claim()
  const expire = () => h.db.query("update outbox set start_job_lease_expires_at = now() - interval '1 second' where id = $1", [job.job_id])
  await expire()
  await full.rpc(h.db, "recover_starts_job_leases", { p_limit: 10 })
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "releasing")
  assert.equal((await h.audit("starts.release_failed")).n, 0)

  await h.db.query("update outbox set retry_count = 2 where id = $1", [job.job_id])
  const [again] = await full.rpc(h.db, "claim_starts_jobs", { p_limit: 1 })
  assert.equal(again.job_id, job.job_id)
  await expire()
  await full.rpc(h.db, "recover_starts_job_leases", { p_limit: 10 })
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "attention")
  assert.equal((await h.audit("starts.release_failed")).n, 1)
  assert.equal((await h.row("select count(*)::int as n from outbox where job_type = 'start_package_notice'", [])).n, 1)
})

// ---------------------------------------------------------------------------
// The permit and plot-plan gates are evidenced by the database from the home's
// permit application (20261013120000_permits): no supplied verdict, waiver or
// definition change clears them.
// ---------------------------------------------------------------------------

const { permitWorld } = require("./support/permits")

function permitDesk(w) {
  const scope = { p_org_id: w.orgId, p_package_id: w.pkg.id, p_actor_id: w.coordinator.userId, p_purchasing_enabled: false }
  return {
    refresh: (evidence = {}) => full.rpc(w.db, "refresh_start_package_gates", { ...scope, p_evidence: evidence }),
    mutate: (gateId, action, input = {}) => full.rpc(w.db, "mutate_start_gate", { ...scope, p_gate_id: gateId, p_action: action, p_input: input }),
    status: async (gate) => (await w.row("select status from start_package_gates where id = $1", [gate.id])).status,
  }
}

test("the permit gate passes only on an approved permit for the lot's pinned plan, under the community's authority", async (t) => {
  const w = await permitWorld(t)
  const desk = permitDesk(w)
  await desk.refresh({ [w.gates.permit.id]: true, [w.gates.plot.id]: true })
  assert.deepEqual([await desk.status(w.gates.permit), await desk.status(w.gates.plot)], ["pending", "pending"], "a supplied verdict is ignored")

  const applicationId = await w.approvedApplication()
  await desk.refresh()
  assert.deepEqual([await desk.status(w.gates.permit), await desk.status(w.gates.plot)], ["passed", "passed"])

  await w.db.query("update permit_applications set expires_on = permit_local_today(org_id, project_id) - 1 where id = $1", [applicationId])
  assert.equal(await w.evidence("permit_approved"), false, "an expired permit starts nothing")
  await w.db.query("update permit_applications set expires_on = null where id = $1", [applicationId])

  await w.db.query("update communities set permit_jurisdiction_company_id = $1 where id = $2", [w.otherAuthority.id, w.community.id])
  assert.equal(await w.evidence("permit_approved"), false, "a permit from another authority is not this community's permit")
  await w.db.query("update communities set permit_jurisdiction_company_id = $1 where id = $2", [w.authority.id, w.community.id])

  await w.db.query("update lots set house_plan_version_id = $1 where id = $2", [w.nextVersion.id, w.lot.id])
  await desk.refresh()
  assert.equal(await desk.status(w.gates.permit), "pending", "a plan change reopens the gate until the revision is approved")
  const revision = await w.open({ p_supersedes_id: applicationId })
  await w.attach(revision, "plot_plan", await w.file("plot-plan-r2.pdf"))
  await w.submit(revision, { p_submitted_on: "2026-09-25" })
  await w.decide(revision, { p_decided_on: "2026-09-26", p_permit_number: "BLD-26-0412-R1", p_issued_permit_file_id: await w.file("permit-r1.pdf"), p_approved_plans_file_id: await w.file("plans-r1.pdf") })
  await desk.refresh()
  assert.equal(await desk.status(w.gates.permit), "passed")
})

test("the authority's letter that no permit is needed clears the gate; a denial does not", async (t) => {
  const w = await permitWorld(t)
  const denied = await w.open()
  await w.attach(denied, "plot_plan", await w.file("plot-plan.pdf"))
  await w.submit(denied)
  await w.decide(denied, { p_decision: "denied", p_note: "Flood elevation not met" })
  assert.equal(await w.evidence("permit_approved"), false)
  const exempt = await w.open()
  const note = "County confirms a fence repair needs no permit"
  await assert.rejects(w.decide(exempt, { p_decision: "not_required", p_note: note }), /no-permit letter is required/)
  const letter = await w.file("exemption-letter.pdf")
  await w.attach(exempt, "authority_letter", letter, { label: "Authority's no-permit letter", requiredFor: "decision" })
  await w.decide(exempt, { p_decision: "not_required", p_issued_permit_file_id: letter, p_note: note })
  assert.equal(await w.evidence("permit_approved"), true)
})

test("the permit gate is never waived, and a fact gate is attested only with evidence on its home", async (t) => {
  const w = await permitWorld(t)
  const desk = permitDesk(w)
  await assert.rejects(desk.mutate(w.gates.permit.id, "waive", { reason: "County issues the permit at the counter" }), /never waived/)
  await assert.rejects(desk.mutate(w.gates.permit.id, "attest", { notes: "Permit 24-118" }), /Only manual gates/)

  const soil = await full.insert(w.db, "start_package_gates", {
    org_id: w.orgId, start_package_id: w.pkg.id,
    gate_definition_id: (await full.insert(w.db, "start_gate_definitions", { org_id: w.orgId, key: "soil_report", label: "Soil report", check_kind: "manual", applies_when: "always" })).id,
  })
  await assert.rejects(desk.mutate(soil.id, "attest", { notes: "Report is in" }), /Attach the evidence/)
  await assert.rejects(desk.mutate(soil.id, "attest", { evidence_file_id: await w.file("soil.pdf", w.otherHome.id) }), /file on this home/)
  await desk.mutate(soil.id, "attest", { evidence_file_id: await w.file("soil.pdf") })
  assert.equal(await desk.status(soil), "passed")
})

test("gate definitions change only with start.release, and the permit and plot-plan gates never change shape", async (t) => {
  const w = await permitWorld(t)
  const asMember = (userId, sql, params = []) => full.asRole(w.db, { role: "authenticated", userId }, (tx) => tx.query(sql, params))
  const deactivate = "update start_gate_definitions set is_active = false where org_id = $1 and key = $2"

  const viewerPatch = await asMember(w.viewer.userId, deactivate, [w.orgId, "permit"])
  assert.equal(viewerPatch.affectedRows, 0, "a viewer's patch reaches no definition")
  await assert.rejects(
    asMember(w.viewer.userId, "insert into start_gate_definitions (org_id, key, label, check_kind) values ($1, 'shortcut', 'Shortcut', 'manual')", [w.orgId]),
    /row-level security/,
  )
  await assert.rejects(asMember(w.coordinator.userId, deactivate, [w.orgId, "permit"]), /cannot be made manual, conditional or inactive/)
  await assert.rejects(asMember(w.coordinator.userId, deactivate, [w.orgId, "plot_plan"]), /cannot be made manual, conditional or inactive/)
  await assert.rejects(w.db.query("update start_gate_definitions set check_kind = 'manual', auto_source = null where key = 'permit'"), /cannot be made manual/)
  await assert.rejects(w.db.query("delete from start_gate_definitions where key = 'permit'"), /cannot be removed/)
  await asMember(w.coordinator.userId, "update start_gate_definitions set label = 'Building permit issued' where org_id = $1 and key = 'permit'", [w.orgId])
  assert.equal((await w.row("select label, is_active from start_gate_definitions where key = 'permit'")).is_active, true)
})

// ---------------------------------------------------------------------------
// EP07-02 / EP07-03: throughput targets, superintendent capacity and the
// data-API lockdown, against the full migration chain.
// ---------------------------------------------------------------------------

/** One more ready house in the org, in its own community, with a superintendent. */
async function readyHome(h, { community, superintendentId = h.actorId, number }) {
  const home = await full.insert(h.db, "projects", { org_id: h.orgId, name: `Lot ${number}`, superintendent_id: superintendentId })
  const lot = await full.insert(h.db, "lots", { org_id: h.orgId, community_id: community.id, project_id: home.id, lot_number: String(number), status: "assigned" })
  const pkg = await full.insert(h.db, "start_packages", { org_id: h.orgId, lot_id: lot.id, community_id: community.id, project_id: home.id, status: "ready" })
  return { home, lot, pkg }
}

const queueFor = (h, pkg, overrides = {}) => full.rpc(h.db, "queue_start_release", {
  p_org_id: h.orgId, p_package_id: pkg.id, p_actor_id: h.actorId, p_scheduled_start_date: "2026-11-02", p_target_week: "2026-11-02",
  p_slot_target: 9, p_confirm_over_slot: false, ...overrides,
})

test("a house releases only with an active member as its superintendent", async (t) => {
  const h = await desk(t)
  await h.db.query("update projects set superintendent_id = null where id = $1", [h.home.id])
  await assert.rejects(h.queue(), /Assign a superintendent/)

  const super1 = await full.seedMember(h.db, { orgId: h.orgId, role: "org_superintendent" })
  await h.db.query("update projects set superintendent_id = $1 where id = $2", [super1.userId, h.home.id])
  await h.db.query("update memberships set status = 'suspended' where user_id = $1", [super1.userId])
  await assert.rejects(h.queue(), /no longer an active member/)
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "ready")

  await h.db.query("update memberships set status = 'active' where user_id = $1", [super1.userId])
  assert.equal((await h.queue()).queued, true)
})

test("division and org throughput targets hold across communities, and over target needs a reason", async (t) => {
  const h = await desk(t)
  const division = await full.insert(h.db, "divisions", { org_id: h.orgId, name: "Gulf Coast" })
  await h.db.query("update communities set division_id = $1 where id = $2", [division.id, h.community.id])
  const second = await full.insert(h.db, "communities", { org_id: h.orgId, name: "Bayshore", division_id: division.id })
  const elsewhere = await full.insert(h.db, "communities", { org_id: h.orgId, name: "Inland" })
  const b = await readyHome(h, { community: second, number: 8 })
  const c = await readyHome(h, { community: elsewhere, number: 9 })
  await full.insert(h.db, "release_throughput_targets", { org_id: h.orgId, division_id: division.id, week_start: "2026-11-02", target_starts: 1 })
  await full.insert(h.db, "release_throughput_targets", { org_id: h.orgId, division_id: null, week_start: "2026-11-02", target_starts: 2 })

  assert.equal((await h.queue({ p_slot_target: 9 })).queued, true)
  const blocked = await queueFor(h, b.pkg)
  assert.equal(blocked.queued, false)
  assert.deepEqual(blocked.exceeded, [{ limit: "division", target: 1, already_targeted: 1 }])
  assert.equal(blocked.limit, "division")
  assert.equal((await h.row("select status from start_packages where id = $1", [b.pkg.id])).status, "ready")

  await assert.rejects(queueFor(h, b.pkg, { p_confirm_over_slot: true }), /needs a reason/)
  const confirmed = await queueFor(h, b.pkg, { p_confirm_over_slot: true, p_over_reason: "Buyer's rate lock expires in three weeks" })
  assert.equal(confirmed.over_slot, true)

  const orgBlocked = await queueFor(h, c.pkg)
  assert.deepEqual(orgBlocked.exceeded, [{ limit: "org", target: 2, already_targeted: 2 }])
  const audit = await h.row("select after_data from audit_log where entity_id = $1 and source = 'starts.release_queued'", [b.pkg.id])
  assert.equal(audit.after_data.over_reason, "Buyer's rate lock expires in three weeks")

  // A different week has no target and is not counted.
  assert.equal((await queueFor(h, c.pkg, { p_target_week: "2026-11-09", p_scheduled_start_date: "2026-11-09" })).queued, true)
})

test("assigning a superintendent is one transaction that enforces the limit and keeps the scoping row in step", async (t) => {
  const h = await desk(t)
  await h.db.query("update projects set superintendent_id = null where id = $1", [h.home.id])
  const person = await full.seedMember(h.db, { orgId: h.orgId, role: "org_superintendent" })
  const successor = await full.seedMember(h.db, { orgId: h.orgId, role: "org_superintendent" })
  await full.insert(h.db, "superintendent_capacity", { org_id: h.orgId, user_id: null, warn_houses: 1, max_houses: 2 })
  for (const number of [11, 12]) await full.insert(h.db, "projects", { org_id: h.orgId, name: `Lot ${number}`, superintendent_id: person.userId })
  const assign = (overrides = {}) => full.rpc(h.db, "assign_project_superintendent", {
    p_org_id: h.orgId, p_project_id: h.home.id, p_user_id: person.userId, p_actor_id: h.actorId, ...overrides,
  })
  const scoped = async (userId) => (await h.db.query("select count(*)::int as n from project_members where project_id = $1 and user_id = $2", [h.home.id, userId])).rows[0].n

  const refused = await assign()
  assert.deepEqual(refused, { assigned: false, requires_override: true, can_override: true, houses: 2, warn: 1, limit: 2 })
  assert.equal((await h.row("select superintendent_id from projects where id = $1", [h.home.id])).superintendent_id, null)
  await assert.rejects(assign({ p_over_reason: "short" }), /reason of at least 10/)
  const viewer = await full.seedMember(h.db, { orgId: h.orgId, role: "org_viewer" })
  await assert.rejects(assign({ p_actor_id: viewer.userId, p_over_reason: "Covering a medical leave this month" }), /project.manage or start.write/)

  // A person with their own row is judged by it, not by the org default.
  await full.insert(h.db, "superintendent_capacity", { org_id: h.orgId, user_id: person.userId, warn_houses: 5, max_houses: 6 })
  const placed = await assign()
  assert.equal(placed.assigned, true)
  assert.equal(placed.houses, 3)
  assert.equal(await scoped(person.userId), 1)

  // Past their own limit the same call goes through only with a reason, and says so in the audit.
  await h.db.query("update superintendent_capacity set warn_houses = 2, max_houses = 3 where user_id = $1", [person.userId])
  await h.db.query("update projects set superintendent_id = null where id = $1", [h.home.id])
  const second = await full.insert(h.db, "projects", { org_id: h.orgId, name: "Lot 13", superintendent_id: null })
  await full.rpc(h.db, "assign_project_superintendent", { p_org_id: h.orgId, p_project_id: second.id, p_user_id: person.userId, p_actor_id: h.actorId })
  const over = await assign({ p_over_reason: "Covering a medical leave this month" })
  assert.equal(over.over_capacity, true)
  const audit = await h.row("select after_data from audit_log where entity_id = $1 and source = 'starts.superintendent_assigned' order by created_at desc limit 1", [h.home.id])
  assert.equal(audit.after_data.reason, "Covering a medical leave this month")

  // Handing the house to someone else swaps the scoping row; clearing removes it.
  const handed = await assign({ p_user_id: successor.userId })
  assert.equal(handed.previous_user_id, person.userId)
  assert.equal(await scoped(person.userId), 0)
  assert.equal(await scoped(successor.userId), 1)
  await assign({ p_user_id: null })
  assert.equal(await scoped(successor.userId), 0)
  assert.equal((await h.row("select superintendent_id from projects where id = $1", [h.home.id])).superintendent_id, null)
  assert.equal((await h.row("select count(*)::int as n from events where entity_id = $1 and event_type = 'project.superintendent_changed'", [h.home.id])).n, 4)
})

test("a member cannot write slot targets or assign a superintendent through the data API", async (t) => {
  const h = await desk(t)
  const viewer = await full.seedMember(h.db, { orgId: h.orgId, role: "org_viewer" })
  const slot = await full.insert(h.db, "community_release_slots", { org_id: h.orgId, community_id: h.community.id, week_start: "2026-11-02", target_starts: 2 })
  const asViewer = (sql, params = []) => full.asRole(h.db, { role: "authenticated", userId: viewer.userId }, (tx) => tx.query(sql, params))

  await assert.rejects(asViewer("update community_release_slots set target_starts = 99 where id = $1", [slot.id]), /permission denied/)
  await assert.rejects(asViewer("insert into community_release_slots (org_id, community_id, week_start, target_starts) values ($1, $2, '2026-11-09', 99)", [h.orgId, h.community.id]), /permission denied/)
  assert.equal((await asViewer("select target_starts from community_release_slots where id = $1", [slot.id])).rows[0].target_starts, 2)
  await assert.rejects(asViewer("update projects set superintendent_id = $1 where id = $2", [viewer.userId, h.home.id]), /assigned through the house's assignment/)
  await assert.rejects(asViewer("insert into release_throughput_targets (org_id, week_start, target_starts) values ($1, '2026-11-02', 0)", [h.orgId]), /permission denied/)
  await assert.rejects(asViewer("insert into superintendent_capacity (org_id, warn_houses, max_houses) values ($1, 1, 1)", [h.orgId]), /permission denied/)
  assert.equal((await h.row("select superintendent_id from projects where id = $1", [h.home.id])).superintendent_id, h.actorId)
})

// ---------------------------------------------------------------------------
// EP07-04 / -11 / -12 / -13 / -17: resumable release steps, a lot under a live
// package, gates that reach packages already open, cancel idempotency and the
// selection fence, against the full migration chain.
// ---------------------------------------------------------------------------

/** A claimed release; `running(step)` leaves a step running, as the worker does while a handler works. */
async function claimedRelease(h) {
  await h.queue()
  const job = await h.claim()
  const running = async (step) => {
    await h.db.query("update start_release_steps set status = 'running' where start_package_id = $1 and step_key = $2", [h.pkg.id, step])
    const settle = (overrides = {}) => full.rpc(h.db, "settle_release_step", {
      p_org_id: h.orgId, p_job_id: job.job_id, p_token: job.claim_token, p_step: step, p_detail: {}, p_expected_count: null, p_version_id: null, ...overrides,
    })
    const state = () => h.row("select status, error, detail from start_release_steps where start_package_id = $1 and step_key = $2", [h.pkg.id, step])
    return { settle, state }
  }
  return { job, running }
}

test("a release step settles only with the receipt it promised, and the two ledgers close together", async (t) => {
  const h = await desk(t)
  const { running } = await claimedRelease(h)
  const { settle, state } = await running("schedule")
  const version = full.uuid()
  const item = (n) => full.insert(h.db, "schedule_items", { org_id: h.orgId, project_id: h.home.id, name: `Task ${n}`, metadata: { release_key: `schedule:${n}`, release_version: version } })

  await assert.rejects(settle(), /cannot complete without a receipt/)
  await item(0)
  await assert.rejects(settle({ p_expected_count: 2, p_version_id: version }), /receipt is incomplete: 1 of 2 built/)
  assert.equal((await state()).status, "running")
  assert.equal((await h.row("select metadata->'plan_instantiation' as ledger from projects where id = $1", [h.home.id])).ledger, null, "a refused step marks nothing on the project")

  await item(1)
  const settled = await settle({ p_expected_count: 2, p_version_id: version, p_detail: { item_ids: ["a", "b"] } })
  assert.deepEqual(settled.receipt, { expected: 2, found: 2 })
  const closed = await state()
  assert.equal(closed.status, "completed")
  assert.deepEqual(closed.detail.receipt, { expected: 2, found: 2 })
  const ledger = (await h.row("select metadata->'plan_instantiation' as ledger from projects where id = $1", [h.home.id])).ledger
  assert.equal(ledger.produced.schedule.version_id, version)
  assert.equal(ledger.seq, 1)
  await assert.rejects(settle({ p_expected_count: 2, p_version_id: version }), /is not running/)
})

test("a step that built nothing records zero, a skipped step needs no count, and a stale claim settles nothing", async (t) => {
  const h = await desk(t)
  const { job, running } = await claimedRelease(h)
  const checklists = await running("checklists")
  assert.deepEqual((await checklists.settle({ p_expected_count: 0 })).receipt, { expected: 0, found: 0 })
  assert.deepEqual((await checklists.state()).detail.receipt, { expected: 0, found: 0 })

  const budget = await running("budget")
  const header = await full.insert(h.db, "budgets", { org_id: h.orgId, project_id: h.home.id, version: 1, status: "approved", total_cents: 100, metadata: { release_key: "budget", release_version: full.uuid() } })
  await full.insert(h.db, "budget_lines", { org_id: h.orgId, budget_id: header.id, description: "Slab", amount_cents: 60, sort_order: 0 })
  await assert.rejects(budget.settle({ p_expected_count: 1 }), /lines total 60 of 100/)
  await full.insert(h.db, "budget_lines", { org_id: h.orgId, budget_id: header.id, description: "Framing", amount_cents: 40, sort_order: 1 })
  await assert.rejects(budget.settle({ p_expected_count: 3 }), /2 of 3 built/)
  await budget.settle({ p_expected_count: 2 })

  const schedule = await running("schedule")
  const skipped = await schedule.settle({ p_detail: { already_instantiated: true }, p_version_id: full.uuid() })
  assert.equal(skipped.receipt, null)
  assert.notEqual((await h.row("select (metadata->'plan_instantiation'->'produced') ? 'schedule' as marked from projects where id = $1", [h.home.id])).marked, true, "a skip is not a mark")

  const drawings = await running("drawings")
  await assert.rejects(full.rpc(h.db, "settle_release_step", {
    p_org_id: h.orgId, p_job_id: job.job_id, p_token: full.uuid(), p_step: "drawings", p_detail: {}, p_expected_count: null, p_version_id: null,
  }), /worker lease lost/)
  await h.db.query("update start_packages set status = 'ready' where id = $1", [h.pkg.id])
  await assert.rejects(drawings.settle(), /no longer releasing/)
  await assert.rejects(full.rpc(h.db, "settle_release_step", { p_org_id: h.orgId, p_job_id: 1, p_token: full.uuid(), p_step: "drawings", p_detail: {}, p_expected_count: null, p_version_id: null },
    { role: "authenticated", userId: h.actorId }), /permission denied/)
})

test("a lot cannot leave its home while a package is live, a stranded package can still be cancelled, and a second cancel changes nothing", async (t) => {
  const h = await desk(t, { status: "open" })
  const detach = "update lots set project_id = null, status = 'assigned' where id = $1"
  await assert.rejects(h.db.query(detach, [h.lot.id]), /Cancel the start package before detaching/)
  const elsewhere = await full.insert(h.db, "communities", { org_id: h.orgId, name: "Inland" })
  await assert.rejects(h.db.query("update lots set community_id = $1 where id = $2", [elsewhere.id, h.lot.id]), /Cancel the start package before detaching or moving/)
  assert.equal((await h.row("select project_id from lots where id = $1", [h.lot.id])).project_id, h.home.id)

  // A lot detached before the guard existed: nothing could reach its package.
  await h.db.exec("alter table lots disable trigger lots_active_start_guard")
  await h.db.query(detach, [h.lot.id])
  await h.db.exec("alter table lots enable trigger lots_active_start_guard")
  const cancel = (reason, actor = h.actorId) => full.rpc(h.db, "cancel_start_package", { p_org_id: h.orgId, p_package_id: h.pkg.id, p_actor_id: actor, p_reason: reason })
  await assert.rejects(full.rpc(h.db, "update_start_package", { p_org_id: h.orgId, p_package_id: h.pkg.id, p_actor_id: h.actorId, p_patch: { notes: "x" }, p_purchasing_enabled: false }), /ancestry differs/)
  const outsider = await full.seedMember(h.db, { role: "org_viewer" })
  await assert.rejects(cancel("Stranded when the lot was detached", outsider.userId), /no longer an active organization member/)

  assert.equal((await cancel("Stranded when the lot was detached")).already_cancelled, false)
  const again = await cancel("A different reason that must not replace the first")
  assert.deepEqual(again, { status: "cancelled", already_cancelled: true })
  const row = await h.row("select status, metadata->>'cancellation_reason' as reason from start_packages where id = $1")
  assert.deepEqual(row, { status: "cancelled", reason: "Stranded when the lot was detached" })
  assert.equal((await h.audit("starts.package_cancelled")).n, 1)
  assert.equal((await h.row("select count(*)::int as n from events where entity_id = $1 and event_type = 'start_package.cancelled'")).n, 1)

  // The lot takes its home back: a null-to-home link is not a detach.
  await h.db.query("update lots set project_id = $1 where id = $2", [h.home.id, h.lot.id])
  await h.db.query("update start_packages set status = 'releasing' where id = $1", [h.pkg.id])
  await assert.rejects(h.db.query(detach, [h.lot.id]), /Cancel the start package/)
})

test("cancelling a releasing package is still refused, with or without its lot", async (t) => {
  const h = await desk(t)
  await h.queue()
  await assert.rejects(full.rpc(h.db, "cancel_start_package", { p_org_id: h.orgId, p_package_id: h.pkg.id, p_actor_id: h.actorId, p_reason: "Cancelling mid release" }),
    /releasing or released start package cannot be cancelled/)
})

const saveGate = (h, overrides = {}) => full.rpc(h.db, "save_start_gate_definition", {
  p_org_id: h.orgId, p_actor_id: h.actorId, p_id: null, p_key: "soil_report", p_label: "Soil report", p_description: null, p_check_kind: "manual",
  p_auto_source: null, p_requires_attestation_permission: null, p_applies_when: "always", p_sort_order: 10, p_is_active: true,
  p_purchasing_communities: [], ...overrides,
})

test("a new gate definition reaches every open and ready package, and a ready package that gains one returns to open", async (t) => {
  const h = await desk(t, { status: "ready" })
  const approval = await full.insert(h.db, "start_gate_definitions", { org_id: h.orgId, key: "final_approval", label: "Final approval", check_kind: "manual", applies_when: "always" })
  await full.insert(h.db, "start_package_gates", { org_id: h.orgId, start_package_id: h.pkg.id, gate_definition_id: approval.id, status: "passed", passed_via: "attested" })
  const lotB = await full.insert(h.db, "lots", { org_id: h.orgId, community_id: h.community.id, lot_number: "8", status: "developed" })
  const open = await full.insert(h.db, "start_packages", { org_id: h.orgId, lot_id: lotB.id, community_id: h.community.id, status: "open" })
  const lotC = await full.insert(h.db, "lots", { org_id: h.orgId, community_id: h.community.id, lot_number: "9", status: "developed" })
  const closed = await full.insert(h.db, "start_packages", { org_id: h.orgId, lot_id: lotC.id, community_id: h.community.id, status: "cancelled" })
  const gatesOf = async (id) => (await h.db.query("select d.key, g.status from start_package_gates g join start_gate_definitions d on d.id = g.gate_definition_id where g.start_package_id = $1 order by d.key", [id])).rows

  const saved = await saveGate(h)
  assert.equal(saved.packages_updated, 2)
  assert.deepEqual(await gatesOf(open.id), [{ key: "final_approval", status: "pending" }, { key: "soil_report", status: "pending" }], "the package also gains every active gate it was missing")
  assert.deepEqual(await gatesOf(h.pkg.id), [{ key: "final_approval", status: "passed" }, { key: "soil_report", status: "pending" }])
  assert.deepEqual(await gatesOf(closed.id), [], "a cancelled package is left alone")
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "open", "a ready package with an unanswered gate is open")
  assert.equal((await h.audit("starts.gates_added")).n, 1)
  assert.equal((await h.row("select count(*)::int as n from audit_log where entity_id = $1 and source = 'starts.gate_definition_saved'", [saved.definition.id])).n, 1)

  assert.equal((await saveGate(h, { p_id: saved.definition.id, p_label: "Soil report on file" })).packages_updated, 0, "saving again adds nothing twice")
  const inactive = await saveGate(h, { p_key: "survey", p_label: "Survey", p_is_active: false })
  assert.equal(inactive.packages_updated, 0)
  assert.equal((await gatesOf(open.id)).some((gate) => gate.key === "survey"), false, "an inactive definition reaches no package")
  const financed = await saveGate(h, { p_key: "loan_docs", p_label: "Loan documents", p_applies_when: "financed_only" })
  assert.equal(financed.packages_updated, 2)
  assert.deepEqual((await gatesOf(open.id)).find((gate) => gate.key === "loan_docs"), { key: "loan_docs", status: "not_applicable" }, "a cash buyer's package does not answer a financing gate")

  await h.db.exec("alter table start_packages disable trigger start_packages_gate_completion_guard")
  await h.db.query("update start_packages set status = 'releasing' where id = $1", [open.id])
  await h.db.exec("alter table start_packages enable trigger start_packages_gate_completion_guard")
  const reactivated = await saveGate(h, { p_id: inactive.definition.id, p_key: "survey", p_label: "Survey", p_is_active: true })
  assert.equal(reactivated.packages_updated, 1, "a reactivated gate reaches open and ready packages, not one already releasing")
  assert.equal((await gatesOf(open.id)).some((gate) => gate.key === "survey"), false)
})

test("saving a gate definition needs start.release held now, and a definition written around it is healed into the package", async (t) => {
  const h = await desk(t, { status: "open" })
  const sales = await full.seedMember(h.db, { orgId: h.orgId, role: "org_sales_agent" })
  await assert.rejects(saveGate(h, { p_actor_id: sales.userId }), /no longer has start.release permission/)
  const stranger = await full.seedMember(h.db, { role: "org_owner" })
  await assert.rejects(saveGate(h, { p_actor_id: stranger.userId }), /no longer an active organization member/)
  await full.asRole(h.db, { role: "authenticated", userId: h.actorId }, (tx) => assert.rejects(tx.query("select public.save_start_gate_definition($1,$2,null,'x_y','X','',  'manual',null,null,'always',1,true,'{}')", [h.orgId, h.actorId]), /permission denied/))
  assert.equal((await h.row("select count(*)::int as n from start_gate_definitions where org_id = $1", [h.orgId])).n, 0)

  await h.db.query("update memberships set status = 'suspended' where user_id = $1", [h.actorId])
  await assert.rejects(saveGate(h), /no longer an active organization member/)
  await h.db.query("update memberships set status = 'active' where user_id = $1", [h.actorId])

  // Written straight to the table (a path that does not fan out): the desk's refresh adds the missing gate.
  await full.insert(h.db, "start_gate_definitions", { org_id: h.orgId, key: "survey", label: "Survey", check_kind: "manual", applies_when: "always" })
  const healed = await full.rpc(h.db, "heal_start_package_gates", { p_org_id: h.orgId, p_package_id: h.pkg.id, p_actor_id: h.actorId, p_purchasing_enabled: false })
  assert.equal(healed.added, 1)
  assert.equal((await full.rpc(h.db, "heal_start_package_gates", { p_org_id: h.orgId, p_package_id: h.pkg.id, p_actor_id: h.actorId, p_purchasing_enabled: false })).added, 0)
})

test("selection groups, choices and exceptions are written under the release claim like any generated artifact", async (t) => {
  const h = await desk(t)
  await h.queue()
  const job = await h.claim()
  const other = await full.insert(h.db, "projects", { org_id: h.orgId, name: "Lot 99" })
  const group = (projectId) => `insert into project_selection_groups (org_id, project_id, group_id) values ('${h.orgId}', '${projectId}', gen_random_uuid())`

  await h.asWorker({ job_id: 999999, claim_token: full.uuid() })
  await assert.rejects(h.db.exec(group(h.home.id)), /worker lease lost/)
  await h.asWorker(job)
  await assert.rejects(h.db.exec(group(other.id)), /worker project mismatch/)
  await assert.rejects(h.db.exec(`insert into selection_exceptions (org_id, project_id, selection_id, option_id, reason) values ('${h.orgId}', '${other.id}', gen_random_uuid(), gen_random_uuid(), 'lead_time_exceeded')`), /worker project mismatch/)
  await h.asWorker(null)
})

test("release keys are written by the release worker only, and a receipt counts only rows of the version it settles", async (t) => {
  const h = await desk(t)
  const asMember = (sql, params = []) => full.asRole(h.db, { role: "authenticated", userId: h.actorId }, (tx) => tx.query(sql, params))
  const forged = /Release keys are written by the release worker only/
  await assert.rejects(asMember("insert into budgets (org_id, project_id, status, metadata) values ($1, $2, 'draft', '{\"release_key\":\"budget\"}')", [h.orgId, h.home.id]), forged)
  await assert.rejects(asMember("insert into schedule_items (org_id, project_id, name, metadata) values ($1, $2, 'Planted', '{\"release_key\":\"schedule:0\"}')", [h.orgId, h.home.id]), forged)
  const plain = await full.insert(h.db, "schedule_items", { org_id: h.orgId, project_id: h.home.id, name: "Ordinary" })
  await asMember("update schedule_items set metadata = '{\"release_key\":\"schedule:1\"}' where id = $1", [plain.id]).catch(() => null)
  assert.equal((await h.row("select metadata->>'release_key' as key from schedule_items where id = $1", [plain.id])).key, null, "a member's update cannot key an existing item")
  await full.insert(h.db, "schedule_items", { org_id: h.orgId, project_id: h.home.id, name: "Built by the worker", metadata: { release_key: "schedule:0", release_version: full.uuid() } })

  const { running } = await claimedRelease(h)
  const { settle } = await running("schedule")
  const version = full.uuid()
  await assert.rejects(settle({ p_expected_count: 1, p_version_id: version }), /0 of 1 built/, "a row of another version is not this step's receipt")
})

test("a lot's plan pin cannot change while its release is stopped part way, and deleting a house names the live package", async (t) => {
  const h = await desk(t)
  const plan = await full.insert(h.db, "house_plans", { org_id: h.orgId, code: "MG1", name: "Mangrove" })
  await h.queue()
  await assert.rejects(h.db.query("update lots set house_plan_id = $1 where id = $2", [plan.id, h.lot.id]), /Cancel the release before changing this lot's plan/)
  await assert.rejects(h.db.query("update lots set house_plan_elevation_id = gen_random_uuid() where id = $1", [h.lot.id]), /Cancel the release before changing/)
  await h.db.query("update lots set house_plan_id = house_plan_id, swing = swing where id = $1", [h.lot.id])
  await h.db.query("update start_packages set status = 'ready' where id = $1", [h.pkg.id])
  await h.db.query("update lots set house_plan_id = $1 where id = $2", [plan.id, h.lot.id])
  await h.db.query("update start_packages set status = 'open' where id = $1", [h.pkg.id])
  await assert.rejects(h.db.query("delete from projects where id = $1", [h.home.id]), /Cancel the start package before detaching or moving this lot or deleting its home/)
})

test("planning houses count against a superintendent, and a division-limited actor cannot assign outside their division", async (t) => {
  const h = await desk(t)
  await h.db.query("update projects set superintendent_id = null where id = $1", [h.home.id])
  const person = await full.seedMember(h.db, { orgId: h.orgId, role: "org_superintendent" })
  await full.insert(h.db, "superintendent_capacity", { org_id: h.orgId, user_id: null, warn_houses: 1, max_houses: 2 })
  for (const number of [21, 22]) await full.insert(h.db, "projects", { org_id: h.orgId, name: `Lot ${number}`, status: "planning", superintendent_id: person.userId })
  await full.insert(h.db, "projects", { org_id: h.orgId, name: "Lot 23", status: "completed", superintendent_id: person.userId })
  assert.equal(await full.rpc(h.db, "superintendent_active_houses", { p_org_id: h.orgId, p_user_id: person.userId }), 2, "planning counts, completed does not")
  const assign = (actor = h.actorId) => full.rpc(h.db, "assign_project_superintendent", { p_org_id: h.orgId, p_project_id: h.home.id, p_user_id: person.userId, p_actor_id: actor })
  assert.equal((await assign()).requires_override, true)

  const gulf = await full.insert(h.db, "divisions", { org_id: h.orgId, name: "Gulf Coast" })
  const treasure = await full.insert(h.db, "divisions", { org_id: h.orgId, name: "Treasure Coast" })
  await h.db.query("update projects set division_id = $1 where id = $2", [treasure.id, h.home.id])
  await h.db.query("update superintendent_capacity set max_houses = 9, warn_houses = 5")
  const limited = await full.seedMember(h.db, { orgId: h.orgId, role: "org_starts_coordinator" })
  await h.db.query("update memberships set division_scope = 'assigned' where user_id = $1", [limited.userId])
  await h.db.query("insert into membership_divisions (membership_id, division_id) select id, $2 from memberships where user_id = $1", [limited.userId, gulf.id])
  await assert.rejects(assign(limited.userId), /outside your division access/)
  await h.db.query("update projects set division_id = $1 where id = $2", [gulf.id, h.home.id])
  assert.equal((await assign(limited.userId)).assigned, true)
})

test("a release in attention still holds its slot, and the release refuses an attested file that has left the home", async (t) => {
  const h = await desk(t)
  const parked = await readyHome(h, { community: h.community, number: 31 })
  await h.db.query("update start_packages set status = 'attention', target_week = '2026-11-02' where id = $1", [parked.pkg.id])
  const blocked = await h.queue({ p_slot_target: 1 })
  assert.equal(blocked.queued, false)
  assert.deepEqual(blocked.exceeded, [{ limit: "community", target: 1, already_targeted: 1 }])

  const definition = await full.insert(h.db, "start_gate_definitions", { org_id: h.orgId, key: "soil_report", label: "Soil report", check_kind: "manual", applies_when: "always", sort_order: 10 })
  const file = await full.insert(h.db, "files", { org_id: h.orgId, project_id: h.home.id, file_name: "soil.pdf", storage_path: "t/soil.pdf" })
  await full.insert(h.db, "start_package_gates", { org_id: h.orgId, start_package_id: h.pkg.id, gate_definition_id: definition.id, status: "passed", passed_via: "attested", evidence_file_id: file.id })
  await h.db.query("update files set archived_at = now() where id = $1", [file.id])
  await assert.rejects(h.queue({ p_slot_target: 9 }), /evidence file is no longer on the home/)
  await h.db.query("update files set archived_at = null where id = $1", [file.id])
  assert.equal((await h.queue({ p_slot_target: 9 })).queued, true)
})

test("flipping a package to financed reopens its financing gate and drops it out of ready, in either order against the queue", async (t) => {
  const definitionOf = (h) => full.insert(h.db, "start_gate_definitions", { org_id: h.orgId, key: "financing", label: "Financing", check_kind: "auto", auto_source: "agreement_milestones_clear", applies_when: "always", sort_order: 80 })
  const update = (h, actorId = h.actorId) => full.rpc(h.db, "update_start_package", { p_org_id: h.orgId, p_package_id: h.pkg.id, p_actor_id: actorId, p_patch: { is_financed: true }, p_purchasing_enabled: false })

  // The edit first: the gate reopens, the package leaves ready, and the queue refuses it.
  const edited = await desk(t, { status: "ready" })
  const gate = await full.insert(edited.db, "start_package_gates", { org_id: edited.orgId, start_package_id: edited.pkg.id, gate_definition_id: (await definitionOf(edited)).id, status: "passed", passed_via: "auto" })
  await edited.db.query("update start_packages set is_financed = true where id = $1", [edited.pkg.id])
  assert.equal((await edited.row("select status from start_package_gates where id = $1", [gate.id])).status, "pending")
  assert.equal((await edited.row("select status from start_packages where id = $1")).status, "open")
  await assert.rejects(edited.queue(), /not ready to release/)

  // The queue first: the package is releasing, so the edit is refused and nothing changes.
  const queued = await desk(t, { status: "ready" })
  await full.insert(queued.db, "start_package_gates", { org_id: queued.orgId, start_package_id: queued.pkg.id, gate_definition_id: (await definitionOf(queued)).id, status: "passed", passed_via: "auto" })
  assert.equal((await queued.queue()).queued, true)
  await assert.rejects(update(queued), /Only open or ready packages can be edited/)
  assert.equal((await queued.row("select is_financed from start_packages where id = $1")).is_financed, false)
})

async function gateDefinition(h, key, appliesWhen = "always") {
  return full.insert(h.db, "start_gate_definitions", { org_id: h.orgId, key, label: key, check_kind: "manual", applies_when: appliesWhen, sort_order: 10 })
}
const giveGate = (h, definition, status, extra = {}) =>
  full.insert(h.db, "start_package_gates", { org_id: h.orgId, start_package_id: h.pkg.id, gate_definition_id: definition.id, status, ...extra })

test("a package cannot enter releasing, in any function, while a gate it answers for is incomplete", async (t) => {
  const h = await desk(t)
  const soil = await gateDefinition(h, "soil_report")
  const gate = await giveGate(h, soil, "pending")
  await assert.rejects(h.queue(), /Release completion is not proven for the soil_report gate/)
  await assert.rejects(h.db.query("update start_packages set status = 'releasing' where id = $1", [h.pkg.id]), /not proven for the soil_report gate/)
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "ready")

  await h.db.query("update start_package_gates set status = 'not_applicable' where id = $1", [gate.id])
  await assert.rejects(h.queue(), /not proven for the soil_report gate/, "an always-gate is never not applicable")
  await h.db.query("update start_package_gates set status = 'waived', waived_reason = 'The surveyor signed off on site' where id = $1", [gate.id])
  assert.equal((await h.queue()).queued, true)
})

test("a gate that does not apply to the package does not hold it, and a definition with no gate row does", async (t) => {
  const h = await desk(t)
  const loan = await gateDefinition(h, "loan_docs", "financed_only")
  await giveGate(h, loan, "pending")
  const cash = await h.queue()
  assert.equal(cash.queued, true, "a pending financing gate does not hold a cash buyer")
  await h.cancel()
  await h.db.query("update start_packages set is_financed = true where id = $1", [h.pkg.id])
  await assert.rejects(h.queue(), /not proven for the loan_docs gate/, "the same gate holds a financed buyer")
  await h.db.query("update start_package_gates set status = 'passed' where start_package_id = $1", [h.pkg.id])
  await gateDefinition(h, "survey")
  await assert.rejects(h.queue(), /not proven for the survey gate/, "an active gate the package has no row for")
})

test("publication refuses a gate the release produced but did not prove, and the queue does not ask for it", async (t) => {
  const h = await desk(t)
  const budget = await gateDefinition(h, "budget")
  const gate = await giveGate(h, budget, "pending")
  assert.equal((await h.queue()).queued, true, "the release itself produces the budget gate")
  const job = await h.claim()
  await h.db.query("update start_release_steps set status = 'completed', completed_at = now() where start_package_id = $1", [h.pkg.id])
  const publish = () => full.rpc(h.db, "publish_start_release", { p_org_id: h.orgId, p_job_id: job.job_id, p_token: job.claim_token, p_event_id: full.uuid() })
  await assert.rejects(publish(), /Release completion is not proven for the budget gate/)
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "releasing")
  await h.db.query("update start_package_gates set status = 'passed' where id = $1", [gate.id])
  assert.equal((await publish()).actual_start_date, "2026-11-02")
})

test("release keys written before rows carried a plan version are stamped with the lot's pinned version", async (t) => {
  const h = await desk(t)
  const plan = await full.insert(h.db, "house_plans", { org_id: h.orgId, code: "MG1", name: "Mangrove" })
  const version = await full.insert(h.db, "house_plan_versions", { org_id: h.orgId, house_plan_id: plan.id, version_number: 1, status: "released", released_at: new Date(), released_by: h.actorId, bundle_snapshot: {} })
  await h.db.query("update lots set house_plan_id = $1, house_plan_version_id = $2 where id = $3", [plan.id, version.id, h.lot.id])
  const budget = await full.insert(h.db, "budgets", { org_id: h.orgId, project_id: h.home.id, version: 1, status: "approved", total_cents: 0, metadata: { release_key: "budget" } })
  const item = await full.insert(h.db, "schedule_items", { org_id: h.orgId, project_id: h.home.id, name: "Excavate", metadata: { release_key: "schedule:0" } })
  const ordinary = await full.insert(h.db, "schedule_items", { org_id: h.orgId, project_id: h.home.id, name: "Ordinary" })
  const stamped = await full.insert(h.db, "schedule_items", { org_id: h.orgId, project_id: h.home.id, name: "Stamped", metadata: { release_key: "schedule:1", release_version: full.uuid() } })

  const result = await full.rpc(h.db, "stamp_release_versions", { p_org_id: h.orgId })
  assert.deepEqual(result, { budgets: 1, schedule_items: 1, inspections: 0 })
  const version_of = async (table, id) => (await h.db.query(`select metadata->>'release_version' as v from ${table} where id = $1`, [id])).rows[0].v
  assert.equal(await version_of("budgets", budget.id), version.id)
  assert.equal(await version_of("schedule_items", item.id), version.id)
  assert.equal(await version_of("schedule_items", ordinary.id), null, "an ordinary row is not keyed, so it is not stamped")
  assert.notEqual(await version_of("schedule_items", stamped.id), version.id, "a row that already names a version keeps it")
  assert.deepEqual(await full.rpc(h.db, "stamp_release_versions", { p_org_id: h.orgId }), { budgets: 0, schedule_items: 0, inspections: 0 }, "stamping again changes nothing")
  await assert.rejects(full.rpc(h.db, "stamp_release_versions", {}, { role: "authenticated", userId: h.actorId }), /permission denied/)
})

test("a gate defined after a release was queued does not strand it: the release is judged by the gate rows it has", async (t) => {
  const h = await desk(t)
  const budget = await gateDefinition(h, "budget")
  const produced = await giveGate(h, budget, "pending")
  assert.equal((await h.queue()).queued, true)
  const job = await h.claim()
  await gateDefinition(h, "late_survey")
  await h.db.query("update start_release_steps set status = 'completed', completed_at = now() where start_package_id = $1", [h.pkg.id])
  await h.db.query("update start_package_gates set status = 'passed' where id = $1", [produced.id])
  const publish = () => full.rpc(h.db, "publish_start_release", { p_org_id: h.orgId, p_job_id: job.job_id, p_token: job.claim_token, p_event_id: full.uuid() })
  assert.equal((await publish()).actual_start_date, "2026-11-02", "the new definition has no row on this package, so it does not hold the publication")
})

test("a retry from attention is judged by the rows the package has, while a fresh queue still needs a row for every active gate", async (t) => {
  const h = await desk(t)
  await h.queue()
  await h.claim()
  await h.db.query("update start_packages set status = 'attention' where id = $1", [h.pkg.id])
  await h.db.query("update outbox set status = 'failed' where payload->>'start_package_id' = $1", [h.pkg.id])
  await gateDefinition(h, "late_survey")
  await full.rpc(h.db, "retry_start_release", { p_org_id: h.orgId, p_package_id: h.pkg.id, p_actor_id: h.actorId })
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "releasing")
  await h.cancel()
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "ready")
  await assert.rejects(h.queue(), /not proven for the late_survey gate/, "once cancelled, queueing again needs the row")
})

test("a release in flight before the gate rules finishes on the gate states it was queued with, and a re-queue is judged afresh", async (t) => {
  const h = await desk(t)
  const financing = await gateDefinition(h, "financing")
  const gate = await giveGate(h, financing, "not_applicable")
  await h.db.exec("alter table start_packages disable trigger start_packages_gate_completion_guard")
  await h.db.query("update start_packages set status = 'releasing', scheduled_start_date = '2026-11-02', metadata = metadata || '{\"gate_rules_legacy\":true}' where id = $1", [h.pkg.id])
  await h.db.exec("alter table start_packages enable trigger start_packages_gate_completion_guard")
  await h.db.query("insert into outbox (org_id, job_type, payload, status) values ($1, 'start_release', $2, 'pending')", [h.orgId, { start_package_id: h.pkg.id, actor_id: h.actorId }])
  await h.db.query("insert into start_release_steps (org_id, start_package_id, step_key, status, completed_at) select $1, $2, step, 'completed', now() from unnest(array['project','budget','schedule','checklists','drawings','pos','notify_trades','finalize']) step", [h.orgId, h.pkg.id])
  const job = await h.claim()
  assert.ok(job)
  const publish = () => full.rpc(h.db, "publish_start_release", { p_org_id: h.orgId, p_job_id: job.job_id, p_token: job.claim_token, p_event_id: full.uuid() })
  assert.equal((await publish()).actual_start_date !== undefined, true, "a cash buyer's not-applicable financing gate, written before the proof rule, does not hold the release")
  assert.equal((await h.row("select metadata ? 'gate_rules_legacy' as legacy from start_packages where id = $1")).legacy, false, "the marker is dropped once released")
})

test("the in-flight allowance ends when the release is cancelled", async (t) => {
  const h = await desk(t)
  const financing = await gateDefinition(h, "financing")
  await giveGate(h, financing, "not_applicable")
  await h.db.exec("alter table start_packages disable trigger start_packages_gate_completion_guard")
  await h.db.query("update start_packages set status = 'releasing', metadata = metadata || '{\"gate_rules_legacy\":true}' where id = $1", [h.pkg.id])
  await h.db.exec("alter table start_packages enable trigger start_packages_gate_completion_guard")
  await h.db.query("insert into outbox (org_id, job_type, payload, status) values ($1, 'start_release', $2, 'pending')", [h.orgId, { start_package_id: h.pkg.id, actor_id: h.actorId }])
  await h.cancel()
  assert.equal((await h.row("select metadata ? 'gate_rules_legacy' as legacy from start_packages where id = $1")).legacy, false)
  await assert.rejects(h.queue(), /not proven for the financing gate/, "today's rule: not applicable on an always gate never counts")
})

test("the legacy marker is dropped on a queue from ready, and a carried marker earns nothing", async (t) => {
  const h = await desk(t)
  const financing = await gateDefinition(h, "financing")
  await giveGate(h, financing, "not_applicable")
  // A privileged writer puts the marker on a ready package: it grants nothing, and the queue refuses today's rule.
  await h.db.query("update start_packages set metadata = metadata || '{\"gate_rules_legacy\":true}' where id = $1", [h.pkg.id])
  await assert.rejects(h.queue(), /not proven for the financing gate/)
  await h.db.query("update start_package_gates set status = 'passed' where start_package_id = $1", [h.pkg.id])
  assert.equal((await h.queue()).queued, true)
  assert.equal((await h.row("select metadata ? 'gate_rules_legacy' as legacy from start_packages where id = $1")).legacy, false, "the queue from ready strips it")
})

test("a waived gate always carries its reason, so no legacy rule is needed for one", async (t) => {
  const h = await desk(t)
  const soil = await gateDefinition(h, "soil_report")
  await assert.rejects(giveGate(h, soil, "waived"), /start_package_gate_waiver_reason/)
})
