const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { orgMfaPolicyBlocks, assuranceLevelFromAccessToken } = require("@/lib/auth/org-mfa-policy")
const {
  signMfaGateCookie,
  verifyMfaGateCookie,
  signOrgMfaPolicyCookie,
  verifyOrgMfaPolicyCookie,
} = require("@/lib/auth/mfa-gate-cookie")

stubModule("@/lib/services/mailer", { sendInviteEmail: async () => {} })

const { suspendMember, reactivateMember } = freshRequire("lib/services/team.ts")
const { getOrgSecurityPolicy, setOrgRequireMfa } = freshRequire("lib/services/org-security.ts")

const ADMIN_ROLE = id(1)
const USER_ROLE = id(2)
const OTHER_ORG = id(900099)
const SECOND_ADMIN = id(11)
const TARGET_USER = id(12)
const TARGET_MEMBERSHIP = id(13)

/** An org whose admin is the acting user, plus the members a test needs. */
function orgWith({ members = [], revoke } = {}) {
  const revocations = []
  const service = createServiceHarness({
    permissions: ["members.manage"],
    tables: {
      role_permissions: [{ role_id: ADMIN_ROLE, permission_key: "org.admin" }],
      app_users: [],
      project_members: [],
    },
    rpc: {
      revoke_user_sessions: (args) => {
        revocations.push(args.p_user_id)
        return revoke ? revoke(args) : { data: 3, error: null }
      },
    },
  })
  service.db.memberships[0].role_id = ADMIN_ROLE
  service.db.memberships.push(...members)
  return { service, revocations }
}

const member = (overrides) => ({
  id: TARGET_MEMBERSHIP,
  org_id: ORG,
  user_id: TARGET_USER,
  role_id: USER_ROLE,
  status: "active",
  ...overrides,
})

const statusOf = (service, membershipId) => service.db.memberships.find((row) => row.id === membershipId).status

test("the last administrator cannot be suspended", async () => {
  const { service, revocations } = orgWith()
  const actorMembership = service.db.memberships[0].id

  await assert.rejects(service.run(() => suspendMember(actorMembership)), /last administrator/)

  assert.equal(statusOf(service, actorMembership), "active")
  assert.deepEqual(revocations, [])
})

test("an administrator can be suspended while another remains", async () => {
  const { service } = orgWith({ members: [member({ id: id(14), user_id: SECOND_ADMIN, role_id: ADMIN_ROLE })] })

  await service.run(() => suspendMember(id(14)))

  assert.equal(statusOf(service, id(14)), "suspended")
})

test("suspending a member ends their sessions and says so in the event", async () => {
  const { service, revocations } = orgWith({ members: [member()] })

  await service.run(() => suspendMember(TARGET_MEMBERSHIP))

  assert.equal(statusOf(service, TARGET_MEMBERSHIP), "suspended")
  assert.deepEqual(revocations, [TARGET_USER])
  const event = service.events.find((entry) => entry.eventType === "member_suspended")
  assert.deepEqual(event.payload.sessions, { revoked: true, count: 3 })
})

test("a member still active in another organization keeps their sessions", async () => {
  const { service, revocations } = orgWith({
    members: [member(), member({ id: id(15), org_id: OTHER_ORG })],
  })

  await service.run(() => suspendMember(TARGET_MEMBERSHIP))

  assert.equal(statusOf(service, TARGET_MEMBERSHIP), "suspended")
  assert.deepEqual(revocations, [])
  const event = service.events.find((entry) => entry.eventType === "member_suspended")
  assert.deepEqual(event.payload.sessions, { revoked: false, reason: "other_active_memberships" })
})

test("a failed session revocation does not undo the suspension and is reported", async () => {
  const { service } = orgWith({
    members: [member()],
    revoke: () => ({ data: null, error: { message: "boom" } }),
  })

  await service.run(() => suspendMember(TARGET_MEMBERSHIP))

  assert.equal(statusOf(service, TARGET_MEMBERSHIP), "suspended")
  const event = service.events.find((entry) => entry.eventType === "member_suspended")
  assert.deepEqual(event.payload.sessions, { revoked: false, reason: "revocation_failed" })
})

test("reactivating a member does not touch sessions", async () => {
  const { service, revocations } = orgWith({ members: [member({ status: "suspended" })] })

  await service.run(() => reactivateMember(TARGET_MEMBERSHIP))

  assert.equal(statusOf(service, TARGET_MEMBERSHIP), "active")
  assert.deepEqual(revocations, [])
  assert.ok(service.events.some((entry) => entry.eventType === "member_reactivated"))
})

function policyOrg({ permissions = ["org.admin"], require_mfa } = {}) {
  return createServiceHarness({
    permissions,
    tables: {
      org_security_policies:
        require_mfa === undefined ? [] : [{ org_id: ORG, require_mfa, updated_by: null, updated_at: "2026-10-01T00:00:00Z" }],
    },
  })
}

test("an organization with no policy row does not require two-factor", async () => {
  const service = policyOrg()

  assert.equal((await service.run(() => getOrgSecurityPolicy())).requireMfa, false)
})

test("an administrator can require two-factor, and the change is audited and announced", async () => {
  const service = policyOrg()

  const policy = await service.run(() => setOrgRequireMfa({ requireMfa: true }))

  assert.equal(policy.requireMfa, true)
  assert.equal((await service.run(() => getOrgSecurityPolicy())).requireMfa, true)
  assert.equal(service.db.org_security_policies[0].updated_by, ACTOR)
  assert.equal(service.audits.length, 1)
  assert.equal(service.audits[0].entityType, "org_security_policy")
  assert.equal(service.audits[0].after.require_mfa, true)
  assert.deepEqual(service.events.map((event) => [event.eventType, event.payload.require_mfa]), [
    ["org_security_policy_updated", true],
  ])
})

test("setting the policy to its current value writes nothing", async () => {
  const service = policyOrg({ require_mfa: true })

  await service.run(() => setOrgRequireMfa({ requireMfa: true }))

  assert.deepEqual(service.writes(), [])
  assert.deepEqual(service.audits, [])
})

test("a member without administrator rights cannot change the policy", async () => {
  const service = policyOrg({ permissions: ["members.manage"], require_mfa: false })

  await assert.rejects(service.run(() => setOrgRequireMfa({ requireMfa: true })))

  assert.equal(service.db.org_security_policies[0].require_mfa, false)
  assert.deepEqual(service.writes(), [])
})

test("two-factor policy only blocks sessions that have not completed a second factor", () => {
  assert.equal(orgMfaPolicyBlocks({ policyRequiresMfa: true, assuranceLevel: "aal1" }), true)
  assert.equal(orgMfaPolicyBlocks({ policyRequiresMfa: true, assuranceLevel: null }), true)
  assert.equal(orgMfaPolicyBlocks({ policyRequiresMfa: true, assuranceLevel: "aal2" }), false)
  assert.equal(orgMfaPolicyBlocks({ policyRequiresMfa: false, assuranceLevel: "aal1" }), false)
})

test("a bearer token's assurance level is read from its claims", () => {
  const token = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`
  assert.equal(assuranceLevelFromAccessToken(token({ aal: "aal2" })), "aal2")
  assert.equal(assuranceLevelFromAccessToken(token({})), null)
  assert.equal(assuranceLevelFromAccessToken("not-a-jwt"), null)
})

test("the policy proof is bound to its session and cannot stand in for the factor proof", async () => {
  const previousSecret = process.env.SUPABASE_SERVICE_ROLE_KEY
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-signing-secret"
  const session = { sub: "user-1", sessionId: "session-1" }
  const proof = await signOrgMfaPolicyCookie(session)

  assert.equal(await verifyOrgMfaPolicyCookie(proof, session), true)
  assert.equal(await verifyOrgMfaPolicyCookie(proof, { ...session, sessionId: "session-2" }), false)
  assert.equal(await verifyMfaGateCookie(proof, session), false)
  assert.equal(await verifyOrgMfaPolicyCookie(await signMfaGateCookie(session), session), false)
  assert.equal(await verifyOrgMfaPolicyCookie(undefined, session), false)

  if (previousSecret === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
  else process.env.SUPABASE_SERVICE_ROLE_KEY = previousSecret
})
