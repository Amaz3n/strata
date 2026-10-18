// LOT-01 signing through the envelope (EP05-03, EP14-01). Needs real file storage (`--storage-env`):
// the signing packet is a PDF the sale renders into the acceptance bucket and the executed copy is
// another, so without storage the subcase is BLOCKED, never skipped or settled by hand.
//
// The sale prepares one envelope for the buyer (sequence 1) and the builder (sequence 2); the builder
// cannot sign first; each signer signs through the public signing action with the link the invitation
// carries; the envelope's execution job (the outbox route production's cron reaches) executes the
// agreement exactly once, binding the executed file; a second delivery of the last signature is quiet.
const sharp = require("sharp")
const Module = require("node:module")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")

const lot = () => require("./lot-01.cjs").helpers
const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }

/**
 * The signing page is a server action: it reads the signer's address from the request headers
 * and revalidates its own path. Outside a Next server there is no request, so for that module
 * only the headers are a loopback request and revalidation is a no-op.
 */
function loadSigningActions() {
  const original = Module._load
  Module._load = function (request, parent, ...rest) {
    const real = original.call(this, request, parent, ...rest)
    if (!String(parent?.filename ?? "").includes("/app/d/[token]/")) return real
    if (request === "next/headers") return { ...real, headers: async () => new Headers({ "x-forwarded-for": "127.0.0.1", "user-agent": "acceptance-signer" }) }
    if (request === "next/cache") return { ...real, revalidatePath: () => {} }
    return real
  }
  try { return require("../../../app/d/[token]/actions") } finally { Module._load = original }
}

async function signaturePng() {
  const bytes = await sharp({ create: { width: 120, height: 40, channels: 3, background: "#ffffff" } })
    .composite([{ input: { create: { width: 80, height: 6, channels: 3, background: "#000000" } }, left: 20, top: 17 }]).png().toBuffer()
  return `data:image/png;base64,${bytes.toString("base64")}`
}

async function agreementSignsThroughAnEnvelope(kit, expected, check) {
  const { org, reservation } = await lot().stage(kit, "reservation")
  const lotId = org.lots[0].id
  const sales = app("community-sales"), { createRecoverableSigningToken } = require("../../../lib/esign/signing-tokens"), { ELECTRONIC_SIGNATURE_CONSENT_TEXT } = require("../../../lib/esign/consent")
  const actions = loadSigningActions()
  const config = seed.configuration(org, { lotId, plan: org.plans[0], swing: "right", skus: ["ST-GAR", ...Object.values(seed.DESIGN_PICKS)] })
  const quote = await kit.as(org.team.sales, () => sales.priceAgreementDraft(config))
  const created = await kit.as(org.team.sales, () => sales.createPurchaseAgreement({ ...config, ...seed.agreementPacketFor(kit, org, lotId), reservationId: reservation.id, expectedQuoteHash: quote.quoteHash }))
  const contractId = created.id
  const requests = () => kit.rows(`select id, token_hash, sequence, signer_role, status, sent_to_email, revision, document_id from public.document_signing_requests where org_id=${kit.q(org.orgId)} and envelope_id=${kit.q(created.signing.envelopeId)} order by sequence, signer_role`)
  const prepared = requests()
  const draftStatus = kit.rows(`select status from public.contracts where id=${kit.q(contractId)}`)[0].status
  const png = await signaturePng()
  const valuesFor = (row, name) => Object.fromEntries(kit.rows(`select id, field_type from public.document_fields where org_id=${kit.q(org.orgId)} and document_id=${kit.q(row.document_id)} and revision=${row.revision} and coalesce(signer_role,'client')=${kit.q(row.signer_role)}`)
    .map((field) => [field.id, field.field_type === "signature" ? png : field.field_type === "checkbox" ? true : field.field_type === "date" ? seed.isoDay(0) : name]))
  const sign = (row) => actions.submitDocumentSignatureAction({ token: createRecoverableSigningToken(row), signerName: row.signer_role === "builder" ? "Builder of record" : "Dana Whitfield", signerEmail: row.sent_to_email, values: valuesFor(row, row.signer_role === "builder" ? "Builder of record" : "Dana Whitfield"), consentText: ELECTRONIC_SIGNATURE_CONSENT_TEXT })

  const builder = prepared.find((row) => row.signer_role === "builder"), buyer = prepared.find((row) => row.signer_role === "buyer")
  const builderFirst = await refusal(() => sign(builder))
  await sign(buyer)
  const afterBuyer = kit.rows(`select status from public.contracts where id=${kit.q(contractId)}`)[0].status
  await sign(requests().find((row) => row.signer_role === "builder"))
  await kit.drainOutbox(org.orgId)
  const redelivered = await refusal(() => sign(requests().find((row) => row.signer_role === "builder")))
  await kit.drainOutbox(org.orgId)
  const contract = kit.rows(`select status, total_cents, signature_data from public.contracts where id=${kit.q(contractId)}`)[0]
  const document = kit.rows(`select status, executed_file_id from public.documents where id=${kit.q(builder.document_id)}`)[0]
  check.equal("the sale prepares one envelope, buyer then builder, signed through the signing page and executed once by its job", expected.expected, {
    prepared: { documentPrepared: Boolean(created.signing.documentId), signers: prepared.map((row) => `${row.sequence}:${row.signer_role}`), contract: draftStatus },
    builderBeforeBuyer: /not yet authorized/.test(builderFirst) ? "refused: buyer signs first" : builderFirst,
    afterBuyerSigns: afterBuyer,
    executed: { status: contract.status, totalCents: Number(contract.total_cents), executedFileBound: Boolean(document.executed_file_id) && contract.signature_data?.executed_file_id === document.executed_file_id },
    reservation: kit.rows(`select status from public.lot_reservations where id=${kit.q(reservation.id)}`)[0].status,
    closings: kit.rows(`select status from public.closings where project_id=${kit.q(created.project_id)} and status<>'cancelled'`).map((row) => row.status),
    executedEvents: Number(kit.rows(`select count(*)::int n from public.events where org_id=${kit.q(org.orgId)} and event_type='purchase_agreement_executed' and entity_id=${kit.q(contractId)}`)[0].n),
    secondDelivery: redelivered === "allowed" ? "quiet" : redelivered,
  })
  return { orgId: org.orgId, contractId, envelopeId: created.signing.envelopeId }
}

module.exports = { subcases: { "agreement-signs-through-an-envelope": agreementSignsThroughAnEnvelope } }
