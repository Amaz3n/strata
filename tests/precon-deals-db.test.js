"use strict"

/**
 * Direct Data API writes to deals (`prospects`, `prospect_contacts`) get the
 * same boundary the server applies: a deal linked to a project needs
 * project.manage on that project — resolved even when project RLS hides it —
 * an explicit deny wins, a lost deal only takes a clean reopen, and a deal in
 * delivery is history. Server-side lifecycle writes run as service_role.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, seedMember, asRole } = require("./support/pglite")

/**
 * A project lead limited to assigned projects who also works the pipeline
 * (granted pipeline.write), an unlinked inquiry, and a deal linked to a precon
 * project the lead is NOT assigned to (so RLS hides it).
 */
async function pipeline(t) {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db, { role: "org_project_lead" })
  await db.query("update memberships set project_scope = 'assigned' where user_id = $1", [userId])
  const { rows: [membership] } = await db.query("select id from memberships where user_id = $1", [userId])
  await insert(db, "membership_permission_overrides", { membership_id: membership.id, permission_key: "pipeline.write", effect: "grant" })
  const unlinked = await insert(db, "prospects", { org_id: orgId, name: "Unlinked", status: "new" })
  const linked = await insert(db, "prospects", { org_id: orgId, name: "Linked", status: "pricing" })
  const project = await insert(db, "projects", { org_id: orgId, name: "Linked", prospect_id: linked.id, phase: "precon" })
  const contact = await insert(db, "prospect_contacts", {
    org_id: orgId,
    prospect_id: linked.id,
    full_name: "Owner",
    email: "owner@example.test",
  })

  /** Run `sql` as the lead; resolves to the rows it affected (RLS filters silently). */
  const asLead = (sql, params = []) =>
    asRole(db, { role: "authenticated", userId }, async (tx) => (await tx.query(sql, params)).rows)
  const assign = async () => {
    const { rows } = await db.query("select id from roles where key = 'org_project_lead'")
    await insert(db, "project_members", {
      org_id: orgId,
      project_id: project.id,
      user_id: userId,
      role_id: rows[0].id,
      status: "active",
    })
  }
  const deny = async (permission) => {
    const { rows } = await db.query("select id from memberships where user_id = $1", [userId])
    await insert(db, "membership_permission_overrides", { membership_id: rows[0].id, permission_key: permission, effect: "deny" })
  }
  const revokePipeline = () => db.query(
    "delete from membership_permission_overrides where membership_id = $1 and permission_key = 'pipeline.write'",
    [membership.id],
  )
  return { db, orgId, userId, unlinked, linked, project, contact, asLead, assign, deny, revokePipeline }
}

const editNotes = "update prospects set notes = $2 where id = $1 returning id"

test("an unlinked inquiry is editable, but a hidden linked project does not make a deal look unlinked", async (t) => {
  const { unlinked, linked, contact, asLead } = await pipeline(t)
  assert.equal((await asLead(editNotes, [unlinked.id, "Allowed"])).length, 1)
  assert.deepEqual(await asLead(editNotes, [linked.id, "Denied"]), [])
  assert.deepEqual(
    await asLead("update prospect_contacts set email = 'changed@example.test' where id = $1 returning id", [contact.id]),
    [],
  )
})

test("an unlinked inquiry is the desks' record: without a desk write key it cannot be edited or deleted", async (t) => {
  const { db, unlinked, asLead, revokePipeline } = await pipeline(t)
  await revokePipeline()
  assert.deepEqual(await asLead(editNotes, [unlinked.id, "Denied"]), [])
  await asLead("delete from prospects where id = $1", [unlinked.id])
  assert.equal((await db.query("select id from prospects where id = $1", [unlinked.id])).rows.length, 1)
})

test("an assigned project lead can edit the deal; an explicit deny still wins", async (t) => {
  const { linked, asLead, assign, deny } = await pipeline(t)
  await assign()
  assert.equal((await asLead(editNotes, [linked.id, "Managed"])).length, 1)

  await deny("project.manage")
  assert.deepEqual(await asLead(editNotes, [linked.id, "Denied"]), [])
})

test("deleting an inquiry takes its contacts with it", async (t) => {
  const { db, orgId, unlinked, asLead } = await pipeline(t)
  const inquirer = await insert(db, "prospect_contacts", { org_id: orgId, prospect_id: unlinked.id, full_name: "Inquirer" })
  await asLead("delete from prospects where id = $1", [unlinked.id])
  assert.deepEqual((await db.query("select id from prospect_contacts where id = $1", [inquirer.id])).rows, [])
})

test("a deal cannot change org, a contact cannot change deal, and only active members own deals", async (t) => {
  const { linked, unlinked, contact, asLead, assign } = await pipeline(t)
  await assign()
  const stranger = "00000000-0000-4000-8000-0000000000ff"
  await assert.rejects(asLead("update prospects set org_id = $2 where id = $1", [linked.id, stranger]), /identity/)
  await assert.rejects(
    asLead("update prospect_contacts set prospect_id = $2 where id = $1", [contact.id, unlinked.id]),
    /cannot be moved/,
  )
  await assert.rejects(asLead("update prospects set owner_user_id = $2 where id = $1", [linked.id, stranger]), /active team member/)
})

test("a lost deal only takes a clean reopen; once delivered, its records are history", async (t) => {
  const { db, linked, project, contact, asLead, assign } = await pipeline(t)
  await assign()
  await db.query("update prospects set status = 'lost', lost_reason = 'Timing', lost_at = now() where id = $1", [linked.id])

  await assert.rejects(asLead(editNotes, [linked.id, "Changed"]), /Reopen/)
  await assert.rejects(asLead("update prospect_contacts set email = null where id = $1", [contact.id]), /Reopen/)
  await assert.rejects(
    asLead("update prospects set status = 'contacted', lost_reason = null, notes = 'Changed' where id = $1", [linked.id]),
    /Reopen/,
  )
  await asLead("update prospects set status = 'contacted', lost_reason = null, lost_at = null where id = $1", [linked.id])

  await db.query("update projects set phase = 'delivery' where id = $1", [project.id])
  await assert.rejects(asLead(editNotes, [linked.id, "Changed"]), /closed/)
  await assert.rejects(asLead("delete from prospect_contacts where id = $1", [contact.id]), /closed/)
})

test("server lifecycle writes pass as service_role; anon cannot read deals or reach the guard", async (t) => {
  const { db, linked } = await pipeline(t)
  await asRole(db, { role: "service_role" }, (tx) => tx.query("update prospects set status = 'won', won_at = now() where id = $1", [linked.id]))
  assert.equal((await db.query("select status from prospects where id = $1", [linked.id])).rows[0].status, "won")

  await assert.rejects(asRole(db, { role: "anon" }, (tx) => tx.query("select * from prospects")), /permission denied/)
  const { rows } = await db.query(
    "select has_function_privilege('authenticated', 'arc_private.guard_deal_mutation()', 'execute') as allowed",
  )
  assert.equal(rows[0].allowed, false)
})

/**
 * A won deal whose house is under contract: the lead's reservation on a lot
 * points at its signed purchase agreement. `agreement(status)` adds another
 * reservation and agreement for the same lead.
 */
async function soldHome(t) {
  const deal = await pipeline(t)
  const { db, orgId, linked, project, assign } = deal
  await assign()
  await db.query("update projects set phase = 'delivery' where id = $1", [project.id])
  await db.query("update prospects set status = 'won', won_at = now() where id = $1", [linked.id])
  const community = await insert(db, "communities", { org_id: orgId, name: "Oak Ridge" })
  const buyer = await insert(db, "contacts", { org_id: orgId, full_name: "Buyer" })
  let lots = 0
  const agreement = async (status) => {
    const contract = await insert(db, "contracts", {
      org_id: orgId,
      project_id: project.id,
      title: "Purchase agreement",
      contract_type: "purchase_agreement",
      status,
    })
    const lot = await insert(db, "lots", { org_id: orgId, community_id: community.id, lot_number: String(++lots), status: "developed" })
    await insert(db, "lot_reservations", {
      org_id: orgId,
      community_id: community.id,
      lot_id: lot.id,
      buyer_contact_id: buyer.id,
      prospect_id: linked.id,
      contract_id: contract.id,
      status: "converted",
    })
    return contract
  }
  const signed = await agreement("active")
  const voidAgreement = (contract) => db.query("update contracts set status = 'void' where id = $1", [contract.id])
  return { ...deal, agreement, signed, voidAgreement }
}

const reopenLead = "update prospects set status = 'qualified', won_at = null, updated_at = now() where id = $1 returning status"

test("voiding the signed purchase agreement re-opens the lead", async (t) => {
  const { db, linked, signed, voidAgreement, asLead } = await soldHome(t)
  await voidAgreement(signed)
  assert.deepEqual(await asLead(reopenLead, [linked.id]), [{ status: "qualified" }])
  const { rows } = await db.query("select won_at from prospects where id = $1", [linked.id])
  assert.equal(rows[0].won_at, null)
})

test("a won lead re-opens only once its agreement is void and no other agreement stands", async (t) => {
  const { linked, signed, agreement, voidAgreement, asLead } = await soldHome(t)
  await assert.rejects(asLead(reopenLead, [linked.id]), /closed/)

  await voidAgreement(signed)
  for (const status of ["draft", "active"]) {
    const other = await agreement(status)
    await assert.rejects(asLead(reopenLead, [linked.id]), /closed/)
    await voidAgreement(other)
  }
  assert.deepEqual(await asLead(reopenLead, [linked.id]), [{ status: "qualified" }])
})

test("a won deal still refuses every other edit, even after its agreement is void", async (t) => {
  const { linked, contact, signed, voidAgreement, asLead } = await soldHome(t)
  await voidAgreement(signed)
  await assert.rejects(asLead(editNotes, [linked.id, "Changed"]), /closed/)
  await assert.rejects(asLead("update prospect_contacts set email = null where id = $1", [contact.id]), /closed/)
  await assert.rejects(asLead("update prospects set status = 'contacted', won_at = null where id = $1", [linked.id]), /closed/)
  await assert.rejects(asLead("update prospects set status = 'qualified' where id = $1", [linked.id]), /closed/)
  await assert.rejects(
    asLead("update prospects set status = 'qualified', won_at = null, notes = 'Changed' where id = $1", [linked.id]),
    /closed/,
  )
})
