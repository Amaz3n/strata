const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

const { invoiceWaiverContentHash } = require("@/lib/lien-waivers/invoice-content")
const { WAIVER_SIGNATURE_CONSENT, selfSignatureValues } = require("@/lib/invoices/waiver-self-signing")

/**
 * The invoice-waiver workflow, envelope sending and the signing page have their
 * own suites. Here they are the neighbours these actions orchestrate: each stub
 * changes the fake database the way the real one does, so the actions read
 * back real state.
 */
const world = { service: null, actor: ACTOR, waiver: null, invoice: null, sends: [], submissions: [] }

const DOCUMENT = id(1)
const ENVELOPE = id(2)
const COWORKER = id(3)
const OUTSIDER = id(4)
const INVOICE = id(7)
const WAIVER = id(8)
const PNG = "data:image/png;base64,iVBORw0KGgoAAA=="

function context(permission) {
  return { supabase: world.service.client, orgId: ORG, userId: world.actor, invoice: world.invoice, permission }
}
const document = () => world.service.db.documents[0]
const workflow = () => world.waiver.metadata.workflow

stubModule("lib/services/invoice-waiver-workflow.ts", {
  invoiceWaiverContext: async (_invoiceId, permission) => context(permission),
  getInvoiceWaiverRecord: async (_invoiceId, _waiverId, permission) => ({ ctx: context(permission), waiver: world.waiver }),
  startInvoiceWaiverSigning: async () => {
    workflow().signing_document_id = DOCUMENT
    return { documentId: DOCUMENT, status: document().status, waiver: world.waiver }
  },
})
stubModule("lib/services/invoice-waiver-signing.ts", {
  completeInvoiceWaiverFromSigning: async () => {
    workflow().lifecycle = "signed"
  },
})
stubModule("lib/services/invoices.ts", {
  getInvoiceWithLines: async () => world.invoice,
  assertInvoiceCanIssue: async () => {},
})
stubModule("app/(app)/signatures/actions.ts", {
  sendDocumentEnvelopeAction: async (input) => {
    world.sends.push(input)
    const db = world.service.db
    db.envelopes.push({ id: ENVELOPE, org_id: ORG, document_id: DOCUMENT, status: "sent", created_at: "2026-10-01T00:00:00Z" })
    db.document_signing_requests.push({
      id: id(5),
      org_id: ORG,
      document_id: DOCUMENT,
      envelope_id: ENVELOPE,
      signer_role: "claimant",
      revision: 1,
    })
    document().status = "sent"
    return { success: true, data: { envelopeId: ENVELOPE } }
  },
  createMySigningLinkAction: async () => ({ success: true, data: { url: `https://app.arc.test/d/${"a".repeat(64)}` } }),
})
stubModule("app/d/[token]/actions.ts", {
  submitDocumentSignatureAction: async (input) => {
    world.submissions.push(input)
    Object.assign(document(), { status: "signed", executed_file_id: id(6) })
    world.service.db.envelopes[0].status = "executed"
    return { success: true }
  },
})
stubModule("next/cache", { revalidatePath() {} })

const { requestWaiverSignatureAction, signOwnInvoiceWaiverAction } = freshRequire("app/(app)/invoices/waiver-actions.ts")
const { holdInvoiceForPhysicalWaiverAction } = freshRequire("app/(app)/invoices/physical-waiver-actions.ts")
const { listWaiverSigners } = freshRequire("lib/services/waiver-signers.ts")

/** A member row as the signer query embeds it. */
function member(userId, name, overrides = {}) {
  return {
    org_id: ORG,
    user_id: userId,
    status: "active",
    user: { id: userId, full_name: name, email: `${name.toLowerCase()}@harbor-homes.us` },
    ...overrides,
  }
}

/** A drafted, unsigned invoice waiver whose details name `signerName`. */
function setup({ signerName = "Alex", actor = ACTOR } = {}) {
  world.invoice = { id: INVOICE, status: "draft", updated_at: "revision-1", metadata: { existing: "kept" }, total_cents: 100 }
  world.waiver = {
    id: WAIVER,
    status: "pending_payment",
    metadata: {
      workflow: {
        version: 2,
        lifecycle: "draft",
        input: { signer_name: signerName },
        invoice_content_hash: invoiceWaiverContentHash(world.invoice),
      },
    },
  }
  world.actor = actor
  world.sends = []
  world.submissions = []
  world.service = createServiceHarness({
    tables: {
      documents: [{ id: DOCUMENT, org_id: ORG, status: "draft", metadata: {} }],
      envelopes: [],
      document_signing_requests: [],
      document_fields: [
        { id: "sig", org_id: ORG, document_id: DOCUMENT, revision: 1, field_type: "signature", signer_role: "claimant", required: true },
        { id: "date", org_id: ORG, document_id: DOCUMENT, revision: 1, field_type: "date", signer_role: "claimant", required: true },
      ],
      invoices: [{ ...world.invoice, org_id: ORG }],
    },
  })
  world.service.db.memberships.push(member(ACTOR, "Alex"), member(COWORKER, "Casey"))
  return world.service
}

test("signer choices are the org's active members who have an email", async () => {
  const service = setup()
  service.db.memberships.push(
    member(id(20), "Other", { org_id: id(21) }),
    member(id(22), "Invited", { status: "invited" }),
    member(id(23), "Nomail", { user: { id: id(23), full_name: "Nomail", email: null } }),
  )

  const signers = await listWaiverSigners(service.client, ORG)

  assert.deepEqual(
    signers.map((signer) => signer.name),
    ["Alex", "Casey"],
  )
  assert.equal(signers[0].email, "alex@harbor-homes.us")
})

describe("requesting a coworker's signature", () => {
  test("someone outside the organization cannot be asked to sign", async () => {
    setup({ signerName: "Casey" })
    const result = await requestWaiverSignatureAction(INVOICE, WAIVER, OUTSIDER, true)
    assert.equal(result.success, false)
    assert.equal(workflow().signing_document_id, undefined)
    assert.deepEqual(world.sends, [])
  })

  test("the signer's identity comes from the server and the request resumes without resending", async () => {
    setup({ signerName: "Casey" })

    const first = await requestWaiverSignatureAction(INVOICE, WAIVER, COWORKER, true)
    assert.equal(first.success, true, first.error)
    assert.equal(first.data.isSelf, false)
    assert.equal(world.sends.length, 1)
    assert.equal(world.sends[0].recipients[0].user_id, COWORKER)
    assert.equal(world.sends[0].recipients[0].email, "casey@harbor-homes.us")
    assert.equal(document().metadata.waiver_signing_experience, "review")
    assert.equal(document().metadata.waiver_signer_id, COWORKER)

    const again = await requestWaiverSignatureAction(INVOICE, WAIVER, COWORKER, true)
    assert.equal(again.data.envelopeId, ENVELOPE)
    assert.equal(world.sends.length, 1)
  })

  test("a request already assigned to someone else is not reassigned", async () => {
    setup({ signerName: "Casey" })
    await requestWaiverSignatureAction(INVOICE, WAIVER, COWORKER, true)
    document().metadata.waiver_signer_id = id(30)

    const result = await requestWaiverSignatureAction(INVOICE, WAIVER, COWORKER, true)

    assert.equal(result.success, false)
    assert.match(result.error, /another signer/)
    assert.equal(world.sends.length, 1)
  })
})

describe("signing your own waiver", () => {
  test("refuses without consent, or when the waiver names someone else", async () => {
    setup({ actor: COWORKER })
    assert.equal((await signOwnInvoiceWaiverAction(INVOICE, WAIVER, PNG, true)).success, false)

    setup()
    assert.equal((await signOwnInvoiceWaiverAction(INVOICE, WAIVER, PNG, false)).success, false)
    assert.deepEqual(world.sends, [])
    assert.deepEqual(world.submissions, [])
  })

  test("signs once through the standard pipeline as the signed-in member", async () => {
    setup()

    const result = await signOwnInvoiceWaiverAction(INVOICE, WAIVER, PNG, true)

    assert.equal(result.success, true, result.error)
    assert.equal(workflow().lifecycle, "signed")
    assert.equal(world.sends.length, 1)
    assert.equal(world.sends[0].recipients[0].user_id, ACTOR)
    const [submission] = world.submissions
    assert.equal(submission.signerName, "Alex")
    assert.equal(submission.signerEmail, "alex@harbor-homes.us")
    assert.equal(submission.consentText, WAIVER_SIGNATURE_CONSENT)
    assert.equal(submission.values.sig, PNG)
    assert.match(submission.values.date, /^\d{4}-\d{2}-\d{2}$/)

    assert.equal((await signOwnInvoiceWaiverAction(INVOICE, WAIVER, PNG, true)).success, true)
    assert.equal(world.sends.length, 1)
    assert.equal(world.submissions.length, 1)
  })

  test("signature values: consent, a bounded PNG, and only the claimant's own fields", () => {
    const signature = { id: "sig", field_type: "signature", signer_role: "claimant", required: true }
    const date = { id: "date", field_type: "date", signer_role: "claimant", required: true }
    const owner = { id: "owner", field_type: "signature", signer_role: "owner", required: true }

    assert.deepEqual(selfSignatureValues([signature, date, owner], PNG, true, "2026-09-12"), {
      sig: PNG,
      date: "2026-09-12",
    })
    assert.throws(() => selfSignatureValues([signature], PNG, false, "2026-09-12"), /Agree/)
    assert.throws(() => selfSignatureValues([signature], "Alex", true, "2026-09-12"), /Add your signature/)
    assert.throws(() => selfSignatureValues([signature], PNG + "A".repeat(500_000), true, "2026-09-12"))
    assert.throws(() => selfSignatureValues([], PNG, true, "2026-09-12"), /no signature field/)
    const text = { id: "text", field_type: "text", signer_role: "claimant", required: true }
    assert.throws(() => selfSignatureValues([signature, text], PNG, true, "2026-09-12"), /additional signing fields/)
  })
})

describe("holding an invoice for a physically signed waiver", () => {
  const invoiceRow = () => world.service.db.invoices[0]

  test("saves the pending delivery without sending or signing anything", async () => {
    setup()

    assert.equal((await holdInvoiceForPhysicalWaiverAction(INVOICE, WAIVER, ["invalid"])).success, false)
    assert.equal(invoiceRow().metadata.waiver_packet, undefined)

    const result = await holdInvoiceForPhysicalWaiverAction(INVOICE, WAIVER, ["client@harbor-homes.us"])

    assert.equal(result.success, true, result.error)
    const packet = invoiceRow().metadata.waiver_packet
    assert.equal(invoiceRow().metadata.existing, "kept")
    assert.equal(packet.delivery_mode, "after_physical_execution")
    assert.deepEqual(packet.recipients, ["client@harbor-homes.us"])
    assert.equal(packet.actor_id, ACTOR)
    assert.deepEqual(world.sends, [])
    assert.deepEqual(world.submissions, [])
  })

  test("an invoice changed since it was read is not overwritten", async () => {
    setup()
    invoiceRow().updated_at = "revision-2"

    const result = await holdInvoiceForPhysicalWaiverAction(INVOICE, WAIVER, ["client@harbor-homes.us"])

    assert.equal(result.success, false)
    assert.equal(invoiceRow().metadata.waiver_packet, undefined)
  })

  test("a waiver prepared for a different version of the invoice is refused", async () => {
    setup()
    workflow().invoice_content_hash = "stale"

    const result = await holdInvoiceForPhysicalWaiverAction(INVOICE, WAIVER, ["client@harbor-homes.us"])

    assert.equal(result.success, false)
    assert.match(result.error, /current waiver/)
  })
})

describe("sending an invoice that waits on a coworker's signature", () => {
  // The same module instance the suite loaded above, with its stubs.
  const { sendInvoiceWithWaiverRequestAction: send } = require("@/app/(app)/invoices/waiver-actions")
  const CUSTOMER = ["customer@example.test"]
  const invoiceRow = () => world.service.db.invoices[0]

  test("the signature is requested and the invoice is held for it, as the sender, to the chosen recipients", async () => {
    setup({ signerName: "Casey" })
    const result = await send(INVOICE, WAIVER, COWORKER, CUSTOMER)

    assert.equal(result.success, true, result.error)
    assert.equal(world.sends.length, 1)
    assert.equal(world.sends[0].recipients[0].user_id, COWORKER)
    const packet = invoiceRow().metadata.waiver_packet
    assert.equal(packet.delivery_mode, "after_signature")
    assert.equal(packet.signer_id, COWORKER)
    assert.equal(packet.actor_id, ACTOR)
    assert.deepEqual(packet.recipients, CUSTOMER)
    assert.equal(invoiceRow().status, "draft", "the invoice is not issued until the waiver is signed")
  })

  test("sending again does not email the signer a second time", async () => {
    setup({ signerName: "Casey" })
    await send(INVOICE, WAIVER, COWORKER, CUSTOMER)
    world.invoice = { ...world.invoice, updated_at: invoiceRow().updated_at, metadata: invoiceRow().metadata }

    const again = await send(INVOICE, WAIVER, COWORKER, CUSTOMER)
    assert.equal(again.success, true, again.error)
    assert.equal(world.sends.length, 1)
  })

  test("nothing is sent to bad addresses, or when the sender names themselves as the signer", async () => {
    const cases = {
      "an invalid recipient": ["Casey", COWORKER, ["invalid"]],
      "no recipients": ["Casey", COWORKER, []],
      "the sender as the signer": ["Alex", ACTOR, CUSTOMER],
      "a signer the waiver does not name": ["Casey", ACTOR, CUSTOMER],
    }
    for (const [name, [signerName, signer, recipients]] of Object.entries(cases)) {
      setup({ signerName })
      const result = await send(INVOICE, WAIVER, signer, recipients)
      assert.equal(result.success, false, name)
      assert.deepEqual(world.sends, [], name)
      assert.deepEqual(world.service.writes("invoices"), [], name)
    }
  })
})
