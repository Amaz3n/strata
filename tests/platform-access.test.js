// Platform capabilities (billing, support, feature flags, impersonation) are
// granted only by a platform role. Tenant grants — even a tenant wildcard — never
// reach them, and every platform surface refuses before it touches data.

require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { id, ORG, ACTOR } = require("./support/service")
const { platformActor, envSuperadmin, dataQueries } = require("./support/platform")
const { freshRequire, stubModule } = require("./support/modules")

// Request-scope and provider boundaries.
const sideEffects = []
stubModule("next/server", { ...require("next/server"), connection: async () => {} })
stubModule("next/navigation", {
  ...require("next/navigation"),
  redirect: (destination) => {
    throw Object.assign(new Error("redirect"), { destination })
  },
  unstable_rethrow: () => {},
})
stubModule("next/cache", { ...require("next/cache"), revalidatePath: (route) => sideEffects.push(["revalidate", route]) })
stubModule("@/lib/services/billing", {
  activateOrgBilling: async () => sideEffects.push(["provider"]),
  syncOrgEntitlementsFromPlan: async () => sideEffects.push(["entitlements"]),
})

const authorization = freshRequire("lib/services/authorization.ts")
const access = freshRequire("lib/services/platform-access.ts")
const admin = freshRequire("lib/services/admin.ts")
const releaseNotes = freshRequire("lib/services/release-notes.ts")
const guards = freshRequire("lib/auth/guards.ts")
const customerActions = freshRequire("app/(app)/admin/customers/actions.ts")
const auditExport = freshRequire("app/api/platform/audit-export/route.ts")

const PROJECT = id(1)
const FOREIGN_ORG = id(2)
const UNKNOWN_PROJECT = id(3)
const FLAG = id(4)
const FORGED_ACTOR = id(5)

const PLATFORM_ONLY = ["platform.billing.manage", "platform.support.read", "platform.feature_flags.manage", "impersonation.start"]

/** An org owner holding every tenant grant there is, including the platform keys by name. */
function tenantOwner() {
  const service = platformActor({
    tenant: ["*", ...PLATFORM_ONLY, "billing.manage"],
    projects: [PROJECT],
    tables: {
      projects: [{ id: PROJECT, org_id: ORG }],
      membership_permission_overrides: [
        { membership_id: id(900003), permission_key: "platform.billing.manage", effect: "grant" },
      ],
    },
  })
  return service
}

function quietly(run) {
  const original = console.error
  console.error = () => {}
  return Promise.resolve()
    .then(run)
    .finally(() => {
      console.error = original
    })
}

// --- the RBAC platform branch -------------------------------------------------

test("tenant wildcards, grants and overrides never grant a platform capability", async () => {
  const owner = tenantOwner()
  for (const permission of PLATFORM_ONLY) {
    for (const scope of [{}, { orgId: ORG }, { orgId: ORG, projectId: PROJECT }]) {
      const decision = await owner.run(() => authorization.authorize({ permission, userId: ACTOR, ...scope }))
      assert.equal(decision.allowed, false, `${permission} ${JSON.stringify(scope)}`)
      assert.deepEqual(decision.scopesEvaluated, ["platform"])
      await assert.rejects(
        owner.run(() => authorization.requireAuthorization({ permission, userId: ACTOR, ...scope })),
        (error) => error.code === "AUTH_FORBIDDEN",
      )
    }
    const many = await owner.run(() =>
      authorization.authorizeMany({ permission, userId: ACTOR, orgId: ORG, projectIds: [PROJECT] }),
    )
    assert.equal(many.get(PROJECT), false, permission)
  }
  // A platform key is decided by the platform role alone: tenant grants are not even read.
  for (const table of ["memberships", "project_members", "membership_permission_overrides"]) {
    assert.deepEqual(owner.reads(table), [], table)
  }
})

test("platform org access does not carry billing, support or feature-flag capabilities", async () => {
  const operator = platformActor({ platform: ["platform.org.access"], tables: { projects: [{ id: PROJECT, org_id: ORG }] } })
  for (const permission of PLATFORM_ONLY) {
    assert.equal((await operator.run(() => authorization.authorize({ permission, userId: ACTOR, orgId: ORG }))).allowed, false, permission)
    const many = await operator.run(() =>
      authorization.authorizeMany({ permission, userId: ACTOR, orgId: ORG, projectIds: [PROJECT] }),
    )
    assert.equal(many.get(PROJECT), false, permission)
  }
  const orgAccess = await operator.run(() => authorization.authorize({ permission: "platform.org.access", userId: ACTOR, orgId: ORG }))
  assert.equal(orgAccess.allowed, true)
})

test("a platform role grants only its capability, and only on projects that live in the named org", async () => {
  const operator = platformActor({
    platform: ["platform.billing.manage"],
    tables: { projects: [{ id: PROJECT, org_id: ORG }] },
  })
  const input = { permission: "platform.billing.manage", userId: ACTOR, orgId: ORG, projectId: PROJECT }
  assert.equal((await operator.run(() => authorization.authorize(input))).allowed, true)
  assert.equal((await operator.run(() => authorization.authorize({ ...input, permission: "platform.support.read" }))).allowed, false)

  const many = await operator.run(() => authorization.authorizeMany({ ...input, projectIds: [PROJECT, UNKNOWN_PROJECT] }))
  assert.equal(many.get(PROJECT), true)
  assert.equal(many.get(UNKNOWN_PROJECT), false, "a project with no home org")

  operator.db.projects[0].org_id = FOREIGN_ORG
  assert.equal((await operator.run(() => authorization.authorize(input))).allowed, false, "a project from another org")
  const moved = await operator.run(() => authorization.authorizeMany({ ...input, projectIds: [PROJECT] }))
  assert.equal(moved.get(PROJECT), false)
})

test("a revoked platform membership or a failed lookup refuses; tenant billing still works", async () => {
  const operator = platformActor({ platform: ["platform.billing.manage"], tenant: ["billing.manage"] })
  const input = { permission: "platform.billing.manage", userId: ACTOR, orgId: ORG }
  assert.equal((await operator.run(() => authorization.authorize(input))).allowed, true)

  operator.db.platform_memberships[0].status = "revoked"
  assert.equal((await operator.run(() => authorization.authorize(input))).allowed, false)
  assert.equal((await operator.run(() => authorization.authorize({ ...input, permission: "billing.manage" }))).allowed, true)

  operator.tamper("platform_memberships", (result) => ({ ...result, data: null, error: { message: "Platform catalog unavailable" } }))
  await assert.rejects(operator.run(() => authorization.authorize(input)), /Platform catalog unavailable/)
})

// --- the platform gate --------------------------------------------------------

test("the platform gate binds the signed-in operator and accepts only platform keys", async () => {
  const operator = platformActor({ platform: ["platform.support.read"] })
  assert.equal((await operator.run(() => access.requireAnyPlatformPermission(["platform.support.read"]))).id, ACTOR)
  await assert.rejects(operator.run(() => access.requireAnyPlatformPermission(["platform.billing.manage"])))
  for (const keys of [["billing.manage"], []]) {
    await assert.rejects(operator.run(() => access.requireAnyPlatformPermission(keys)), /Invalid platform permission/)
  }

  envSuperadmin(true)
  assert.equal((await operator.run(() => access.requireAnyPlatformPermission(["platform.billing.manage"]))).id, ACTOR)
  envSuperadmin(false)
})

test("every global admin service refuses a tenant owner before reading platform data", async () => {
  const args = {
    getCustomers: [{}],
    getSubscriptions: [{}],
    getAuditLogs: [{}],
    toggleFeatureFlag: [FLAG, ORG, true, ACTOR],
    createFeatureFlag: [{}],
    updateFeatureFlag: [{}],
    deleteFeatureFlag: [{}],
  }
  const exported = Object.entries(admin).filter(([, value]) => typeof value === "function")
  assert.ok(exported.length >= 16)
  for (const [name, call] of exported) {
    const owner = tenantOwner()
    await assert.rejects(owner.run(() => call(...(args[name] ?? []))), /Missing permission: platform\./, name)
    assert.deepEqual(dataQueries(owner), [], name)
    assert.deepEqual(owner.audits, [], name)
  }
})

test("release-note publishing and its admin list refuse a tenant owner before reading data", async () => {
  for (const [name, args] of [
    ["listReleaseNotesForAdmin", []],
    ["createReleaseNote", [{}]],
    ["updateReleaseNote", [FLAG, {}]],
    ["deleteReleaseNote", [FLAG]],
  ]) {
    const owner = tenantOwner()
    await assert.rejects(owner.run(() => releaseNotes[name](...args)), /Missing permission: platform\./, name)
    assert.deepEqual(dataQueries(owner), [], name)
  }
})

test("cross-org customer actions refuse before database, provider, entitlements, audit or revalidation", async () => {
  const form = (values) => {
    const data = new FormData()
    for (const [key, value] of Object.entries(values)) data.set(key, value)
    return data
  }
  for (const [name, input] of [
    ["extendCustomerTrialAction", form({ orgId: FOREIGN_ORG, trialDays: "30" })],
    [
      "activateCustomerBillingAction",
      form({ orgId: FOREIGN_ORG, amountDollars: "1000", interval: "month", collectionMethod: "checkout" }),
    ],
    [
      "updateCustomerDetailsAction",
      form({
        orgId: FOREIGN_ORG,
        name: "Other builder",
        slug: "other-builder",
        status: "active",
        billingModel: "subscription",
        billingEmail: "",
        productTier: "production",
      }),
    ],
    ["updateCustomerSubscriptionAction", form({ orgId: FOREIGN_ORG, status: "active" })],
    ["deleteOrganizationAction", FOREIGN_ORG],
  ]) {
    const owner = tenantOwner()
    sideEffects.length = 0
    const result = await quietly(() => owner.run(() => customerActions[name](input)))
    assert.equal(result.success, false, name)
    assert.match(result.error, /platform\.billing\.manage/, name)
    assert.deepEqual(dataQueries(owner), [], name)
    assert.deepEqual([...sideEffects, ...owner.audits, ...owner.events], [], name)
  }
})

test("an operator cannot write a feature flag or org status under someone else's name", async () => {
  const operator = platformActor({ platform: ["platform.feature_flags.manage", "platform.billing.manage"] })
  for (const [name, args] of [
    ["toggleFeatureFlag", [FLAG, ORG, true, FORGED_ACTOR]],
    ["createFeatureFlag", [{ actorId: FORGED_ACTOR }]],
    ["updateFeatureFlag", [{ actorId: FORGED_ACTOR }]],
    ["deleteFeatureFlag", [{ actorId: FORGED_ACTOR }]],
  ]) {
    await assert.rejects(operator.run(() => admin[name](...args)), /Platform actor mismatch/, name)
  }
  await assert.rejects(
    operator.run(() => access.setPlatformOrganizationStatus({ orgId: ORG, status: "archived", actorUserId: FORGED_ACTOR })),
    /Platform actor mismatch/,
  )
  assert.deepEqual(dataQueries(operator), [])
})

test("a permitted flag change is audited under the signed-in operator", async () => {
  const operator = platformActor({
    platform: ["platform.feature_flags.manage"],
    tables: { feature_flags: [{ id: FLAG, org_id: ORG, flag_key: "test_flag", enabled: false }] },
  })
  await operator.run(() => admin.toggleFeatureFlag(FLAG, ORG, true))
  assert.equal(operator.db.feature_flags[0].enabled, true)
  assert.equal(operator.audits.length, 1)
  assert.equal(operator.audits[0].actorId, ACTOR)
  assert.equal(operator.audits[0].orgId, ORG)
})

test("the audit export answers 403 before reading any log", async () => {
  const owner = tenantOwner()
  const request = { nextUrl: new URL(`https://arc.test/api/platform/audit-export?orgId=${FOREIGN_ORG}`) }
  const response = await owner.run(() => auditExport.GET(request))
  assert.equal(response.status, 403)
  assert.deepEqual(dataQueries(owner), [])
})

// --- route guards -------------------------------------------------------------

async function guardOutcome(service, guard) {
  try {
    await quietly(() => service.run(guard))
    return "allowed"
  } catch (error) {
    if (error.destination) return error.destination
    throw error
  }
}

test("a platform route guard is satisfied only by a platform role, a tenant guard only by a tenant role", async () => {
  const owner = tenantOwner()
  for (const guard of [
    () => guards.requirePermissionGuard("platform.billing.manage", ORG),
    () => guards.requireAnyPermissionGuard(["platform.support.read"], ORG),
  ]) {
    assert.equal(await guardOutcome(owner, guard), "/unauthorized")
  }
  assert.equal(await guardOutcome(owner, () => guards.requirePermissionGuard("billing.manage")), "allowed")
  assert.equal(await guardOutcome(owner, () => guards.requireAnyPermissionGuard(["billing.manage"])), "allowed")

  const operator = platformActor({ platform: ["platform.billing.manage", "platform.support.read"] })
  assert.equal(await guardOutcome(operator, () => guards.requirePermissionGuard("platform.billing.manage")), "allowed")
  assert.equal(await guardOutcome(operator, () => guards.requireAnyPermissionGuard(["platform.support.read"])), "allowed")
  assert.equal(await guardOutcome(operator, () => guards.requirePermissionGuard("billing.manage")), "/unauthorized")
})
