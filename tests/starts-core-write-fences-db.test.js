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
  const home = await full.insert(db, "projects", { org_id: orgId, name: "Lot 7" })
  const lot = await full.insert(db, "lots", { org_id: orgId, community_id: community.id, project_id: home.id, lot_number: "7" })
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
  return h
}

test("the desk's service-role writes pass the fences that refuse the browser", async (t) => {
  const h = await desk(t, { status: "open" })
  const definition = await full.insert(h.db, "start_gate_definitions", { org_id: h.orgId, key: "permit", label: "Permit", check_kind: "manual", applies_when: "always", sort_order: 10 })
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

  assert.deepEqual(slot, { queued: false, target_week: "2026-11-02", target: 0, already_targeted: 0 })
  assert.equal((await h.row("select status from start_packages where id = $1")).status, "ready")
  assert.equal((await h.row("select count(*)::int as n from outbox where payload->>'start_package_id' = $1", [h.pkg.id])).n, 0)
  assert.equal((await h.queue({ p_slot_target: 0, p_confirm_over_slot: true })).over_slot, true)
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

test("publication releases the package and writes its audit in one transaction under the claim", async (t) => {
  const h = await desk(t)
  await h.queue()
  const job = await h.claim()
  const publish = (token = job.claim_token) => full.rpc(h.db, "publish_start_release", { p_org_id: h.orgId, p_job_id: job.job_id, p_token: token })

  await h.asWorker(job)
  await assert.rejects(publish(full.uuid()), /lease lost/)
  assert.equal((await h.audit("starts.release_published")).n, 0)

  await publish()
  await h.asWorker(null)
  const pkg = await h.row("select status, released_by, actual_start_date::text as started from start_packages where id = $1")
  assert.deepEqual(pkg, { status: "released", released_by: h.actorId, started: "2026-11-02" })
  assert.equal((await h.audit("starts.release_published")).n, 1)
  await assert.rejects(publish(), /no longer releasing/)
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
