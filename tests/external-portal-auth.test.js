require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

// Session tokens are hashed with this secret; any test value works.
process.env.PORTAL_ACCESS_SECRET = "test-portal-access-secret-0123456789abcdef"

// External boundaries: the signed-in Supabase user, the cookie jar, portal
// token decryption, mail and rate limiting. Everything else is real.
let signedIn = null
let cookies = []
stubModule("@/lib/supabase/server", {
  ...require("@/lib/supabase/server"),
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: signedIn }, error: null }) },
  }),
})
stubModule("next/headers", { cookies: async () => ({ set: (cookie) => cookies.push(cookie) }) })
stubModule("@/lib/services/portal-credentials", {
  ...require("@/lib/services/portal-credentials"),
  decryptPortalToken: (value) => (value === "encrypted" ? "portal-secret" : null),
})
stubModule("@/lib/services/mailer", { sendExternalVerifyEmail: async () => {} })
stubModule("@/lib/services/auth-rate-limit", { enforceAuthRateLimit: async () => {} })

const { getTradeBuilderWorkspace, openTradeBuilderConnection } = freshRequire("lib/services/external-portal-auth.ts")

const IDENTITY = id(1)
const GRANT = id(2)
const BUILDER_ORG = id(3)
const UNKNOWN_GRANT = id(99)

function identity(overrides = {}) {
  return {
    id: IDENTITY,
    email: "pilot@example.test",
    status: "active",
    email_verified_at: "2026-01-01T00:00:00Z",
    paused_at: null,
    revoked_at: null,
    ...overrides,
  }
}

/** A live grant to a builder's sub portal, embedded the way PostgREST returns it. */
function grant(overrides = {}, tokenOverrides = {}) {
  return {
    id: GRANT,
    identity_id: IDENTITY,
    org_id: BUILDER_ORG,
    status: "active",
    paused_at: null,
    revoked_at: null,
    portal_access_token_id: "token",
    bid_access_token_id: null,
    org: { id: BUILDER_ORG, name: "Builder" },
    token: {
      id: "token",
      portal_type: "sub",
      token_encrypted: "encrypted",
      expires_at: null,
      project: { id: "project", name: "Builder job", status: "active" },
      ...tokenOverrides,
    },
    ...overrides,
  }
}

/** A trade company whose member is signed in as `user`. */
function tradeMember({ user = {}, identities = [identity()], grants = [grant()], permissions = ["org.member"] } = {}) {
  signedIn = { id: ACTOR, email: "PILOT@example.test", email_confirmed_at: "2026-01-01T00:00:00Z", ...user }
  cookies = []
  return createServiceHarness({
    permissions,
    tables: {
      org_settings: [{ org_id: ORG, settings: { business_profile: { kind: "trade", specialty: "Electrical" } } }],
      external_identities: identities,
      external_identity_grants: grants,
    },
  })
}

test("builder connections need a confirmed login that is a claimed, verified identity", async () => {
  for (const [name, setup] of [
    ["unconfirmed login", { user: { email_confirmed_at: null } }],
    ["another user's session", { user: { id: id(50) } }],
    ["unverified identity", { identities: [identity({ email_verified_at: null })] }],
    ["identity for another email", { identities: [identity({ email: "someone-else@example.test" })] }],
  ]) {
    const service = tradeMember(setup)
    assert.equal(await service.run(() => getTradeBuilderWorkspace()), null, name)
    assert.deepEqual(service.writes(), [], name)
  }
})

test("a trade member without org membership is refused", async () => {
  const service = tradeMember({ permissions: [] })
  await assert.rejects(service.run(() => getTradeBuilderWorkspace()))
  assert.deepEqual(service.writes(), [])
})

test("paused, revoked, foreign or expired grants never open a session", async () => {
  for (const [name, stale] of [
    ["paused", grant({ paused_at: "2026-02-01T00:00:00Z" })],
    ["revoked", grant({ revoked_at: "2026-02-01T00:00:00Z" })],
    ["withdrawn", grant({ status: "revoked" })],
    ["another identity's", grant({ identity_id: id(51) })],
    ["expired token", grant({}, { expires_at: "2020-01-01T00:00:00Z" })],
  ]) {
    const service = tradeMember({ grants: [stale] })
    await assert.rejects(service.run(() => openTradeBuilderConnection(GRANT)), /no longer available/, name)
    assert.deepEqual(service.writes(), [], name)
    assert.deepEqual(cookies, [], name)
  }
})

test("opening a live sub grant starts a session for that verified person only", async () => {
  const service = tradeMember()
  const workspace = await service.run(() => getTradeBuilderWorkspace())
  assert.deepEqual(workspace.items.map((item) => item.id), [GRANT])

  await assert.rejects(service.run(() => openTradeBuilderConnection(UNKNOWN_GRANT)), /no longer available/)
  assert.deepEqual(service.writes("external_identity_sessions"), [])

  assert.deepEqual(await service.run(() => openTradeBuilderConnection(GRANT)), { href: "/s/portal-secret" })
  assert.deepEqual(service.db.external_identity_sessions.map((session) => session.identity_id), [IDENTITY])
  assert.equal(cookies.length, 1)
  assert.equal(cookies[0].httpOnly, true)
  assert.ok(service.writes().every((write) => !("password_attempts" in write.payload)), "no password attempt is counted")
})
