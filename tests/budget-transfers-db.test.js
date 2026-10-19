"use strict"

/**
 * The database contract behind `lib/services/budget-transfers.ts`: approving
 * (`post_budget_transfer`) and rejecting/voiding (`close_budget_transfer`) a
 * zero-sum budget transfer. Both functions are SECURITY INVOKER and callable by
 * `authenticated`, so they must bind the actor to the caller and check
 * `budget.approve` themselves.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember, uuid } = require("./support/pglite")

/**
 * An org with an approver, a requester and a pending transfer moving $500
 * between two lines. Pass `db` to add another org to an existing database.
 */
async function pendingTransfer(t, { lines = [-50000, 50000], db } = {}) {
  db ??= await createDatabase(t)
  const approver = await seedMember(db, { role: "pm" })
  const requester = await seedMember(db, { orgId: approver.orgId, role: "pm" })
  const viewer = await seedMember(db, { orgId: approver.orgId, role: "org_viewer" })
  const orgId = approver.orgId
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const budget = await insert(db, "budgets", { org_id: orgId, project_id: project.id })
  const transfer = await insert(db, "budget_transfers", {
    org_id: orgId,
    project_id: project.id,
    transfer_number: 1,
    reason: "Move framing savings to roofing",
    status: "pending_approval",
    requested_by: requester.userId,
  })
  for (const amount of lines) {
    const line = await insert(db, "budget_lines", { org_id: orgId, budget_id: budget.id, description: "Line" })
    await insert(db, "budget_transfer_lines", {
      org_id: orgId,
      transfer_id: transfer.id,
      budget_line_id: line.id,
      amount_cents: amount,
    })
  }
  return { db, orgId, approver, requester, viewer, transfer }
}

/** Call a transfer function as a signed-in user, the way the app's client does. */
function asUser(db, userId, name, args) {
  return rpc(db, name, args, { role: "authenticated", userId })
}

async function transferRow(db, id) {
  return (await db.query("select * from budget_transfers where id = $1", [id])).rows[0]
}

test("an approver posts a balanced transfer as one zero-total budget revision", async (t) => {
  const { db, approver, transfer } = await pendingTransfer(t)

  const revisionId = await asUser(db, approver.userId, "post_budget_transfer", {
    p_transfer_id: transfer.id,
    p_actor_id: approver.userId,
  })

  const stored = await transferRow(db, transfer.id)
  assert.equal(stored.status, "approved")
  assert.equal(stored.approved_by, approver.userId)
  assert.equal(stored.budget_revision_id, revisionId)
  const { rows } = await db.query(
    `select r.status, r.total_cents, sum(l.amount_cents)::int as net, count(l.*)::int as lines
     from budget_revisions r join budget_revision_lines l on l.budget_revision_id = r.id
     where r.id = $1 group by r.id`,
    [revisionId],
  )
  assert.deepEqual(rows, [{ status: "posted", total_cents: 0, net: 0, lines: 2 }])
})

test("posting refuses an impersonated actor, a missing permission, self-approval and unbalanced lines", async (t) => {
  const cases = [
    { name: "acting for someone else", caller: "approver", actor: "requester", error: /Actor identity mismatch/ },
    { name: "without budget.approve", caller: "viewer", actor: "viewer", error: /Insufficient permission/ },
    { name: "approving your own request", caller: "requester", actor: "requester", error: /cannot approve their own/ },
    { name: "lines that do not net to zero", caller: "approver", actor: "approver", lines: [-50000, 40000], error: /net to zero/ },
  ]
  const db = await createDatabase(t)
  for (const { name, caller, actor, lines, error } of cases) {
    const home = await pendingTransfer(t, { lines, db })
    await assert.rejects(
      asUser(home.db, home[caller].userId, "post_budget_transfer", {
        p_transfer_id: home.transfer.id,
        p_actor_id: home[actor].userId,
      }),
      error,
      name,
    )
    assert.equal((await transferRow(home.db, home.transfer.id)).status, "pending_approval", name)
    const { rows } = await db.query("select count(*)::int as n from budget_revisions where org_id = $1", [home.orgId])
    assert.equal(rows[0].n, 0, name)
  }
})

test("voiding an approved transfer voids its posted revision and records who and why", async (t) => {
  const { db, approver, transfer } = await pendingTransfer(t)
  const revisionId = await asUser(db, approver.userId, "post_budget_transfer", {
    p_transfer_id: transfer.id,
    p_actor_id: approver.userId,
  })

  await asUser(db, approver.userId, "close_budget_transfer", {
    p_transfer_id: transfer.id,
    p_actor_id: approver.userId,
    p_status: "void",
    p_reason: "Entered on the wrong job",
  })

  const stored = await transferRow(db, transfer.id)
  assert.equal(stored.status, "void")
  assert.equal(stored.metadata.void_reason, "Entered on the wrong job")
  assert.equal(stored.metadata.void_by, approver.userId)
  const { rows } = await db.query("select status from budget_revisions where id = $1", [revisionId])
  assert.equal(rows[0].status, "voided")
})

test("closing refuses an impersonated actor, a missing permission and a missing reason", async (t) => {
  const cases = [
    { name: "acting for someone else", caller: "approver", actor: "requester", error: /Actor identity mismatch/ },
    { name: "without budget.approve", caller: "viewer", actor: "viewer", error: /Insufficient permission/ },
    { name: "no reason", caller: "approver", actor: "approver", reason: " ", error: /reason is required/ },
  ]
  const db = await createDatabase(t)
  for (const { name, caller, actor, reason = "Duplicate request", error } of cases) {
    const home = await pendingTransfer(t, { db })
    await assert.rejects(
      asUser(home.db, home[caller].userId, "close_budget_transfer", {
        p_transfer_id: home.transfer.id,
        p_actor_id: home[actor].userId,
        p_status: "rejected",
        p_reason: reason,
      }),
      error,
      name,
    )
    assert.equal((await transferRow(home.db, home.transfer.id)).status, "pending_approval", name)
  }
})

test("anonymous callers cannot execute either transfer function", async (t) => {
  const { db, transfer } = await pendingTransfer(t)
  const anon = { role: "anon" }
  await assert.rejects(
    rpc(db, "post_budget_transfer", { p_transfer_id: transfer.id, p_actor_id: uuid() }, anon),
    /permission denied/,
  )
  await assert.rejects(
    rpc(
      db,
      "close_budget_transfer",
      { p_transfer_id: transfer.id, p_actor_id: uuid(), p_status: "rejected", p_reason: "Nope" },
      anon,
    ),
    /permission denied/,
  )
})

test("a member of another org cannot see the transfer to post it", async (t) => {
  const { db, transfer } = await pendingTransfer(t)
  const stranger = await seedMember(db, { role: "pm" })
  await assert.rejects(
    asRole(db, { role: "authenticated", userId: stranger.userId }, (tx) =>
      tx.query("select public.post_budget_transfer($1, $2)", [transfer.id, stranger.userId]),
    ),
    /not found/,
  )
})
