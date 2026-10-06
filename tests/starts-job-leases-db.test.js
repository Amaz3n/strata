const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs")
const { PGlite } = require("@electric-sql/pglite")
const ORG = "00000000-0000-4000-8000-000000000001", OTHER = "00000000-0000-4000-8000-000000000002"
async function setup(t) {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec("create role anon; create role authenticated; create role service_role; create table outbox(id bigint generated always as identity primary key,org_id uuid,job_type text,payload jsonb default '{}'::jsonb,status text default 'pending',retry_count integer default 0,last_error text,run_at timestamptz default now(),updated_at timestamptz default now(),created_at timestamptz default now(),priority integer default 0);")
  await db.exec(fs.readFileSync(require.resolve("../supabase/migrations/20261003023000_starts_job_claim_leases.sql"), "utf8"))
  const insert = (type = "start_release", priority = 0) => db.query("insert into outbox(org_id,job_type,priority) values($1,$2,$3)", [ORG, type, priority])
  const claim = async (limit = 2) => (await db.query("select * from claim_starts_jobs($1)", [limit])).rows
  const transition = async (job, action, org = ORG) => (await db.query("select transition_starts_job_lease($1,$2,$3,$4,'failed') ok", [org, job.job_id, job.claim_token, action])).rows[0].ok
  return { db, insert, claim, transition }
}
test("SQL claim is bounded, ordered and isolates starts work", async t => {
  const h = await setup(t)
  await h.insert("drawing", 100); await h.insert("start_release", 1); await h.insert("start_release_trade_notice", 2); await h.insert("trade_schedule_change_notice", 0)
  const jobs = await h.claim(2)
  assert.equal(jobs.length, 2); assert.equal(jobs[0].job_type, "start_release_trade_notice")
  assert.equal(new Set(jobs.map(job => job.claim_token)).size, 2)
  assert.equal((await h.claim()).length, 1); assert.equal((await h.claim()).length, 0)
  for (const limit of [null, 0, 7]) await assert.rejects(h.claim(limit), /Invalid starts claim limit/)
})
test("expired claims cannot transition and successive claims have distinct tokens", async t => {
  const h = await setup(t); await h.insert()
  const old = (await h.claim())[0]
  await h.db.exec("update outbox set start_job_lease_expires_at=now()-interval '1 second'")
  for (const action of ["heartbeat", "complete", "retry", "defer"]) assert.equal(await h.transition(old, action), false)
  assert.equal((await h.db.query("select recover_starts_job_leases() n")).rows[0].n, 1)
  const fresh = (await h.claim())[0]; assert.notEqual(old.claim_token, fresh.claim_token)
  assert.equal(fresh.retry_count, 1)
  for (const action of ["heartbeat", "complete", "retry", "defer"]) assert.equal(await h.transition(old, action), false)
  assert.equal(await h.transition(fresh, "complete", OTHER), false)
  assert.equal(await h.transition(fresh, "heartbeat"), true)
  assert.equal(await h.transition(fresh, "complete"), true)
  assert.equal(await h.transition(fresh, "retry"), false)
})
test("deferral preserves retry budget while retries back off and dead-letter on the third failure", async t => {
  const h = await setup(t); await h.insert()
  let job = (await h.claim())[0]
  assert.equal(await h.transition(job, "defer"), true)
  assert.equal((await h.claim()).length, 0)
  assert.equal((await h.db.query("select retry_count from outbox")).rows[0].retry_count, 0)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await h.db.exec("update outbox set run_at=now()-interval '1 second'")
    job = (await h.claim())[0]
    assert.equal(await h.transition(job, "retry"), true)
    const row = (await h.db.query("select *,run_at>now() deferred from outbox")).rows[0]
    assert.equal(row.retry_count, attempt); assert.equal(row.status, attempt === 3 ? "failed" : "pending")
    assert.equal(row.start_claim_token, null)
    if (attempt < 3) assert.equal(row.deferred, true)
  }
})
test("recovery is bounded, consumes crash retry budget and leaves legacy workers alone", async t => {
  const h = await setup(t); await h.insert(); await h.insert(); await h.insert("start_release_trade_notice")
  await h.claim(3)
  await h.db.exec("update outbox set retry_count=2,start_job_lease_expires_at=now()-interval '1 second'; insert into outbox(org_id,job_type,status,updated_at) values('00000000-0000-4000-8000-000000000001','start_release','processing',now()-interval '1 day')")
  assert.equal((await h.db.query("select recover_starts_job_leases(2) n")).rows[0].n, 2)
  assert.equal((await h.db.query("select recover_starts_job_leases(2) n")).rows[0].n, 1)
  assert.equal((await h.db.query("select count(*)::int n from outbox where status='failed'")).rows[0].n, 3)
  assert.equal((await h.db.query("select count(*)::int n from outbox where status='processing'")).rows[0].n, 1)
})
test("browser roles cannot claim or change worker ownership", async t => {
  const h = await setup(t)
  for (const role of ["anon", "authenticated"]) {
    await h.db.exec(`set role ${role}`)
    await assert.rejects(h.claim(), /permission denied/)
    await assert.rejects(h.db.query("select recover_starts_job_leases()"), /permission denied/)
    await assert.rejects(h.db.query("select transition_starts_job_lease($1,1,gen_random_uuid(),'complete')", [ORG]), /permission denied/)
    await h.db.exec("reset role")
  }
})

test("browser table grants cannot be used to forge starts actors or overwrite claims", async t => {
  const h = await setup(t); await h.insert(); const job = (await h.claim())[0]
  await h.db.exec("grant select,insert,update,delete on outbox to authenticated; grant usage,select on sequence outbox_id_seq to authenticated; set role authenticated")
  await assert.rejects(h.db.query("insert into outbox(org_id,job_type,payload) values($1,'start_release','{}')", [ORG]), /authorized server actions/)
  await assert.rejects(h.db.query("update outbox set status='pending',start_claim_token=null where id=$1", [job.job_id]), /authorized server actions/)
  await assert.rejects(h.db.query("update outbox set job_type='other' where id=$1", [job.job_id]), /authorized server actions/)
  await assert.rejects(h.db.query("delete from outbox where id=$1", [job.job_id]), /authorized server actions/)
  await h.db.exec("reset role; grant select,update on outbox to service_role; set role service_role")
  assert.equal(await h.transition(job, "complete"), true)
})
