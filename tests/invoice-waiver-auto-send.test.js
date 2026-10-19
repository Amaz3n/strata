"use strict"

/**
 * When an invoice is held until its waiver is signed, the signature completes
 * the send (`sendInvoiceAfterWaiverSignature`) — as the person who prepared it,
 * to the recipients they chose, and only once. Issuing itself is
 * `issueInvoiceWithContext` (tests/invoices.test.js), which re-checks that
 * person's permission.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const issued = []
stubModule("@/lib/services/invoices", {
  issueInvoiceWithContext: async (context, args) => {
    issued.push({ actor: context.userId, recipients: args.recipients, invoiceId: args.invoiceId })
  },
})

const { sendInvoiceAfterWaiverSignature } = freshRequire("lib/services/invoice-waiver-auto-send.ts")

const INVOICE = id(1)
const WAIVER = id(2)
const DOCUMENT = id(3)
const SIGNER = id(4)
const PREPARER = id(5)

function setup({ packet = {}, flow = {}, status = "draft", signer = SIGNER, physical = null } = {}) {
  issued.length = 0
  return createServiceHarness({
    tables: {
      orgs: [{ id: ORG, product_tier: "residential" }],
      invoices: [
        {
          id: INVOICE,
          org_id: ORG,
          status,
          metadata: {
            waiver_packet: {
              enabled: true,
              delivery_mode: "after_signature",
              waiver_id: WAIVER,
              signer_id: SIGNER,
              actor_id: PREPARER,
              recipients: ["client@example.test"],
              ...packet,
            },
          },
        },
      ],
      invoice_lien_waivers: [
        {
          id: WAIVER,
          org_id: ORG,
          invoice_id: INVOICE,
          metadata: {
            workflow: { version: 2, lifecycle: "signed", signing_document_id: DOCUMENT, shared: true, ...flow },
            physical_execution: physical,
          },
        },
      ],
      documents: [{ id: DOCUMENT, org_id: ORG, metadata: { waiver_signer_id: signer } }],
    },
  })
}

const send = (service) => sendInvoiceAfterWaiverSignature(service.client, ORG, INVOICE, WAIVER)

test("a signed waiver sends its held invoice as the preparer, to the chosen recipients", async () => {
  await send(setup())
  assert.deepEqual(issued, [{ actor: PREPARER, recipients: ["client@example.test"], invoiceId: INVOICE }])
})

test("nothing is sent for an unsigned, flagged, cancelled or already issued packet", async () => {
  const quiet = {
    "an unsigned waiver": setup({ flow: { lifecycle: "draft" } }),
    "a waiver needing review": setup({ flow: { needs_review: true } }),
    "a packet turned off": setup({ packet: { enabled: false } }),
    "a packet for another waiver": setup({ packet: { waiver_id: id(99) } }),
    "an invoice already sent": setup({ status: "sent" }),
    "a void invoice": setup({ status: "void" }),
  }
  for (const [name, service] of Object.entries(quiet)) {
    issued.length = 0
    await send(service)
    assert.deepEqual(issued, [], name)
  }
})

test("a waiver signed by someone other than the chosen signer is refused for review", async () => {
  await assert.rejects(send(setup({ signer: id(98) })), /needs review/)
  assert.deepEqual(issued, [])
})

test("a paper waiver sends only once its execution is confirmed", async () => {
  const paper = { packet: { delivery_mode: "after_physical_execution" }, flow: { signing_document_id: undefined } }
  await assert.rejects(send(setup(paper)), /Confirm the executed waiver/)
  assert.deepEqual(issued, [])

  await send(setup({ ...paper, physical: { confirmed_by: id(97) } }))
  assert.equal(issued.length, 1)
  assert.equal(issued[0].actor, PREPARER)
})
