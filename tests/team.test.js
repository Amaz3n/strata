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

// The platform gate answers from this operator list; everything else is real.
const platformOperators = new Set()
stubModule("@/lib/services/platform-access", {
  requireAnyPlatformPermission: async () => {
    if (!platformOperators.has(ACTOR)) throw new Error("Forbidden")
    return { id: ACTOR }
  },
})

const { suspendMember, reactivateMember, removeMember, inviteTeamMember, resetMemberMfa } = freshRequire("lib/services/team.ts")
const { resolveOrgEnrollmentGate, resolveStepUpGate } = freshRequire("lib/auth/session-mfa-gates.ts")
const { getOrgSecurityPolicy, setOrgRequireMfa } = freshRequire("lib/services/org-security.ts")

const ADMIN_ROLE = id(1)
const USER_ROLE = id(2)
const OTHER_ORG = id(900099)
const SECOND_ADMIN = id(11)
const TARGET_USER = id(12)
const TARGET_MEMBERSHIP = id(13)

/** An org whose admin is the acting user, plus the members a test needs. */
function orgWith({ members = [], revoke, permissions = ["members.manage"] } = {}) {
  const revocations = []
  const service = createServiceHarness({
    permissions,
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
  const { service } = orgWith({
    permissions: ["org.admin", "members.manage"],
    members: [member({ id: id(14), user_id: SECOND_ADMIN, role_id: ADMIN_ROLE })],
  })

  await service.run(() => suspendMember(id(14)))

  assert.equal(statusOf(service, id(14)), "suspended")
})

test("a member manager without org.admin cannot suspend, reactivate or remove an administrator, and the refusal is logged", async () => {
  const { service } = orgWith({
    members: [
      member({ id: id(14), user_id: SECOND_ADMIN, role_id: ADMIN_ROLE }),
      member({ id: id(16), user_id: id(17), role_id: ADMIN_ROLE, status: "suspended" }),
    ],
  })

  await assert.rejects(service.run(() => suspendMember(id(14))), /cannot grant access/)
  await assert.rejects(service.run(() => reactivateMember(id(16))), /cannot grant access/)
  await assert.rejects(service.run(() => removeMember(id(14))), /cannot grant access/)

  assert.equal(statusOf(service, id(14)), "active")
  assert.equal(statusOf(service, id(16)), "suspended")
  assert.ok(service.db.authorization_audit_log.some((row) => row.decision === "deny" && row.action_key === "org.admin"))
})

test("a member manager can still suspend an ordinary member", async () => {
  const { service } = orgWith({ members: [member()] })

  await service.run(() => suspendMember(TARGET_MEMBERSHIP))

  assert.equal(statusOf(service, TARGET_MEMBERSHIP), "suspended")
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

const OFFICE_ROLE = id(3)
const OWNER_ROLE = id(4)
const DIVISION_A = id(21)
const DIVISION_B = id(22)

/** An actor holding `members.manage` (not org.admin) inviting into an org with real role rows. */
function inviteOrg({ permissions = ["members.manage", "invoice.read"], divisions, projects, appUsers = [], extraMemberships = [] } = {}) {
  const service = createServiceHarness({
    permissions,
    divisions,
    projects,
    tables: {
      roles: [
        { id: ADMIN_ROLE, key: "org_admin", scope: "org" },
        { id: USER_ROLE, key: "org_user", scope: "org" },
        { id: OFFICE_ROLE, key: "org_office_admin", scope: "org" },
        { id: OWNER_ROLE, key: "org_owner", scope: "org" },
      ],
      role_permissions: [
        { role_id: ADMIN_ROLE, permission_key: "org.admin" },
        { role_id: OWNER_ROLE, permission_key: "org.admin" },
        { role_id: OFFICE_ROLE, permission_key: "members.manage" },
        { role_id: USER_ROLE, permission_key: "invoice.read" },
      ],
      app_users: appUsers,
      orgs: [{ id: ORG, name: "Acme", slug: "acme" }],
      project_members: [],
      divisions: [
        { id: DIVISION_A, org_id: ORG },
        { id: DIVISION_B, org_id: ORG },
      ],
    },
    rpc: {
      get_org_member_mfa_status: () => ({ data: [], error: null }),
      revoke_user_sessions: () => ({ data: 0, error: null }),
    },
  })
  service.db.memberships.push(...extraMemberships)
  return service
}

const invite = (overrides) => ({ email: "new@example.com", role: "org_user", ...overrides })
const newUser = { id: id(30), email: "new@example.com", full_name: null }
const memberRows = (service) => service.db.memberships.filter((row) => row.user_id !== ACTOR)

test("an inviter without org.admin cannot invite an administrator or owner, and the denial is logged", async () => {
  const service = inviteOrg({ appUsers: [newUser] })

  for (const role of ["org_admin", "org_owner"]) {
    await assert.rejects(service.run(() => inviteTeamMember({ input: invite({ role }) })), /cannot grant access you do not hold/)
  }

  assert.deepEqual(memberRows(service), [])
  assert.ok(service.db.authorization_audit_log.some((row) => row.decision === "deny" && row.action_key === "org.admin"))
})

test("an inviter cannot grant a permission override they do not hold", async () => {
  const service = inviteOrg({ appUsers: [newUser] })
  const permissionOverrides = [{ permission_key: "invoice.send", effect: "grant" }]

  await assert.rejects(service.run(() => inviteTeamMember({ input: invite({ permissionOverrides }) })), /cannot grant access/)
  assert.deepEqual(memberRows(service), [])
})

test("an inviter can invite a role made only of permissions they hold", async () => {
  const service = inviteOrg({ appUsers: [newUser] })

  await service.run(() => inviteTeamMember({ input: invite() }))

  assert.equal(memberRows(service)[0].status, "invited")
  assert.equal(memberRows(service)[0].role_id, USER_ROLE)
})

test("an org administrator can invite an administrator", async () => {
  const service = inviteOrg({ permissions: ["org.admin", "members.manage"], appUsers: [newUser] })

  await service.run(() => inviteTeamMember({ input: invite({ role: "org_admin" }) }))

  assert.equal(memberRows(service)[0].role_id, ADMIN_ROLE)
})

test("a division-limited inviter can only invite into their own divisions", async () => {
  const service = inviteOrg({ divisions: [DIVISION_A], appUsers: [newUser] })

  await assert.rejects(service.run(() => inviteTeamMember({ input: invite({ divisionScope: "all" }) })), /limited to your own divisions/)
  await assert.rejects(
    service.run(() => inviteTeamMember({ input: invite({ divisionScope: "assigned", divisionIds: [DIVISION_B] }) })),
    /only assign divisions you belong to/,
  )
  assert.deepEqual(memberRows(service), [])

  await service.run(() => inviteTeamMember({ input: invite({ divisionScope: "assigned", divisionIds: [DIVISION_A] }) }))
  const invited = memberRows(service)[0]
  assert.deepEqual(service.db.membership_divisions.filter((row) => row.membership_id === invited.id).map((row) => row.division_id), [DIVISION_A])
})

test("a project-limited inviter cannot invite someone with access to every project", async () => {
  const service = inviteOrg({ appUsers: [newUser], projects: [id(40)] })

  await assert.rejects(service.run(() => inviteTeamMember({ input: invite({ projectScope: "all" }) })), /assigned projects/)
  assert.deepEqual(memberRows(service), [])

  await service.run(() => inviteTeamMember({ input: invite({ projectScope: "assigned" }) }))
  assert.equal(memberRows(service)[0].project_scope, "assigned")
})

test("an invite created for the importer meets the same rank rule", async () => {
  const service = inviteOrg({ appUsers: [newUser] })
  const { createOrgMemberInvite, inviteRefusal } = freshRequire("lib/services/team.ts")
  const base = { supabase: service.client, orgId: ORG, actorUserId: ACTOR, email: "new@example.com", sendEmail: false }

  await assert.rejects(service.run(() => createOrgMemberInvite({ ...base, role: "org_owner" })), /cannot grant access/)
  assert.deepEqual(memberRows(service), [])
  assert.match(await service.run(() => inviteRefusal({ ...base, role: "org_owner", divisionId: null })), /cannot grant access/)
  assert.equal(await service.run(() => inviteRefusal({ ...base, role: "org_user", divisionId: null })), null)
})

test("platform provisioning invites the owner of a new org without any membership there, but only for a platform operator", async () => {
  const service = inviteOrg({ permissions: [], appUsers: [newUser] })
  const { createOrgMemberInvite } = freshRequire("lib/services/team.ts")
  const request = { supabase: service.client, orgId: ORG, actorUserId: ACTOR, email: "new@example.com", sendEmail: false, role: "org_owner" }

  await assert.rejects(
    service.run(() => createOrgMemberInvite({ ...request, authority: { kind: "platform_provisioning" } })),
    /Forbidden/,
  )
  assert.deepEqual(memberRows(service), [])

  platformOperators.add(ACTOR)
  try {
    await service.run(() => createOrgMemberInvite({ ...request, authority: { kind: "platform_provisioning" } }))
  } finally {
    platformOperators.delete(ACTOR)
  }
  assert.equal(memberRows(service)[0].role_id, OWNER_ROLE)
})

test("a division-limited manager can only suspend, reactivate or remove members limited to their own divisions", async () => {
  const cases = [
    { name: "an org-wide member", target: member({ division_scope: "all" }), allowed: false },
    { name: "a member of another division", target: member({ division_scope: "assigned" }), divisions: [DIVISION_B], allowed: false },
    { name: "a member spanning a foreign division", target: member({ division_scope: "assigned" }), divisions: [DIVISION_A, DIVISION_B], allowed: false },
    { name: "a member inside their divisions", target: member({ division_scope: "assigned" }), divisions: [DIVISION_A], allowed: true },
  ]
  for (const { name, target, divisions = [], allowed } of cases) {
    for (const act of [(id) => suspendMember(id), (id) => reactivateMember(id), (id) => removeMember(id)]) {
      const service = inviteOrg({ divisions: [DIVISION_A], extraMemberships: [target] })
      service.db.membership_divisions.push(...divisions.map((division_id) => ({ membership_id: target.id, division_id })))
      const run = service.run(() => act(target.id))
      if (allowed) await run
      else await assert.rejects(run, /limited to your own divisions/, name)
    }
  }
})

test("inviting an active or suspended member again is refused and changes nothing", async () => {
  for (const status of ["active", "suspended"]) {
    const service = inviteOrg({
      appUsers: [newUser],
      extraMemberships: [member({ user_id: newUser.id, status, role_id: OFFICE_ROLE })],
    })

    await assert.rejects(service.run(() => inviteTeamMember({ input: invite() })), /already/)

    const row = memberRows(service)[0]
    assert.equal(row.status, status)
    assert.equal(row.role_id, OFFICE_ROLE)
  }
})

test("suspending a member cancels what they queued to run as them", async () => {
  const otherUser = id(40)
  const { service } = orgWith({ members: [member()] })
  Object.assign(service.db, {
    invoice_schedules: [
      { id: id(50), org_id: ORG, created_by: TARGET_USER, active: true },
      { id: id(51), org_id: ORG, created_by: otherUser, active: true },
    ],
    report_schedules: [{ id: id(52), org_id: ORG, created_by: TARGET_USER, is_active: true }],
    outbox: [
      { id: 1, org_id: ORG, status: "pending", job_type: "issue_invoice_scheduled", payload: { actor_id: TARGET_USER } },
      { id: 2, org_id: ORG, status: "pending", job_type: "issue_invoice_scheduled", payload: { actor_id: otherUser } },
      { id: 3, org_id: OTHER_ORG, status: "pending", job_type: "issue_invoice_scheduled", payload: { actor_id: TARGET_USER } },
    ],
    payment_run_approvers: [
      { org_id: ORG, user_id: TARGET_USER },
      { org_id: ORG, user_id: otherUser },
    ],
    device_tokens: [{ id: id(53), org_id: ORG, user_id: TARGET_USER, token: "t" }],
  })

  await service.run(() => suspendMember(TARGET_MEMBERSHIP))

  assert.deepEqual(service.db.invoice_schedules.map((row) => row.active), [false, true])
  assert.deepEqual(service.db.report_schedules.map((row) => row.is_active), [false])
  assert.deepEqual(service.db.outbox.map((row) => row.status), ["failed", "pending", "pending"])
  assert.match(service.db.outbox[0].last_error, /Cancelled/)
  assert.deepEqual(service.db.payment_run_approvers.map((row) => row.user_id), [otherUser])
  assert.deepEqual(service.db.device_tokens, [])
  const event = service.events.find((entry) => entry.eventType === "member_suspended")
  assert.deepEqual(event.payload.queued, {
    invoice_schedules: 1,
    report_schedules: 1,
    outbox_jobs: 1,
    payment_approver_rows: 1,
    device_tokens: 1,
    failed: [],
  })
})

test("removing a member sweeps too, and a person active elsewhere keeps their other devices", async () => {
  const { service } = orgWith({ members: [member(), member({ id: id(15), org_id: OTHER_ORG })] })
  Object.assign(service.db, {
    invoice_schedules: [{ id: id(50), org_id: ORG, created_by: TARGET_USER, active: true }],
    device_tokens: [
      { id: id(53), org_id: ORG, user_id: TARGET_USER, token: "a" },
      { id: id(54), org_id: OTHER_ORG, user_id: TARGET_USER, token: "b" },
    ],
  })

  await service.run(() => removeMember(TARGET_MEMBERSHIP))

  assert.equal(service.db.invoice_schedules[0].active, false)
  assert.deepEqual(service.db.device_tokens.map((row) => row.token), ["b"])
  assert.equal(service.events.find((entry) => entry.eventType === "member_removed").payload.queued.device_tokens, 1)
})

function mfaOrg({ permissions, targetRole }) {
  const service = inviteOrg({
    permissions,
    extraMemberships: [member({ role_id: targetRole })],
  })
  const deleted = []
  service.client.auth = {
    admin: {
      mfa: {
        listFactors: async () => ({ data: { factors: [{ id: "f1", status: "verified" }] }, error: null }),
        deleteFactor: async ({ id: factorId }) => {
          deleted.push(factorId)
          return { error: null }
        },
      },
    },
  }
  const revocations = []
  const rpc = service.client.rpc.bind(service.client)
  service.client.rpc = (name, args) => {
    if (name === "revoke_user_sessions") {
      revocations.push(args.p_user_id)
      return Promise.resolve({ data: 2, error: null })
    }
    return rpc(name, args)
  }
  return { service, deleted, revocations }
}

test("an MFA reset is refused for a member whose role carries permissions the actor lacks", async () => {
  const { service, deleted, revocations } = mfaOrg({ permissions: ["members.manage"], targetRole: ADMIN_ROLE })

  await assert.rejects(service.run(() => resetMemberMfa(TARGET_MEMBERSHIP)), /cannot grant access/)

  assert.deepEqual(deleted, [])
  assert.deepEqual(revocations, [])
})

test("an MFA reset removes the factor, ends every session of the member and is announced", async () => {
  const { service, deleted, revocations } = mfaOrg({ permissions: ["members.manage", "invoice.read"], targetRole: USER_ROLE })

  const result = await service.run(() => resetMemberMfa(TARGET_MEMBERSHIP))

  assert.deepEqual(result, { reset: true, deletedFactors: 1, sessionsEnded: true })
  assert.deepEqual(deleted, ["f1"])
  assert.deepEqual(revocations, [TARGET_USER])
  const event = service.events.find((entry) => entry.eventType === "member_mfa_reset")
  assert.deepEqual(event.payload.sessions, { revoked: true, count: 2 })
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

// The proxy's two-factor gates (lib/auth/session-mfa-gates.ts).
// The "no" proofs are signed with the service-role secret.
function withSigningSecret(t) {
  const previous = process.env.SUPABASE_SERVICE_ROLE_KEY
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-signing-secret"
  t.after(() => {
    if (previous === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previous
  })
}

const gateClaims = { sub: "user-1", session_id: "session-1" }

function auth({ factors = [], error = null } = {}) {
  return { auth: { getUser: async () => ({ data: { user: error ? null : { id: "user-1", factors } }, error }) } }
}

function policies({ rows = [], error = null } = {}) {
  const query = { select: () => query, eq: () => query, limit: async () => ({ data: error ? null : rows, error }) }
  return { from: () => query }
}

test("a member with a verified factor owes a code; one without passes and gets a proof that skips the next lookup", async (t) => {
  withSigningSecret(t)
  assert.deepEqual(await resolveStepUpGate(auth({ factors: [{ status: "verified" }] }), gateClaims, undefined), { kind: "required" })

  const first = await resolveStepUpGate(auth({ factors: [{ status: "unverified" }] }), gateClaims, undefined)
  assert.equal(first.kind, "pass")
  assert.ok(first.proof)
  // With the proof, the Auth server is not asked again for this session.
  assert.deepEqual(await resolveStepUpGate(auth({ error: { message: "down" } }), gateClaims, first.proof), { kind: "pass" })
  // A proof for another session is worthless.
  assert.equal((await resolveStepUpGate(auth({ factors: [{ status: "verified" }] }), { ...gateClaims, session_id: "session-2" }, first.proof)).kind, "required")
})

test("an organization requiring two-factor sends a member without a factor to enrollment, and that answer is never cached", async (t) => {
  withSigningSecret(t)
  assert.deepEqual(await resolveOrgEnrollmentGate(policies({ rows: [{ org_id: "org-1" }] }), gateClaims, undefined), { kind: "required" })

  const none = await resolveOrgEnrollmentGate(policies(), gateClaims, undefined)
  assert.equal(none.kind, "pass")
  assert.ok(none.proof)
  assert.deepEqual(await resolveOrgEnrollmentGate(policies({ rows: [{ org_id: "org-1" }] }), gateClaims, none.proof), { kind: "pass" })
})

test("a lookup that fails refuses the request instead of letting the session through", async () => {
  assert.deepEqual(await resolveStepUpGate(auth({ error: { message: "auth server unavailable" } }), gateClaims, undefined), { kind: "unavailable" })
  assert.deepEqual(await resolveOrgEnrollmentGate(policies({ error: { message: "connection reset" } }), gateClaims, undefined), { kind: "unavailable" })
})
