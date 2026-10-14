"use strict"

/**
 * The database contract behind `lib/services/selection-approvals.ts`: a buyer
 * approves exactly the selections and prices that were sent, identified by one
 * terms hash. A change after sending voids the request and its signing
 * envelope; a stale hash approves nothing; the signed price is the confirmed
 * price even when the catalog moved; declined, expired and voided stay
 * distinct; and nothing here is writable by a signed-in member.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember } = require("./support/pglite")

async function home(t, { cutoff = "2099-06-30" } = {}) {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db)
  const buyer = await insert(db, "contacts", { org_id: orgId, full_name: "Dana Buyer", email: "dana@example.test" })
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 7", client_id: buyer.id })
  const group = await insert(db, "selection_groups", { org_id: orgId, name: "Interior", schedule_task_key: "drywall", cutoff_offset_days: -7 })
  const instance = await insert(db, "project_selection_groups", { org_id: orgId, project_id: project.id, group_id: group.id, cutoff_date: cutoff })
  const selection = async (name, price) => {
    const category = await insert(db, "selection_categories", { org_id: orgId, name })
    const option = await insert(db, "selection_options", { org_id: orgId, category_id: category.id, name: `${name} upgrade`, price_cents: price })
    const alternative = await insert(db, "selection_options", { org_id: orgId, category_id: category.id, name: `${name} standard`, price_cents: 0 })
    const row = await insert(db, "project_selections", {
      org_id: orgId, project_id: project.id, category_id: category.id, group_id: group.id,
      selected_option_id: option.id, price_cents_snapshot: price, cost_cents_snapshot: price / 2, status: "selected",
    })
    return { ...row, option, alternative }
  }
  const kitchen = await selection("Kitchen", 4_500_00)
  const flooring = await selection("Flooring", 2_000_00)
  const terms = async () => rpc(db, "selection_terms", { p_org_id: orgId, p_project_id: project.id, p_group_id: group.id })
  return { db, orgId, userId, buyer, project, group, instance, kitchen, flooring, terms }
}

const send = (fixture, channel, hash) => rpc(fixture.db, "send_selection_approval", {
  p_org_id: fixture.orgId, p_project_id: fixture.project.id, p_group_id: fixture.group.id, p_channel: channel,
  p_expected_terms_hash: hash, p_actor_id: fixture.userId,
})

const approveInPortal = (fixture, hash) => rpc(fixture.db, "approve_selection_terms", {
  p_org_id: fixture.orgId, p_project_id: fixture.project.id, p_group_id: fixture.group.id, p_channel: "portal",
  p_terms_hash: hash, p_contact_id: fixture.buyer.id,
})

const approvalStatus = async (db, id) => (await db.query("select status from selection_approvals where id = $1", [id])).rows[0].status
const selectionStatuses = async (db) => (await db.query("select status from project_selections order by id")).rows.map((row) => row.status)
const refusal = (detail) => (error) => error.detail === detail

/** Publishes the e-sign request the way the service does, with a generated PDF on the home. */
async function sendForSignature(fixture) {
  const { db, orgId, userId, project } = fixture
  const approval = await send(fixture, "esign", (await fixture.terms()).terms_hash)
  const file = await insert(db, "files", {
    org_id: orgId, project_id: project.id, file_name: "selections.pdf", storage_path: `${orgId}/selections.pdf`,
    mime_type: "application/pdf", source: "generated", visibility: "private", checksum: "a".repeat(64), size_bytes: 2048,
  })
  await rpc(db, "reserve_selection_approval_document", { p_org_id: orgId, p_approval_id: approval.id, p_actor_id: userId, p_file_id: file.id, p_title: "Interior selections" })
  const envelopeId = await rpc(db, "publish_selection_approval_document", {
    p_org_id: orgId, p_approval_id: approval.id, p_actor_id: userId,
    p_source: JSON.stringify({ file_id: file.id, sha256: "a".repeat(64), size_bytes: 2048, storage_path: file.storage_path }),
    p_subject: "Approve your interior selections", p_message: null,
  })
  return { approval, envelopeId }
}

test("sending freezes every selection's option and price under one hash, and only for the terms that were reviewed", async (t) => {
  const fixture = await home(t)
  const { db } = fixture
  const terms = await fixture.terms()
  assert.equal(terms.total_cents, 6_500_00)
  await assert.rejects(send(fixture, "portal", "0".repeat(64)), refusal("SELECTION_TERMS_CHANGED"))

  const approval = await send(fixture, "portal", terms.terms_hash)
  assert.equal(approval.status, "sent")
  assert.equal(approval.terms_hash, terms.terms_hash)
  assert.equal(new Date(approval.expires_at).toISOString(), "2099-07-01T04:00:00.000Z")
  const { rows: lines } = await db.query("select option_name, price_cents from selection_approval_lines where approval_id = $1 order by price_cents", [approval.id])
  assert.deepEqual(lines, [{ option_name: "Flooring upgrade", price_cents: 2_000_00 }, { option_name: "Kitchen upgrade", price_cents: 4_500_00 }])
  await assert.rejects(send(fixture, "esign", terms.terms_hash), refusal("SELECTION_APPROVAL_PENDING"))
})

test("a change after sending voids the request and its signing envelope", async (t) => {
  const fixture = await home(t)
  const { db } = fixture
  const { approval, envelopeId } = await sendForSignature(fixture)
  const { rows: [envelope] } = await db.query("select status, metadata->>'selection_terms_hash' as hash from envelopes where id = $1", [envelopeId])
  assert.deepEqual(envelope, { status: "sent", hash: approval.terms_hash })

  await db.query("update project_selections set selected_option_id = $2, price_cents_snapshot = 0 where id = $1", [fixture.kitchen.id, fixture.kitchen.alternative.id])
  assert.equal(await approvalStatus(db, approval.id), "voided")
  const { rows: [after] } = await db.query("select status from envelopes where id = $1", [envelopeId])
  assert.equal(after.status, "voided")
  // Locking the group is not a change to what was sent.
  const portal = await send(fixture, "portal", (await fixture.terms()).terms_hash)
  await db.query("update project_selections set locked_at = now()")
  assert.equal(await approvalStatus(db, portal.id), "sent")
})

test("the buyer's portal approval binds the hash they saw, at the price that was sent", async (t) => {
  const fixture = await home(t)
  const { db } = fixture
  const seen = (await fixture.terms()).terms_hash
  await db.query("update project_selections set selected_option_id = $2, price_cents_snapshot = 0 where id = $1", [fixture.flooring.id, fixture.flooring.alternative.id])
  await assert.rejects(approveInPortal(fixture, seen), refusal("SELECTION_TERMS_CHANGED"))
  assert.deepEqual(await selectionStatuses(db), ["selected", "selected"])

  const fresh = (await fixture.terms()).terms_hash
  await db.query("update selection_options set price_cents = 9900000 where id = $1", [fixture.kitchen.option.id])
  const approval = await approveInPortal(fixture, fresh)
  assert.equal(approval.status, "approved")
  assert.equal(approval.channel, "portal")
  assert.equal(approval.approved_by_contact_id, fixture.buyer.id)
  const { rows } = await db.query("select status, price_cents_snapshot from project_selections where id = $1", [fixture.kitchen.id])
  assert.deepEqual(rows[0], { status: "confirmed", price_cents_snapshot: 4_500_00 })
  await assert.rejects(approveInPortal(fixture, fresh), refusal("SELECTION_ALREADY_APPROVED"))
})

test("a signature made before the cutoff lands at the signed terms after the group locked", async (t) => {
  const fixture = await home(t)
  const { db, orgId } = fixture
  const { approval, envelopeId } = await sendForSignature(fixture)
  await db.query("update document_signing_requests set status = 'signed', signed_at = now() where envelope_id = $1", [envelopeId])
  await db.query("update envelopes set status = 'executed', executed_at = now() where id = $1", [envelopeId])
  await db.query("update project_selection_groups set status = 'locked', locked_at = now()")
  await db.query("update project_selections set locked_at = now()")

  const evidence = JSON.stringify({ executed_file_id: null, signer_name: "Dana Buyer", signer_email: "dana@example.test" })
  const outcome = await rpc(db, "approve_selection_approval_from_envelope", { p_org_id: orgId, p_approval_id: approval.id, p_envelope_id: envelopeId, p_evidence: evidence })
  assert.equal(outcome.outcome, "approved")
  assert.deepEqual(await selectionStatuses(db), ["confirmed", "confirmed"])
  const again = await rpc(db, "approve_selection_approval_from_envelope", { p_org_id: orgId, p_approval_id: approval.id, p_envelope_id: envelopeId, p_evidence: evidence })
  assert.equal(again.idempotent, true)
  const { rows: events } = await db.query("select event_type from events where entity_id = $1 order by created_at, event_type", [approval.id])
  assert.deepEqual(events.map((event) => event.event_type), ["selection_approval_sent", "selection_approval_approved"])
})

test("an envelope that does not carry the request approves nothing", async (t) => {
  const fixture = await home(t)
  const { db, orgId } = fixture
  const { approval } = await sendForSignature(fixture)
  const other = await sendForSignature(await home(t))
  await assert.rejects(
    rpc(db, "approve_selection_approval_from_envelope", { p_org_id: orgId, p_approval_id: approval.id, p_envelope_id: other.envelopeId, p_evidence: "{}" }),
    /does not carry that approval/,
  )
})

test("declined, voided and expired stay distinct, and each group can be sent again", async (t) => {
  const declined = await home(t)
  const { approval: declinedApproval, envelopeId } = await sendForSignature(declined)
  const { rows: [request] } = await declined.db.query("select id from document_signing_requests where envelope_id = $1", [envelopeId])
  await rpc(declined.db, "cancel_esign_envelope", { p_org_id: declined.orgId, p_envelope_id: envelopeId, p_reason: "Wrong cabinets", p_request_id: request.id })
  const { rows: [decline] } = await declined.db.query("select status, decline_reason from selection_approvals where id = $1", [declinedApproval.id])
  assert.deepEqual(decline, { status: "declined", decline_reason: "Wrong cabinets" })

  const expired = await home(t)
  const { approval: expiredApproval, envelopeId: expiringEnvelope } = await sendForSignature(expired)
  await expired.db.query("update envelopes set status = 'expired' where id = $1", [expiringEnvelope])
  assert.equal(await approvalStatus(expired.db, expiredApproval.id), "expired")

  const portal = await home(t)
  const portalApproval = await send(portal, "portal", (await portal.terms()).terms_hash)
  await rpc(portal.db, "void_selection_approval", { p_org_id: portal.orgId, p_approval_id: portalApproval.id, p_actor_id: portal.userId, p_reason: "Buyer asked to change flooring" })
  assert.equal(await approvalStatus(portal.db, portalApproval.id), "voided")

  for (const fixture of [declined, expired, portal]) {
    assert.deepEqual(await selectionStatuses(fixture.db), ["selected", "selected"])
    await send(fixture, "portal", (await fixture.terms()).terms_hash)
  }
  const { rows: queued } = await declined.db.query("select payload->>'status' as status from outbox where job_type = 'notify_selection_approval_outcome'")
  assert.deepEqual(queued.map((row) => row.status), ["declined"])
})

test("a request past its deadline expires on the sweep", async (t) => {
  const fixture = await home(t)
  const { db } = fixture
  const approval = await send(fixture, "portal", (await fixture.terms()).terms_hash)
  await db.query("alter table selection_approvals disable trigger selection_approvals_lifecycle")
  await db.query("update selection_approvals set expires_at = now() - interval '1 minute' where id = $1", [approval.id])
  await db.query("alter table selection_approvals enable trigger selection_approvals_lifecycle")
  const swept = await rpc(db, "expire_selection_approvals", { p_limit: 10 })
  assert.deepEqual(swept.map((row) => row.id), [approval.id])
  assert.equal(await approvalStatus(db, approval.id), "expired")
})

test("an in-person approval needs a signed copy uploaded for it, once", async (t) => {
  const fixture = await home(t)
  const { db, orgId, userId, project } = fixture
  const hash = (await fixture.terms()).terms_hash
  const inPerson = (fileId) => rpc(db, "approve_selection_terms", {
    p_org_id: orgId, p_project_id: project.id, p_group_id: fixture.group.id, p_channel: "in_person",
    p_terms_hash: hash, p_user_id: userId, p_signed_copy_file_id: fileId,
  })
  const upload = (overrides) => insert(db, "files", {
    org_id: orgId, project_id: project.id, file_name: "signed.pdf", storage_path: `${orgId}/${Math.random()}.pdf`,
    mime_type: "application/pdf", category: "contracts", uploaded_by: userId, ...overrides,
  })
  const elsewhere = await insert(db, "projects", { org_id: orgId, name: "Lot 9" })
  const { userId: someoneElse } = await seedMember(db, { orgId })
  const refusedFiles = [
    await upload({ project_id: elsewhere.id }),
    await upload({ category: "photos" }),
    await upload({ mime_type: "text/plain" }),
    await upload({ uploaded_by: someoneElse }),
    await upload({ created_at: new Date(Date.now() - 3 * 3600_000).toISOString() }),
    await upload({ source: "generated" }),
  ]
  for (const file of refusedFiles) await assert.rejects(inPerson(file.id), refusal("SELECTION_SIGNED_COPY_REQUIRED"))
  const signed = await upload({})
  const approval = await inPerson(signed.id)
  assert.deepEqual([approval.status, approval.channel, approval.signed_copy_file_id], ["approved", "in_person", signed.id])

  // A signed copy is one approval's evidence; it is never cited again.
  await assert.rejects(inPerson(signed.id), refusal("SELECTION_SIGNED_COPY_REQUIRED"))
})

test("resending the signing envelope reissues it and keeps the request, which then approves from the replacement", async (t) => {
  const fixture = await home(t)
  const { db, orgId, userId } = fixture
  const { approval, envelopeId } = await sendForSignature(fixture)
  const replacementId = await rpc(db, "resend_esign_envelope", { p_org_id: orgId, p_envelope_id: envelopeId, p_actor_id: userId })
  assert.notEqual(replacementId, envelopeId)
  const { rows: [kept] } = await db.query("select status, envelope_id, document_id from selection_approvals where id = $1", [approval.id])
  const { rows: [replacement] } = await db.query("select status, document_id from envelopes where id = $1", [replacementId])
  assert.deepEqual([kept.status, kept.envelope_id, kept.document_id], ["sent", replacementId, replacement.document_id])
  assert.equal((await db.query("select status from envelopes where id = $1", [envelopeId])).rows[0].status, "voided")

  const outcome = await rpc(db, "approve_selection_approval_from_envelope", { p_org_id: orgId, p_approval_id: approval.id, p_envelope_id: replacementId, p_evidence: "{}" })
  assert.equal(outcome.outcome, "approved")
  // Voiding the replacement by hand still voids a request that is out.
  const again = await home(t)
  const second = await sendForSignature(again)
  const replaced = await rpc(again.db, "resend_esign_envelope", { p_org_id: again.orgId, p_envelope_id: second.envelopeId, p_actor_id: again.userId })
  await rpc(again.db, "cancel_esign_envelope", { p_org_id: again.orgId, p_envelope_id: replaced, p_reason: "Buyer changed their mind" })
  assert.equal(await approvalStatus(again.db, second.approval.id), "voided")

  // The words of a resend's reason are not the signal: a plain void that quotes them still voids the request.
  const quoting = await home(t)
  const third = await sendForSignature(quoting)
  await rpc(quoting.db, "cancel_esign_envelope", { p_org_id: quoting.orgId, p_envelope_id: third.envelopeId, p_reason: "Superseded by new signature copy" })
  assert.equal(await approvalStatus(quoting.db, third.approval.id), "voided")
})

test("a signed-in member writes no approval, no line and no approval document", async (t) => {
  const fixture = await home(t)
  const { db, orgId, userId, project } = fixture
  const approval = await send(fixture, "portal", (await fixture.terms()).terms_hash)
  const asMember = (sql, params) => asRole(db, { role: "authenticated", userId }, (tx) => tx.query(sql, params))

  const { rows } = await asMember("select id from selection_approvals")
  assert.deepEqual(rows.map((row) => row.id), [approval.id])
  for (const [sql, params] of [
    ["update selection_approvals set status = 'approved', approved_at = now() where id = $1", [approval.id]],
    ["insert into selection_approvals (org_id, project_id, channel, status, terms_hash, total_cents) values ($1, $2, 'portal', 'approved', $3, 0)", [orgId, project.id, "b".repeat(64)]],
    ["update selection_approval_lines set price_cents = 1 where approval_id = $1", [approval.id]],
    ["delete from selection_approvals where id = $1", [approval.id]],
    ["insert into documents (org_id, project_id, title, document_type, source_entity_type, source_entity_id) values ($1, $2, 'Forged', 'other', 'selection_approval', $3)", [orgId, project.id, approval.id]],
  ]) {
    await assert.rejects(asMember(sql, params), (error) => error.code === "42501" || /permission denied/.test(error.message), sql)
  }
  assert.equal(await approvalStatus(db, approval.id), "sent")
  await assert.rejects(db.query("update selection_approvals set terms_hash = $2 where id = $1", [approval.id, "c".repeat(64)]), /never changes/)
})

test("a signature request on a single selection is retired: none can be created, even by the service", async (t) => {
  const fixture = await home(t)
  const { db, orgId, project } = fixture
  const pdf = await insert(db, "files", { org_id: orgId, project_id: project.id, file_name: "kitchen.pdf", storage_path: `${orgId}/kitchen.pdf`, mime_type: "application/pdf" })
  const document = await insert(db, "documents", { org_id: orgId, project_id: project.id, title: "Kitchen selection", document_type: "other", source_file_id: pdf.id, source_entity_type: "selection", source_entity_id: fixture.kitchen.id })
  await assert.rejects(
    insert(db, "envelopes", { org_id: orgId, project_id: project.id, document_id: document.id, status: "draft", source_entity_type: "selection", source_entity_id: fixture.kitchen.id }),
    /sending the group for approval/,
  )
})
