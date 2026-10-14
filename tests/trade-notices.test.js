"use strict"

/**
 * `lib/services/trade-notices.ts`: a trade notice is sent once, from what was
 * reserved, however the send, the response or the worker fails. Real
 * reserve/settle SQL on the migrated schema; the mail provider is a fake that
 * honours its idempotency key the way Resend does.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { stubModule, freshRequire } = require("./support/modules")
const { createFakeSupabase } = require("./support/fake-supabase")
const { createPgliteClient } = require("./support/pglite-client")
const { createDatabase, insert, seedMember } = require("./support/pglite")

/** Resend: the same Idempotency-Key within a day returns the first message. */
function fakeProvider({ accept = true } = {}) {
  const state = { calls: [], messages: new Map(), accept }
  state.sendEmail = async (payload) => {
    state.calls.push(payload)
    if (!state.accept) return false
    if (!state.messages.has(payload.idempotencyKey)) state.messages.set(payload.idempotencyKey, { id: `msg-${state.messages.size + 1}`, html: payload.html, to: payload.to })
    try {
      await payload.onAccepted?.(state.messages.get(payload.idempotencyKey).id)
    } catch {
      return false
    }
    return true
  }
  return state
}

async function setup(t, { failRpc } = {}) {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db)
  const company = await insert(db, "companies", { org_id: orgId, name: "Palmetto Framing" })
  const provider = fakeProvider()
  const client = createPgliteClient(db, { failRpc })
  stubModule("@/lib/supabase/server", { createServiceSupabaseClient: () => client })
  stubModule("@/lib/services/mailer", {
    escapeHtml: String, getOrgSenderEmail: () => "sender@example.test", renderStandardEmailLayout: (input) => input.messageHtml,
    sendEmail: (payload) => provider.sendEmail(payload),
  })
  stubModule("@/lib/services/context", { requireOrgContext: async () => ({ orgId, userId }) })
  stubModule("@/lib/services/permissions", { requirePermission: async () => undefined })
  stubModule("@/lib/services/authorization", { getProjectReadScopeForUser: async () => ({ divisionIds: null, projectMembershipRequired: false }) })
  stubModule("@/lib/services/starts-pipeline-trigger", { triggerStartsPipeline: async () => ({ triggered: false }) })
  const { deliverTradeNotice } = freshRequire("lib/services/trade-notices.ts")
  const draft = (name = "Rough framing") => ({
    subject: "3-week trade look-ahead", recipients: ["foreman@example.test"],
    snapshot: {
      title: "Look-ahead", intro: "Upcoming work", lines: [{ label: "Lot 14", name, dates: "2026-10-20 – 2026-10-22" }],
      buttonText: null, buttonUrl: null, org: { name: "Builder", slug: "builder", logoUrl: null },
    },
  })
  const deliver = (build = async () => draft(), key = "lookahead:one") => deliverTradeNotice({
    orgId, actorId: userId, kind: "lookahead", companyId: company.id, projectId: null, dedupeKey: key, scope: {}, build,
  })
  const rows = async () => (await db.query("select * from trade_notice_deliveries order by created_at")).rows
  const sentRecords = async () => ({
    events: (await db.query("select count(*)::int n from events where event_type = 'trade_notice.sent'")).rows[0].n,
    audits: (await db.query("select count(*)::int n from audit_log where entity_type = 'trade_notice'")).rows[0].n,
  })
  return { db, orgId, company, provider, deliver, draft, rows, sentRecords }
}

test("a notice goes out once under the delivery's provider key and a repeat is a duplicate", async (t) => {
  const s = await setup(t)
  assert.equal(await s.deliver(), "sent")
  assert.equal(await s.deliver(), "duplicate")
  assert.equal(s.provider.calls.length, 1)
  const [row] = await s.rows()
  assert.equal(s.provider.calls[0].idempotencyKey, row.idempotency_key)
  assert.equal(row.status, "accepted")
  assert.equal(row.provider_message_id, "msg-1")
  assert.deepEqual(await s.sentRecords(), { events: 1, audits: 1 })
})

test("a crash after the provider accepted retries under the same key and sends one message", async (t) => {
  let lose = true
  const s = await setup(t, { failRpc: (name) => name === "settle_trade_notice" && lose })
  await assert.rejects(s.deliver(), /Failed to record trade notice delivery/)
  assert.equal((await s.rows())[0].status, "reserved")
  lose = false
  assert.equal(await s.deliver(), "sent")
  assert.equal(s.provider.calls.length, 2, "the retry did send again")
  assert.equal(s.provider.messages.size, 1, "but the provider recognised the key and sent one message")
  assert.equal((await s.rows())[0].provider_message_id, "msg-1")
  assert.deepEqual(await s.sentRecords(), { events: 1, audits: 1 })
})

test("two simultaneous sends of one notice reach the provider as one message", async (t) => {
  const s = await setup(t)
  const outcomes = await Promise.all([s.deliver(), s.deliver()])
  assert.ok(outcomes.includes("sent"))
  assert.equal(s.provider.messages.size, 1)
  assert.deepEqual(await s.sentRecords(), { events: 1, audits: 1 })
})

test("a retry sends what was reserved, not what the schedule says now", async (t) => {
  let lose = true
  const s = await setup(t, { failRpc: (name) => name === "settle_trade_notice" && lose })
  await assert.rejects(s.deliver(async () => s.draft("Rough framing")))
  lose = false
  let rebuilt = 0
  await s.deliver(async () => { rebuilt += 1; return s.draft("Moved to next month") })
  assert.equal(rebuilt, 0)
  assert.match([...s.provider.messages.values()][0].html, /Rough framing/)
  assert.doesNotMatch([...s.provider.messages.values()][0].html, /next month/)
})

test("an email the provider refuses is recorded as failed and retries under the same key", async (t) => {
  const s = await setup(t)
  s.provider.accept = false
  await assert.rejects(s.deliver(), /was not accepted/)
  const [failed] = await s.rows()
  assert.equal(failed.status, "failed")
  s.provider.accept = true
  assert.equal(await s.deliver(), "sent")
  assert.equal((await s.rows())[0].idempotency_key, failed.idempotency_key)
})

test("a notice whose outcome is unknown is not sent until a coordinator decides", async (t) => {
  let lose = true
  const s = await setup(t, { failRpc: (name) => name === "settle_trade_notice" && lose })
  await assert.rejects(s.deliver())
  lose = false
  await s.db.query("update trade_notice_deliveries set last_attempt_at = now() - interval '25 hours'")
  await assert.rejects(s.deliver(), /outcome of this trade notice is unknown/)
  assert.equal((await s.rows())[0].status, "ambiguous")
  assert.equal(s.provider.calls.length, 1, "nothing was sent while it was unknown")
})

test("nothing to say reserves nothing", async (t) => {
  const s = await setup(t)
  assert.equal(await s.deliver(async () => null), "skipped")
  assert.deepEqual(await s.rows(), [])
})

test("a trade's link is its token for the house, else its vendor token, never a paused, expired or revoked one", async () => {
  const org = "00000000-0000-4000-8000-000000000001"
  const company = "00000000-0000-4000-8000-000000000002"
  const house = "00000000-0000-4000-8000-000000000003"
  process.env.PORTAL_ACCESS_SECRET ??= "trade-notice-test-secret-with-32-plus-chars"
  const { encryptPortalToken } = freshRequire("lib/services/portal-credentials.ts")
  const token = (value, fields) => ({ id: value, org_id: org, company_id: company, portal_type: "sub", project_id: null, revoked_at: null, paused_at: null, expires_at: null, created_at: "2026-10-01T00:00:00Z", token_encrypted: encryptPortalToken(value), ...fields })
  const links = async (tokens, project) => {
    stubModule("@/lib/supabase/server", { createServiceSupabaseClient: () => null })
    const { resolveTradePortalLink } = freshRequire("lib/services/trade-notices.ts")
    return resolveTradePortalLink(createFakeSupabase({ portal_access_tokens: tokens }), org, company, project)
  }
  assert.match(await links([token("vendor"), token("house", { project_id: house })], house), /\/s\/house$/)
  assert.match(await links([token("vendor"), token("house", { project_id: house })], null), /\/s\/vendor$/, "a multi-house notice opens the vendor workspace")
  assert.match(await links([token("vendor"), token("paused", { project_id: house, paused_at: "2026-10-02T00:00:00Z" })], house), /\/s\/vendor$/)
  assert.match(await links([token("vendor"), token("expired", { project_id: house, expires_at: "2020-01-01T00:00:00Z" })], house), /\/s\/vendor$/)
  assert.equal(await links([token("revoked", { revoked_at: "2026-10-02T00:00:00Z" }), token("other-house", { project_id: "x" })], house), null)
  assert.match(await links([token("vendor"), token("unreadable", { project_id: house, token_encrypted: null })], house), /\/s\/vendor$/, "a token with no stored copy cannot become a link")
})
