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
