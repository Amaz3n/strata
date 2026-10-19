const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

process.env.DOCUMENT_SIGNING_SECRET ??= "signature-delivery-fixture-secret"

/** The mail provider: real templates, a recorded send that accepts or not. */
const provider = { accepts: false, sends: [] }
const mailer = require("@/lib/services/mailer")
stubModule("@/lib/services/mailer", {
  ...mailer,
  sendEmail: async (payload) => {
    provider.sends.push(payload)
    if (!provider.accepts) return false
    await payload.onAccepted?.(`provider-${provider.sends.length}`)
    return true
  },
})

const { createRecoverableSigningToken, hashSigningToken } = require("@/lib/esign/signing-tokens")
const { deliverAutomaticSigningReminder, deliverSigningInvitation, issueSigningLinkForRequest } = freshRequire(
  "lib/services/signature-delivery.ts",
)

const REQUEST = id(1)
const SENT_AT = "2026-01-01T00:00:00+00:00"
const RECEIPT_AT = "2026-01-02T00:00:00+00:00"

/** One signing request with the relations PostgREST embeds for the service. */
function signingRequest(overrides = {}) {
  return {
    id: REQUEST,
    org_id: ORG,
    document_id: id(2),
    envelope_id: id(3),
    token_hash: hashSigningToken("original"),
    status: "viewed",
    sent_at: SENT_AT,
    sent_to_email: "signer@harbor-homes.us",
    expires_at: null,
    documents: { title: "Agreement", status: "sent" },
    envelopes: { status: "sent", expires_at: null, metadata: { reminder_settings: { enabled: true } } },
    envelope_recipients: { name: "Signer" },
    ...overrides,
  }
}

function harness({ accepts = true, request = {} } = {}) {
  provider.accepts = accepts
  provider.sends = []
  const accepted = []
  const service = createServiceHarness({
    tables: {
      orgs: [{ id: ORG, name: "Harbor Homes" }],
      documents: [{ id: id(2), org_id: ORG, metadata: {} }],
      document_signing_requests: [signingRequest(request)],
      esign_reminder_deliveries: [],
    },
    rpc: {
      record_esign_email_accepted: (args) => {
        accepted.push(args)
        return { data: null, error: null }
      },
    },
  })
  // The receipt's `sent_at` is a column default.
  service.tamper("esign_reminder_deliveries", replies.patch({ sent_at: RECEIPT_AT }), { on: "select" })
  const row = () => service.db.document_signing_requests[0]
  return { service, accepted, row }
}

describe("automatic reminders", () => {
  const input = { orgId: ORG, requestId: REQUEST, deliveryKey: `${REQUEST}:${SENT_AT}` }

  test("a provider failure is recorded and stays retryable without rotating the link", async () => {
    const { service, row } = harness({ accepts: false })
    const token = row().token_hash

    await assert.rejects(service.run(() => deliverAutomaticSigningReminder(input)), /not delivered/)

    assert.equal(row().delivery_status, "failed")
    assert.equal(row().token_hash, token)
    assert.deepEqual(service.db.esign_reminder_deliveries, [])

    provider.accepts = true
    await service.run(() => deliverAutomaticSigningReminder(input))
    assert.equal(service.db.esign_reminder_deliveries.length, 1)
    assert.equal(provider.sends[0].idempotencyKey, provider.sends[1].idempotencyKey)
  })

  test("a delivered reminder is not sent again for the same key", async () => {
    const { service, accepted } = harness()

    await service.run(() => deliverAutomaticSigningReminder(input))
    await service.run(() => deliverAutomaticSigningReminder(input))

    assert.equal(provider.sends.length, 1)
    assert.equal(accepted.length, 1)
    assert.equal(accepted[0].p_kind, "reminder")
  })

  test("nothing is sent when automation is off, or the request is no longer open", async () => {
    const cases = [
      { envelopes: { status: "sent", metadata: { reminder_settings: { enabled: false } } } },
      { status: "signed" },
      { envelopes: { status: "voided", metadata: { reminder_settings: { enabled: true } } } },
      { expires_at: "2020-01-01T00:00:00Z" },
    ]
    for (const request of cases) {
      const { service } = harness({ request })
      await service.run(() => deliverAutomaticSigningReminder(input))
      assert.equal(provider.sends.length, 0, JSON.stringify(request))
    }
  })

  test("a manual reminder sends with automation off, once per key", async () => {
    const { service } = harness({
      request: { envelopes: { status: "sent", metadata: { reminder_settings: { enabled: false } } } },
    })
    const manual = { ...input, deliveryKey: `manual:${REQUEST}:attempt-1` }

    await service.run(() => deliverAutomaticSigningReminder(manual))
    await service.run(() => deliverAutomaticSigningReminder(manual))

    assert.equal(provider.sends.length, 1)
    const [receipt] = service.db.esign_reminder_deliveries
    assert.equal(receipt.delivery_type, "manual")
    assert.equal(receipt.delivery_key, manual.deliveryKey)
  })
})

describe("invitations", () => {
  const input = { orgId: ORG, requestId: REQUEST }

  test("an open invitation is sent without changing its state; a finished one is not", async () => {
    const { service, row } = harness()
    await service.run(() => deliverSigningInvitation(input))
    assert.equal(provider.sends.length, 1)
    assert.equal(row().status, "viewed")

    row().status = "signed"
    await service.run(() => deliverSigningInvitation(input))
    assert.equal(provider.sends.length, 1)
  })

  test("correcting the recipient sends to the new address under a new provider key", async () => {
    const { service, row } = harness()
    await service.run(() => deliverSigningInvitation(input))

    row().token_hash = hashSigningToken("corrected")
    row().sent_to_email = "corrected@harbor-homes.us"
    await service.run(() => deliverSigningInvitation(input))

    assert.notEqual(provider.sends[0].idempotencyKey, provider.sends[1].idempotencyKey)
    assert.deepEqual(provider.sends[1].to, ["corrected@harbor-homes.us"])
  })

  test("a correction mid-send never pairs the old link with the new recipient", async () => {
    const { service, row } = harness({ accepts: false })
    const original = signingRequest()
    const link = createRecoverableSigningToken(original)
    // The recipient is corrected while the invitation is being rendered.
    service.tamper("orgs", (result) => {
      row().token_hash = hashSigningToken("corrected-in-flight")
      row().sent_to_email = "new@harbor-homes.us"
      return result
    })

    await assert.rejects(service.run(() => deliverSigningInvitation(input)), /not delivered/)

    assert.deepEqual(provider.sends[0].to, [original.sent_to_email])
    assert.ok(provider.sends[0].html.includes(link))
    // The failure belongs to the old invitation; the corrected one is untouched.
    assert.equal(row().delivery_status, undefined)
  })
})

describe("issuing a signing link", () => {
  test("a link is refused once the recipient changed", async () => {
    const { service } = harness()
    await assert.rejects(
      service.run(() =>
        issueSigningLinkForRequest(service.client, {
          orgId: ORG,
          requestId: REQUEST,
          markSent: false,
          expectedEmail: "previous@harbor-homes.us",
        }),
      ),
      /recipient changed/,
    )
  })

  test("a draft is marked sent only under the credential the link was built from", async () => {
    const params = { orgId: ORG, requestId: REQUEST, markSent: true, expectedEmail: "SIGNER@harbor-homes.us" }

    const issued = harness({ request: { status: "draft" } })
    const { url } = await issued.service.run(() => issueSigningLinkForRequest(issued.service.client, params))
    assert.ok(url.includes(createRecoverableSigningToken(signingRequest())))
    assert.equal(issued.row().status, "sent")

    const raced = harness({ request: { status: "draft" } })
    raced.service.tamper("document_signing_requests", replies.patch({ token_hash: "rotated-meanwhile" }), {
      on: "select",
    })
    await raced.service.run(() => issueSigningLinkForRequest(raced.service.client, params))
    assert.equal(raced.row().status, "draft")
  })
})
