"use strict"

/**
 * The database contract behind purchase agreement packets, versions and
 * cancellation (20261013020000_agreement_packets_and_versions): which of the
 * org's documents a home is sold on and the hash that binds them, that a
 * published document never changes, that signing is refused on a stale packet,
 * that a buyer-signed change order is the agreement's next version and the only
 * way its price moves, and that cancelling a sale reconciles it in one step.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember } = require("./support/pglite")

const sha = (n) => String(n).padStart(64, "0")

/** An org with two Florida communities, one Georgia community, and a way to publish documents. */
async function salesOrg(t) {
  const db = await createDatabase(t)
  const owner = await seedMember(db)
  const { orgId } = owner
  const cypress = await insert(db, "communities", { org_id: orgId, name: "Cypress Landing", state: "FL" })
  const heron = await insert(db, "communities", { org_id: orgId, name: "Heron Point", state: "Florida" })
  const peach = await insert(db, "communities", { org_id: orgId, name: "Peach Grove", state: "GA" })
  let documents = 0
  const template = (kind, name) => insert(db, "agreement_templates", { org_id: orgId, kind, name, created_by: owner.userId })
  const draft = async (templateId, { title, states = [], communities = [], required = false } = {}) => {
    documents += 1
    const file = await insert(db, "files", { org_id: orgId, file_name: `${documents}.pdf`, storage_path: `${orgId}/general/agreement-templates/${documents}.pdf`, mime_type: "application/pdf" })
    const { rows: [{ next }] } = await db.query("select coalesce(max(version_number), 0) + 1 as next from agreement_template_versions where template_id = $1", [templateId])
    const version = await insert(db, "agreement_template_versions", {
      org_id: orgId, template_id: templateId, version_number: next, title: title ?? `Document ${documents}`, required, applies_to_states: states,
      source_file_id: file.id, content_sha256: sha(documents), size_bytes: 1000, page_count: 4, storage_path: file.storage_path, created_by: owner.userId,
    })
    for (const communityId of communities) await insert(db, "agreement_template_version_communities", { org_id: orgId, version_id: version.id, community_id: communityId })
    return version
  }
  const publish = (versionId) => rpc(db, "publish_agreement_template_version", { p_org_id: orgId, p_version_id: versionId, p_actor_id: owner.userId })
  const published = async (kind, name, options) => {
    const family = await template(kind, name)
    const version = await draft(family.id, options)
    await publish(version.id)
    return { family, version }
  }
  const resolve = (communityId, optional = []) =>
    rpc(db, "resolve_agreement_packet", { p_org_id: orgId, p_community_id: communityId, p_optional_template_ids: JSON.stringify(optional) })
  return { db, owner, orgId, cypress, heron, peach, template, draft, publish, published, resolve }
}

/** The detail code a refused call raised. */
async function refusal(promise) {
  try {
    await promise
  } catch (error) {
    return error.detail ?? error.message
  }
  return null
}

test("a home is sold on its most specific agreement, every required addendum, and only the optional ones picked", async (t) => {
  const org = await salesOrg(t)
  await org.published("agreement", "Florida agreement", { title: "Florida purchase agreement", states: ["FL"] })
  await org.published("agreement", "Georgia agreement", { title: "Georgia purchase agreement", states: ["GA"] })
  await org.published("agreement", "Cypress agreement", { title: "Cypress Landing purchase agreement", communities: [org.cypress.id] })
  await org.published("addendum", "HOA", { title: "HOA disclosure", states: ["FL"], required: true })
  const waterfront = await org.published("addendum", "Waterfront", { title: "Waterfront addendum", states: ["FL"] })
  const georgiaOnly = await org.published("addendum", "Georgia disclosure", { title: "Georgia disclosure", states: ["GA"], required: true })

  const cypress = await org.resolve(org.cypress.id)
  assert.equal(cypress.jurisdiction, "FL")
  assert.deepEqual(cypress.documents.map((row) => row.title), ["Cypress Landing purchase agreement", "HOA disclosure"])
  assert.deepEqual(cypress.optional_offered.map((row) => row.title), ["Waterfront addendum"])

  // A community naming its state in full resolves the same jurisdiction.
  const heron = await org.resolve(org.heron.id, [waterfront.family.id])
  assert.deepEqual(heron.documents.map((row) => row.title), ["Florida purchase agreement", "HOA disclosure", "Waterfront addendum"])

  const peach = await org.resolve(org.peach.id)
  assert.deepEqual(peach.documents.map((row) => row.title), ["Georgia purchase agreement", "Georgia disclosure"])

  assert.equal(await refusal(org.resolve(org.cypress.id, [georgiaOnly.family.id])), "AGREEMENT_PACKET_CHANGED")
  assert.equal((await org.resolve(org.cypress.id)).hash, cypress.hash, "the same documents hash the same")
  assert.notEqual((await org.resolve(org.cypress.id, [waterfront.family.id])).hash, cypress.hash)
})

test("a home with no published agreement, or two that apply equally, cannot be sold", async (t) => {
  const org = await salesOrg(t)
  assert.equal(await refusal(org.resolve(org.cypress.id)), "AGREEMENT_PACKET_UNAVAILABLE")
  await org.published("agreement", "Statewide A", { states: ["FL"] })
  await org.published("agreement", "Statewide B", { states: ["FL"] })
  assert.equal(await refusal(org.resolve(org.cypress.id)), "AGREEMENT_PACKET_AMBIGUOUS")
})

test("a published version never changes; publishing the next supersedes it and only drafts can be edited or discarded", async (t) => {
  const org = await salesOrg(t)
  const { family, version: first } = await org.published("agreement", "Florida agreement", { states: ["FL"] })
  const member = (fn) => asRole(org.db, { role: "authenticated", userId: org.owner.userId }, fn)

  const edited = await member((tx) => tx.query("update agreement_template_versions set title = 'Edited' where id = $1", [first.id]))
  assert.equal(edited.affectedRows ?? edited.rowCount ?? 0, 0, "a member's write never reaches a published version")
  await assert.rejects(org.db.query("update agreement_template_versions set content_sha256 = $2 where id = $1", [first.id, sha(99)]), /cannot change/)
  await assert.rejects(org.db.query("delete from agreement_template_versions where id = $1", [first.id]), /withdraw it instead/)

  const second = await org.draft(family.id, { states: ["FL"] })
  await member((tx) => tx.query("update agreement_template_versions set title = 'Florida agreement (2026)' where id = $1", [second.id]))
  await assert.rejects(member((tx) => tx.query("update agreement_template_versions set status = 'published' where id = $1", [second.id])), /publish action/)
  await org.publish(second.id)
  const { rows } = await org.db.query("select version_number, status from agreement_template_versions where template_id = $1 order by version_number", [family.id])
  assert.deepEqual(rows, [{ version_number: 1, status: "superseded" }, { version_number: 2, status: "published" }])
  assert.equal((await org.resolve(org.cypress.id)).documents[0].version_number, 2)
})

/** A draft agreement on a Cypress Landing home, holding the packet the home resolved to when it was written. */
async function draftAgreement(org, { optional = [], lotNumber = "47" } = {}) {
  const project = await insert(org.db, "projects", { org_id: org.orgId, name: `Lot ${lotNumber}` })
  const lot = await insert(org.db, "lots", { org_id: org.orgId, community_id: org.cypress.id, lot_number: lotNumber, status: "started", project_id: project.id })
  const { optional_offered: _offered, ...packet } = await org.resolve(org.cypress.id, optional)
  const contract = await insert(org.db, "contracts", {
    org_id: org.orgId, project_id: project.id, title: "Purchase Agreement — Lot 47", status: "draft", contract_type: "purchase_agreement", total_cents: 385_000_00,
    snapshot: JSON.stringify({ purchase_agreement: { configuration: { lot_id: lot.id }, pricing: { totalCents: 385_000_00 }, packet } }),
  })
  const stale = async () => (await org.db.query("select public.agreement_packet_stale_reason($1, $2) as reason", [org.orgId, contract.id])).rows[0].reason
  return { project, lot, contract, stale }
}

test("signing is refused once a packet document is withdrawn or a newly required addendum is missing; a newer version is not a block", async (t) => {
  const org = await salesOrg(t)
  const { family } = await org.published("agreement", "Florida agreement", { states: ["FL"] })
  const hoa = await org.published("addendum", "HOA", { title: "HOA disclosure", states: ["FL"], required: true })
  const home = await draftAgreement(org)
  assert.equal(await home.stale(), null)

  const newer = await org.draft(family.id, { states: ["FL"] })
  await org.publish(newer.id)
  assert.equal(await home.stale(), null, "the packet keeps the version the buyer was shown")

  await org.published("addendum", "Flood", { title: "Flood zone disclosure", states: ["FL"], required: true })
  assert.match(await home.stale(), /missing the required addendum Flood zone disclosure/)

  const later = await draftAgreement(org, { lotNumber: "48" })
  assert.equal(await later.stale(), null)
  await rpc(org.db, "withdraw_agreement_template_version", { p_org_id: org.orgId, p_version_id: hoa.version.id, p_actor_id: org.owner.userId, p_reason: "Counsel recalled it" })
  assert.match(await later.stale(), /was withdrawn/)
})

test("a refreshed draft takes the packet the seller reviewed; a signing document freezes it", async (t) => {
  const org = await salesOrg(t)
  await org.published("agreement", "Florida agreement", { states: ["FL"] })
  const home = await draftAgreement(org)
  await org.published("addendum", "Flood", { title: "Flood zone disclosure", states: ["FL"], required: true })
  const fresh = await org.resolve(org.cypress.id)
  const refresh = (hash) => rpc(org.db, "refresh_purchase_agreement_packet", { p_org_id: org.orgId, p_contract_id: home.contract.id, p_actor_id: org.owner.userId, p_optional_template_ids: "[]", p_expected_hash: hash })

  assert.equal(await refusal(refresh(sha(1))), "AGREEMENT_PACKET_CHANGED")
  await refresh(fresh.hash)
  assert.equal(await home.stale(), null)
  const { rows: [saved] } = await org.db.query("select snapshot->'purchase_agreement'->'packet'->>'hash' as hash from contracts where id = $1", [home.contract.id])
  assert.equal(saved.hash, fresh.hash)
})

/** A signed agreement on a home with a buyer, as signing leaves it. */
async function signedAgreement(t) {
  const org = await salesOrg(t)
  const project = await insert(org.db, "projects", { org_id: org.orgId, name: "Lot 47" })
  const contract = await insert(org.db, "contracts", {
    org_id: org.orgId, project_id: project.id, title: "Purchase Agreement — Lot 47", status: "draft", contract_type: "purchase_agreement",
    total_cents: 385_000_00, snapshot: JSON.stringify({ purchase_agreement: { pricing: { totalCents: 385_000_00 } } }),
  })
  await org.db.query("update contracts set status = 'active', signed_at = now(), signature_data = $2 where id = $1", [contract.id, JSON.stringify({ envelope_id: "env", packet_hash: sha(7) })])
  const changeOrder = async (row = {}) => insert(org.db, "change_orders", { org_id: org.orgId, project_id: project.id, title: "Covered patio", status: "pending", lifecycle: "proposed", total_cents: 12_500_00, requires_signature: true, client_visible: true, ...row })
  const approve = (id, metadata) => org.db.query("update change_orders set status = 'approved', lifecycle = 'approved', approved_at = now(), metadata = $2 where id = $1", [id, JSON.stringify(metadata)])
  const versions = async () => (await org.db.query("select version_number, kind, price_delta_cents::int as delta, authorized_total_cents::int as total from purchase_agreement_versions where contract_id = $1 order by version_number", [contract.id])).rows
  return { ...org, project, contract, changeOrder, approve, versions }
}

test("signing writes version 1, and each change order the buyer signs is the next version of the price", async (t) => {
  const sale = await signedAgreement(t)
  assert.deepEqual(await sale.versions(), [{ version_number: 1, kind: "original", delta: 385_000_00, total: 385_000_00 }])

  const patio = await sale.changeOrder()
  await sale.approve(patio.id, { approval_method: "portal_native_signature", approved_signer_name: "Pat Buyer" })
  const fireplace = await sale.changeOrder({ title: "Delete fireplace", total_cents: -3_000_00 })
  await sale.approve(fireplace.id, { approved_via_envelope: true, approved_envelope_id: "env-2" })

  assert.deepEqual(await sale.versions(), [
    { version_number: 1, kind: "original", delta: 385_000_00, total: 385_000_00 },
    { version_number: 2, kind: "amendment", delta: 12_500_00, total: 397_500_00 },
    { version_number: 3, kind: "amendment", delta: -3_000_00, total: 394_500_00 },
  ])
  const { rows: [bound] } = await sale.db.query("select contract_id from change_orders where id = $1", [patio.id])
  assert.equal(bound.contract_id, sale.contract.id)
  const { rows: [terms] } = await sale.db.query("select version_number, authorized_total_cents::int as total, original_total_cents::int as original from purchase_agreement_authorized_terms where contract_id = $1", [sale.contract.id])
  assert.deepEqual(terms, { version_number: 3, total: 394_500_00, original: 385_000_00 })
  const { rows: [contract] } = await sale.db.query("select total_cents from contracts where id = $1", [sale.contract.id])
  assert.equal(contract.total_cents, 385_000_00, "the signed agreement itself never changes")
})

test("an amendment needs the buyer's evidence, cannot be voided or repriced, and cannot take the price below zero", async (t) => {
  const sale = await signedAgreement(t)
  const patio = await sale.changeOrder()
  await assert.rejects(sale.approve(patio.id, { approval_method: "manual_offline" }), /needs the buyer's signature/)
  await sale.approve(patio.id, { approval_method: "manual_offline", approved_signed_file_id: "signed-copy" })

  await assert.rejects(sale.db.query("update change_orders set status = 'cancelled', lifecycle = 'void' where id = $1", [patio.id]), /cannot be voided/)
  await assert.rejects(sale.db.query("update change_orders set total_cents = 1 where id = $1", [patio.id]), /price cannot change/)
  await assert.rejects(sale.db.query("update purchase_agreement_versions set authorized_total_cents = 1"), /signed record/)

  const giveaway = await sale.changeOrder({ total_cents: -500_000_00 })
  await assert.rejects(sale.approve(giveaway.id, { approval_method: "portal_native_signature" }), /below zero/)

  // A change that never needed the buyer's signature is not part of the agreement's price.
  const internal = await sale.changeOrder({ requires_signature: false })
  await sale.approve(internal.id, {})
  assert.equal((await sale.versions()).length, 2)
})

test("a member's own approval of an amendment needs change_order.approve and the buyer's signed copy on file, never a signature flag", async (t) => {
  const sale = await signedAgreement(t)
  const { db, orgId, owner, project } = sale
  const superintendent = await seedMember(db, { orgId, role: "org_project_lead" })
  const { rows: [lead] } = await db.query("select id from roles where key = 'org_project_lead'")
  await insert(db, "project_members", { org_id: orgId, project_id: project.id, user_id: superintendent.userId, role_id: lead.id, status: "active" })
  const asMember = (member, id, metadata) => asRole(db, { role: "authenticated", userId: member.userId }, (tx) =>
    tx.query("update change_orders set status = 'approved', lifecycle = 'approved', approved_at = now(), approved_by = $3, metadata = $2 where id = $1",
      [id, JSON.stringify(metadata), member.userId]))
  const patio = await sale.changeOrder()
  await assert.rejects(asMember(owner, patio.id, { approved_via_envelope: "true" }), /recorded when the buyer signs/)
  await assert.rejects(asMember(owner, patio.id, { approval_method: "portal_native_signature" }), /recorded when the buyer signs/)
  await assert.rejects(asMember(owner, patio.id, { approval_method: "manual_offline", approved_signed_file_id: "00000000-0000-4000-8000-000000000001" }), /file on this home/)
  const elsewhere = await insert(db, "projects", { org_id: orgId, name: "Lot 48" })
  const foreign = await insert(db, "files", { org_id: orgId, project_id: elsewhere.id, file_name: "other.pdf", storage_path: `${orgId}/other.pdf`, mime_type: "application/pdf" })
  await assert.rejects(asMember(owner, patio.id, { approval_method: "manual_offline", approved_signed_file_id: foreign.id }), /file on this home/)
  const orgLevel = await insert(db, "files", { org_id: orgId, file_name: "org.pdf", storage_path: `${orgId}/org.pdf`, mime_type: "application/pdf" })
  await assert.rejects(asMember(owner, patio.id, { approval_method: "manual_offline", approved_signed_file_id: orgLevel.id }), /file on this home/)
  const signed = await insert(db, "files", { org_id: orgId, project_id: project.id, file_name: "signed.pdf", storage_path: `${orgId}/signed.pdf`, mime_type: "application/pdf" })
  await assert.rejects(asMember(superintendent, patio.id, { approval_method: "manual_offline", approved_signed_file_id: signed.id }), /needs change_order.approve/)
  await asMember(owner, patio.id, { approval_method: "manual_offline", approved_signed_file_id: signed.id })
  assert.equal((await sale.versions()).length, 2)
  // Binding to the agreement happens at approval, never on a member's insert.
  await assert.rejects(asRole(db, { role: "authenticated", userId: owner.userId }, (tx) =>
    tx.query("insert into change_orders (org_id, project_id, contract_id, title, status, total_cents) values ($1, $2, $3, 'Pool', 'approved', 100)", [orgId, project.id, sale.contract.id])),
  /set when the buyer's signed approval is recorded/)
})

test("a change order out for e-signature is frozen, and its approval is the amount on the signed document", async (t) => {
  const sale = await signedAgreement(t)
  const { db, orgId, project, owner } = sale
  const patio = await sale.changeOrder()
  await insert(db, "change_order_lines", { org_id: orgId, change_order_id: patio.id, description: "Covered patio", quantity: 1, unit_cost_cents: 12_500_00 })
  const file = await insert(db, "files", { org_id: orgId, project_id: project.id, file_name: "co.pdf", storage_path: `${orgId}/co.pdf`, mime_type: "application/pdf" })
  const document = await insert(db, "documents", { org_id: orgId, project_id: project.id, document_type: "change_order", title: "CO 1", source_file_id: file.id, source_entity_type: "change_order", source_entity_id: patio.id })
  const envelope = await insert(db, "envelopes", { org_id: orgId, project_id: project.id, document_id: document.id, status: "draft" })
  await db.query("update envelopes set status = 'sent', sent_at = now() where id = $1", [envelope.id])
  const { rows: [sent] } = await db.query("select metadata from envelopes where id = $1", [envelope.id])
  assert.equal(Number(sent.metadata.change_order_total_cents), 12_500_00, "sending records the total the buyer signs")

  const member = { role: "authenticated", userId: owner.userId }
  await assert.rejects(asRole(db, member, (tx) => tx.query("update change_orders set total_cents = -2000000 where id = $1", [patio.id])), /out for signature/)
  await assert.rejects(db.query("update change_orders set requires_signature = false where id = $1", [patio.id]), /out for signature/)
  await assert.rejects(db.query("insert into change_order_lines (org_id, change_order_id, description, quantity, unit_cost_cents) values ($1, $2, 'Extra', 1, 100)", [orgId, patio.id]), /out for signature/)
  await assert.rejects(db.query("update change_order_lines set unit_cost_cents = 1 where change_order_id = $1", [patio.id]), /out for signature/)

  // An envelope that recorded another amount cannot approve this one.
  await db.query("update envelopes set status = 'executed', metadata = metadata || '{\"change_order_total_cents\": 500000}' where id = $1", [envelope.id])
  await assert.rejects(sale.approve(patio.id, { approved_via_envelope: true, approved_envelope_id: envelope.id }), /signed document shows 500000/)
  await db.query("update envelopes set metadata = metadata || '{\"change_order_total_cents\": 1250000}' where id = $1", [envelope.id])
  await sale.approve(patio.id, { approved_via_envelope: true, approved_envelope_id: envelope.id })
  assert.deepEqual((await sale.versions()).map((row) => row.delta), [385_000_00, 12_500_00])

  // Voided, a change order is editable again.
  const deck = await sale.changeOrder({ title: "Deck" })
  const voided = await insert(db, "envelopes", { org_id: orgId, project_id: project.id, document_id: document.id, status: "draft", source_entity_type: "change_order", source_entity_id: deck.id })
  await db.query("update envelopes set status = 'sent' where id = $1", [voided.id])
  await assert.rejects(db.query("update change_orders set total_cents = 1 where id = $1", [deck.id]), /out for signature/)
  await db.query("update envelopes set status = 'voided', voided_at = now() where id = $1", [voided.id])
  await db.query("update change_orders set total_cents = 1 where id = $1", [deck.id])
})

test("a member never creates, executes, re-terms or voids a purchase agreement through the data API", async (t) => {
  const sale = await signedAgreement(t)
  const { db, orgId, owner, project } = sale
  const asOwner = (sql, params) => asRole(db, { role: "authenticated", userId: owner.userId }, (tx) => tx.query(sql, params))
  const draft = await insert(db, "contracts", { org_id: orgId, project_id: (await insert(db, "projects", { org_id: orgId, name: "Lot 50" })).id,
    title: "Draft", status: "draft", contract_type: "purchase_agreement", total_cents: 300_000_00, snapshot: JSON.stringify({ purchase_agreement: {} }) })
  await assert.rejects(asOwner("insert into contracts (org_id, project_id, title, status, contract_type, total_cents) values ($1, $2, 'Forged', 'active', 'purchase_agreement', 1)", [orgId, project.id]), /created from its reservation/)
  await assert.rejects(asOwner("update contracts set status = 'active', signed_at = now() where id = $1", [draft.id]), /only through the sales desk/)
  await assert.rejects(asOwner("update contracts set snapshot = '{}'::jsonb, buyer_contact_id = null, total_cents = 1 where id = $1", [draft.id]), /only through the sales desk/)
  await assert.rejects(asOwner("update contracts set status = 'void' where id = $1", [sale.contract.id]), /only through the sales desk/)
  await assert.rejects(asOwner("update contracts set number = 'PA-9999', terms = 'Edited', effective_date = '2027-01-01', title = 'Edited' where id = $1", [sale.contract.id]), /only through the sales desk/)
  await assert.rejects(asOwner("delete from contracts where id = $1", [draft.id]), /a record; cancel the sale/)
  // A member still edits an ordinary contract.
  const fixedPrice = await insert(db, "contracts", { org_id: orgId, project_id: project.id, title: "Prime", status: "draft", contract_type: "fixed", total_cents: 100 })
  await asOwner("update contracts set status = 'active', total_cents = 200 where id = $1", [fixedPrice.id])
  const { rows: [{ status }] } = await db.query("select status from contracts where id = $1", [sale.contract.id])
  assert.equal(status, "active")
})

test("cancelling a sale voids it and reconciles what it committed, once, against the plan that was reviewed", async (t) => {
  const sale = await signedAgreement(t)
  const { db, orgId } = sale
  const buyer = await insert(db, "contacts", { org_id: orgId, full_name: "Pat Buyer" })
  const prospect = await insert(db, "prospects", { org_id: orgId, name: "Pat Buyer", status: "won", won_at: new Date() })
  const lot = await insert(db, "lots", { org_id: orgId, community_id: sale.cypress.id, lot_number: "47", status: "started", project_id: sale.project.id })
  const deposit = await insert(db, "invoices", { org_id: orgId, project_id: sale.project.id, invoice_number: "DEP-47", title: "Earnest deposit", status: "paid", total_cents: 10_000_00, balance_due_cents: 0,
    due_date: "2026-09-01", client_visible: true, sent_at: new Date(), metadata: JSON.stringify({ invoice_kind: "earnest_deposit", customer_id: buyer.id }) })
  const payment = await insert(db, "payments", { org_id: orgId, invoice_id: deposit.id, amount_cents: 10_000_00, provider: "manual", status: "succeeded" })
  await insert(db, "payment_reversals", { org_id: orgId, payment_id: payment.id, invoice_id: deposit.id, amount_cents: 1_000_00, reversal_type: "refund", status: "succeeded" })
  const reservation = await insert(db, "lot_reservations", { org_id: orgId, community_id: sale.cypress.id, lot_id: lot.id, status: "converted", buyer_contact_id: buyer.id, prospect_id: prospect.id, contract_id: sale.contract.id, deposit_invoice_id: deposit.id })
  const closing = await insert(db, "closings", { org_id: orgId, project_id: sale.project.id, lot_id: lot.id, community_id: sale.cypress.id, status: "projected" })
  const unsigned = await sale.changeOrder({ title: "Pool" })
  const preview = () => rpc(db, "preview_purchase_agreement_cancellation", { p_org_id: orgId, p_contract_id: sale.contract.id })
  const cancel = (hash) => rpc(db, "void_purchase_agreement_atomic", {
    p_org_id: orgId, p_contract_id: sale.contract.id, p_actor_id: sale.owner.userId, p_reason: "Buyer financing fell through",
    p_deposit_disposition: "split", p_forfeit_cents: 2_500_00, p_expected_plan_hash: hash,
  })

  const plan = await preview()
  assert.deepEqual([plan.deposit.collected_cents, plan.deposit.refunded_cents, plan.deposit.available_cents].map(Number), [10_000_00, 1_000_00, 9_000_00])
  assert.deepEqual(plan.pending_change_orders.map((row) => row.id), [unsigned.id])
  assert.equal(await refusal(cancel(sha(3))), "AGREEMENT_CANCELLATION_CHANGED")

  const { cancellation } = await cancel(plan.hash)
  assert.deepEqual([cancellation.deposit_disposition, Number(cancellation.forfeit_cents), Number(cancellation.refund_cents)], ["split", 2_500_00, 6_500_00])
  const state = async (table, id) => (await db.query(`select status from ${table} where id = $1`, [id])).rows[0].status
  assert.equal(await state("contracts", sale.contract.id), "void")
  assert.equal(await state("lot_reservations", reservation.id), "released")
  assert.equal(await state("prospects", prospect.id), "qualified")
  assert.equal(await state("closings", closing.id), "cancelled")
  assert.equal(await state("change_orders", unsigned.id), "cancelled")
  assert.match(await refusal(cancel(plan.hash)), /Active purchase agreement not found/)
  const { rows: [{ n }] } = await db.query("select count(*)::int n from purchase_agreement_cancellations where contract_id = $1", [sale.contract.id])
  assert.equal(n, 1)
  await assert.rejects(db.query("update purchase_agreement_cancellations set reason = 'Edited'"), /decision cannot change/)
})

test("a sale whose closing is recorded is not cancelled until the closing is reversed", async (t) => {
  const sale = await signedAgreement(t)
  await insert(sale.db, "closings", { org_id: sale.orgId, project_id: sale.project.id, status: "projected" })
  await sale.db.query("set session_replication_role = replica")
  await sale.db.query("update closings set status = 'closed', scheduled_date = current_date, actual_date = current_date where project_id = $1", [sale.project.id])
  await sale.db.query("set session_replication_role = origin")
  const plan = await rpc(sale.db, "preview_purchase_agreement_cancellation", { p_org_id: sale.orgId, p_contract_id: sale.contract.id })
  assert.match(plan.blocked, /Reverse the closing first/)
  await assert.rejects(rpc(sale.db, "void_purchase_agreement_atomic", {
    p_org_id: sale.orgId, p_contract_id: sale.contract.id, p_actor_id: sale.owner.userId, p_reason: "Buyer walked",
    p_deposit_disposition: "refund", p_forfeit_cents: null, p_expected_plan_hash: plan.hash,
  }), /Reverse the closing first/)
})

test("office admins manage agreement templates; sales consultants read them", async (t) => {
  const db = await createDatabase(t)
  const { rows } = await db.query(`
    select array_agg(r.key order by r.key) as roles from role_permissions p join roles r on r.id = p.role_id
    where p.permission_key = 'agreement_template.manage'`)
  assert.deepEqual(rows[0].roles, ["org_admin", "org_office_admin", "org_owner"])
})
