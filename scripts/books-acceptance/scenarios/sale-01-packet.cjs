// SALE-01 subcases for EP05-03 (agreement packet versions) and EP05-07 (amendments and
// cancellation). Composed into sale-01.cjs by the lead; each subcase is
// `async (kit, expected, check)` and acts through `kit.as`, so permissions and row security are
// the real ones:
//
//   agreement-packet-follows-community-and-state   EP05-03  the most specific agreement, every required addendum, only the optional ones picked
//   published-agreement-versions-are-immutable      EP05-03  a published version never changes; v2 supersedes v1; a draft keeps v1 pinned
//   signing-is-refused-without-a-required-addendum  EP05-03  a newly required addendum or a withdrawn version makes the draft stale until refreshed
//   no-agreement-without-a-published-template       EP05-03  a state with no published agreement cannot be sold
//   agreement-packet-hash-binds-snapshot-and-signing EP05-03 the resolver's hash is the snapshot's, the signature's and version 1's
//   signed-change-orders-version-the-agreement      EP05-07  buyer-signed change orders are versions 2 and 3; the signed agreement never changes
//   amendment-requires-the-buyers-signature         EP05-07  no offline approval without the signed copy, no void of an amendment, none on a voided sale
//   resold-home-settles-only-its-own-amendments     EP05-07  a cancelled buyer's amendment never prices the next buyer's sale
//   cancelling-a-sale-reconciles-what-was-committed EP05-07  void, unsigned change orders, the lot, the split deposit and portal access, from one receipt
//   settled-sale-cannot-be-voided                    EP05-07  a recorded closing is reversed first
//
// Every subcase runs in one org of its own (`packetOrg`), so publishing and withdrawing documents
// never changes another module's sales. The stack has no file storage: a template version is a file
// row and a checksum, inserted as a draft by SQL (the upload is not what these subcases are about);
// publishing and withdrawing go through the template service. Rendering the packet needs
// --storage-env, so `source_sha256` is asserted only when storage is configured.
//
// Expected values (expected/SALE-01.json, under each subcase's `expected`) are the observed objects
// below; every amount follows from the inputs in the code: the community sheet prices The plan at
// org.plans[0]'s base, change orders are +$12,500 and -$3,000, a resale buyer's prior amendment is
// +$20,000, and the cancelled deposit is $10,000 split $2,500 forfeited / $7,500 refunded.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const fx = require("./lot-01-sales-fixtures.cjs")
const { app } = require("./shared.cjs")

const lot = () => require("./lot-01.cjs").helpers
const equal = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const attempt = async (work) => {
  try { await work(); return "allowed" } catch (error) { return error.code ?? error.message }
}

/**
 * A member's write straight through the data API (PostgREST with their session), as a script
 * or a browser console would send it: what the database itself allows a member.
 */
const viaDataApi = (kit, actor, table, id, patch) => attempt(() => kit.as(actor, async () => {
  const { supabase } = await require("../../../lib/services/context").requireOrgContext()
  const { data, error } = await supabase.from(table).update(patch).eq("id", id).select("id")
  if (error) throw new Error(error.message)
  if (!data?.length) throw new Error("no row updated")
}))
const deskOnly = (text) => (/change only through the sales desk/.test(text) ? "refused: sales desk only" : text)

const PACKET_ORGS = new WeakMap()
/** A production builder with Cypress Landing (FL), the plans and the base agreement seeded. Built once per run. */
function packetOrg(kit) {
  if (!PACKET_ORGS.has(kit)) PACKET_ORGS.set(kit, (async () => {
    const org = await seed.productionBuilder(kit, { name: "SALE-01 agreement packets" })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    return org
  })())
  return PACKET_ORGS.get(kit)
}

/** A draft version of the org's own document, as an upload would leave it, then published by the owner. */
async function publish(kit, org, { kind, name, title, states = [], communityIds = [], required = false, templateId = null }) {
  const q = kit.q, fileId = randomUUID(), versionId = randomUUID(), familyId = templateId ?? randomUUID()
  const next = templateId ? Number(kit.rows(`select max(version_number)::int n from public.agreement_template_versions where template_id=${q(templateId)}`)[0].n) + 1 : 1
  kit.sql(`begin;
insert into public.files(id,org_id,file_name,storage_path,mime_type,size_bytes) values(${q(fileId)},${q(org.orgId)},${q(`${name}.pdf`)},${q(`acceptance/${fileId}.pdf`)},'application/pdf',24000);
${templateId ? "" : `insert into public.agreement_templates(id,org_id,kind,name,created_by) values(${q(familyId)},${q(org.orgId)},${q(kind)},${q(name)},${q(org.owner.userId)});`}
insert into public.agreement_template_versions(id,org_id,template_id,version_number,title,required,applies_to_states,source_file_id,content_sha256,size_bytes,page_count,storage_path,created_by)
  values(${q(versionId)},${q(org.orgId)},${q(familyId)},${next},${q(title)},${required},${q(`{${states.join(",")}}`)}::text[],${q(fileId)},${q(randomUUID().replace(/-/g, "").padEnd(64, "0"))},24000,6,${q(`acceptance/${fileId}.pdf`)},${q(org.owner.userId)});
${communityIds.map((id) => `insert into public.agreement_template_version_communities(org_id,version_id,community_id) values(${q(org.orgId)},${q(versionId)},${q(id)});`).join("\n")}
commit;`)
  await kit.as(org.owner, () => app("agreement-templates").publishAgreementTemplateVersion({ versionId }))
  return { templateId: familyId, versionId }
}

const titles = (packet) => packet.documents.map((row) => `${row.title} v${row.version_number}`)
const preview = (kit, org, input) => kit.as(org.team.sales, () => app("community-sales").previewAgreementPacket(input))

/** A buyer reserved on a fresh Cypress Landing lot, and the agreement written for them but not yet signed. */
async function draftSale(kit, org, name) {
  const buyer = await fx.reservedBuyer(kit, org, { name, depositCents: 500000, receivedOn: null })
  const sales = app("community-sales")
  const config = seed.configuration(org, { lotId: buyer.lot.id, plan: org.plans[0], swing: "right" })
  const quote = await kit.as(org.team.sales, () => sales.priceAgreementDraft(config))
  await kit.as(org.team.sales, () => sales.createPurchaseAgreement({ ...config, ...seed.agreementPacketFor(kit, org, buyer.lot.id), reservationId: buyer.reservation.id, expectedQuoteHash: quote.quoteHash }))
    .catch((error) => { if (!/^Missing (R2 credentials|DOCUMENT_SIGNING_SECRET)/.test(error.message)) throw error })
  const contractId = kit.rows(`select contract_id from public.lot_reservations where id=${kit.q(buyer.reservation.id)}`)[0].contract_id
  return { buyer, contractId, quote }
}

const packetOf = (kit, contractId) => kit.rows(`select snapshot->'purchase_agreement'->'packet' packet from public.contracts where id=${kit.q(contractId)}`)[0].packet

// ---------------------------------------------------------------------------
// EP05-03

async function agreementPacketFollowsCommunityAndState(kit, expected, check) {
  const org = await packetOrg(kit)
  const communities = app("communities")
  const georgia = await kit.as(org.owner, () => communities.createCommunity({ name: "Peach Grove", code: "PGV", divisionId: org.divisionId, status: "active", city: "Savannah", state: "GA", postalCode: "31401", plannedLotCount: 2, targetAbsorptionPerMonth: 1 }))
  await publish(kit, org, { kind: "agreement", name: "Georgia agreement", title: "Georgia purchase agreement", states: ["GA"] })
  await publish(kit, org, { kind: "agreement", name: "Cypress agreement", title: "Cypress Landing purchase agreement", communityIds: [org.communityId] })
  await publish(kit, org, { kind: "addendum", name: "HOA", title: "HOA disclosure", states: ["FL"], required: true })
  const waterfront = await publish(kit, org, { kind: "addendum", name: "Waterfront", title: "Waterfront addendum", states: ["FL"] })
  const georgiaOnly = await publish(kit, org, { kind: "addendum", name: "Georgia disclosure", title: "Georgia disclosure", states: ["GA"], required: true })
  const home = await fx.newLot(kit, org)

  const base = (await preview(kit, org, { lotId: home.id })).packet
  const picked = (await preview(kit, org, { lotId: home.id, optionalAddendumTemplateIds: [waterfront.templateId] })).packet
  const inapplicable = await attempt(() => preview(kit, org, { lotId: home.id, optionalAddendumTemplateIds: [georgiaOnly.templateId] }))
  const georgiaPacket = kit.rows(`select public.resolve_agreement_packet(${kit.q(org.orgId)},${kit.q(georgia.id)},'[]'::jsonb) packet`)[0].packet
  equal(check, "a Cypress Landing home gets the community's agreement and the required Florida addendum; an optional addendum only when picked; a Georgia addendum is refused", expected.expected, {
    jurisdiction: base.jurisdiction,
    documents: titles(base),
    offered: base.optional_offered.map((row) => row.title),
    withWaterfront: titles(picked),
    hashChangesWithThePick: base.hash !== picked.hash,
    inapplicableAddendum: inapplicable,
    georgia: titles(georgiaPacket),
  })
  return { orgId: org.orgId }
}

async function publishedAgreementVersionsAreImmutable(kit, expected, check) {
  const org = await packetOrg(kit)
  const templates = app("agreement-templates")
  const family = await publish(kit, org, { kind: "addendum", name: "Warranty addendum", title: "Limited warranty addendum", states: ["FL"], required: true })
  const pinned = await draftSale(kit, org, "Pinned Buyer")
  const editPublished = await attempt(() => kit.as(org.owner, () => templates.updateAgreementTemplateDraft({ versionId: family.versionId, title: "Edited after publication", required: true, states: ["FL"], communityIds: [] })))
  const sqlEdit = (() => { try { kit.sql(`update public.agreement_template_versions set content_sha256=${kit.q("f".repeat(64))} where id=${kit.q(family.versionId)}`); return "allowed" } catch (error) { return /cannot change/.test(error.message) ? "refused: document is immutable" : error.message } })()
  const consultantPublishes = await attempt(() => kit.as(org.team.sales, () => templates.publishAgreementTemplateVersion({ versionId: family.versionId })))
  const second = await publish(kit, org, { kind: "addendum", name: "Warranty addendum", title: "Limited warranty addendum", states: ["FL"], required: true, templateId: family.templateId })
  const statuses = kit.rows(`select version_number, status from public.agreement_template_versions where template_id=${kit.q(family.templateId)} order by version_number`)
  const later = await draftSale(kit, org, "Later Buyer")
  const versionIn = (contractId) => packetOf(kit, contractId).documents.find((row) => row.template_id === family.templateId)?.version_number ?? null
  equal(check, "a published version cannot be edited; publishing v2 supersedes v1; a draft written before keeps v1 and a new one gets v2", expected.expected, {
    editPublished: /Only a draft version/.test(editPublished) ? "refused: only drafts are edited" : editPublished,
    sqlEdit,
    consultantPublishes: /agreement_template\.manage|Missing permission|^AUTH_FORBIDDEN$/.test(consultantPublishes) ? "refused: needs agreement template management" : consultantPublishes,
    statuses: statuses.map((row) => `v${row.version_number} ${row.status}`),
    pinnedDraft: versionIn(pinned.contractId),
    newDraft: versionIn(later.contractId),
    secondIsLive: second.versionId === kit.rows(`select current_version_id from public.agreement_templates where id=${kit.q(family.templateId)}`)[0].current_version_id,
  })
  return { orgId: org.orgId }
}

async function signingIsRefusedWithoutARequiredAddendum(kit, expected, check) {
  const org = await packetOrg(kit)
  const sales = app("community-sales"), signing = app("agreement-signing-status"), templates = app("agreement-templates")
  const sale = await draftSale(kit, org, "Stale Packet Buyer")
  const stage = async () => (await kit.as(org.team.sales, () => signing.getAgreementSigningState(sale.contractId))).stage
  const before = await stage()
  const flood = await publish(kit, org, { kind: "addendum", name: "Flood zone", title: "Flood zone disclosure", states: ["FL"], required: true })
  const afterRequired = await stage()
  const reviewed = (await preview(kit, org, { contractId: sale.contractId })).packet
  const staleRefresh = await attempt(() => kit.as(org.team.sales, () => sales.refreshPurchaseAgreementPacket({ contractId: sale.contractId, expectedPacketHash: "0".repeat(64) })))
  await kit.as(org.team.sales, () => sales.refreshPurchaseAgreementPacket({ contractId: sale.contractId, expectedPacketHash: reviewed.hash }))
  const afterRefresh = await stage()
  await kit.as(org.owner, () => templates.withdrawAgreementTemplateVersion({ versionId: flood.versionId, reason: "Counsel recalled the flood disclosure" }))
  const afterWithdrawal = await stage()
  // The draft cannot be executed or re-termed by a member writing the row directly.
  const memberActivates = deskOnly(await viaDataApi(kit, org.team.sales, "contracts", sale.contractId, { status: "active", signed_at: new Date().toISOString() }))
  const memberEditsSnapshot = deskOnly(await viaDataApi(kit, org.team.sales, "contracts", sale.contractId, { snapshot: {}, total_cents: 1 }))
  equal(check, "a newly required addendum and a withdrawn version each make the unsigned draft stale; a refresh on the reviewed packet clears it", expected.expected, {
    before, afterRequired, staleRefresh, afterRefresh, afterWithdrawal,
    refreshedDocuments: titles(packetOf(kit, sale.contractId)).length,
    memberActivates, memberEditsSnapshot,
    stillDraft: kit.rows(`select status from public.contracts where id=${kit.q(sale.contractId)}`)[0].status,
  })
  return { orgId: org.orgId, contractId: sale.contractId }
}

async function noAgreementWithoutAPublishedTemplate(kit, expected, check) {
  const org = await packetOrg(kit)
  const communities = app("communities")
  const texas = await kit.as(org.owner, () => communities.createCommunity({ name: "Bluebonnet Ranch", code: "BBR", divisionId: org.divisionId, status: "active", city: "Austin", state: "TX", postalCode: "78701", plannedLotCount: 1, targetAbsorptionPerMonth: 1 }))
  const resolved = (() => { try { kit.rows(`select public.resolve_agreement_packet(${kit.q(org.orgId)},${kit.q(texas.id)},'[]'::jsonb)`); return "allowed" } catch (error) { return /No published purchase agreement/.test(error.message) ? "AGREEMENT_PACKET_UNAVAILABLE" : error.message } })()
  // The org publishes agreements for Florida and Georgia only.
  equal(check, "a home in a state no published agreement covers resolves to no packet, so no agreement can be written for it", expected.expected, { texas: resolved })
  return { orgId: org.orgId }
}

async function agreementPacketHashBindsSnapshotAndSigning(kit, expected, check) {
  const org = await packetOrg(kit)
  const buyer = await fx.reservedBuyer(kit, org, { name: "Bound Packet", depositCents: 500000, receivedOn: null })
  const resolved = seed.agreementPacketFor(kit, org, buyer.lot.id).expectedPacketHash
  const sale = await fx.agreementFor(kit, org, buyer)
  const contract = kit.rows(`select snapshot->'purchase_agreement'->'packet'->>'hash' snapshot_hash, signature_data->>'packet_hash' signed_hash, signature_data->>'source_sha256' source from public.contracts where id=${kit.q(sale.contractId)}`)[0]
  const original = kit.rows(`select version_number, kind, scope->'packet'->>'hash' hash from public.purchase_agreement_versions where contract_id=${kit.q(sale.contractId)} order by version_number`)
  equal(check, "the packet the resolver hashed is the snapshot's, the executed signature's and version 1's", expected.expected, {
    snapshotIsResolved: contract.snapshot_hash === resolved,
    signatureBindsPacket: contract.signed_hash === resolved,
    versions: original.map((row) => ({ version: row.version_number, kind: row.kind, bindsPacket: row.hash === resolved })),
    sourceBytesBound: process.env.ACCEPTANCE_STORAGE_ENV ? /^[0-9a-f]{64}$/.test(contract.source ?? "") : "requires storage",
  })
  return { orgId: org.orgId, contractId: sale.contractId }
}

// ---------------------------------------------------------------------------
// EP05-07

/** A change order on the home, priced, buyer-facing, needing the buyer's signature. */
const changeOrder = (kit, org, projectId, title, cents) => kit.as(org.owner, () => app("change-orders").createChangeOrder({ input: {
  project_id: projectId, title, summary: title, tax_rate: 0, markup_percent: 0, markup_mode: "percent", requires_signature: true, client_visible: true,
  lines: [{ description: title, quantity: 1, unit_cost: cents / 100, taxable: false }],
} }))
const buyerSigns = (kit, org, projectId, changeOrderId, signerName) => kit.service(() => app("change-orders").approveChangeOrderFromPortalSignature({
  orgId: org.orgId, projectId, changeOrderId, signerName, signerEmail: null, signatureImage: "data:image/png;base64,iVBORw0KGgo=", signerIp: "203.0.113.7",
}))
const versionsOf = (kit, contractId) => kit.rows(`select version_number, kind, price_delta_cents::bigint delta, authorized_total_cents::bigint total from public.purchase_agreement_versions where contract_id=${kit.q(contractId)} order by version_number`)
  .map((row) => ({ version: row.version_number, kind: row.kind, deltaCents: Number(row.delta), authorizedCents: Number(row.total) }))

async function signedChangeOrdersVersionTheAgreement(kit, expected, check) {
  const org = await packetOrg(kit)
  const buyer = await fx.reservedBuyer(kit, org, { name: "Versioned Buyer", depositCents: 500000, receivedOn: null })
  const sale = await fx.agreementFor(kit, org, buyer)
  const signed = kit.rows(`select total_cents, snapshot from public.contracts where id=${kit.q(sale.contractId)}`)[0]
  const kitchen = await changeOrder(kit, org, sale.projectId, "Upgraded kitchen", 12_500_00)
  await buyerSigns(kit, org, sale.projectId, kitchen.id, "Versioned Buyer")
  const fireplace = await changeOrder(kit, org, sale.projectId, "Delete fireplace", -3_000_00)
  const signedFileId = seed.signedCopyFile(kit, org, sale.projectId, "fireplace-signed.pdf")
  await kit.as(org.owner, () => app("change-orders").approveChangeOrder({ changeOrderId: fireplace.id, approval: { signerName: "Versioned Buyer", note: "Signed at the design center", signedFileId } }))
  const settlement = await kit.as(org.owner, () => app("closings").buildSettlement(fx.closingOf(kit, sale.projectId)))
  const after = kit.rows(`select total_cents, snapshot from public.contracts where id=${kit.q(sale.contractId)}`)[0]
  equal(check, "the signed agreement is version 1, each change order the buyer signed is the next, and the settlement prices the head", expected.expected, {
    versions: versionsOf(kit, sale.contractId).map((row) => ({ ...row, deltaCents: row.kind === "original" ? "agreement price" : row.deltaCents, authorizedCents: row.authorizedCents - Number(signed.total_cents) })),
    signedAgreementUntouched: Number(after.total_cents) === Number(signed.total_cents) && JSON.stringify(after.snapshot) === JSON.stringify(signed.snapshot),
    settlementAmendmentsCents: settlement.components.approvedChangeOrdersCents,
    settlementOverAgreementCents: settlement.finalPriceCents - Number(signed.total_cents),
  })
  return { orgId: org.orgId, contractId: sale.contractId }
}

async function amendmentRequiresTheBuyersSignature(kit, expected, check) {
  const org = await packetOrg(kit)
  const changes = app("change-orders"), sales = app("community-sales")
  const buyer = await fx.reservedBuyer(kit, org, { name: "Careful Buyer", depositCents: 500000, receivedOn: null })
  const sale = await fx.agreementFor(kit, org, buyer)
  const patio = await changeOrder(kit, org, sale.projectId, "Covered patio", 8_000_00)
  const unsignedApproval = await attempt(() => kit.as(org.owner, () => changes.approveChangeOrder({ changeOrderId: patio.id, approval: { signerName: "Careful Buyer", note: "Agreed by phone" } })))
  // A member cannot forge the buyer's signature by writing the approval flags directly.
  const approvedNow = { status: "approved", lifecycle: "approved", approved_by: org.owner.userId, approved_at: new Date().toISOString() }
  const forgedEnvelope = await viaDataApi(kit, org.owner, "change_orders", patio.id, { ...approvedNow, metadata: { approved_via_envelope: "true" } })
  const forgedSignedCopy = await viaDataApi(kit, org.owner, "change_orders", patio.id, { ...approvedNow, metadata: { approval_method: "manual_offline", approved_signed_file_id: randomUUID() } })
  await buyerSigns(kit, org, sale.projectId, patio.id, "Careful Buyer")
  const voidAmendment = await attempt(() => kit.as(org.owner, () => changes.voidChangeOrder({ changeOrderId: patio.id, reason: "Buyer changed their mind" })))
  const sqlVoid = (() => { try { kit.sql(`update public.change_orders set status='cancelled', lifecycle='void' where id=${kit.q(patio.id)}`); return "allowed" } catch (error) { return /cannot be voided/.test(error.message) ? "refused: amendment cannot be voided" : error.message } })()
  const plan = await kit.as(org.owner, () => sales.previewAgreementCancellation(sale.contractId))
  await kit.as(org.owner, () => sales.voidPurchaseAgreement({ contractId: sale.contractId, reason: "Buyer relocated for work", depositDisposition: "refund", expectedPlanHash: plan.hash }))
  const late = await changeOrder(kit, org, sale.projectId, "Late pool request", 30_000_00)
  await buyerSigns(kit, org, sale.projectId, late.id, "Careful Buyer")
  equal(check, "an amendment needs the buyer's signature, is never voided, and a change on a cancelled sale amends nothing", expected.expected, {
    unsignedApproval: /amends the buyer's signed purchase agreement/.test(unsignedApproval) ? "refused: needs the buyer's signed copy" : unsignedApproval,
    voidAmendment: /cannot be voided/.test(voidAmendment) ? "refused: amendment cannot be voided" : voidAmendment,
    sqlVoid,
    forgedEnvelope: /recorded when the buyer signs/.test(forgedEnvelope) ? "refused: needs the buyer's signature" : forgedEnvelope,
    forgedSignedCopy: /must be a file on this home/.test(forgedSignedCopy) ? "refused: needs the signed copy on file" : forgedSignedCopy,
    versionsAfterCancellation: versionsOf(kit, sale.contractId).map((row) => row.kind),
  })
  return { orgId: org.orgId, contractId: sale.contractId }
}

async function resoldHomeSettlesOnlyItsOwnAmendments(kit, expected, check) {
  const org = await packetOrg(kit)
  const sales = app("community-sales")
  const first = await fx.reservedBuyer(kit, org, { name: "First Buyer", depositCents: 500000, receivedOn: null })
  const firstSale = await fx.agreementFor(kit, org, first)
  const pool = await changeOrder(kit, org, firstSale.projectId, "Pool", 20_000_00)
  await buyerSigns(kit, org, firstSale.projectId, pool.id, "First Buyer")
  const plan = await kit.as(org.owner, () => sales.previewAgreementCancellation(firstSale.contractId))
  await kit.as(org.owner, () => sales.voidPurchaseAgreement({ contractId: firstSale.contractId, reason: "First buyer's financing was declined", depositDisposition: "refund", expectedPlanHash: plan.hash }))
  const second = await fx.reservedBuyer(kit, org, { name: "Second Buyer", depositCents: 500000, receivedOn: null, lot: first.lot })
  const secondSale = await fx.agreementFor(kit, org, second)
  const settlement = await kit.as(org.owner, () => app("closings").buildSettlement(fx.closingOf(kit, secondSale.projectId)))
  equal(check, "a home resold after a cancellation settles only its own buyer's amendments", expected.expected, {
    sameHome: secondSale.projectId === firstSale.projectId,
    firstBuyerVersions: versionsOf(kit, firstSale.contractId).length,
    secondBuyerAmendmentsCents: settlement.components.approvedChangeOrdersCents,
    secondBuyerPriceIsTheirAgreement: settlement.finalPriceCents === Number(kit.rows(`select total_cents from public.contracts where id=${kit.q(secondSale.contractId)}`)[0].total_cents),
  })
  return { orgId: org.orgId, contractId: secondSale.contractId }
}

async function cancellingASaleReconcilesWhatWasCommitted(kit, expected, check) {
  const org = await packetOrg(kit)
  const sales = app("community-sales"), q = kit.q
  const buyer = await fx.reservedBuyer(kit, org, { name: "Split Deposit", depositCents: 10_000_00, receivedOn: seed.isoDay(0) })
  const sale = await fx.agreementFor(kit, org, buyer)
  const pending = await changeOrder(kit, org, sale.projectId, "Unsigned gutters", 2_000_00)
  const plan = await kit.as(org.owner, () => sales.previewAgreementCancellation(sale.contractId))
  const stale = await attempt(() => kit.as(org.owner, () => sales.voidPurchaseAgreement({ contractId: sale.contractId, reason: "Buyer walked", depositDisposition: "refund", expectedPlanHash: "0".repeat(64) })))
  // Voiding the row directly would skip the deposit, the lot and the receipt.
  const memberVoid = deskOnly(await viaDataApi(kit, org.owner, "contracts", sale.contractId, { status: "void" }))
  const cancellation = await kit.as(org.owner, () => sales.voidPurchaseAgreement({ contractId: sale.contractId, reason: "Buyer walked away after the appraisal", depositDisposition: "split", forfeitCents: 2_500_00, expectedPlanHash: plan.hash }))
  const status = (table, id) => kit.rows(`select status from public.${table} where id=${q(id)}`)[0].status
  const refunds = kit.rows(`select coalesce(sum(amount_cents),0)::bigint cents from public.payment_reversals where metadata->>'agreement_cancellation_id'=${q(cancellation.id)}`)[0].cents
  const forfeiture = kit.rows(`select total_cents::bigint cents from public.invoices where metadata->>'invoice_kind'='deposit_forfeiture' and metadata->>'source_agreement_cancellation_id'=${q(cancellation.id)}`)
  const second = await attempt(() => kit.as(org.owner, () => sales.voidPurchaseAgreement({ contractId: sale.contractId, reason: "Buyer walked away after the appraisal", depositDisposition: "refund", expectedPlanHash: plan.hash })))
  equal(check, "cancelling voids the agreement and its unsigned change orders, returns the lot, splits the deposit as decided and records it once", expected.expected, {
    plan: { availableCents: plan.deposit.available_cents, pendingChangeOrders: plan.pending_change_orders.length, closing: plan.closing?.status ?? null },
    stalePlan: stale,
    memberVoid,
    contract: status("contracts", sale.contractId),
    pendingChangeOrder: status("change_orders", pending.id),
    reservation: status("lot_reservations", buyer.reservation.id),
    closing: kit.rows(`select status from public.closings where project_id=${q(sale.projectId)} order by created_at desc limit 1`)[0].status,
    receipt: { disposition: cancellation.depositDisposition, forfeitCents: cancellation.forfeitCents, refundCents: cancellation.refundCents, settlement: cancellation.settlementStatus },
    refundedCents: Number(refunds),
    forfeitureInvoiceCents: forfeiture.map((row) => Number(row.cents)),
    secondCancellation: /Active purchase agreement not found/.test(second) ? "refused: nothing left to cancel" : second,
  })
  return { orgId: org.orgId, contractId: sale.contractId }
}

async function settledSaleCannotBeVoided(kit, expected, check) {
  const org = await packetOrg(kit)
  const sales = app("community-sales")
  const { sale, closingId } = await fx.homeAtTheTable(kit, org, { name: "Closed Buyer", depositCents: 500000, date: seed.isoDay(0) })
  await fx.settleCall(kit, org.owner, closingId, seed.isoDay(0), "WIRE-PACKET").catch((error) => { if (!/Missing R2/.test(error.message)) throw error })
  const plan = await kit.as(org.owner, () => sales.previewAgreementCancellation(sale.contractId))
  const voided = await attempt(() => kit.as(org.owner, () => sales.voidPurchaseAgreement({ contractId: sale.contractId, reason: "Buyer wants out after closing", depositDisposition: "refund", expectedPlanHash: plan.hash })))
  equal(check, "a sale whose closing is recorded is refused until the closing is reversed, and nothing moves", expected.expected, {
    closing: kit.rows(`select status from public.closings where id=${kit.q(closingId)}`)[0].status,
    blocked: /Reverse the closing first/.test(plan.blocked ?? "") ? "reverse the closing first" : plan.blocked,
    voided: /Reverse the closing first/.test(voided) ? "refused: reverse the closing first" : voided,
    contract: kit.rows(`select status from public.contracts where id=${kit.q(sale.contractId)}`)[0].status,
  })
  return { orgId: org.orgId, contractId: sale.contractId }
}

const subcases = {
  "agreement-packet-follows-community-and-state": agreementPacketFollowsCommunityAndState,
  "published-agreement-versions-are-immutable": publishedAgreementVersionsAreImmutable,
  "signing-is-refused-without-a-required-addendum": signingIsRefusedWithoutARequiredAddendum,
  "no-agreement-without-a-published-template": noAgreementWithoutAPublishedTemplate,
  "agreement-packet-hash-binds-snapshot-and-signing": agreementPacketHashBindsSnapshotAndSigning,
  "signed-change-orders-version-the-agreement": signedChangeOrdersVersionTheAgreement,
  "amendment-requires-the-buyers-signature": amendmentRequiresTheBuyersSignature,
  "resold-home-settles-only-its-own-amendments": resoldHomeSettlesOnlyItsOwnAmendments,
  "cancelling-a-sale-reconciles-what-was-committed": cancellingASaleReconcilesWhatWasCommitted,
  "settled-sale-cannot-be-voided": settledSaleCannotBeVoided,
}
module.exports = { subcases, helpers: { packetOrg, publish, draftSale, changeOrder, buyerSigns } }
