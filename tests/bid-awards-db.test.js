"use strict"

/**
 * The database contract for taking back a price-book award: rescinding it
 * voids the vendor price agreements it minted, in the same transaction, so
 * purchasing stops pricing homes from a bid the builder withdrew.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, rpc, seedMember } = require("./support/pglite")

async function priceBookAward(t) {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db)
  const company = await insert(db, "companies", { org_id: orgId, name: "Framing Co" })
  const division = await insert(db, "divisions", { org_id: orgId, name: "North", code: "N" })
  const community = await insert(db, "communities", { org_id: orgId, division_id: division.id, name: "Oak Ridge", code: "OR" })
  const costCode = await insert(db, "cost_codes", { org_id: orgId, code: "06-100", name: "Framing" })
  const pkg = await insert(db, "bid_packages", {
    org_id: orgId,
    community_id: community.id,
    award_target: "price_agreement",
    title: "Framing rebid",
    status: "awarded",
  })
  const invite = await insert(db, "bid_invites", { org_id: orgId, bid_package_id: pkg.id, company_id: company.id, status: "submitted" })
  const submission = await insert(db, "bid_submissions", { org_id: orgId, bid_invite_id: invite.id, total_cents: 100_000 })
  const award = await insert(db, "bid_awards", { org_id: orgId, bid_package_id: pkg.id, awarded_submission_id: submission.id, awarded_by: userId })
  const agreement = (overrides) =>
    insert(db, "vendor_price_agreements", {
      org_id: orgId,
      company_id: company.id,
      cost_code_id: costCode.id,
      community_id: community.id,
      pricing_kind: "unit",
      uom: "sf",
      unit_cost_cents: 250,
      status: "active",
      ...overrides,
    })
  const minted = await agreement({ source: "bid_award", source_bid_award_id: award.id })
  const unrelated = await agreement({ source: "manual" })
  const rescind = () =>
    rpc(db, "rescind_bid_award", { p_org_id: orgId, p_bid_award_id: award.id, p_actor_id: userId, p_reason: "Trade withdrew" })
  const statusOf = async (id) =>
    (await db.query("select status from vendor_price_agreements where id = $1", [id])).rows[0].status
  return { db, award, minted, unrelated, rescind, statusOf }
}

test("rescinding a price-book award voids the agreements it minted and nothing else", async (t) => {
  const { db, award, minted, unrelated, rescind, statusOf } = await priceBookAward(t)

  await rescind()

  assert.equal(await statusOf(minted.id), "void")
  assert.equal(await statusOf(unrelated.id), "active")
  const { rows } = await db.query("select rescinded_at, rescind_reason from bid_awards where id = $1", [award.id])
  assert.ok(rows[0].rescinded_at)
  assert.equal(rows[0].rescind_reason, "Trade withdrew")
})

test("a second rescind is refused and changes nothing", async (t) => {
  const { rescind, statusOf, unrelated } = await priceBookAward(t)
  await rescind()

  await assert.rejects(rescind(), /already rescinded/)
  assert.equal(await statusOf(unrelated.id), "active")
})

test("awarding a price-book package mints agreements for the priced cost-coded lines with the reviewed terms", async (t) => {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db)
  const company = await insert(db, "companies", { org_id: orgId, name: "Framing Co" })
  const community = await insert(db, "communities", { org_id: orgId, name: "Oak Ridge", code: "OR" })
  const framing = await insert(db, "cost_codes", { org_id: orgId, code: "06-100", name: "Framing" })
  const trim = await insert(db, "cost_codes", { org_id: orgId, code: "06-200", name: "Trim" })
  const pkg = await insert(db, "bid_packages", { org_id: orgId, community_id: community.id, award_target: "price_agreement", title: "Framing rebid", status: "draft" })
  const invite = await insert(db, "bid_invites", { org_id: orgId, bid_package_id: pkg.id, company_id: company.id, status: "submitted" })
  const submission = await insert(db, "bid_submissions", { org_id: orgId, bid_invite_id: invite.id, total_cents: 300_000, is_current: true })
  const line = async (costCode, response, extra = {}) => {
    const scope = await insert(db, "bid_scope_items", { org_id: orgId, bid_package_id: pkg.id, description: "Line", cost_code_id: costCode?.id ?? null, unit: "sf", ...extra.scope })
    return insert(db, "bid_submission_items", { org_id: orgId, bid_submission_id: submission.id, bid_scope_item_id: scope.id, response, amount_cents: 100_000, unit_rate_cents: 250, quantity: 400, description: "Line" })
  }
  const priced = await line(framing, "priced")
  await line(trim, "excluded")
  await line(null, "priced")
  const prior = await insert(db, "vendor_price_agreements", {
    org_id: orgId, company_id: company.id, cost_code_id: framing.id, community_id: community.id,
    pricing_kind: "unit", uom: "sf", unit_cost_cents: 300, status: "active", effective_from: "2020-01-01",
  })
  const notes = "Reviewed scope: wall framing\n\nCommercial terms: net 30"
  const award = () => rpc(db, "run_bid_award_price_agreements", { p_org_id: orgId, p_bid_submission_id: submission.id, p_awarded_by: userId, p_notes: notes, p_accepted_alternate_ids: [] })

  const result = await award()

  assert.equal(result.agreement_ids.length, 1)
  const minted = (await db.query("select * from vendor_price_agreements where id = $1", [result.agreement_ids[0]])).rows[0]
  assert.equal(minted.source, "bid_award")
  assert.equal(minted.source_bid_award_id, result.award_id)
  assert.equal(minted.status, "active")
  assert.equal(minted.company_id, company.id)
  assert.equal(minted.cost_code_id, framing.id)
  assert.equal(minted.community_id, community.id)
  assert.equal(Number(minted.unit_cost_cents), 250)
  assert.equal(minted.notes, notes)
  assert.equal(minted.metadata.bid_submission_item_id, priced.id)
  const old = (await db.query("select status, superseded_by_id from vendor_price_agreements where id = $1", [prior.id])).rows[0]
  assert.deepEqual(old, { status: "superseded", superseded_by_id: minted.id })
  assert.equal((await db.query("select notes from bid_awards where id = $1", [result.award_id])).rows[0].notes, notes)
  assert.equal((await db.query("select status from bid_packages where id = $1", [pkg.id])).rows[0].status, "awarded")

  assert.deepEqual((await award()).agreement_ids, result.agreement_ids)
  assert.equal((await db.query("select count(*)::int n from vendor_price_agreements where source_bid_award_id = $1", [result.award_id])).rows[0].n, 1)
})
