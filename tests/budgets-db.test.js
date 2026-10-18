"use strict"

/**
 * The database contract behind the budget baseline: once locked, the original
 * lines and lock time can never change, whoever writes to the row.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, seedMember } = require("./support/pglite")

async function lockedBudget(t) {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const budget = await insert(db, "budgets", { org_id: orgId, project_id: project.id })
  return { db, orgId, userId, project, budget }
}

const lock = (db, budgetId, lines) =>
  db.query("update budgets set baseline_lines = $2::jsonb, baseline_locked_at = now() where id = $1", [budgetId, JSON.stringify(lines)])

test("a budget with no baseline can be locked once", async (t) => {
  const { db, budget } = await lockedBudget(t)
  await lock(db, budget.id, [{ amount_cents: 500_000 }])
  const row = (await db.query("select baseline_lines, baseline_locked_at from budgets where id = $1", [budget.id])).rows[0]
  assert.deepEqual(row.baseline_lines, [{ amount_cents: 500_000 }])
  assert.notEqual(row.baseline_locked_at, null)
})

test("a locked baseline cannot be rewritten, cleared or re-dated", async (t) => {
  const { db, budget } = await lockedBudget(t)
  await lock(db, budget.id, [{ amount_cents: 500_000 }])
  await assert.rejects(lock(db, budget.id, [{ amount_cents: 650_000 }]), /locked budget baseline cannot be changed/)
  await assert.rejects(db.query("update budgets set baseline_lines = null where id = $1", [budget.id]), /cannot be changed/)
  await assert.rejects(db.query("update budgets set baseline_locked_at = null where id = $1", [budget.id]), /cannot be changed/)
  const row = (await db.query("select baseline_lines from budgets where id = $1", [budget.id])).rows[0]
  assert.deepEqual(row.baseline_lines, [{ amount_cents: 500_000 }])
})

test("the living budget stays editable after its baseline is locked", async (t) => {
  const { db, budget } = await lockedBudget(t)
  await lock(db, budget.id, [{ amount_cents: 500_000 }])
  await db.query("update budgets set total_cents = 650000, status = 'approved' where id = $1", [budget.id])
  assert.equal((await db.query("select total_cents from budgets where id = $1", [budget.id])).rows[0].total_cents, 650000)
})

test("a revised budget version starts without a baseline and can set its own", async (t) => {
  const { db, orgId, project, budget } = await lockedBudget(t)
  await lock(db, budget.id, [{ amount_cents: 500_000 }])
  const revision = await insert(db, "budgets", { org_id: orgId, project_id: project.id, version: 2 })
  assert.equal(revision.baseline_locked_at, null)
  await lock(db, revision.id, [{ amount_cents: 650_000 }])
})

test("deleting the user who locked a baseline does not count as rewriting it", async (t) => {
  const { db, budget } = await lockedBudget(t)
  const locker = (await db.query("select id from auth.users limit 1")).rows[0].id
  await db.query("update budgets set baseline_lines = '[]'::jsonb, baseline_locked_at = now(), baseline_locked_by = $2 where id = $1", [budget.id, locker])
  await db.query("update budgets set baseline_locked_by = null where id = $1", [budget.id])
})
