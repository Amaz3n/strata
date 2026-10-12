"use strict"

require("../scripts/register-ts-node-test")

/**
 * The lead intake records (20261013010000_lead_intake): one filing core that
 * merges a returning buyer into their open deal and keeps every touch, the
 * delivery log behind the division wall, who may write a deal, and the
 * normalizers the TypeScript twins must agree with.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember } = require("./support/pglite")
const { normalizeEmail, normalizePhone, phoneMatchIsSameBuyer } = require("../lib/sales/lead-identity.ts")

async function member(db, orgId, { role, divisions = null }) {
  const { userId } = await seedMember(db, { orgId, role })
  if (divisions) {
    const { rows } = await db.query(
      "update memberships set division_scope = 'assigned' where org_id = $1 and user_id = $2 returning id",
      [orgId, userId],
    )
    for (const divisionId of divisions) await insert(db, "membership_divisions", { membership_id: rows[0].id, division_id: divisionId })
  }
  return userId
}

/** An org with a community in each of two divisions and a website source. */
async function intakeOrg(t) {
  const db = await createDatabase(t)
  const { orgId, userId: ownerId } = await seedMember(db)
  const gulf = await insert(db, "divisions", { org_id: orgId, name: "Gulf Coast" })
  const treasure = await insert(db, "divisions", { org_id: orgId, name: "Treasure Coast" })
  const cypress = await insert(db, "communities", { org_id: orgId, name: "Cypress Landing", code: "CL", division_id: gulf.id })
  const seagrape = await insert(db, "communities", { org_id: orgId, name: "Seagrape Hammock", code: "SGH", division_id: treasure.id })
  const source = await insert(db, "lead_intake_sources", {
    org_id: orgId, name: "Website", public_id: "lis_abcdefghijklmnopqrstuvwx", signing_secret_encrypted: "ciphertext", secret_hint: "wxyz",
  })
  return { db, orgId, ownerId, gulf, treasure, cypress, seagrape, source }
}

let deliveries = 0
async function receipt(org, overrides = {}) {
  deliveries += 1
  return insert(org.db, "lead_intake_receipts", {
    org_id: org.orgId, source_id: org.source.id, idempotency_key: `delivery-${deliveries}`, payload: JSON.stringify({}), ...overrides,
  })
}

function lead(overrides = {}) {
  return { name: "Dana Rivers", email: "dana@example.test", channel: "web", source: "Website", traffic_bucket: "web_inquiries", ...overrides }
}

const file = (org, receiptId, body) => rpc(org.db, "file_lead", { p_org_id: org.orgId, p_receipt_id: receiptId, p_lead: JSON.stringify(body) })

test("the SQL normalizers and their TypeScript twins agree", async (t) => {
  const db = await createDatabase(t)
  const emails = ["  Dana@Example.TEST ", "", "   ", "x@y.z"]
  const phones = ["(239) 555-0142", "+1 239.555.0142", "1-239-555-0142", "555-0142", "", "+44 20 7946 0958"]
  for (const value of emails) {
    const { rows } = await db.query("select public.arc_normalize_email($1) as v", [value])
    assert.equal(rows[0].v, normalizeEmail(value), value)
  }
  for (const value of phones) {
    const { rows } = await db.query("select public.arc_normalize_phone($1) as v", [value])
    assert.equal(rows[0].v, normalizePhone(value), value)
  }
})

test("a returning buyer merges into their open deal by email, then by phone, and every touch is kept", async (t) => {
  const org = await intakeOrg(t)
  const first = await receipt(org)
  const filed = await file(org, first.id, lead({ phone: "(239) 555-0142", community_id: org.cypress.id, owner_user_id: org.ownerId, routing_outcome: "community_assignee", utm_campaign: "spring" }))
  assert.equal(filed.outcome, "filed")

  const byEmail = await file(org, (await receipt(org)).id, lead({ email: " DANA@example.test", utm_campaign: "summer", owner_user_id: null, routing_outcome: "unrouted" }))
  const byPhone = await file(org, (await receipt(org)).id, lead({ email: null, phone: "+1 239 555 0142" }))
  assert.deepEqual([byEmail.outcome, byEmail.matched_by, byEmail.routing_outcome], ["merged", "email", "existing_owner"])
  assert.deepEqual([byPhone.outcome, byPhone.matched_by], ["merged", "phone"])
  assert.equal(byEmail.prospect_id, filed.prospect_id)
  assert.equal(byPhone.prospect_id, filed.prospect_id)

  const touches = await org.db.query("select touch, utm_campaign from prospect_attributions where prospect_id = $1 order by touch", [filed.prospect_id])
  assert.deepEqual(touches.rows, [{ touch: 1, utm_campaign: "spring" }, { touch: 2, utm_campaign: "summer" }, { touch: 3, utm_campaign: null }])
  const traffic = await org.db.query("select web_inquiries from community_traffic where community_id = $1", [org.cypress.id])
  assert.deepEqual(traffic.rows, [{ web_inquiries: 1 }], "a merge is not a new visitor")
  const owner = await org.db.query("select owner_user_id from prospects where id = $1", [filed.prospect_id])
  assert.equal(owner.rows[0].owner_user_id, org.ownerId, "a merge never moves the owner")
})

test("a phone merges only when one side has no email; two emails on one phone are two buyers, the second flagged", async (t) => {
  const org = await intakeOrg(t)
  const office = "(239) 555-0100"
  const first = await file(org, (await receipt(org)).id, lead({ phone: office }))
  // A co-op agent sends a second buyer with the agent's own number.
  const flaggedReceipt = await receipt(org)
  const second = await file(org, flaggedReceipt.id, lead({ name: "Lee Park", email: "lee.park@example.test", phone: office }))
  assert.deepEqual([second.outcome, second.matched_by, second.possible_duplicate_prospect_id], ["filed", null, first.prospect_id])
  assert.notEqual(second.prospect_id, first.prospect_id)
  const { rows: [saved] } = await org.db.query("select possible_duplicate_prospect_id from lead_intake_receipts where id = $1", [flaggedReceipt.id])
  assert.equal(saved.possible_duplicate_prospect_id, first.prospect_id)
  const { rows: [contact] } = await org.db.query("select email from prospect_contacts where prospect_id = $1 and is_primary", [second.prospect_id])
  assert.equal(contact.email, "lee.park@example.test", "the second buyer's email is theirs, not dropped")

  // With no email to tell them apart, the phone is the buyer.
  const phoneOnly = await file(org, (await receipt(org)).id, lead({ email: null, phone: office }))
  assert.deepEqual([phoneOnly.outcome, phoneOnly.matched_by, phoneOnly.prospect_id], ["merged", "phone", first.prospect_id])

  // The TypeScript twin (directory matching) reads the same rule.
  assert.equal(phoneMatchIsSameBuyer("lee.park@example.test", "dana@example.test"), false)
  assert.equal(phoneMatchIsSameBuyer(null, "dana@example.test"), true)
  assert.equal(phoneMatchIsSameBuyer("Dana@Example.test ", null), true)
  assert.equal(phoneMatchIsSameBuyer(" DANA@example.test", "dana@example.test"), true)
})

test("a name alone never merges, and a lost buyer who returns is a new deal flagged as returning", async (t) => {
  const org = await intakeOrg(t)
  const first = await file(org, null, lead({ channel: "walk_in" }))
  const namesake = await file(org, null, lead({ email: "other.dana@example.test", channel: "walk_in" }))
  assert.notEqual(namesake.prospect_id, first.prospect_id)

  await org.db.query("update prospects set status = 'lost', lost_at = now() where id = $1", [first.prospect_id])
  const back = await file(org, (await receipt(org)).id, lead())
  assert.equal(back.outcome, "filed")
  assert.notEqual(back.prospect_id, first.prospect_id)
  assert.equal(back.prior_prospect_id, first.prospect_id)
})

test("a filed delivery replays its result and a dismissed one cannot be filed", async (t) => {
  const org = await intakeOrg(t)
  const delivery = await receipt(org)
  const filed = await file(org, delivery.id, lead())
  const replay = await file(org, delivery.id, lead({ email: "someone.else@example.test" }))
  assert.equal(replay.replayed, true)
  assert.equal(replay.prospect_id, filed.prospect_id)

  const dismissed = await receipt(org, { status: "dismissed", resolved_at: new Date().toISOString(), resolved_by: org.ownerId })
  await assert.rejects(file(org, dismissed.id, lead()), /cannot be filed/)
  await assert.rejects(file(org, (await receipt(org)).id, lead({ email: null, phone: "555-0142" })), /email or a phone/)
})

test("only the service files a lead", async (t) => {
  const org = await intakeOrg(t)
  await assert.rejects(
    rpc(org.db, "file_lead", { p_org_id: org.orgId, p_receipt_id: null, p_lead: JSON.stringify(lead()) }, { role: "authenticated", userId: org.ownerId }),
    /permission denied/,
  )
})

test("a deal with no home is written only by a desk write key", async (t) => {
  const org = await intakeOrg(t)
  const consultant = await member(org.db, org.orgId, { role: "org_sales_agent" })
  const superintendent = await member(org.db, org.orgId, { role: "org_superintendent" })
  const estimator = await member(org.db, org.orgId, { role: "org_estimator" })
  const create = (userId) => asRole(org.db, { role: "authenticated", userId }, (tx) =>
    tx.query("insert into prospects (org_id, name) values ($1, 'Walk-in') returning id", [org.orgId]))

  await assert.rejects(create(superintendent), /permission to edit this deal|row-level security/)
  const sold = await create(consultant)
  assert.equal(sold.rows.length, 1)
  assert.equal((await create(estimator)).rows.length, 1)
  const reassign = await asRole(org.db, { role: "authenticated", userId: superintendent }, (tx) =>
    tx.query("update prospects set owner_user_id = $2 where id = $1", [sold.rows[0].id, superintendent]))
  assert.equal(reassign.rowCount, 0)
})

test("staffing a community takes community.write and counting traffic takes a desk write key", async (t) => {
  const org = await intakeOrg(t)
  const superintendent = await member(org.db, org.orgId, { role: "org_superintendent" })
  const as = (fn) => asRole(org.db, { role: "authenticated", userId: superintendent }, fn)
  await assert.rejects(
    as((tx) => tx.query("insert into community_assignments (org_id, community_id, user_id, role) values ($1, $2, $3, 'sales')", [org.orgId, org.cypress.id, superintendent])),
    /row-level security/,
  )
  await assert.rejects(
    as((tx) => tx.query("select public.increment_community_traffic($1, $2, current_date, 'walk_ins')", [org.orgId, org.cypress.id])),
    /row-level security/,
  )
})

test("traffic counts add rather than overwrite", async (t) => {
  const org = await intakeOrg(t)
  const as = (fn) => asRole(org.db, { role: "authenticated", userId: org.ownerId }, fn)
  for (const bucket of ["walk_ins", "walk_ins", "appointments"]) {
    await as((tx) => tx.query("select public.increment_community_traffic($1, $2, '2026-10-12', $3)", [org.orgId, org.cypress.id, bucket]))
  }
  const { rows } = await org.db.query("select walk_ins, appointments, web_inquiries from community_traffic where community_id = $1", [org.cypress.id])
  assert.deepEqual(rows, [{ walk_ins: 2, appointments: 1, web_inquiries: 0 }])
})

test("the delivery log stands behind the division wall and secrets are never readable", async (t) => {
  const org = await intakeOrg(t)
  const gulfConsultant = await member(org.db, org.orgId, { role: "org_sales_agent", divisions: [org.gulf.id] })
  const superintendent = await member(org.db, org.orgId, { role: "org_superintendent" })
  await receipt(org, { community_id: org.cypress.id })
  await receipt(org, { community_id: org.seagrape.id })
  await receipt(org, { status: "failed", failure_code: "unknown_community" })
  const read = (userId, sql) => asRole(org.db, { role: "authenticated", userId }, (tx) => tx.query(sql))

  const seen = await read(gulfConsultant, "select community_id from lead_intake_receipts order by community_id nulls last")
  assert.deepEqual(seen.rows.map((row) => row.community_id), [org.cypress.id, null])
  assert.equal((await read(superintendent, "select id from lead_intake_receipts")).rows.length, 0)
  assert.equal((await read(org.ownerId, "select id, secret_hint from lead_intake_sources")).rows.length, 1)
  await assert.rejects(read(org.ownerId, "select signing_secret_encrypted from lead_intake_sources"), /permission denied/)
  await assert.rejects(read(org.ownerId, "update lead_intake_receipts set status = 'dismissed'"), /permission denied/)
})

test("routing offers only consultants who can work the lead and reach its division, least recently assigned first", async (t) => {
  const org = await intakeOrg(t)
  const gulf = await member(org.db, org.orgId, { role: "org_sales_agent", divisions: [org.gulf.id] })
  const treasure = await member(org.db, org.orgId, { role: "org_sales_agent", divisions: [org.treasure.id] })
  const superintendent = await member(org.db, org.orgId, { role: "org_superintendent" })
  for (const userId of [gulf, treasure, superintendent, org.ownerId]) {
    await insert(org.db, "community_assignments", { org_id: org.orgId, community_id: org.cypress.id, user_id: userId, role: "sales" })
  }
  await insert(org.db, "prospects", { org_id: org.orgId, name: "Earlier", community_id: org.cypress.id, owner_user_id: gulf })

  const context = await rpc(org.db, "lead_routing_context", { p_org_id: org.orgId, p_community_id: org.cypress.id, p_candidate_ids: [] })
  assert.equal(context.division_id, org.gulf.id)
  assert.equal(context.community_assignees.at(-1).user_id, gulf, "the consultant who just got a lead goes last")
  assert.deepEqual([...context.eligible_user_ids].sort(), [gulf, org.ownerId].sort())
})

test("filing takes the rotation's turn itself, so a lead routed on a stale read still goes to whoever is next", async (t) => {
  const org = await intakeOrg(t)
  const first = await member(org.db, org.orgId, { role: "org_sales_agent" })
  const second = await member(org.db, org.orgId, { role: "org_sales_agent" })
  const routed = (email) => lead({ email, community_id: org.cypress.id, owner_user_id: first, routing_outcome: "community_assignee", round_robin_user_ids: [first, second] })

  // Both deliveries were routed to `first` from the same read; the second files after the first committed.
  const one = await file(org, (await receipt(org)).id, routed("one@example.test"))
  const two = await file(org, (await receipt(org)).id, routed("two@example.test"))
  assert.deepEqual([one.owner_user_id, two.owner_user_id].sort(), [first, second].sort())
  const three = await file(org, (await receipt(org)).id, routed("three@example.test"))
  assert.equal(three.owner_user_id, one.owner_user_id, "the turn comes back around")

  await assert.rejects(
    file(org, (await receipt(org)).id, { ...routed("four@example.test"), owner_user_id: org.ownerId }),
    /not in the community rotation/,
  )
})

test("a rejected delivery is logged without its body and counted on its source in one statement", async (t) => {
  const org = await intakeOrg(t)
  const at = new Date().toISOString()
  await rpc(org.db, "record_lead_delivery_rejection", { p_source_id: org.source.id, p_reason: "bad_signature", p_at: at })
  await rpc(org.db, "record_lead_delivery_rejection", { p_source_id: org.source.id, p_reason: "stale_timestamp", p_at: at })
  const { rows: [source] } = await org.db.query("select rejected_count, last_rejection_reason from lead_intake_sources where id = $1", [org.source.id])
  assert.deepEqual(source, { rejected_count: 2, last_rejection_reason: "stale_timestamp" })
  const { rows } = await org.db.query("select status, idempotency_key, payload from lead_intake_receipts where source_id = $1 order by failure_code", [org.source.id])
  assert.deepEqual(rows, [
    { status: "rejected", idempotency_key: null, payload: null },
    { status: "rejected", idempotency_key: null, payload: null },
  ])
})

test("on an org that also sells custom homes, a lead with no community is listed by the Pipeline, not the Sales board", async (t) => {
  const org = await intakeOrg(t)
  const walkIn = await insert(org.db, "prospects", { org_id: org.orgId, name: "Custom home lead" })
  const buyer = await insert(org.db, "prospects", { org_id: org.orgId, name: "Cypress buyer", community_id: org.cypress.id })
  const board = (includeCommunityless) => asRole(org.db, { role: "authenticated", userId: org.ownerId }, async (tx) =>
    (await tx.query("select prospect_id from get_sales_deals(p_org_id => $1, p_include_communityless => $2)", [org.orgId, includeCommunityless])).rows
      .map((row) => row.prospect_id).sort())
  assert.deepEqual(await board(true), [walkIn.id, buyer.id].sort())
  assert.deepEqual(await board(false), [buyer.id])
})

test("a dismissed delivery's submission is purged after 90 days and a rejected one is deleted", async (t) => {
  const org = await intakeOrg(t)
  const old = new Date(Date.now() - 91 * 86_400_000).toISOString()
  const dismissed = await receipt(org, { status: "dismissed", resolved_at: old, resolved_by: org.ownerId, contact_email: "dana@example.test", payload: JSON.stringify({ email: "dana@example.test" }) })
  const recent = await receipt(org, { status: "dismissed", resolved_at: new Date().toISOString(), resolved_by: org.ownerId, payload: JSON.stringify({ email: "x@example.test" }) })
  await receipt(org, { status: "rejected", idempotency_key: null, failure_code: "bad_signature", payload: null, received_at: old })

  assert.equal(await rpc(org.db, "purge_lead_intake_payloads"), 2)
  const { rows } = await org.db.query("select id, payload, contact_email from lead_intake_receipts where org_id = $1 order by received_at", [org.orgId])
  assert.deepEqual(rows.map((row) => [row.id, row.payload === null, row.contact_email]), [
    [dismissed.id, true, null],
    [recent.id, false, null],
  ])
})

test("lead_intake.manage goes to owners and admins, and sales consultants gain the pipeline", async (t) => {
  const db = await createDatabase(t)
  const { rows } = await db.query(`
    select
      array(select r.key from roles r join role_permissions rp on rp.role_id = r.id and rp.permission_key = 'lead_intake.manage' order by 1) as managers,
      array(select rp.permission_key from roles r join role_permissions rp on rp.role_id = r.id where r.key = 'org_sales_agent' and rp.permission_key like 'pipeline.%' order by 1) as consultant`)
  assert.deepEqual(rows[0].managers, ["org_admin", "org_office_admin", "org_owner"])
  assert.deepEqual(rows[0].consultant, ["pipeline.read", "pipeline.write"])
})
