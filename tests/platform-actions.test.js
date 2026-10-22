const assert = require("node:assert/strict")
const test = require("node:test")
const { isRedirectError } = require("next/dist/client/components/redirect-error")

const { createFakeSupabase } = require("./support/fake-supabase")
const { stubModule, freshRequire } = require("./support/modules")
const { asRole, createDatabase, insert, rpc, seedMember, uuid } = require("./support/pglite")

const ORG = "00000000-0000-4000-8000-000000000001"
const OPERATOR = "00000000-0000-4000-8000-000000000002"
const OTHER_ORG = "00000000-0000-4000-8000-000000000003"

// ---------------------------------------------------------------------------
// The platform console's enter-organization action.
// ---------------------------------------------------------------------------

function loadActions({ permitted = true } = {}) {
  const selected = []
  // revalidatePath needs a request's static generation store; redirect is real.
  stubModule("next/cache", { revalidatePath() {} })
  stubModule("@/lib/auth/context", { requireAuth: async () => ({ user: { id: "user" } }) })
  stubModule("@/lib/services/platform-access", {
    requireAnyPlatformPermission: async () => {
      if (!permitted) throw new Error("Platform access required")
    },
  })
  stubModule("@/lib/services/platform-session", {
    setPlatformOrgContext: async (input) => selected.push(input),
  })
  return { actions: freshRequire("app/(app)/platform/actions.ts"), selected }
}

function switchForm({ orgId = ORG, reason = "Ticket 1234: invoice totals", durationMinutes } = {}) {
  const form = new FormData()
  form.set("orgId", orgId)
  form.set("reason", reason)
  if (durationMinutes !== undefined) form.set("durationMinutes", String(durationMinutes))
  return form
}

test("entering an organization redirects home with a reason and a one-hour default", async () => {
  const { actions, selected } = loadActions()
  await assert.rejects(actions.enterOrgContextAction(switchForm()), (error) => {
    assert.ok(isRedirectError(error))
    assert.match(error.digest, /;\/;/)
    return true
  })
  assert.deepEqual(selected, [{ orgId: ORG, reason: "Ticket 1234: invoice totals", durationMinutes: 60 }])
})

test("entering an organization without platform access returns an error and selects nothing", async () => {
  const { actions, selected } = loadActions({ permitted: false })
  const result = await actions.enterOrgContextAction(switchForm())
  assert.deepEqual(result, { success: false, error: "Platform access required" })
  assert.deepEqual(selected, [])
})

test("entering an organization is refused without a reason, past eight hours, or with a malformed id", async () => {
  const cases = [
    [{ orgId: "not-an-org" }, "Invalid organization id"],
    [{ reason: "  checking " }, "Give a reason of at least 10 characters"],
    [{ durationMinutes: 481 }, "Support access cannot last longer than 8 hours"],
  ]
  for (const [form, error] of cases) {
    const { actions, selected } = loadActions()
    assert.deepEqual(await actions.enterOrgContextAction(switchForm(form)), { success: false, error })
    assert.deepEqual(selected, [])
  }
})

// ---------------------------------------------------------------------------
// Opening a grant (lib/services/platform-session.ts).
// ---------------------------------------------------------------------------

function loadSession({ openGrant }) {
  const cookieWrites = []
  const grantCalls = []
  const supabase = createFakeSupabase({}, {
    open_platform_access_grant: async (args) => {
      grantCalls.push(args)
      return openGrant(args)
    },
  })
  stubModule("next/headers", {
    cookies: async () => ({
      get: () => undefined,
      set: ({ name, value }) => cookieWrites.push({ name, value }),
    }),
  })
  stubModule("@/lib/auth/context", { requireAuth: async () => ({ user: { id: OPERATOR, email: "ops@arc.test" } }) })
  stubModule("@/lib/services/platform-access", {
    requireAnyPlatformPermission: async () => ({ id: OPERATOR, email: "ops@arc.test" }),
  })
  stubModule("@/lib/services/permissions", { requireAnyPermission: async () => {} })
  stubModule("@/lib/services/context", { requireOrgContext: async () => ({}) })
  stubModule("@/lib/services/audit", { recordAudit: async () => {} })
  stubModule("@/lib/services/events", { recordEvent: async () => {} })
  stubModule("@/lib/supabase/server", {
    createServerSupabaseClient: async () => supabase,
    createServiceSupabaseClient: () => supabase,
  })
  return { session: freshRequire("lib/services/platform-session.ts"), cookieWrites, grantCalls }
}

function grantRow(args) {
  return {
    id: uuid(),
    org_id: args.p_org_id,
    operator_user_id: args.p_operator_user_id,
    operator_email: args.p_operator_email,
    reason: args.p_reason,
    impersonation_session_id: null,
    granted_at: "2026-10-11T12:00:00.000Z",
    expires_at: "2026-10-11T13:00:00.000Z",
    ended_at: null,
  }
}

test("entering opens a grant for the stated reason and duration before selecting the organization", async () => {
  const { session, cookieWrites, grantCalls } = loadSession({ openGrant: (args) => ({ data: grantRow(args), error: null }) })
  const grant = await session.setPlatformOrgContext({ orgId: ORG, reason: "Ticket 1234: invoice totals", durationMinutes: 120 })

  assert.equal(grant.orgId, ORG)
  assert.equal(grantCalls.length, 1)
  assert.equal(grantCalls[0].p_minutes, 120)
  assert.equal(grantCalls[0].p_operator_email, "ops@arc.test")
  assert.deepEqual(
    cookieWrites.map((write) => write.name),
    ["org_id", "platform_context_org_id"],
  )
})

test("a grant that cannot be written fails entering and selects no organization", async () => {
  const { session, cookieWrites } = loadSession({
    openGrant: () => ({ data: null, error: { message: "permission denied for table platform_access_grants" } }),
  })
  await assert.rejects(
    session.setPlatformOrgContext({ orgId: ORG, reason: "Ticket 1234: invoice totals" }),
    /Unable to open support access: permission denied/,
  )
  assert.deepEqual(cookieWrites, [])
})

test("entering refuses a short reason and more than eight hours before writing anything", async () => {
  const { session, grantCalls } = loadSession({ openGrant: (args) => ({ data: grantRow(args), error: null }) })
  await assert.rejects(session.setPlatformOrgContext({ orgId: ORG, reason: "help" }), /at least 10 characters/)
  await assert.rejects(
    session.setPlatformOrgContext({ orgId: ORG, reason: "Ticket 1234: invoice totals", durationMinutes: 9 * 60 }),
    /longer than 8 hours/,
  )
  assert.deepEqual(grantCalls, [])
})

// ---------------------------------------------------------------------------
// Org context for Arc staff (lib/auth/context.ts requireOrgMembership).
// ---------------------------------------------------------------------------

/**
 * A render-time request by a platform operator whose org cookie selects ORG.
 * `grants` is what the database reports as the operator's open, unexpired
 * grants (expiry itself is the database's job, tested below).
 */
function loadContext({ memberOf = [], grants = [], grantError = null, operator = true, orgAccess = true, cookieOrgId = ORG, owner = false }) {
  delete process.env.SUPERADMIN_IDS
  const supabase = createFakeSupabase(
    {
      memberships: memberOf.map((orgId, index) => ({
        id: `membership-${index}`,
        org_id: orgId,
        user_id: OPERATOR,
        role_id: "role-pm",
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
        roles: { key: "project_manager" },
        orgs: { product_tier: "residential" },
      })),
      platform_memberships: operator
        ? [
            {
              id: "platform",
              user_id: OPERATOR,
              status: "active",
              expires_at: null,
              role: { key: owner ? "platform_super_admin" : "platform_admin", permissions: [{ permission_key: orgAccess ? "platform.org.access" : "platform.users.read" }] },
            },
          ]
        : [],
      orgs: [{ id: ORG, product_tier: "production" }],
    },
    {
      active_platform_access_grants: async (args) =>
        grantError
          ? { data: null, error: { message: grantError } }
          : {
              data: grants.filter((grant) => grant.org_id === args.p_org_id && grant.operator_user_id === args.p_operator_user_id),
              error: null,
            },
    },
  )
  supabase.auth = { getUser: async () => ({ data: { user: { id: OPERATOR, email: "ops@arc.test" } } }) }
  stubModule("next/headers", {
    cookies: async () => ({
      get: (name) => (name === "org_id" && cookieOrgId ? { value: cookieOrgId } : undefined),
      set() {
        throw new Error("Cookies can only be modified in a Server Action or Route Handler")
      },
    }),
  })
  stubModule("next/cache", { cacheLife() {} })
  stubModule("next/server", { after() {}, connection: async () => {} })
  stubModule("@/lib/supabase/server", {
    createServerSupabaseClient: async () => supabase,
    createServiceSupabaseClient: () => supabase,
  })
  // The grant check lives beside the superadmin list; reload it onto this database.
  freshRequire("lib/auth/platform.ts")
  return freshRequire("lib/auth/context.ts")
}

test("a platform owner enters without a grant and overrides a limited membership", async () => {
  for (const memberOf of [[], [ORG]]) {
    const context = loadContext({ memberOf, owner: true, grantError: "Grant database unavailable" })
    const resolved = await context.requireOrgMembership(ORG)
    assert.equal(resolved.orgId, ORG)
    assert.equal(resolved.membership.role_key, "owner")
    assert.equal(resolved.membership.id, "platform-admin")
  }
  await assert.rejects(loadContext({ owner: true }).requireOrgMembership(OTHER_ORG), /Organization not found/)
})

const OPEN_GRANT = { id: "grant", org_id: ORG, operator_user_id: OPERATOR }

test("a platform operator without a grant has no access to an organization they do not belong to", async () => {
  const context = loadContext({})
  await assert.rejects(context.requireOrgMembership(), /No active organization/)
  await assert.rejects(loadContext({}).requireOrgMembership(ORG), /no longer have access/)
})

test("a platform operator with an open grant acts as the organization's owner", async () => {
  const resolved = await loadContext({ grants: [OPEN_GRANT] }).requireOrgMembership()
  assert.equal(resolved.orgId, ORG)
  assert.equal(resolved.membership.role_key, "owner")
  assert.equal(resolved.membership.org_product_tier, "production")
})

test("a grant does nothing for someone who is no longer a platform operator", async () => {
  await assert.rejects(loadContext({ grants: [OPEN_GRANT], operator: false }).requireOrgMembership(ORG), /no longer have access/)
})

test("a platform member without platform.org.access gets no organization context from a grant", async () => {
  await assert.rejects(loadContext({ grants: [OPEN_GRANT], orgAccess: false }).requireOrgMembership(ORG), /no longer have access/)
})

test("a grant that cannot be read refuses access rather than granting it", async () => {
  await assert.rejects(loadContext({ grantError: "timeout" }).requireOrgMembership(ORG), /Unable to verify support access/)
})

test("a platform operator who belongs to the organization uses their real membership", async () => {
  const resolved = await loadContext({ memberOf: [ORG], grants: [OPEN_GRANT] }).requireOrgMembership()
  assert.equal(resolved.membership.id, "membership-0")
  assert.equal(resolved.membership.role_key, "project_manager")
})

test("without a grant an operator's stale org cookie falls back to their own organization", async () => {
  const resolved = await loadContext({ memberOf: [OTHER_ORG] }).requireOrgMembership()
  assert.equal(resolved.orgId, OTHER_ORG)
  assert.equal(resolved.membership.role_key, "project_manager")
})

// ---------------------------------------------------------------------------
// The grant ledger itself (supabase/migrations/…_platform_access_grants.sql).
// ---------------------------------------------------------------------------

/** Opens a grant as the app does and returns the stored row. */
async function openGrant(db, { orgId, operatorId, minutes = 60, reason = "Ticket 1234: invoice totals" }) {
  await rpc(db, "open_platform_access_grant", {
    p_org_id: orgId,
    p_operator_user_id: operatorId,
    p_operator_email: "ops@arc.test",
    p_reason: reason,
    p_minutes: minutes,
  })
  const { rows } = await db.query(
    "select * from platform_access_grants where org_id = $1 and operator_user_id = $2 order by granted_at desc limit 1",
    [orgId, operatorId],
  )
  return rows[0]
}

async function activeGrants(db, operatorId, orgId) {
  return rpc(db, "active_platform_access_grants", { p_operator_user_id: operatorId, p_org_id: orgId })
}

test("an open grant is active until it is ended or expires, and opening it is audited", async (t) => {
  const db = await createDatabase(t)
  const { orgId } = await seedMember(db)
  const { userId: operatorId } = await seedMember(db)

  const grant = await openGrant(db, { orgId, operatorId })
  assert.deepEqual((await activeGrants(db, operatorId, orgId)).map((row) => row.id), [grant.id])
  const { rows: audit } = await db.query(
    "select action_key, reason_code, resource_id from authorization_audit_log where org_id = $1",
    [orgId],
  )
  assert.deepEqual(audit, [{ action_key: "platform.org.access", reason_code: "grant_opened", resource_id: grant.id }])

  await db.query("update platform_access_grants set ended_at = now() where id = $1", [grant.id])
  assert.deepEqual(await activeGrants(db, operatorId, orgId), [])

  await insert(db, "platform_access_grants", {
    org_id: orgId,
    operator_user_id: operatorId,
    operator_email: "ops@arc.test",
    reason: "Ticket 1234: invoice totals",
    granted_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    expires_at: new Date(Date.now() - 3600_000).toISOString(),
  })
  assert.deepEqual(await activeGrants(db, operatorId, orgId), [])
})

test("a grant needs a reason and cannot last longer than eight hours", async (t) => {
  const db = await createDatabase(t)
  const { orgId } = await seedMember(db)
  const { userId: operatorId } = await seedMember(db)

  await assert.rejects(openGrant(db, { orgId, operatorId, minutes: 481 }), /between 5 minutes and 8 hours/)
  await assert.rejects(openGrant(db, { orgId, operatorId, reason: "   help   " }), /platform_access_grants_reason_check/)
  await assert.rejects(
    insert(db, "platform_access_grants", {
      org_id: orgId,
      operator_user_id: operatorId,
      operator_email: "ops@arc.test",
      reason: "Ticket 1234: invoice totals",
      expires_at: new Date(Date.now() + 9 * 3600_000).toISOString(),
    }),
    /platform_access_grants_window/,
  )
  assert.deepEqual(await activeGrants(db, operatorId, orgId), [])
})

test("an organization's administrators see its support access; other members and organizations do not", async (t) => {
  const db = await createDatabase(t)
  const { orgId, userId: ownerId } = await seedMember(db)
  const { userId: superintendentId } = await seedMember(db, { orgId, role: "org_superintendent" })
  const { userId: strangerId } = await seedMember(db)
  const { userId: operatorId } = await seedMember(db)
  const grant = await openGrant(db, { orgId, operatorId })

  const read = (userId) =>
    asRole(db, { role: "authenticated", userId }, async (tx) => (await tx.query("select id from platform_access_grants")).rows)
  assert.deepEqual(await read(ownerId), [{ id: grant.id }])
  assert.deepEqual(await read(superintendentId), [])
  assert.deepEqual(await read(strangerId), [])

  await assert.rejects(
    asRole(db, { role: "authenticated", userId: ownerId }, (tx) =>
      tx.query("update platform_access_grants set expires_at = now() + interval '1 hour' where id = $1", [grant.id]),
    ),
    /permission denied/,
  )
})
