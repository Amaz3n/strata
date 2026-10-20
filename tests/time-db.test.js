"use strict"

/**
 * The database contract behind crew time and payroll: who may write rates, periods,
 * clock rows and approvals, what a locked entry survives, and how a period closes.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, asRole, rpc, insert, seedMember, uuid } = require("./support/pglite")

async function world(t) {
  const db = await createDatabase(t)
  const owner = await seedMember(db, { role: "org_owner" })
  const crew = await seedMember(db, { orgId: owner.orgId, role: "org_crew_member" })
  const mate = await seedMember(db, { orgId: owner.orgId, role: "org_crew_member" })
  const foreman = await seedMember(db, { orgId: owner.orgId, role: "org_foreman" })
  const project = await insert(db, "projects", { org_id: owner.orgId, name: "Palm Court" })
  const costCode = await insert(db, "cost_codes", { org_id: owner.orgId, code: "01", name: "Labor" })
  return { db, orgId: owner.orgId, owner, crew, mate, foreman, project, costCode }
}

const entry = (w, overrides = {}) =>
  insert(w.db, "time_entries", {
    org_id: w.orgId, project_id: w.project.id, worker_user_id: w.crew.userId, worker_name: "Casey",
    work_date: "2026-10-05", hours: 8, base_rate_cents: 3400, burden_multiplier: 1.25, status: "submitted",
    cost_code_id: w.costCode.id, ...overrides,
  })
const as = (w, who, fn) => asRole(w.db, { role: "authenticated", userId: who.userId }, fn)
const close = (w, args = {}) =>
  rpc(w.db, "close_pay_period", {
    p_org_id: w.orgId, p_closed_by: w.owner.userId, p_starts_on: "2026-10-04", p_ends_on: "2026-10-10",
    p_summary: {}, p_import_id: null, ...args,
  })

test("a crew member cannot write rates, periods or clock rows, or read coworkers' rates", async (t) => {
  const w = await world(t)
  await insert(w.db, "labor_rates", { org_id: w.orgId, user_id: w.crew.userId, effective_on: "2026-01-01", cost_rate_cents: 3400 })
  await insert(w.db, "labor_rates", { org_id: w.orgId, user_id: w.mate.userId, effective_on: "2026-01-01", cost_rate_cents: 3200 })

  const seen = await as(w, w.crew, (tx) => tx.query("select user_id from labor_rates"))
  assert.deepEqual(seen.rows.map((row) => row.user_id), [w.crew.userId])
  assert.equal((await as(w, w.owner, (tx) => tx.query("select 1 from labor_rates"))).rows.length, 2)

  await assert.rejects(as(w, w.crew, (tx) => tx.query("update labor_rates set cost_rate_cents = 99999 where user_id = $1", [w.crew.userId])), /permission denied/)
  await assert.rejects(as(w, w.crew, (tx) => tx.query("insert into pay_periods (org_id, starts_on, ends_on) values ($1, '2026-10-04', '2026-10-10')", [w.orgId])), /permission denied/)
  await assert.rejects(as(w, w.crew, (tx) => tx.query(
    "insert into time_clock_sessions (org_id, project_id, worker_user_id, work_date, started_at) values ($1, $2, $3, '2026-10-05', now())",
    [w.orgId, w.project.id, w.mate.userId])), /permission denied/)

  await insert(w.db, "time_clock_sessions", { org_id: w.orgId, project_id: w.project.id, worker_user_id: w.mate.userId, work_date: "2026-10-05", started_at: "2026-10-05T12:00:00Z" })
  assert.equal((await as(w, w.crew, (tx) => tx.query("select 1 from time_clock_sessions"))).rows.length, 0)
  assert.equal((await as(w, w.foreman, (tx) => tx.query("select 1 from time_clock_sessions"))).rows.length, 1)
})

test("a crew member cannot approve or reprice time, or touch a coworker's", async (t) => {
  const w = await world(t)
  const mine = await entry(w)
  const theirs = await entry(w, { worker_user_id: w.mate.userId, work_date: "2026-10-06" })

  const approve = (tx, id, set) => tx.query(`update time_entries set ${set} where id = $1`, [id])
  await assert.rejects(as(w, w.crew, (tx) => approve(tx, mine.id, "status = 'pm_approved'")), /whoever approves time/)
  await assert.rejects(as(w, w.crew, (tx) => approve(tx, mine.id, "base_rate_cents = 99900")), /whoever approves time/)
  await assert.rejects(as(w, w.crew, (tx) => approve(tx, mine.id, "is_overtime = true")), /whoever approves time/)
  await assert.rejects(as(w, w.crew, (tx) => approve(tx, theirs.id, "hours = 1")), /only change your own time/)
  await assert.rejects(as(w, w.crew, (tx) => tx.query(
    "insert into time_entries (org_id, project_id, worker_user_id, worker_name, work_date, hours, base_rate_cents, status) values ($1, $2, $3, 'x', '2026-10-07', 8, 100, 'pm_approved')",
    [w.orgId, w.project.id, w.crew.userId])), /whoever approves time/)

  await as(w, w.crew, (tx) => approve(tx, mine.id, "hours = 7.5, notes = 'fixed'"))
  await as(w, w.foreman, (tx) => approve(tx, mine.id, "status = 'pm_approved', approved_by_pm_at = now()"))
  const row = (await w.db.query("select status, hours from time_entries where id = $1", [mine.id])).rows[0]
  assert.deepEqual({ status: row.status, hours: Number(row.hours) }, { status: "pm_approved", hours: 7.5 })
})

test("a locked entry survives the deletion of its cost code and its project, but not edits", async (t) => {
  const w = await world(t)
  const locked = await entry(w, { status: "pm_approved" })
  await close(w)
  assert.equal((await w.db.query("select status from time_entries where id = $1", [locked.id])).rows[0].status, "locked")

  await assert.rejects(w.db.query("update time_entries set hours = 1 where id = $1", [locked.id]), /cannot change/)
  await assert.rejects(w.db.query("update time_entries set cost_code_id = $2 where id = $1", [locked.id, (await insert(w.db, "cost_codes", { org_id: w.orgId, code: "02", name: "Other" })).id]), /cannot change/)
  await assert.rejects(w.db.query("delete from time_entries where id = $1", [locked.id]), /cannot be deleted/)
  await w.db.query("update time_entries set metadata = '{\"memo\": 1}'::jsonb where id = $1", [locked.id])

  await w.db.query("delete from cost_codes where id = $1", [w.costCode.id])
  assert.equal((await w.db.query("select cost_code_id from time_entries where id = $1", [locked.id])).rows[0].cost_code_id, null)
  await w.db.query("delete from projects where id = $1", [w.project.id])
  assert.equal((await w.db.query("select 1 from time_entries where id = $1", [locked.id])).rows.length, 0)
})

test("a correction reverses a locked entry without writing the generated cost", async (t) => {
  const w = await world(t)
  const original = await entry(w, { status: "pm_approved" })
  await close(w)
  const reversal = await insert(w.db, "time_entries", {
    org_id: w.orgId, project_id: w.project.id, worker_user_id: w.crew.userId, worker_name: "Casey",
    work_date: "2026-10-12", hours: -8, base_rate_cents: 3400, burden_multiplier: 1.25, status: "pm_approved",
    reverses_time_entry_id: original.id,
  })
  assert.equal(reversal.cost_cents, -original.cost_cents)
  await assert.rejects(insert(w.db, "time_entries", { ...reversal, id: uuid(), cost_cents: -1, reverses_time_entry_id: null }), /cost_cents/)
})

test("closing a period is atomic and refuses unfinished work, open clocks and overlap", async (t) => {
  const w = await world(t)
  const waiting = await entry(w)
  await assert.rejects(close(w), /1 entry is still waiting/)

  await w.db.query("update time_entries set status = 'pm_approved' where id = $1", [waiting.id])
  const clock = await insert(w.db, "time_clock_sessions", { org_id: w.orgId, project_id: w.project.id, worker_user_id: w.crew.userId, work_date: "2026-10-06", started_at: "2026-10-06T12:00:00Z" })
  await assert.rejects(close(w), /Still clocked in/)
  assert.equal((await w.db.query("select count(*)::int as n from pay_periods")).rows[0].n, 0)

  await w.db.query("update time_clock_sessions set ended_at = started_at + interval '1 hour' where id = $1", [clock.id])
  const result = await close(w)
  assert.equal(result.locked, 1)
  await assert.rejects(close(w), /already closed/)
  await assert.rejects(close(w, { p_starts_on: "2026-10-08", p_ends_on: "2026-10-14" }), /overlaps/)
  await assert.rejects(
    rpc(w.db, "close_pay_period", { p_org_id: w.orgId, p_closed_by: w.owner.userId, p_starts_on: "2026-10-18", p_ends_on: "2026-10-24", p_summary: {}, p_import_id: null }, { role: "authenticated", userId: w.owner.userId }),
    /permission denied/,
  )
})
