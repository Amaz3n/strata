"use strict"

/**
 * The database contract for taking back a price-book award: rescinding it
 * voids the vendor price agreements it minted, in the same transaction, so
 * purchasing stops pricing homes from a bid the builder withdrew, and puts back
 * the price the award displaced. Also the write fence on the bid tables and the
 * price book: a member's own JWT reaches only what the services would let them.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember } = require("./support/pglite")

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

const daysFrom = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

/** A price-book package with one priced line, a bidder and an incumbent. */
async function rebid(t, { incumbentSameVendor = true } = {}) {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db)
  const incumbentCo = await insert(db, "companies", { org_id: orgId, name: "Framing Co" })
  const winnerCo = incumbentSameVendor ? incumbentCo : await insert(db, "companies", { org_id: orgId, name: "Frame Two" })
  const community = await insert(db, "communities", { org_id: orgId, name: "Oak Ridge", code: "OR" })
  const costCode = await insert(db, "cost_codes", { org_id: orgId, code: "06-100", name: "Framing" })
  const pkg = await insert(db, "bid_packages", { org_id: orgId, community_id: community.id, award_target: "price_agreement", title: "Framing rebid", status: "draft" })
  const invite = await insert(db, "bid_invites", { org_id: orgId, bid_package_id: pkg.id, company_id: winnerCo.id, status: "submitted" })
  const submission = await insert(db, "bid_submissions", { org_id: orgId, bid_invite_id: invite.id, total_cents: 100_000, is_current: true })
  const scope = await insert(db, "bid_scope_items", { org_id: orgId, bid_package_id: pkg.id, description: "Framing", cost_code_id: costCode.id, unit: "sf" })
  await insert(db, "bid_submission_items", { org_id: orgId, bid_submission_id: submission.id, bid_scope_item_id: scope.id, response: "priced", amount_cents: 100_000, unit_rate_cents: 250, quantity: 400, description: "Framing" })
  await db.query("update bid_packages set status = 'open' where id = $1", [pkg.id])
  const incumbent = await insert(db, "vendor_price_agreements", {
    org_id: orgId, company_id: incumbentCo.id, cost_code_id: costCode.id, community_id: community.id,
    pricing_kind: "unit", uom: "sf", unit_cost_cents: 300, status: "active", effective_from: "2020-01-01", effective_to: "2099-12-31",
  })
  const award = (effectiveFrom = null) =>
    rpc(db, "run_bid_award_price_agreements", {
      p_org_id: orgId, p_bid_submission_id: submission.id, p_awarded_by: userId, p_notes: "Reviewed scope: framing", p_accepted_alternate_ids: [], p_effective_from: effectiveFrom,
    })
  const row = async (id) => (await db.query("select status, effective_to::text, superseded_by_id, metadata from vendor_price_agreements where id = $1", [id])).rows[0]
  return { db, orgId, userId, pkg, submission, incumbent, award, row, costCode, community, incumbentCo, winnerCo }
}

test("a rebid ends the incumbent the day before the chosen date and a rescind puts it back exactly", async (t) => {
  const { db, orgId, userId, incumbent, award, row } = await rebid(t)
  const start = daysFrom(10)

  const result = await award(start)
  const minted = result.agreement_ids[0]

  const during = await row(incumbent.id)
  assert.equal(during.status, "active", "a price that starts later leaves the incumbent in force")
  assert.equal(during.effective_to, daysFrom(9))
  assert.equal(during.superseded_by_id, minted)
  assert.deepEqual(result.displaced_ids, [incumbent.id])
  assert.equal((await row(minted)).metadata.supersedes[0].prior_effective_to, "2099-12-31")

  const [rescinded] = await rpc(db, "rescind_bid_award", { p_org_id: orgId, p_bid_award_id: result.award_id, p_actor_id: userId, p_reason: "Trade withdrew" })
  assert.deepEqual(rescinded.voided_agreement_ids, [minted])
  assert.deepEqual(rescinded.restored_agreement_ids, [incumbent.id])
  assert.deepEqual(rescinded.skipped_agreement_ids, [])
  const after = await row(incumbent.id)
  assert.deepEqual({ status: after.status, effective_to: after.effective_to, superseded_by_id: after.superseded_by_id }, { status: "active", effective_to: "2099-12-31", superseded_by_id: null })
  assert.equal((await row(minted)).status, "void")
})

test("a different vendor winning ends the incumbent today and rescinding restores it", async (t) => {
  const { db, orgId, userId, incumbent, award, row } = await rebid(t, { incumbentSameVendor: false })

  const result = await award()

  const ended = await row(incumbent.id)
  assert.equal(ended.status, "superseded")
  assert.equal(ended.effective_to, daysFrom(-1))
  await rpc(db, "rescind_bid_award", { p_org_id: orgId, p_bid_award_id: result.award_id, p_actor_id: userId, p_reason: "Trade withdrew" })
  assert.equal((await row(incumbent.id)).status, "active")
})

test("a predecessor repriced or voided since the award is skipped, not resurrected", async (t) => {
  const { db, orgId, userId, incumbent, award, row } = await rebid(t)
  const result = await award()
  await db.query("update vendor_price_agreements set effective_to = effective_to - 1 where id = $1", [incumbent.id])

  const [rescinded] = await rpc(db, "rescind_bid_award", { p_org_id: orgId, p_bid_award_id: result.award_id, p_actor_id: userId, p_reason: "Trade withdrew" })

  assert.deepEqual(rescinded.restored_agreement_ids, [])
  assert.deepEqual(rescinded.skipped_agreement_ids, [incumbent.id])
  assert.equal((await row(incumbent.id)).status, "superseded")
})

test("an effective date in the past, or beyond a year, is refused", async (t) => {
  const { award } = await rebid(t)
  await assert.rejects(award(daysFrom(-1)), /today up to a year ahead/)
  await assert.rejects(award(daysFrom(400)), /today up to a year ahead/)
})

test("rescinding reports the purchase orders that priced from the voided rows", async (t) => {
  const { db, orgId, userId, award } = await rebid(t)
  const result = await award()
  const home = await insert(db, "projects", { org_id: orgId, name: "Lot 4" })
  await insert(db, "commitments", {
    org_id: orgId, project_id: home.id, title: "Framing PO", status: "approved", commitment_type: "purchase_order",
    metadata: { source_agreement_ids: [result.agreement_ids[0]] },
  })

  const [rescinded] = await rpc(db, "rescind_bid_award", { p_org_id: orgId, p_bid_award_id: result.award_id, p_actor_id: userId, p_reason: "Trade withdrew" })

  assert.equal(rescinded.affected_po_count, 1)
})

test("void and end need a reason, report the orders priced from the agreement and leave a record", async (t) => {
  const { db, orgId, userId, incumbent, row } = await rebid(t)
  const home = await insert(db, "projects", { org_id: orgId, name: "Lot 4" })
  await insert(db, "commitments", {
    org_id: orgId, project_id: home.id, title: "Framing PO", status: "approved", commitment_type: "purchase_order",
    metadata: { source_agreement_ids: [incumbent.id] },
  })
  const state = (args) => rpc(db, "price_agreement_state", { p_org_id: orgId, p_agreement_id: incumbent.id, p_actor_id: userId, p_effective_to: null, p_reason: "Vendor closed", ...args })

  await assert.rejects(state({ p_action: "void", p_reason: " " }), /reason is required/)
  await assert.rejects(state({ p_action: "end", p_effective_to: "2019-01-01" }), /cannot fall before/)
  const ended = await state({ p_action: "end", p_effective_to: daysFrom(30) })
  assert.equal(ended.affected_po_count, 1)
  assert.equal((await row(incumbent.id)).effective_to, daysFrom(30))
  await state({ p_action: "void" })
  const voided = await row(incumbent.id)
  assert.equal(voided.status, "void")
  assert.equal(voided.metadata.state_change.reason, "Vendor closed")
  await assert.rejects(state({ p_action: "void" }), /Only draft or active/)
})

test("two awards for the same scope and date leave one price that takes effect", async (t) => {
  const { db, orgId, userId, community, costCode, award, row } = await rebid(t)
  const second = await insert(db, "companies", { org_id: orgId, name: "Frame Three" })
  const pkg = await insert(db, "bid_packages", { org_id: orgId, community_id: community.id, award_target: "price_agreement", title: "Second", status: "draft" })
  const invite = await insert(db, "bid_invites", { org_id: orgId, bid_package_id: pkg.id, company_id: second.id, status: "submitted" })
  const submission = await insert(db, "bid_submissions", { org_id: orgId, bid_invite_id: invite.id, total_cents: 90_000, is_current: true })
  const scope = await insert(db, "bid_scope_items", { org_id: orgId, bid_package_id: pkg.id, description: "Framing", cost_code_id: costCode.id, unit: "sf" })
  await insert(db, "bid_submission_items", { org_id: orgId, bid_submission_id: submission.id, bid_scope_item_id: scope.id, response: "priced", amount_cents: 90_000, unit_rate_cents: 225, quantity: 400, description: "Framing" })
  await db.query("update bid_packages set status = 'open' where id = $1", [pkg.id])

  const start = daysFrom(20)
  const first = await award(start)
  const next = await rpc(db, "run_bid_award_price_agreements", { p_org_id: orgId, p_bid_submission_id: submission.id, p_awarded_by: userId, p_notes: "n", p_accepted_alternate_ids: [], p_effective_from: start })

  assert.equal((await row(first.agreement_ids[0])).status, "superseded")
  assert.equal((await row(next.agreement_ids[0])).status, "active")
  assert.deepEqual(next.displaced_ids, [first.agreement_ids[0]])
})

/** A world for the fence: an owner, a buyer limited to one division, and a sales agent. */
async function fenced(t) {
  const world = await rebid(t)
  const { db, orgId } = world
  const gulf = await insert(db, "divisions", { org_id: orgId, name: "Gulf Coast" })
  const atlantic = await insert(db, "divisions", { org_id: orgId, name: "Atlantic" })
  const gulfCommunity = await insert(db, "communities", { org_id: orgId, division_id: gulf.id, name: "Gulf Pines", code: "GP" })
  const atlanticCommunity = await insert(db, "communities", { org_id: orgId, division_id: atlantic.id, name: "Atlantic Ridge", code: "AR" })
  const { userId: salesId } = await seedMember(db, { orgId, role: "org_sales_agent" })
  const { userId: buyerId } = await seedMember(db, { orgId, role: "org_purchasing_manager" })
  const { userId: gulfBuyerId } = await seedMember(db, { orgId, role: "org_purchasing_manager" })
  const { rows } = await db.query("update memberships set division_scope = 'assigned' where org_id = $1 and user_id = $2 returning id", [orgId, gulfBuyerId])
  await insert(db, "membership_divisions", { membership_id: rows[0].id, division_id: gulf.id })
  const as = (userId, fn) => asRole(db, { role: "authenticated", userId }, fn)
  const agreementRow = (overrides) => ({
    org_id: orgId, company_id: world.incumbentCo.id, cost_code_id: world.costCode.id, pricing_kind: "unit", uom: "sf",
    unit_cost_cents: 1, status: "active", ...overrides,
  })
  return { ...world, gulf, atlantic, gulfCommunity, atlanticCommunity, salesId, buyerId, gulfBuyerId, as, agreementRow }
}

test("a member without bid.write cannot write the bid tables through their own session", async (t) => {
  const { db, pkg, submission, orgId, salesId, buyerId, as } = await fenced(t)

  const refused = await as(salesId, (tx) => tx.query("update bid_packages set title = 'Forged' where id = $1 returning id", [pkg.id]))
  assert.equal(refused.rows.length, 0)
  await assert.rejects(as(salesId, (tx) => tx.query("insert into bid_scope_items (org_id, bid_package_id, description) values ($1, $2, 'x')", [orgId, pkg.id])), /row-level security/)
  const allowed = await as(buyerId, (tx) => tx.query("update bid_packages set title = 'Renamed' where id = $1 returning id", [pkg.id]))
  assert.equal(allowed.rows.length, 1)
  assert.equal((await db.query("select title from bid_packages where id = $1", [pkg.id])).rows[0].title, "Renamed")
  assert.equal((await as(salesId, (tx) => tx.query("select id from bid_submissions where id = $1", [submission.id]))).rows.length, 1, "reads stay open to members")
})

test("nobody writes bid_awards through the data API, and ancestry cannot be re-pointed", async (t) => {
  const { db, orgId, pkg, submission, award, buyerId, community, as } = await fenced(t)
  const result = await award()
  const otherPkg = await insert(db, "bid_packages", { org_id: orgId, community_id: community.id, award_target: "price_agreement", title: "Other", status: "open" })
  const otherInvite = await insert(db, "bid_invites", { org_id: orgId, bid_package_id: otherPkg.id, company_id: (await db.query("select id from companies limit 1")).rows[0].id, status: "submitted" })
  const otherSubmission = await insert(db, "bid_submissions", { org_id: orgId, bid_invite_id: otherInvite.id, total_cents: 1, is_current: true })

  await assert.rejects(as(buyerId, (tx) => tx.query("update bid_awards set rescinded_at = now() where id = $1", [result.award_id])), /permission denied/)
  await assert.rejects(db.query("update bid_awards set awarded_submission_id = $2 where id = $1", [result.award_id, otherSubmission.id]), /cannot move/)
  await assert.rejects(db.query("update bid_invites set bid_package_id = $2 where bid_package_id = $1", [pkg.id, otherPkg.id]), /cannot move/)
  await assert.rejects(db.query("update bid_submissions set bid_invite_id = $2 where id = $1", [submission.id, otherInvite.id]), /cannot move/)
  await assert.rejects(
    insert(db, "bid_awards", { org_id: orgId, bid_package_id: otherPkg.id, awarded_submission_id: submission.id }),
    /does not belong to this package/,
  )
})

test("an issued or awarded package keeps its parent, target and status against a member", async (t) => {
  const { db, orgId, pkg, award, buyerId, community, as, atlanticCommunity } = await fenced(t)
  const change = (set, id = pkg.id) => as(buyerId, (tx) => tx.query(`update bid_packages set ${set} where id = $1`, [id]))

  await assert.rejects(change(`community_id = '${atlanticCommunity.id}'`), /keeps its community/)
  await assert.rejects(change("award_target = 'commitment'"), /award target is fixed/)
  await assert.rejects(change("status = 'awarded'"), /awarding a bid/)
  await award()
  await assert.rejects(change("status = 'open'"), /rescinding its award/)
  const draft = await insert(db, "bid_packages", { org_id: orgId, community_id: community.id, award_target: "price_agreement", title: "Draft", status: "draft" })
  await change(`community_id = '${atlanticCommunity.id}'`, draft.id)
  assert.equal((await db.query("select community_id from bid_packages where id = $1", [draft.id])).rows[0].community_id, atlanticCommunity.id)
})

test("price agreements are division-fenced and members can only insert", async (t) => {
  const { db, orgId, salesId, buyerId, gulfBuyerId, gulf, atlantic, gulfCommunity, atlanticCommunity, incumbent, as, agreementRow } = await fenced(t)
  const insertAs = (userId, overrides) => as(userId, (tx) => insert(tx, "vendor_price_agreements", agreementRow(overrides)))

  await assert.rejects(insertAs(salesId, {}), /row-level security/)
  await insertAs(buyerId, {})
  await insertAs(gulfBuyerId, { division_id: gulf.id })
  await insertAs(gulfBuyerId, { community_id: gulfCommunity.id })
  await assert.rejects(insertAs(gulfBuyerId, { division_id: atlantic.id }), /row-level security/)
  await assert.rejects(insertAs(gulfBuyerId, { community_id: atlanticCommunity.id }), /row-level security/)
  await assert.rejects(insertAs(gulfBuyerId, {}), /row-level security/, "an org-wide row needs unrestricted scope")
  await assert.rejects(insertAs(buyerId, { source: "bid_award" }), /manual or imported/)
  await assert.rejects(insertAs(buyerId, { status: "void" }), /manual or imported/)

  const voided = await as(buyerId, (tx) => tx.query("update vendor_price_agreements set status = 'void' where id = $1 returning id", [incumbent.id]))
  assert.equal(voided.rows.length, 0, "void goes through the reasoned function")
  const gulfSees = await as(gulfBuyerId, (tx) => tx.query("select id from vendor_price_agreements where org_id = $1 and division_id = $2", [orgId, atlantic.id]))
  assert.equal(gulfSees.rows.length, 0)
  assert.equal((await db.query("select status from vendor_price_agreements where id = $1", [incumbent.id])).rows[0].status, "active")
})

test("a bid line can only price a scope item of its own package, for any writer", async (t) => {
  const { db, orgId, pkg, submission, community, costCode, buyerId, as } = await fenced(t)
  const other = await insert(db, "bid_packages", { org_id: orgId, community_id: community.id, award_target: "price_agreement", title: "Elsewhere", status: "draft" })
  const foreign = await insert(db, "bid_scope_items", { org_id: orgId, bid_package_id: other.id, description: "Foreign", cost_code_id: costCode.id, unit: "sf" })
  const own = (await db.query("select id from bid_scope_items where bid_package_id = $1", [pkg.id])).rows[0]
  const line = (await db.query("select id from bid_submission_items where bid_submission_id = $1", [submission.id])).rows[0]

  await assert.rejects(as(buyerId, (tx) => tx.query("update bid_submission_items set bid_scope_item_id = $2 where id = $1", [line.id, foreign.id])), /scope item of the package/)
  await assert.rejects(insert(db, "bid_submission_items", { org_id: orgId, bid_submission_id: submission.id, bid_scope_item_id: foreign.id, response: "priced", amount_cents: 1, description: "x" }), /scope item of the package/)
  await db.query("update bid_submission_items set bid_scope_item_id = $2 where id = $1", [line.id, own.id])
})

test("rescinding restores an incumbent the sweep expired after the new price started", async (t) => {
  const { db, orgId, userId, incumbent, award, row } = await rebid(t)
  const result = await award(daysFrom(10))
  await db.query("update vendor_price_agreements set status = 'expired' where id = $1", [incumbent.id])

  const [rescinded] = await rpc(db, "rescind_bid_award", { p_org_id: orgId, p_bid_award_id: result.award_id, p_actor_id: userId, p_reason: "Trade withdrew" })

  assert.deepEqual(rescinded.restored_agreement_ids, [incumbent.id])
  const after = await row(incumbent.id)
  assert.deepEqual({ status: after.status, effective_to: after.effective_to }, { status: "active", effective_to: "2099-12-31" })
})

test("a division-limited member cannot write a plan-only package, and ending can only shorten", async (t) => {
  const { db, orgId, userId, incumbent, gulfBuyerId, buyerId, as } = await fenced(t)
  const plan = await insert(db, "house_plans", { org_id: orgId, name: "Mangrove", code: "MG" })
  const plan_only = (id) => as(id, (tx) => tx.query("insert into bid_packages (org_id, house_plan_id, award_target, title, status) values ($1, $2, 'price_agreement', 'Plan only', 'draft') returning id", [orgId, plan.id]))

  await assert.rejects(plan_only(gulfBuyerId), /row-level security/)
  assert.equal((await plan_only(buyerId)).rows.length, 1)
  await assert.rejects(
    rpc(db, "price_agreement_state", { p_org_id: orgId, p_agreement_id: incumbent.id, p_action: "end", p_effective_to: "2100-06-01", p_reason: "Extend", p_actor_id: userId }),
    /ended earlier, not extended/,
  )
})
