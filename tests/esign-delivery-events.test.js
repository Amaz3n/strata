const assert = require("node:assert/strict")
const test = require("node:test")

const { freshRequire } = require("./support/modules")
const { asRole, createDatabase } = require("./support/pglite")
const { createDatabaseClient, seedSigningDocument } = require("./support/esign-database")

const { runWithServiceSupabaseClient } = require("@/lib/supabase/service-client-context")
const { processSigningDeliveryWebhook, recordSigningEmailAccepted } = freshRequire(
  "lib/services/esign-delivery-events.ts",
)

const TYPES = { sent: "email.sent", delivered: "email.delivered", bounced: "email.bounced" }

async function deliveryFixture(t) {
  const db = await createDatabase(t)
  const client = createDatabaseClient(db)
  const signing = await seedSigningDocument(db, { tokenHash: "invitation-1" })
  const service = (work) => runWithServiceSupabaseClient(client, work)

  return {
    db,
    /** The provider's webhook, as the route hands it over after verifying it. */
    event: (eventId, status, occurredAt, providerId = "email-1", data = {}) =>
      service(() =>
        processSigningDeliveryWebhook({
          eventId,
          type: TYPES[status],
          createdAt: occurredAt,
          data: { email_id: providerId, ...data },
        }),
      ),
    /** The provider accepted an invitation sent under `tokenHash`. */
    accepted: (providerId, tokenHash = "invitation-1") =>
      service(() =>
        recordSigningEmailAccepted({
          orgId: signing.orgId,
          requestId: signing.requestId,
          providerId,
          expectedTokenHash: tokenHash,
          kind: "invitation",
        }),
      ),
    request: async () =>
      (await db.query("select * from document_signing_requests where id = $1", [signing.requestId])).rows[0],
    correctRecipient: () =>
      db.query("update document_signing_requests set token_hash = 'invitation-2', sent_to_email = $2 where id = $1", [
        signing.requestId,
        "corrected@example.test",
      ]),
  }
}

test("delivery status follows the newest event, whichever arrives first", async (t) => {
  const { db, event, accepted, request } = await deliveryFixture(t)

  // The webhook can beat the send call's own acknowledgement.
  await event("delivered-1", "delivered", "2020-01-02T00:00:00Z")
  await accepted("email-1")
  assert.equal((await request()).delivery_status, "delivered")

  // An older event arriving late does not regress the status.
  await event("sent-1", "sent", "2020-01-01T00:00:00Z")
  assert.equal((await request()).delivery_status, "delivered")

  // A replayed event is recorded once.
  await event("delivered-1", "delivered", "2020-01-02T00:00:00Z")
  const { rows } = await db.query("select count(*)::int as n from esign_delivery_events")
  assert.equal(rows[0].n, 2)
})

test("a resend tracks the new message and ignores the previous one", async (t) => {
  const { event, accepted, request } = await deliveryFixture(t)
  await accepted("email-1")
  await accepted("email-2")
  assert.equal((await request()).provider_email_id, "email-2")
  assert.equal((await request()).delivery_status, "accepted")

  await event("bounce-old", "bounced", "2020-01-03T00:00:00Z", "email-1")
  assert.equal((await request()).delivery_status, "accepted")

  await event("bounce-new", "bounced", "2020-01-04T00:00:00Z", "email-2", { bounce: { message: "vendor detail" } })
  const bounced = await request()
  assert.equal(bounced.delivery_status, "bounced")
  assert.doesNotMatch(bounced.delivery_error, /vendor detail/)

  // Acknowledging the same message again does not hide the bounce.
  await accepted("email-2")
  assert.equal((await request()).delivery_status, "bounced")
})

test("correcting the recipient clears delivery evidence that belonged to the old invitation", async (t) => {
  const { event, accepted, request, correctRecipient } = await deliveryFixture(t)
  await accepted("email-1")
  await event("bounce", "bounced", "2020-01-04T00:00:00Z")

  await correctRecipient()
  const corrected = await request()
  for (const column of ["provider_email_id", "delivery_status", "delivery_error", "delivery_updated_at"]) {
    assert.equal(corrected[column], null, column)
  }

  // Late evidence about the old invitation lands nowhere.
  await event("bounce-late", "bounced", "2020-01-05T00:00:00Z")
  await accepted("email-1", "invitation-1")
  assert.equal((await request()).delivery_status, null)

  await accepted("email-3", "invitation-2")
  assert.equal((await request()).provider_email_id, "email-3")
  assert.equal((await request()).delivery_status, "accepted")
})

test("only the service role may record delivery events", async (t) => {
  const { db } = await deliveryFixture(t)
  await assert.rejects(
    asRole(db, { role: "authenticated" }, (tx) =>
      tx.query("select record_esign_delivery_event('forged', 'email-1', 'delivered', now(), null)"),
    ),
    /permission denied/,
  )
})

test("webhooks that are not delivery events, or lack an id or time, change nothing", async () => {
  assert.equal(await processSigningDeliveryWebhook({ eventId: "opened", type: "email.opened" }), false)
  await assert.rejects(
    processSigningDeliveryWebhook({ eventId: "no-time", type: "email.delivered", data: { email_id: "email-1" } }),
    /timestamp/,
  )
  await assert.rejects(
    processSigningDeliveryWebhook({ eventId: "no-id", type: "email.delivered", createdAt: "2020-01-01T00:00:00Z" }),
    /identifier/,
  )
})
