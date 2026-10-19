"use strict"

/**
 * The database contract for pricing from trade quotes: an issued scope is
 * immutable until a revision snapshots it; a revision, a withdrawal or a new
 * addendum retires the pricing decision built on the old scope; a quote is
 * selected for pricing at its normalized (complete-scope) cost; and an award
 * needs a current, acknowledged quote and a reviewed scope and terms. Every
 * function here is service-role only.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, rpc, seedMember } = require("./support/pglite")

const DECISION = {
  vendor_total_cents: 100000,
  normalized_total_cents: 120000,
  accepted_alternate_ids: [],
  gaps: [{ description: "Pumping", amount_cents: 20000, owner: "GC", disposition: "allowance" }],
  rationale: "Confirmed scope",
  snapshot: {},
}

/** An org with a delivery project and an issued concrete package with one invited trade. */
async function issuedPackage(t, { phase = "delivery" } = {}) {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12", phase })
  const company = await insert(db, "companies", { org_id: orgId, name: "Slab Co" })
  const pkg = await insert(db, "bid_packages", {
    org_id: orgId,
    project_id: project.id,
    title: "Concrete",
    scope: "Concrete scope",
    status: "draft",
  })
  const scope = await insert(db, "bid_scope_items", {
    org_id: orgId,
    bid_package_id: pkg.id,
    item_type: "base",
    description: "Concrete",
  })
  const invite = await insert(db, "bid_invites", {
    org_id: orgId,
    bid_package_id: pkg.id,
    company_id: company.id,
    status: "sent",
  })
  await db.query("update bid_packages set status = 'open' where id = $1", [pkg.id])

  const submit = async (revision) =>
    (
      await rpc(db, "create_bid_submission_version", {
        p_org_id: orgId,
        p_bid_invite_id: invite.id,
        p_payload: { total_cents: 100000, scope_revision: revision },
      })
    ).submission_id
  const select = (submissionId) =>
    rpc(db, "save_bid_pricing_decision", {
      p_org_id: orgId,
      p_submission_id: submissionId,
      p_user_id: userId,
      p_data: DECISION,
    })
  const award = (submissionId, scopeText = "Agreed slab and pumping", terms = "Net 30; 5% retainage") =>
    rpc(db, "run_reviewed_bid_award", {
      p_org_id: orgId,
      p_bid_submission_id: submissionId,
      p_awarded_by: userId,
      p_notes: null,
      p_accepted_alternate_ids: [],
      p_reviewed_scope: scopeText,
      p_reviewed_terms: terms,
    })
  const currentDecisions = async () =>
    (await db.query("select * from bid_pricing_decisions where superseded_at is null")).rows
  const reopen = () => db.query("update bid_packages set status = 'open' where id = $1", [pkg.id])
  const revise = (reason = "Revised slab") =>
    rpc(db, "begin_bid_scope_revision", { p_org_id: orgId, p_package_id: pkg.id, p_reason: reason })

  return { db, orgId, userId, project, pkg, scope, invite, submit, select, award, currentDecisions, reopen, revise }
}

test("an issued scope cannot be edited in place", async (t) => {
  const { db, pkg, scope } = await issuedPackage(t)
  await assert.rejects(db.query("update bid_scope_items set description = 'Changed' where id = $1", [scope.id]), /immutable/)
  await assert.rejects(db.query("update bid_packages set scope = 'Changed' where id = $1", [pkg.id]), /scope revision/)
})

test("selecting a quote prices it at its complete-scope cost and snapshots the scope it covered", async (t) => {
  const { submit, select, currentDecisions } = await issuedPackage(t)
  await select(await submit(1))

  const [decision] = await currentDecisions()
  assert.equal(Number(decision.vendor_total_cents), 100000)
  assert.equal(Number(decision.normalized_total_cents), 120000)
  assert.equal(decision.snapshot.scope[0].description, "Concrete")
})

test("a scope revision retires the selection and refuses quotes and forms from the old scope", async (t) => {
  const { db, scope, submit, select, currentDecisions, reopen, revise } = await issuedPackage(t)
  const old = await submit(1)
  await select(old)

  await revise()
  assert.deepEqual(await currentDecisions(), [])
  await db.query("update bid_scope_items set description = 'Revised slab' where id = $1", [scope.id])
  await assert.rejects(submit(2), /not open/, "a revised package is a draft until reissued")

  await reopen()
  await assert.rejects(submit(1), /scope changed/)
  await assert.rejects(select(old), /no longer eligible/)
  const { rows } = await db.query("select snapshot -> 'scope' -> 0 ->> 'description' as description from bid_scope_revisions")
  assert.deepEqual(rows, [{ description: "Concrete" }])
})

test("a withdrawn quote loses its pricing and cannot be awarded", async (t) => {
  const { db, submit, select, award, currentDecisions } = await issuedPackage(t)
  const quote = await submit(1)
  await select(quote)

  await db.query("update bid_submissions set status = 'withdrawn' where id = $1", [quote])
  assert.deepEqual(await currentDecisions(), [])
  await assert.rejects(award(quote), /refreshed/)
  assert.equal((await db.query("select count(*)::int as n from commitments")).rows[0].n, 0)
})

test("a new addendum needs a fresh, acknowledged quote and a reviewed scope before award", async (t) => {
  const { db, orgId, pkg, invite, submit, select, award } = await issuedPackage(t)
  const before = await submit(1)
  await select(before)

  await insert(db, "bid_addenda", { org_id: orgId, bid_package_id: pkg.id, number: 1 })
  await assert.rejects(select(before), /no longer eligible/)

  const revised = await submit(2)
  await assert.rejects(award(revised), /acknowledge/)
  const [addendum] = (await db.query("select id from bid_addenda")).rows
  await insert(db, "bid_addendum_acknowledgements", { org_id: orgId, bid_addendum_id: addendum.id, bid_invite_id: invite.id })
  await assert.rejects(award(revised, ""), /Review scope/)

  const result = await award(revised)
  const { rows } = await db.query("select scope, terms, metadata from commitments where id = $1", [result.commitment_id])
  assert.equal(rows[0].scope, "Agreed slab and pumping")
  assert.equal(rows[0].terms, "Net 30; 5% retainage")
  assert.equal(rows[0].metadata.subcontract_review_required, false)
})

test("a precon job cannot commit subcontract cost before the owner contract is signed", async (t) => {
  const { submit, award } = await issuedPackage(t, { phase: "precon" })
  await assert.rejects(award(await submit(1)), /signed owner contract/)
})

test("browser roles can neither see pricing decisions nor run an award", async (t) => {
  const db = await createDatabase(t)
  const { rows } = await db.query(`
    select has_table_privilege('authenticated', 'bid_pricing_decisions', 'select') as read,
           has_table_privilege('authenticated', 'bid_pricing_decisions', 'insert') as write,
           has_function_privilege('anon', 'run_reviewed_bid_award(uuid,uuid,uuid,text,uuid[],text,text,text)', 'execute') as anon_award,
           has_function_privilege('authenticated', 'run_reviewed_bid_award(uuid,uuid,uuid,text,uuid[],text,text,text)', 'execute') as member_award,
           has_function_privilege('authenticated', 'save_bid_pricing_decision(uuid,uuid,uuid,jsonb)', 'execute') as member_select
  `)
  assert.deepEqual(rows[0], { read: false, write: false, anon_award: false, member_award: false, member_select: false })
})
