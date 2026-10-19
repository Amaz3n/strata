const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { NextRequest } = require("next/server")
const { GET } = freshRequire("app/api/jobs/esign/route.ts")

const SECRET = "esign-cron-fixture-secret"
const LONG_AGO = "2020-01-01T00:00:00+00:00"

function cronRequest(secret = SECRET) {
  return new NextRequest("http://localhost/api/jobs/esign", { headers: { authorization: `Bearer ${secret}` } })
}

/** `count` sent envelopes with reminders on, each with one signer last asked long ago. */
function harness(t, { count = 1, envelope = {}, request = {}, deliveries = [] } = {}) {
  const previous = process.env.CRON_SECRET
  process.env.CRON_SECRET = SECRET
  t.after(() => {
    if (previous === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = previous
  })
  const envelopes = Array.from({ length: count }, (_, index) => ({
    id: id(1000 + index),
    org_id: ORG,
    document_id: id(5000 + index),
    status: "sent",
    expires_at: null,
    metadata: { reminder_settings: { enabled: true, interval_days: 1 } },
    ...envelope,
  }))
  return createServiceHarness({
    tables: {
      envelopes,
      document_signing_requests: envelopes.map((row, index) => ({
        id: id(3000 + index),
        org_id: ORG,
        envelope_id: row.id,
        document_id: row.document_id,
        sequence: 1,
        required: true,
        status: "sent",
        sent_to_email: "signer@harbor-homes.us",
        sent_at: LONG_AGO,
        viewed_at: null,
        ...request,
      })),
      documents: envelopes.map((row) => ({ id: row.document_id, org_id: ORG, status: "sent" })),
      esign_reminder_deliveries: deliveries,
      outbox: [],
      job_runs: [],
      events: [],
    },
  })
}

const reminders = (service) => service.db.outbox.filter((job) => job.job_type === "send_esign_reminder")

test("every due signer is queued once, past the first page of envelopes", async (t) => {
  const service = harness(t, { count: 251 })

  const response = await service.run(() => GET(cronRequest()))

  assert.equal(response.status, 200)
  assert.equal((await response.json()).reminders.queued, 251)
  const jobs = reminders(service)
  assert.equal(jobs.length, 251)
  assert.equal(new Set(jobs.map((job) => job.payload.signing_request_id)).size, 251)
  assert.equal(jobs[0].payload.delivery_key, `${jobs[0].payload.signing_request_id}:${LONG_AGO}`)
})

test("signers are not reminded when reminders are off or they were reminded recently", async (t) => {
  const off = harness(t, { envelope: { metadata: { reminder_settings: { enabled: false } } } })
  await off.run(() => GET(cronRequest()))
  assert.deepEqual(reminders(off), [])

  const recent = harness(t, {
    deliveries: [
      {
        org_id: ORG,
        signing_request_id: id(3000),
        delivery_type: "automatic",
        status: "sent",
        sent_at: new Date().toISOString(),
      },
    ],
  })
  await recent.run(() => GET(cronRequest()))
  assert.deepEqual(reminders(recent), [])
})

test("expired envelopes close with their open requests and are not reminded", async (t) => {
  const service = harness(t, { envelope: { expires_at: LONG_AGO } })

  await service.run(() => GET(cronRequest()))

  assert.equal(service.db.envelopes[0].status, "expired")
  assert.equal(service.db.document_signing_requests[0].status, "expired")
  assert.equal(service.db.documents[0].status, "expired")
  assert.deepEqual(reminders(service), [])
})

test("an unauthenticated call does nothing", async (t) => {
  const service = harness(t)
  const response = await service.run(() => GET(cronRequest("wrong-secret")))
  assert.equal(response.status, 401)
  assert.deepEqual(service.writes(), [])
})
