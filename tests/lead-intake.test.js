"use strict"

/**
 * `lib/services/lead-intake.ts` — what a website delivery does before it is
 * filed: refused when unsigned, replayed when repeated, shown as failed when it
 * names nobody; and who may close a failed one.
 */

const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const test = require("node:test")

process.env.TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef"

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { encryptIntegrationSecret } = freshRequire("lib/integrations/secrets.ts")
const { signInboundPayload } = freshRequire("lib/inbound/signature.ts")
const { dismissLeadReceipt, fileLeadReceipt, receiveLeadDelivery } = freshRequire("lib/services/lead-intake.ts")

const SOURCE = id(1)
const PUBLIC_ID = "lis_abcdefghijklmnopqrstuvwx"
const SECRET = "arcwh_test_secret"
const NOW = new Date("2026-10-12T15:00:00Z")
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000))

function source() {
  return {
    id: SOURCE, org_id: ORG, name: "Website", public_id: PUBLIC_ID, secret_hint: "cret", default_source_label: "Website",
    default_community_id: null, default_owner_user_id: null, status: "active", last_received_at: null, last_rejected_at: null,
    last_rejection_reason: null, rejected_count: 0, previous_secret_expires_at: null, created_at: "2026-10-01T00:00:00Z",
    signing_secret_encrypted: encryptIntegrationSecret(SECRET), previous_secret_encrypted: null,
  }
}

function receipt(overrides = {}) {
  return {
    id: id(50), org_id: ORG, source_id: SOURCE, idempotency_key: "web-1", payload_hash: null, payload: {}, status: "received",
    failure_code: null, last_error: null, attempts: 0, next_attempt_at: null, community_id: null, contact_name: null,
    contact_email: null, contact_phone: null, prospect_id: null, matched_by: null, prior_prospect_id: null, owner_user_id: null,
    routing_outcome: null, routing_reason: null, received_at: "2026-10-12T14:00:00Z", ...overrides,
  }
}

function harness({ receipts = [], permissions = ["sales.read", "sales.manage"] } = {}) {
  return createServiceHarness({
    permissions,
    tables: { lead_intake_sources: [source()], lead_intake_receipts: receipts, outbox: [] },
    rpc: {
      // The database logs the refusal and counts it on the source in one statement.
      record_lead_delivery_rejection: ({ p_source_id, p_reason, p_at }, store) => {
        const row = store.lead_intake_sources.find((candidate) => candidate.id === p_source_id)
        Object.assign(row, { rejected_count: row.rejected_count + 1, last_rejected_at: p_at, last_rejection_reason: p_reason })
        store.lead_intake_receipts.push({ ...receipt({ id: id(90), idempotency_key: null, payload: null }), status: "rejected", failure_code: p_reason, received_at: p_at })
        return { data: null, error: null }
      },
    },
  })
}

function deliver(service, body, { key = "web-1", signature } = {}) {
  const rawBody = JSON.stringify(body)
  return service.run(() => receiveLeadDelivery({
    publicId: PUBLIC_ID,
    rawBody,
    timestamp: TIMESTAMP,
    signature: signature ?? signInboundPayload(SECRET, TIMESTAMP, rawBody),
    idempotencyKey: key,
    now: NOW,
  }))
}

test("a wrongly signed delivery is refused, logged as rejected, and never filed", async () => {
  const service = harness()
  const response = await deliver(service, { email: "dana@example.test" }, { signature: "0".repeat(64) })

  assert.equal(response.status, 401)
  assert.deepEqual(service.db.lead_intake_receipts.map((row) => [row.status, row.failure_code, row.idempotency_key]), [["rejected", "bad_signature", null]])
  assert.equal(service.db.lead_intake_sources[0].rejected_count, 1)
  assert.equal(service.queries.filter((query) => query.table === "rpc:file_lead").length, 0)
})

test("a repeated key replays the first answer, and a different body under it is refused", async () => {
  const body = { email: "dana@example.test", first_name: "Dana" }
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex")
  const service = harness({ receipts: [receipt({ payload_hash: hash, status: "filed", prospect_id: id(70) })] })

  assert.deepEqual(await deliver(service, body), { status: 200, body: { receipt_id: id(50), status: "filed" } })
  assert.equal((await deliver(service, { ...body, phone: "239-555-0142" })).status, 409)
  assert.deepEqual(service.writes("lead_intake_receipts"), [])
})

test("a submission with no email or phone is kept and shown as failed, not filed", async () => {
  const service = harness({ receipts: [receipt({ payload: { first_name: "Dana", community: "CL" }, contact_name: "Dana" })] })
  const outcome = await service.run(() => fileLeadReceipt(id(50), ORG))

  assert.equal(outcome.status, "failed")
  assert.equal(outcome.failureCode, "no_contact_key")
  const [row] = service.db.lead_intake_receipts
  assert.deepEqual([row.status, row.failure_code], ["failed", "no_contact_key"])
  assert.equal(service.queries.filter((query) => query.table === "rpc:file_lead").length, 0)
})

test("dismissing a failed delivery takes a deal write key", async () => {
  const failed = receipt({ status: "failed", failure_code: "unknown_community" })
  const reader = harness({ receipts: [failed], permissions: ["sales.read"] })
  await assert.rejects(reader.run(() => dismissLeadReceipt({ receiptId: failed.id, note: "Spam submission" })), /sales.manage|pipeline.write|permission/i)
  assert.deepEqual(reader.writes("lead_intake_receipts"), [])

  const consultant = harness({ receipts: [receipt({ status: "failed", failure_code: "unknown_community" })] })
  await consultant.run(() => dismissLeadReceipt({ receiptId: failed.id, note: "Spam submission" }))
  assert.deepEqual([consultant.db.lead_intake_receipts[0].status, consultant.db.lead_intake_receipts[0].resolution_note], ["dismissed", "Spam submission"])
})
